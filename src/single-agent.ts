/**
 * SingleAgent — A concrete AgentLoop that uses pi's SDK for all four phases.
 *
 * This is the "proof of heartbeat" — one agent running the full
 * Observe → Evaluate → Select → Act loop with an LLM.
 *
 * The LLM is used in the EVALUATE phase (structured output to score actions).
 * The SELECT phase is a deterministic policy function.
 * The ACT phase uses pi's tools (bash, read, write, edit).
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
import { existsSync, readFileSync, mkdirSync } from "fs";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { AgentLoop } from "./agent-loop.js";
import type {
  Action,
  ActionResult,
  AgentLoopConfig,
  Input,
  ScoredAction,
  State,
  TaskBrief,
} from "./types.js";

// ── Action Types ─────────────────────────────────────────

const ACTION_TYPES = {
  /** Execute a bash command */
  BASH: "bash",
  /** Read a file */
  READ: "read",
  /** Write a file */
  WRITE: "write",
  /** Edit a file */
  EDIT: "edit",
  /** Update working memory */
  UPDATE_MEMORY: "update_memory",
  /** Report task complete */
  COMPLETE: "complete",
  /** Do nothing this heartbeat */
  WAIT: "wait",
} as const;

// ── Configuration ────────────────────────────────────────

export interface SingleAgentConfig extends AgentLoopConfig {
  /** Anthropic API key (or set ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  /** Model to use */
  model?: string;
  /** Initial task to work on */
  task?: TaskBrief;
  /** System prompt override */
  systemPrompt?: string;
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

  constructor(config: SingleAgentConfig) {
    super(config);
    this.agentConfig = config;
    this.task = config.task ?? null;
  }

  // ── Setup / Teardown ─────────────────────────────────────

  protected async setup(): Promise<void> {
    const { workDir } = this.config;
    await mkdir(workDir, { recursive: true });
    await mkdir(join(workDir, "memory"), { recursive: true });
    await mkdir(join(workDir, "history"), { recursive: true });

    // Load persisted memory
    await this.loadMemory();

    // Initialize pi SDK components
    const authStorage = AuthStorage.create(join(workDir, "auth.json"));
    const apiKey = this.agentConfig.apiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      authStorage.setRuntimeApiKey("anthropic", apiKey);
    }

    const modelRegistry = new ModelRegistry(authStorage);
    const modelId = this.agentConfig.model ?? "claude-sonnet-4-20250514";
    const model = getModel("anthropic", modelId as any);
    if (!model) throw new Error(`Model not found: ${modelId}`);

    const cwd = workDir;

