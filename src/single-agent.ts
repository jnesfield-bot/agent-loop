/**
 * SingleAgent — A concrete AgentLoop that uses pi's SDK for all four phases.
 *
 * Actions come in two forms:
 *   - Primitive: one atomic step per heartbeat (bash, read, write, edit)
 *   - Skill: a coherent sequence of steps that executes within a single
 *     heartbeat. The agent plans the steps, then the act phase runs them
 *     all sequentially with per-step events for observability.
 *
 * This is the "options" framework applied to LLM agents:
 *   - Primitive actions are single-step options (duration = 1 heartbeat)
 *   - Skills are multi-step options (duration = N sub-steps, 1 heartbeat)
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  convertToLlm,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  createExtensionRuntime,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  AgentSession,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "fs";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { AgentLoop } from "./agent-loop.js";
import type {
  Action,
  ActionResult,
  AgentLoopConfig,
  Input,
  PrimitiveAction,
  ScoredAction,
  SkillAction,
  SkillDescriptor,
  SkillExecution,
  SkillStep,
  State,
  TaskBrief,
} from "./types.js";

// ── Primitive Action Types ───────────────────────────────
//
// Three categories:
//   1. Pi tools — file I/O and shell (the "hands")
//   2. Search tools — structured queries (grep, find, ls)
//   3. Agent control — memory, delegation, messaging, lifecycle
//

const PRIMITIVE_TYPES = {
  // Pi tools (file I/O + shell)
  BASH: "bash",
  READ: "read",
  WRITE: "write",
  EDIT: "edit",

  // Search tools (structured, not shell one-liners)
  GREP: "grep",
  FIND: "find",
  LS: "ls",

  // Agent control
  UPDATE_MEMORY: "update_memory",
  DELEGATE: "delegate",
  MESSAGE: "message",
  COMPLETE: "complete",
  WAIT: "wait",
} as const;

// ── Configuration ────────────────────────────────────────

export interface SingleAgentConfig extends AgentLoopConfig {
  apiKey?: string;
  model?: string;
  task?: TaskBrief;
  systemPrompt?: string;
  /** Directory for the replay buffer. Set to enable automatic recording. */
  replayBufferDir?: string;
  /** Episode ID for grouping transitions. Auto-generated if not set. */
  episodeId?: string;
}

// ── Implementation ───────────────────────────────────────

export class SingleAgent extends AgentLoop {
  private agentConfig: SingleAgentConfig;
  private session: AgentSession | null = null;
  private piAgent: Agent | null = null;
  private task: TaskBrief | null;
  private memory: Record<string, string> = {};
  private actionHistory: ActionResult[] = [];
  private inputs: Input[] = [];
  private skills: SkillDescriptor[] = [];
  private replayBufferDir: string | null;
  private replayIndex: any = null;
  private episodeId: string;

  constructor(config: SingleAgentConfig) {
    super(config);
    this.agentConfig = config;
    this.task = config.task ?? null;
    this.replayBufferDir = config.replayBufferDir ?? null;
    this.episodeId = config.episodeId ?? `ep-${Date.now().toString(36)}`;
  }

  // ── Setup / Teardown ─────────────────────────────────────

  protected async setup(): Promise<void> {
    const { workDir } = this.config;
    await mkdir(workDir, { recursive: true });
    await mkdir(join(workDir, "memory"), { recursive: true });
    await mkdir(join(workDir, "history"), { recursive: true });

    await this.loadMemory();
    this.skills = this.discoverSkills();
    this.initReplayBuffer();

    // Initialize pi SDK
    const authStorage = AuthStorage.create(join(workDir, "auth.json"));
    const apiKey = this.agentConfig.apiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) authStorage.setRuntimeApiKey("anthropic", apiKey);

    const modelRegistry = new ModelRegistry(authStorage);
    const modelId = this.agentConfig.model ?? "claude-sonnet-4-20250514";
    const model = getModel("anthropic", modelId as any);
    if (!model) throw new Error(`Model not found: ${modelId}`);