    // Build the system prompt for the evaluate phase
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
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools,
      },
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
  }

  // ── Phase 1: OBSERVE ─────────────────────────────────────

  protected async observe(): Promise<State> {
    // Refresh memory from disk
    await this.loadMemory();

    // Gather workspace state
    const observations: Record<string, unknown> = {};

    // List files in workDir for awareness
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

    // Drain pending inputs
    const inputs = [...this.inputs];
    this.inputs = [];

    return {
      timestamp: Date.now(),
      agentId: this.config.agentId,
      currentTask: this.task,
      memory: { ...this.memory },
      children: [], // SingleAgent has no children
      inputs,
      lastActionResult: this.lastResult,
      observations,
    };
  }

  // ── Phase 2: EVALUATE ────────────────────────────────────

  protected async evaluate(state: State): Promise<ScoredAction[]> {
    if (!this.session) throw new Error("Session not initialized");

    // Build a structured prompt asking the LLM to propose and score actions
    const prompt = this.buildEvaluatePrompt(state);

    // Collect the LLM's response
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

    // Parse the structured response into scored actions
    return this.parseEvaluateResponse(responseText);
  }

  // ── Phase 3: SELECT ──────────────────────────────────────

  protected select(scoredActions: ScoredAction[]): Action {
    // Greedy policy: pick highest-valued action
    // This is deliberately simple and deterministic.
    // Future: epsilon-greedy, UCB, constraint-based filtering, etc.

    if (scoredActions.length === 0) {
      return {
        type: ACTION_TYPES.WAIT,
        description: "No actions available",
        params: {},
      };
    }

    // Sort by value descending
    const sorted = [...scoredActions].sort((a, b) => b.value - a.value);

    // Safety filter: remove actions that violate constraints
    const task = this.task;
    if (task?.constraints.length) {
      // TODO: constraint checking
    }

    return sorted[0].action;
  }

  // ── Phase 4: ACT ─────────────────────────────────────────

  protected async act(action: Action): Promise<ActionResult> {
    const startTime = Date.now();

    try {
      let output: string;

      switch (action.type) {
        case ACTION_TYPES.BASH:
          output = await this.executeBash(action.params.command as string);
          break;

        case ACTION_TYPES.READ:
          output = await this.executeRead(action.params.path as string);
          break;

        case ACTION_TYPES.WRITE:
          await this.executeWrite(
            action.params.path as string,
            action.params.content as string,
          );
          output = `Wrote ${action.params.path}`;
          break;

        case ACTION_TYPES.EDIT:
          await this.executeEdit(
            action.params.path as string,
            action.params.oldText as string,
            action.params.newText as string,
          );
          output = `Edited ${action.params.path}`;
          break;

        case ACTION_TYPES.UPDATE_MEMORY:
          this.memory[action.params.key as string] = action.params.value as string;
          await this.saveMemory();
          output = `Updated memory key: ${action.params.key}`;
          break;

        case ACTION_TYPES.COMPLETE:
          this.stop();
          output = `Task completed: ${action.params.summary ?? "done"}`;
          break;

        case ACTION_TYPES.WAIT:
          output = "Waiting...";
          break;

        default:
          output = `Unknown action type: ${action.type}`;
      }

      const result: ActionResult = {
        action,
        success: true,
        output,
        artifacts: [],
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      };

      this.actionHistory.push(result);
      return result;

    } catch (error) {
      const result: ActionResult = {
        action,
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        artifacts: [],
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      };

      this.actionHistory.push(result);
      return result;
    }
  }

  // ── Tool Execution ───────────────────────────────────────

  private async executeBash(command: string): Promise<string> {
    const { execSync } = await import("child_process");
    try {
      return execSync(command, {
        encoding: "utf-8",
        cwd: this.config.workDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
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

  private async executeEdit(
    path: string,
    oldText: string,
    newText: string,
  ): Promise<void> {
    const fullPath = path.startsWith("/") ? path : join(this.config.workDir, path);
    const content = await readFile(fullPath, "utf-8");
    if (!content.includes(oldText)) {
      throw new Error(`Text not found in ${path}`);
    }
    await writeFile(fullPath, content.replace(oldText, newText));
  }

  // ── Memory Persistence ───────────────────────────────────

  private async loadMemory(): Promise<void> {
    const memFile = join(this.config.workDir, "memory", "state.json");
    if (existsSync(memFile)) {
      try {
        this.memory = JSON.parse(readFileSync(memFile, "utf-8"));
      } catch {
        this.memory = {};
      }
    }
  }

  private async saveMemory(): Promise<void> {
    const memFile = join(this.config.workDir, "memory", "state.json");
    await writeFile(memFile, JSON.stringify(this.memory, null, 2));
  }

  private async saveHistory(): Promise<void> {
    const histFile = join(
      this.config.workDir,
      "history",
      `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
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
      "type": "bash|read|write|edit|update_memory|complete|wait",
      "description": "What this action does and why",
      "params": { ... }
    },
    "value": 0.0 to 1.0,
    "reasoning": "Why this score"
  }
]
\`\`\`

## Action Types

- **bash**: \`{ "command": "..." }\` — Run a shell command
- **read**: \`{ "path": "..." }\` — Read a file
- **write**: \`{ "path": "...", "content": "..." }\` — Write/create a file
- **edit**: \`{ "path": "...", "oldText": "...", "newText": "..." }\` — Edit a file
- **update_memory**: \`{ "key": "...", "value": "..." }\` — Persist something to memory
- **complete**: \`{ "summary": "..." }\` — Mark task as done
- **wait**: \`{}\` — Do nothing this heartbeat

## Scoring Guidelines

- 1.0 = Critically important, do this now
- 0.7-0.9 = High value, directly advances the task
- 0.4-0.6 = Moderate value, useful but not urgent
- 0.1-0.3 = Low value, minor or speculative
- 0.0 = No value

Propose 1-5 candidate actions. Score them honestly.`;
  }

  private buildEvaluatePrompt(state: State): string {
    const parts: string[] = [];

    parts.push(`## Current State (Heartbeat #${this.heartbeatCount})`);
    parts.push(`Time: ${new Date(state.timestamp).toISOString()}`);

    if (state.currentTask) {
      parts.push(`\n## Task`);
      parts.push(`Description: ${state.currentTask.description}`);
      parts.push(`Success Criteria:`);
      for (const c of state.currentTask.successCriteria) {
        parts.push(`  - ${c}`);
      }
      if (state.currentTask.constraints.length > 0) {
        parts.push(`Constraints:`);
        for (const c of state.currentTask.constraints) {
          parts.push(`  - ${c}`);
        }
      }
    }

    if (Object.keys(state.memory).length > 0) {
      parts.push(`\n## Memory`);
      for (const [key, value] of Object.entries(state.memory)) {
        parts.push(`${key}: ${value}`);
      }
    }

    if (state.inputs.length > 0) {
      parts.push(`\n## Pending Inputs`);
      for (const input of state.inputs) {
        parts.push(`[${input.source}] ${input.content}`);
      }
    }

    if (state.lastActionResult) {
      parts.push(`\n## Last Action Result`);
      parts.push(`Action: ${state.lastActionResult.action.type} — ${state.lastActionResult.action.description}`);
      parts.push(`Success: ${state.lastActionResult.success}`);
      parts.push(`Output: ${state.lastActionResult.output.substring(0, 2000)}`);
      if (state.lastActionResult.error) {
        parts.push(`Error: ${state.lastActionResult.error}`);
      }
    }

    if (state.observations["workspace_files"]) {
      parts.push(`\n## Workspace Files`);
      parts.push(state.observations["workspace_files"] as string);
    }

    parts.push(`\n## Instructions`);
    parts.push(`Propose 1-5 candidate actions as a JSON array. Score each by value.`);

    return parts.join("\n");
  }

  // ── Response Parsing ─────────────────────────────────────

  private parseEvaluateResponse(text: string): ScoredAction[] {
    try {
      // Try to extract JSON from the response
      // The LLM might wrap it in markdown code blocks
      let jsonStr = text.trim();

      // Strip markdown code fences
      const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      // Find JSON array
      const arrayStart = jsonStr.indexOf("[");
      const arrayEnd = jsonStr.lastIndexOf("]");
      if (arrayStart !== -1 && arrayEnd !== -1) {
        jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);
      }

      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        console.warn("LLM response is not an array, wrapping");
        return [parsed as ScoredAction];
      }

      return parsed.map((item: any) => ({
        action: {
          type: item.action?.type ?? "wait",
          description: item.action?.description ?? "",
          params: item.action?.params ?? {},
        },
        value: typeof item.value === "number" ? item.value : 0.5,
        reasoning: item.reasoning ?? "",
      }));
    } catch (error) {
      console.error("Failed to parse LLM evaluate response:", error);
      console.error("Raw response:", text.substring(0, 500));

      // Fallback: wait action
      return [
        {
          action: {
            type: "wait",
            description: "Parse failure fallback",
            params: {},
          },
          value: 0.1,
          reasoning: `Could not parse LLM response: ${error}`,
        },
      ];
    }
  }

  // ── Public API ───────────────────────────────────────────

  /** Add an input for the agent to process on next heartbeat */
  addInput(input: Input): void {
    this.inputs.push(input);
  }

  /** Set or update the current task */
  setTask(task: TaskBrief): void {
    this.task = task;
  }

  /** Get the action history */
  getHistory(): ActionResult[] {
    return [...this.actionHistory];
  }

  /** Get current memory */
  getMemory(): Record<string, string> {
    return { ...this.memory };
  }
}