    const cwd = workDir;
    const systemPrompt = this.buildSystemPrompt();

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getAppendSystemPrompt: () => [],
      getPathMetadata: () => new Map(),
      extendResources: () => {},
      reload: async () => {},
    };

    const tools = [
      createReadTool(cwd),
      createBashTool(cwd),
      createEditTool(cwd),
      createWriteTool(cwd),
    ];

    this.piAgent = new Agent({
      initialState: { systemPrompt, model, thinkingLevel: "off", tools },
      convertToLlm,
      getApiKey: async () => {
        const key = await modelRegistry.getApiKeyForProvider("anthropic");
        if (!key) throw new Error("No Anthropic API key available");
        return key;
      },
    });

    this.session = new AgentSession({
      agent: this.piAgent,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      }),
      cwd,
      modelRegistry,
      resourceLoader,
      baseToolsOverride: Object.fromEntries(tools.map((t) => [t.name, t])) as any,
    });
  }

  protected async teardown(): Promise<void> {
    await this.saveMemory();
    await this.saveHistory();
    this.finalizeReplayEpisode();
  }

  // ── Replay Buffer ─────────────────────────────────────────

  private initReplayBuffer(): void {
    if (!this.replayBufferDir) return;
    const dir = this.replayBufferDir;
    for (const sub of ["transitions", "boards", "media", "episodes"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    const indexPath = join(dir, "index.json");
    if (existsSync(indexPath)) {
      this.replayIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
    } else {
      this.replayIndex = {
        bufferVersion: 1,
        agentId: this.config.agentId,
        created: new Date().toISOString(),
        transitions: [],
        episodes: [],
        stats: { totalTransitions: 0, totalEpisodes: 0, successRate: 0, avgDurationMs: 0 },
      };
    }
    // Register episode
    if (!this.replayIndex.episodes.find((e: any) => e.id === this.episodeId)) {
      this.replayIndex.episodes.push({
        id: this.episodeId,
        start: this.replayIndex.stats.totalTransitions + 1,
        end: null,
        status: "running",
        task: this.task?.description ?? "",
      });
      this.replayIndex.stats.totalEpisodes = this.replayIndex.episodes.length;
    }
    this.saveReplayIndex();
  }

  /**
   * Record one heartbeat transition into the replay buffer.
   * Called automatically by the base loop after every act().
   */
  protected override async recordTransition(
    state: State,
    candidates: ScoredAction[],
    selected: Action,
    result: ActionResult,
  ): Promise<void> {
    if (!this.replayBufferDir || !this.replayIndex) return;

    const id = this.replayIndex.stats.totalTransitions + 1;
    const paddedId = String(id).padStart(6, "0");

    // Render board snapshot for this state
    const board = this.renderBoardText(state);

    // Save board
    const boardRef = `boards/${paddedId}.txt`;
    writeFileSync(join(this.replayBufferDir, boardRef), board);

    // Collect attachments from the result
    const attachments: any[] = [];
    const mediaDir = join(this.replayBufferDir, "media", paddedId);

    // Attach skill trace if present
    if (result.skillTrace) {
      mkdirSync(mediaDir, { recursive: true });
      const tracePath = join(mediaDir, "skill-trace.json");
      writeFileSync(tracePath, JSON.stringify(result.skillTrace, null, 2));
      attachments.push({
        name: "skill-trace.json",
        type: "json",
        ref: `media/${paddedId}/skill-trace.json`,
        size: statSync(tracePath).size,
      });
    }

    // Attach result output if substantial
    if (result.output && result.output.length > 200) {
      mkdirSync(mediaDir, { recursive: true });
      const outPath = join(mediaDir, "output.txt");
      writeFileSync(outPath, result.output);
      attachments.push({
        name: "output.txt",
        type: "text",
        ref: `media/${paddedId}/output.txt`,
        size: result.output.length,
      });
    }

    // Copy any artifact files
    for (const artifact of result.artifacts) {
      try {
        const fullPath = artifact.startsWith("/") ? artifact : join(this.config.workDir, artifact);
        if (existsSync(fullPath)) {
          mkdirSync(mediaDir, { recursive: true });
          const name = basename(fullPath);
          copyFileSync(fullPath, join(mediaDir, name));
          attachments.push({
            name,
            type: "file",
            ref: `media/${paddedId}/${name}`,
            size: statSync(fullPath).size,
          });
        }
      } catch { /* skip unreadable artifacts */ }
    }

    // Auto-tags
    const tags: Record<string, string> = {
      actionType: selected.kind === "skill" ? `skill:${(selected as SkillAction).skillName}` : (selected as PrimitiveAction).type,
    };
    if (selected.kind === "skill") tags.skill = (selected as SkillAction).skillName;

    // Compact state summary
    const stateSummary = {
      taskDescription: state.currentTask?.description ?? null,
      memoryKeys: Object.keys(state.memory ?? {}),
      fileCount: ((state.observations?.workspace_files as string) ?? "").split("\n").filter(Boolean).length,
      inputCount: state.inputs.length,
      childCount: state.children.length,
      skillCount: state.availableSkills.length,
    };

    // Metrics
    const selectedValue = candidates.length > 0
      ? Math.max(...candidates.map(c => c.value))
      : 0;

    const transition = {
      id,
      heartbeat: this.heartbeatCount,
      timestamp: Date.now(),
      agentId: this.config.agentId,
      episodeId: this.episodeId,
      board,
      boardRef,
      state: stateSummary,
      candidates: candidates.map(c => ({
        action: { kind: c.action.kind, type: c.action.kind === "skill" ? `skill:${(c.action as SkillAction).skillName}` : (c.action as PrimitiveAction).type },
        value: c.value,
        reasoning: c.reasoning,
      })),
      selected: {
        kind: selected.kind,
        type: selected.kind === "skill" ? "skill" : (selected as PrimitiveAction).type,
        description: selected.description,
        params: selected.kind === "skill" ? { skillName: (selected as SkillAction).skillName, goal: (selected as SkillAction).goal } : selected.params,
      },
      result: {
        success: result.success,
        output: result.output.substring(0, 2000),
        error: result.error,
        durationMs: result.durationMs,
        artifacts: result.artifacts,
      },
      attachments,
      tags,
      metrics: {
        selectedValue,
        candidateCount: candidates.length,
        actMs: result.durationMs,
      },
    };

    // Write transition
    const transPath = join(this.replayBufferDir, "transitions", `${paddedId}.json`);
    writeFileSync(transPath, JSON.stringify(transition, null, 2));

    // Update index
    this.replayIndex.transitions.push({
      id,
      heartbeat: this.heartbeatCount,
      timestamp: transition.timestamp,
      actionType: tags.actionType,
      success: result.success,
      episode: this.episodeId,
      tags,
    });

    this.replayIndex.stats.totalTransitions = this.replayIndex.transitions.length;
    const successes = this.replayIndex.transitions.filter((t: any) => t.success === true).length;
    const total = this.replayIndex.transitions.filter((t: any) => t.success !== null).length;
    this.replayIndex.stats.successRate = total > 0 ? +(successes / total).toFixed(3) : 0;

    this.saveReplayIndex();
  }

  private finalizeReplayEpisode(): void {
    if (!this.replayBufferDir || !this.replayIndex) return;
    const episode = this.replayIndex.episodes.find((e: any) => e.id === this.episodeId);
    if (episode && !episode.end) {
      episode.end = this.replayIndex.stats.totalTransitions;
      episode.status = "completed";
      this.saveReplayIndex();
    }
  }

  private saveReplayIndex(): void {
    if (!this.replayBufferDir || !this.replayIndex) return;
    writeFileSync(join(this.replayBufferDir, "index.json"), JSON.stringify(this.replayIndex, null, 2));
  }

  /**
   * Render a compact text board from state — used for replay buffer snapshots.
   * This is a lightweight inline version; the full blackboard skill has more options.
   */
  private renderBoardText(state: State): string {
    const W = 54;
    const HR = "═".repeat(W);
    const hr = "─".repeat(W - 2);
    const pad = (s: string, w = W - 2) => s.length > w ? s.substring(0, w - 1) + "…" : s + " ".repeat(w - s.length);
    const box = (title: string, lines: string[]) => {
      const out = [`╠${HR}╣`, `║  ${pad(title)}║`, `║  ┌${hr}┐║`];
      for (const l of lines) out.push(`║  │${pad(" " + l, W - 4)}│║`);
      out.push(`║  └${hr}┘║`);
      return out;
    };

    const time = new Date(state.timestamp).toISOString().substring(11, 16);
    const lines: string[] = [];
    lines.push(`╔${HR}╗`);
    lines.push(`║  ${pad(`BOARD #${this.heartbeatCount}  [executive]${" ".repeat(20)}${time}`)}║`);

    // Task
    if (state.currentTask) {
      const tl = [`Description: ${state.currentTask.description}`];
      for (const c of state.currentTask.successCriteria ?? []) tl.push(`  ☐ ${c}`);
      lines.push(...box("TASK", tl));
    }

    // Last action
    if (state.lastActionResult) {
      const r = state.lastActionResult;
      const type = r.action.kind === "skill" ? `skill:${(r.action as SkillAction).skillName}` : (r.action as PrimitiveAction).type;
      const al = [`${type} ${r.success ? "✓" : "✗"} (${r.durationMs}ms)`];
      if (r.output) al.push(r.output.split("\n")[0].substring(0, 70));
      if (r.error) al.push(`ERROR: ${r.error.substring(0, 60)}`);
      lines.push(...box("LAST ACTION", al));
    }

    // Memory
    const mk = Object.keys(state.memory);
    if (mk.length) {
      lines.push(...box(`MEMORY (${mk.length})`, mk.slice(0, 8).map(k => `${k}: ${String(state.memory[k]).substring(0, 50)}`)));
    }

    // Skills
    if (state.availableSkills.length) {
      lines.push(...box(`SKILLS (${state.availableSkills.length})`, [state.availableSkills.map(s => s.name).join("  ")]));
    }

    lines.push(`╚${HR}╝`);
    return lines.join("\n");
  }

  // ── Skill Discovery ──────────────────────────────────────

  /**
   * Discover skills from configured directories.
   * Looks for SKILL.md files with YAML frontmatter (name + description).
   */
  private discoverSkills(): SkillDescriptor[] {
    const dirs = this.config.skillDirs ?? [];

    // Also check the repo's own skills dir
    const repoSkills = join(this.config.workDir, "..", "skills");
    if (existsSync(repoSkills)) dirs.push(repoSkills);

    // And the standard pi locations
    const homeSkills = join(process.env.HOME ?? "", ".pi", "agent", "skills");
    if (existsSync(homeSkills)) dirs.push(homeSkills);

    const skills: SkillDescriptor[] = [];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) {
            // Direct .md file in skills root
            if (entry.name.endsWith(".md") && entry.name !== "README.md") {
              const skill = this.parseSkillFile(join(dir, entry.name), dir);
              if (skill) skills.push(skill);
            }
            continue;
          }
          // Subdirectory — look for SKILL.md
          const skillMd = join(dir, entry.name, "SKILL.md");
          if (existsSync(skillMd)) {
            const skill = this.parseSkillFile(skillMd, join(dir, entry.name));
            if (skill) skills.push(skill);
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    return skills;
  }

  private parseSkillFile(path: string, baseDir: string): SkillDescriptor | null {
    try {
      const content = readFileSync(path, "utf-8");
      const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;

      const fm = fmMatch[1];
      const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();

      if (!name || !description) return null;

      return { name, description, skillPath: path, baseDir };
    } catch {
      return null;
    }
  }

  /** Load the full instructions for a skill (on demand) */
  private loadSkillInstructions(skill: SkillDescriptor): string {
    if (skill.instructions) return skill.instructions;
    try {
      const content = readFileSync(skill.skillPath, "utf-8");
      // Strip frontmatter
      const stripped = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
      // Replace {baseDir} placeholders
      skill.instructions = stripped.replace(/\{baseDir\}/g, skill.baseDir);
      return skill.instructions;
    } catch {
      return "(could not load skill instructions)";
    }
  }

  // ── Phase 1: OBSERVE ─────────────────────────────────────

  protected async observe(): Promise<State> {
    await this.loadMemory();

    const observations: Record<string, unknown> = {};

    try {
      const { execSync } = await import("child_process");
      const files = execSync(`find ${this.config.workDir} -maxdepth 3 -type f | head -50`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      observations["workspace_files"] = files;
    } catch {
      observations["workspace_files"] = "(could not list files)";
    }

    const inputs = [...this.inputs];
    this.inputs = [];

    return {
      timestamp: Date.now(),
      agentId: this.config.agentId,
      currentTask: this.task,
      memory: { ...this.memory },
      children: [],
      inputs,
      lastActionResult: this.lastResult,
      availableSkills: this.skills,
      activeSkill: this.activeSkill,
      observations,
    };
  }

  // ── Phase 2: EVALUATE ────────────────────────────────────

  protected async evaluate(state: State): Promise<ScoredAction[]> {
    if (!this.session) throw new Error("Session not initialized");

    const prompt = this.buildEvaluatePrompt(state);

    let responseText = "";
    const unsubscribe = this.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        (event as any).assistantMessageEvent?.type === "text_delta"
      ) {
        responseText += (event as any).assistantMessageEvent.delta;
      }
    });

    await this.session.prompt(prompt);
    unsubscribe();

    return this.parseEvaluateResponse(responseText);
  }

  // ── Phase 3: SELECT ──────────────────────────────────────

  protected select(scoredActions: ScoredAction[]): Action {
    if (scoredActions.length === 0) {
      return { kind: "primitive", type: "wait", description: "No actions available", params: {} };
    }

    const sorted = [...scoredActions].sort((a, b) => b.value - a.value);
    return sorted[0].action;
  }

  // ── Phase 4: ACT ─────────────────────────────────────────

  protected async act(action: Action): Promise<ActionResult> {
    if (action.kind === "skill") {
      return this.executeSkill(action as SkillAction);
    }
    return this.executePrimitive(action as PrimitiveAction);
  }

  // ── Primitive Execution ──────────────────────────────────

  private async executePrimitive(action: PrimitiveAction): Promise<ActionResult> {
    const startTime = Date.now();

    try {
      let output: string;

      switch (action.type) {
        case PRIMITIVE_TYPES.BASH:
          output = await this.executeBash(action.params.command as string);
          break;
        case PRIMITIVE_TYPES.READ:
          output = await this.executeRead(action.params.path as string);
          break;
        case PRIMITIVE_TYPES.WRITE:
          await this.executeWrite(action.params.path as string, action.params.content as string);
          output = `Wrote ${action.params.path}`;
          break;
        case PRIMITIVE_TYPES.EDIT:
          await this.executeEdit(action.params.path as string, action.params.oldText as string, action.params.newText as string);
          output = `Edited ${action.params.path}`;
          break;

        // Search tools
        case PRIMITIVE_TYPES.GREP:
          output = await this.executeGrep(
            action.params.pattern as string,
            action.params.path as string | undefined,
            action.params.options as Record<string, unknown> | undefined,
          );
          break;
        case PRIMITIVE_TYPES.FIND:
          output = await this.executeFind(
            action.params.path as string | undefined,
            action.params.pattern as string | undefined,
            action.params.type as string | undefined,
            action.params.maxDepth as number | undefined,
          );
          break;
        case PRIMITIVE_TYPES.LS:
          output = await this.executeLs(
            action.params.path as string | undefined,
            action.params.options as Record<string, unknown> | undefined,
          );
          break;

        // Agent control
        case PRIMITIVE_TYPES.DELEGATE:
          output = await this.executeDelegate(action.params);
          break;
        case PRIMITIVE_TYPES.MESSAGE:
          output = await this.executeMessage(action.params);
          break;
        case PRIMITIVE_TYPES.UPDATE_MEMORY:
          this.memory[action.params.key as string] = action.params.value as string;
          await this.saveMemory();
          output = `Updated memory key: ${action.params.key}`;
          break;
        case PRIMITIVE_TYPES.COMPLETE:
          this.stop();
          output = `Task completed: ${action.params.summary ?? "done"}`;
          break;
        case PRIMITIVE_TYPES.WAIT:
          output = "Waiting...";
          break;
        default:
          output = `Unknown action type: ${action.type}`;
      }

      const result: ActionResult = {
        action, success: true, output, artifacts: [],
        durationMs: Date.now() - startTime, timestamp: Date.now(),
      };
      this.actionHistory.push(result);
      return result;

    } catch (error) {
      const result: ActionResult = {
        action, success: false, output: "",
        error: error instanceof Error ? error.message : String(error),
        artifacts: [], durationMs: Date.now() - startTime, timestamp: Date.now(),
      };
      this.actionHistory.push(result);
      return result;
    }
  }

  // ── Skill Execution ──────────────────────────────────────

  /**
   * Execute a skill as a coherent sequence.
   *
   * 1. Load the skill instructions
   * 2. Ask the LLM to plan the sequence of primitive steps
   * 3. Execute each step, feeding results into the next
   * 4. Return the aggregate result
   *
   * The entire skill runs within a single heartbeat of the outer loop.
   * Sub-step events are emitted for observability.
   */
  private async executeSkill(action: SkillAction): Promise<ActionResult> {
    const startTime = Date.now();
    const skill = this.skills.find((s) => s.name === action.skillName);

    if (!skill) {
      return {
        action, success: false, output: "",
        error: `Skill not found: ${action.skillName}. Available: ${this.skills.map((s) => s.name).join(", ")}`,
        artifacts: [], durationMs: Date.now() - startTime, timestamp: Date.now(),
      };
    }

    // Load full instructions
    const instructions = this.loadSkillInstructions(skill);

    // Initialize skill execution tracking
    const execution: SkillExecution = {
      skill,
      goal: action.goal,
      steps: [],
      currentStep: 0,
      complete: false,
      failed: false,
      output: "",
      artifacts: [],
    };

    this.activeSkill = execution;

    try {
      // Ask the LLM to plan the skill steps
      const steps = await this.planSkillSteps(skill, instructions, action.goal);

      execution.steps = steps;

      // Execute each step sequentially
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        execution.currentStep = i;

        this.emit({
          type: "skill_step_start",
          skill: skill.name,
          step: i,
          description: step.description,
          timestamp: Date.now(),
        });

        // Execute the primitive action for this step
        const stepResult = await this.executePrimitive(step.action);
        step.result = stepResult;

        this.emit({
          type: "skill_step_end",
          skill: skill.name,
          step: i,
          success: stepResult.success,
          timestamp: Date.now(),
        });

        // Accumulate outputs
        execution.output += `\n--- Step ${i + 1}: ${step.description} ---\n`;
        execution.output += stepResult.output;
        if (stepResult.artifacts.length > 0) {
          execution.artifacts.push(...stepResult.artifacts);
        }

        // If a step fails, ask the LLM whether to continue or abort
        if (!stepResult.success) {
          const shouldContinue = await this.shouldContinueSkill(execution, stepResult);
          if (!shouldContinue) {
            execution.failed = true;
            break;
          }
        }
      }

      execution.complete = !execution.failed;

      this.emit({
        type: "skill_complete",
        skill: skill.name,
        success: execution.complete,
        steps: execution.steps.length,
        timestamp: Date.now(),
      });

      const result: ActionResult = {
        action,
        success: execution.complete,
        output: execution.output.trim(),
        artifacts: execution.artifacts,
        error: execution.failed ? `Skill failed at step ${execution.currentStep + 1}` : undefined,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        skillTrace: execution,
      };

      this.actionHistory.push(result);
      return result;

    } catch (error) {
      execution.failed = true;

      const result: ActionResult = {
        action, success: false, output: execution.output.trim(),
        error: error instanceof Error ? error.message : String(error),
        artifacts: execution.artifacts,
        durationMs: Date.now() - startTime, timestamp: Date.now(),
        skillTrace: execution,
      };
      this.actionHistory.push(result);
      return result;

    } finally {
      this.activeSkill = null;
    }
  }

  /**
   * Ask the LLM to plan the sequence of steps for a skill invocation.
   * Returns an ordered list of primitive actions to execute.
   */
  private async planSkillSteps(
    skill: SkillDescriptor,
    instructions: string,
    goal: string,
  ): Promise<SkillStep[]> {
    if (!this.session) throw new Error("Session not initialized");

    const prompt = `You are planning the execution steps for a skill.

## Skill: ${skill.name}
${skill.description}

## Skill Instructions
${instructions}

## Goal
${goal}

## Current Memory
${Object.keys(this.memory).length > 0 ? Object.entries(this.memory).map(([k, v]) => `${k}: ${v}`).join("\n") : "(empty)"}

## Instructions

Plan the concrete sequence of primitive steps to accomplish the goal using this skill.
Respond with ONLY a JSON array. Each element:

\`\`\`json
[
  {
    "description": "What this step does",
    "action": {
      "kind": "primitive",
      "type": "bash|read|write|edit",
      "description": "...",
      "params": { ... }
    }
  }
]
\`\`\`

Be specific. Use actual commands from the skill instructions. Use the correct paths.
Plan all steps needed to reach the goal. Typically 3-15 steps.`;

    let responseText = "";
    const unsubscribe = this.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        (event as any).assistantMessageEvent?.type === "text_delta"
      ) {
        responseText += (event as any).assistantMessageEvent.delta;
      }
    });

    await this.session.prompt(prompt);
    unsubscribe();

    return this.parseSkillPlan(responseText);
  }

  /** Ask the LLM whether to continue after a failed step */
  private async shouldContinueSkill(
    execution: SkillExecution,
    failedResult: ActionResult,
  ): Promise<boolean> {
    if (!this.session) return false;

    const prompt = `A skill step failed. Should we continue or abort?

Skill: ${execution.skill.name}
Goal: ${execution.goal}
Step ${execution.currentStep + 1}/${execution.steps.length}: ${execution.steps[execution.currentStep].description}
Error: ${failedResult.error}
Output so far: ${execution.output.substring(0, 1000)}

Respond with ONLY "continue" or "abort".`;

    let responseText = "";
    const unsubscribe = this.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        (event as any).assistantMessageEvent?.type === "text_delta"
      ) {
        responseText += (event as any).assistantMessageEvent.delta;
      }
    });

    await this.session.prompt(prompt);
    unsubscribe();

    return responseText.toLowerCase().includes("continue");
  }

  private parseSkillPlan(text: string): SkillStep[] {
    try {
      let jsonStr = text.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();

      const arrayStart = jsonStr.indexOf("[");
      const arrayEnd = jsonStr.lastIndexOf("]");
      if (arrayStart !== -1 && arrayEnd !== -1) {
        jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);
      }

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];

      return parsed.map((item: any, index: number) => ({
        index,
        description: item.description ?? `Step ${index + 1}`,
        action: {
          kind: "primitive" as const,
          type: item.action?.type ?? "bash",
          description: item.action?.description ?? item.description ?? "",
          params: item.action?.params ?? {},
        },
      }));
    } catch (error) {
      console.error("Failed to parse skill plan:", error);
      return [];
    }
  }

  // ── Tool Execution ───────────────────────────────────────

  private async executeBash(command: string): Promise<string> {
    const { execSync } = await import("child_process");
    try {
      return execSync(command, {
        encoding: "utf-8", cwd: this.config.workDir,
        timeout: 60000, maxBuffer: 1024 * 1024,
      });
    } catch (error: any) {
      return error.stdout || error.stderr || error.message;
    }
  }

  private async executeRead(path: string): Promise<string> {
    const fullPath = path.startsWith("/") ? path : join(this.config.workDir, path);
    return readFile(fullPath, "utf-8");
  }

  private async executeWrite(path: string, content: string): Promise<void> {
    const fullPath = path.startsWith("/") ? path : join(this.config.workDir, path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content);
  }

  private async executeEdit(path: string, oldText: string, newText: string): Promise<void> {
    const fullPath = path.startsWith("/") ? path : join(this.config.workDir, path);
    const content = await readFile(fullPath, "utf-8");
    if (!content.includes(oldText)) throw new Error(`Text not found in ${path}`);
    await writeFile(fullPath, content.replace(oldText, newText));
  }

  // ── Search Tools ───────────────────────────────────────────

  private async executeGrep(
    pattern: string,
    path?: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    const target = path
      ? (path.startsWith("/") ? path : join(this.config.workDir, path))
      : this.config.workDir;
    const flags: string[] = ["-rn"];
    if (options?.ignoreCase) flags.push("-i");
    if (options?.maxCount) flags.push(`-m ${options.maxCount}`);
    if (options?.include) flags.push(`--include="${options.include}"`);
    if (options?.exclude) flags.push(`--exclude="${options.exclude}"`);
    if (options?.context) flags.push(`-C ${options.context}`);
    const cmd = `grep ${flags.join(" ")} "${pattern.replace(/"/g, '\\"')}" ${target}`;
    return this.executeBash(cmd);
  }

  private async executeFind(
    path?: string,
    pattern?: string,
    type?: string,
    maxDepth?: number,
  ): Promise<string> {
    const target = path
      ? (path.startsWith("/") ? path : join(this.config.workDir, path))
      : this.config.workDir;
    const parts = ["find", target];
    if (maxDepth != null) parts.push(`-maxdepth ${maxDepth}`);
    if (type) parts.push(`-type ${type}`);
    if (pattern) parts.push(`-name "${pattern.replace(/"/g, '\\"')}"`);
    parts.push("| head -100");
    return this.executeBash(parts.join(" "));
  }

  private async executeLs(
    path?: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    const target = path
      ? (path.startsWith("/") ? path : join(this.config.workDir, path))
      : this.config.workDir;
    const flags: string[] = ["-la"];
    if (options?.recursive) flags.push("-R");
    if (options?.humanReadable) flags.push("-h");
    return this.executeBash(`ls ${flags.join(" ")} ${target}`);
  }

  // ── Agent Control ─────────────────────────────────────────

  /**
   * Delegate a task to a child agent.
   * In SingleAgent this is a stub — real delegation happens in ExecutiveAgent.
   * Here we log the intent so the pattern is established.
   */
  private async executeDelegate(params: Record<string, unknown>): Promise<string> {
    const taskDescription = params.description as string ?? "(no description)";
    const targetAgent = params.targetAgent as string ?? "worker";
    const priority = params.priority as number ?? 5;

    // Store delegation intent in memory for future ExecutiveAgent implementation
    const delegations = JSON.parse(this.memory["_delegations"] ?? "[]");
    delegations.push({
      targetAgent,
      description: taskDescription,
      priority,
      timestamp: Date.now(),
      status: "pending",
    });
    this.memory["_delegations"] = JSON.stringify(delegations);
    await this.saveMemory();

    return `Delegation queued: [${targetAgent}] ${taskDescription} (priority: ${priority}). ` +
      `Note: SingleAgent cannot spawn children — delegation will be fulfilled by ExecutiveAgent.`;
  }

  /**
   * Send a message to another agent (parent, child, or sibling).
   * In SingleAgent this writes to a message queue file.
   */
  private async executeMessage(params: Record<string, unknown>): Promise<string> {
    const to = params.to as string ?? "parent";
    const content = params.content as string ?? "";
    const channel = params.channel as string ?? "default";

    const messages = JSON.parse(this.memory["_outbox"] ?? "[]");
    messages.push({
      to,
      channel,
      content,
      from: this.config.agentId,
      timestamp: Date.now(),
    });
    this.memory["_outbox"] = JSON.stringify(messages);
    await this.saveMemory();

    return `Message sent to ${to} on channel ${channel}: "${content.substring(0, 100)}"`;
  }

  // ── Memory Persistence ───────────────────────────────────

  private async loadMemory(): Promise<void> {
    const memFile = join(this.config.workDir, "memory", "state.json");
    if (existsSync(memFile)) {
      try { this.memory = JSON.parse(readFileSync(memFile, "utf-8")); } catch { this.memory = {}; }
    }
  }

  private async saveMemory(): Promise<void> {
    const memFile = join(this.config.workDir, "memory", "state.json");
    await writeFile(memFile, JSON.stringify(this.memory, null, 2));
  }

  private async saveHistory(): Promise<void> {
    const histFile = join(this.config.workDir, "history", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(histFile, JSON.stringify(this.actionHistory, null, 2));
  }

  // ── Prompt Construction ──────────────────────────────────

  private buildSystemPrompt(): string {
    return this.agentConfig.systemPrompt ?? `You are an autonomous agent operating in a structured decision loop.

Each heartbeat, you receive the current state and must respond with a JSON array of scored actions.

## Response Format

You MUST respond with ONLY a JSON array. No other text. Each element:

\`\`\`json
[
  {
    "action": {
      "kind": "primitive",
      "type": "bash|read|write|edit|update_memory|complete|wait",
      "description": "What this action does and why",
      "params": { ... }
    },
    "value": 0.0 to 1.0,
    "reasoning": "Why this score"
  }
]
\`\`\`

## Primitive Action Types

### File I/O (pi tools)
- **bash**: \`{ "command": "..." }\` — Run a shell command
- **read**: \`{ "path": "..." }\` — Read a file
- **write**: \`{ "path": "...", "content": "..." }\` — Write/create a file
- **edit**: \`{ "path": "...", "oldText": "...", "newText": "..." }\` — Edit a file

### Search (structured queries — prefer these over shell one-liners)
- **grep**: \`{ "pattern": "...", "path": "...", "options": { "ignoreCase": true, "include": "*.ts", "context": 3 } }\` — Search file contents
- **find**: \`{ "path": "...", "pattern": "*.ts", "type": "f", "maxDepth": 3 }\` — Find files
- **ls**: \`{ "path": "...", "options": { "recursive": true } }\` — List directory

### Agent Control
- **update_memory**: \`{ "key": "...", "value": "..." }\` — Persist to working memory
- **delegate**: \`{ "description": "...", "targetAgent": "worker", "priority": 5 }\` — Assign task to child
- **message**: \`{ "to": "parent|child-id", "content": "...", "channel": "default" }\` — Send inter-agent message
- **complete**: \`{ "summary": "..." }\` — Mark task as done
- **wait**: \`{}\` — Do nothing this heartbeat

## Skill Actions

Skills are multi-step sequences. To invoke a skill:

\`\`\`json
{
  "action": {
    "kind": "skill",
    "type": "skill",
    "skillName": "name-of-skill",
    "goal": "What you want the skill to accomplish",
    "description": "Why you're invoking this skill",
    "params": {}
  },
  "value": 0.0 to 1.0,
  "reasoning": "Why this skill at this value"
}
\`\`\`

When you select a skill, you'll be asked to plan the concrete steps. The steps then execute sequentially.
Use skills when the task calls for a coherent multi-step workflow rather than individual commands.

## Scoring Guidelines

- 1.0 = Critically important, do this now
- 0.7-0.9 = High value, directly advances the task
- 0.4-0.6 = Moderate value, useful but not urgent
- 0.1-0.3 = Low value, minor or speculative
- 0.0 = No value

Propose 1-5 candidate actions (primitive or skill). Score them honestly.`;
  }

  private buildEvaluatePrompt(state: State): string {
    const parts: string[] = [];

    parts.push(`## Current State (Heartbeat #${this.heartbeatCount})`);
    parts.push(`Time: ${new Date(state.timestamp).toISOString()}`);

    if (state.currentTask) {
      parts.push(`\n## Task`);
      parts.push(`Description: ${state.currentTask.description}`);
      parts.push(`Success Criteria:`);
      for (const c of state.currentTask.successCriteria) parts.push(`  - ${c}`);
      if (state.currentTask.constraints.length > 0) {
        parts.push(`Constraints:`);
        for (const c of state.currentTask.constraints) parts.push(`  - ${c}`);
      }
    }

    // Show available skills
    if (state.availableSkills.length > 0) {
      parts.push(`\n## Available Skills`);
      for (const skill of state.availableSkills) {
        parts.push(`- **${skill.name}**: ${skill.description}`);
      }
      parts.push(`\nInvoke a skill when a coherent multi-step workflow is more appropriate than a single command.`);
    }

    if (Object.keys(state.memory).length > 0) {
      parts.push(`\n## Memory`);
      for (const [key, value] of Object.entries(state.memory)) parts.push(`${key}: ${value}`);
    }

    if (state.inputs.length > 0) {
      parts.push(`\n## Pending Inputs`);
      for (const input of state.inputs) parts.push(`[${input.source}] ${input.content}`);
    }

    if (state.lastActionResult) {
      parts.push(`\n## Last Action Result`);
      const r = state.lastActionResult;
      parts.push(`Action: ${r.action.kind === "skill" ? `skill:${(r.action as SkillAction).skillName}` : r.action.type} — ${r.action.description}`);
      parts.push(`Success: ${r.success}`);
      parts.push(`Output: ${r.output.substring(0, 2000)}`);
      if (r.error) parts.push(`Error: ${r.error}`);
      if (r.skillTrace) {
        parts.push(`Skill steps completed: ${r.skillTrace.currentStep + 1}/${r.skillTrace.steps.length}`);
      }
    }

    if (state.observations["workspace_files"]) {
      parts.push(`\n## Workspace Files`);
      parts.push(state.observations["workspace_files"] as string);
    }

    parts.push(`\n## Instructions`);
    parts.push(`Propose 1-5 candidate actions (primitive or skill) as a JSON array. Score each by value.`);

    return parts.join("\n");
  }

  // ── Response Parsing ─────────────────────────────────────

  private parseEvaluateResponse(text: string): ScoredAction[] {
    try {
      let jsonStr = text.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();

      const arrayStart = jsonStr.indexOf("[");
      const arrayEnd = jsonStr.lastIndexOf("]");
      if (arrayStart !== -1 && arrayEnd !== -1) jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [parsed as ScoredAction];

      return parsed.map((item: any) => {
        const actionData = item.action ?? {};
        const kind = actionData.kind ?? "primitive";

        let action: Action;
        if (kind === "skill") {
          action = {
            kind: "skill",
            type: "skill",
            skillName: actionData.skillName ?? "",
            goal: actionData.goal ?? actionData.description ?? "",
            description: actionData.description ?? "",
            params: actionData.params ?? {},
          };
        } else {
          action = {
            kind: "primitive",
            type: actionData.type ?? "wait",
            description: actionData.description ?? "",
            params: actionData.params ?? {},
          };
        }

        return {
          action,
          value: typeof item.value === "number" ? item.value : 0.5,
          reasoning: item.reasoning ?? "",
        };
      });
    } catch (error) {
      console.error("Failed to parse LLM evaluate response:", error);
      return [{
        action: { kind: "primitive", type: "wait", description: "Parse failure fallback", params: {} },
        value: 0.1,
        reasoning: `Could not parse LLM response: ${error}`,
      }];
    }
  }

  // ── Public API ───────────────────────────────────────────

  addInput(input: Input): void { this.inputs.push(input); }
  setTask(task: TaskBrief): void { this.task = task; }
  getHistory(): ActionResult[] { return [...this.actionHistory]; }
  getMemory(): Record<string, string> { return { ...this.memory }; }
  getSkills(): SkillDescriptor[] { return [...this.skills]; }
}
