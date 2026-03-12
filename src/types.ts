/**
 * Core types for the Agent Loop system.
 *
 * The loop follows an RL-inspired heartbeat:
 *   Observe → Evaluate → Select → Act → (repeat)
 *
 * Actions come in two forms:
 *   - Primitive: a single atomic step (one bash command, one file read)
 *   - Skill: a temporally extended sequence that runs to completion
 *     (the "options" framework from Sutton, Precup & Singh 1999)
 */

/** Unique identifier for an agent instance */
export type AgentId = string;

/** Unique identifier for a task */
export type TaskId = string;

// ── Skills ───────────────────────────────────────────────

/** A discovered skill the agent can invoke */
export interface SkillDescriptor {
  /** Skill name (matches directory name) */
  name: string;
  /** What this skill does — drives evaluate scoring */
  description: string;
  /** Path to the SKILL.md file */
  skillPath: string;
  /** Base directory containing the skill's scripts/assets */
  baseDir: string;
  /** Full instructions (loaded on demand) */
  instructions?: string;
}

/** A single step within a skill execution sequence */
export interface SkillStep {
  /** Step index (0-based) */
  index: number;
  /** What this step does */
  description: string;
  /** The primitive action to execute */
  action: PrimitiveAction;
  /** Output from execution */
  result?: ActionResult;
}

/** Status of a skill that's currently executing */
export interface SkillExecution {
  /** Which skill is running */
  skill: SkillDescriptor;
  /** The goal/intent for this invocation */
  goal: string;
  /** Planned steps (may grow as execution reveals more work) */
  steps: SkillStep[];
  /** Index of the current step being executed */
  currentStep: number;
  /** Whether the skill sequence is complete */
  complete: boolean;
  /** Whether the skill sequence failed */
  failed: boolean;
  /** Accumulated output from all steps */
  output: string;
  /** Files created/modified during execution */
  artifacts: string[];
}

// ── Actions ──────────────────────────────────────────────

/** A primitive (atomic) action — one step, one heartbeat */
export interface PrimitiveAction {
  kind: "primitive";
  type: string;
  description: string;
  params: Record<string, unknown>;
}

/** A skill action — a coherent sequence that may span multiple sub-steps */
export interface SkillAction {
  kind: "skill";
  type: "skill";
  /** Which skill to invoke */
  skillName: string;
  /** The goal for this skill invocation */
  goal: string;
  description: string;
  params: Record<string, unknown>;
}

/** An action is either primitive or a skill invocation */
export type Action = PrimitiveAction | SkillAction;

/** A candidate action with an estimated value */
export interface ScoredAction {
  action: Action;
  /** Estimated value/utility of taking this action (higher = better) */
  value: number;
  /** LLM's reasoning for this score */
  reasoning: string;
}

/** Result of executing an action (primitive or full skill) */
export interface ActionResult {
  action: Action;
  success: boolean;
  output: string;
  artifacts: string[];
  error?: string;
  durationMs: number;
  timestamp: number;
  /** If this was a skill, the full execution trace */
  skillTrace?: SkillExecution;
}

// ── State ────────────────────────────────────────────────

/** The observed state of the world at a given heartbeat */
export interface State {
  /** When this observation was taken */
  timestamp: number;
  /** The agent observing */
  agentId: AgentId;
  /** Current task being worked on, if any */
  currentTask: TaskBrief | null;
  /** Contents of workspace memory */
  memory: Record<string, string>;
  /** Status of any child agents (for executive agents) */
  children: ChildStatus[];
  /** Pending inputs (messages, events, signals) */
  inputs: Input[];
  /** Results from the last action taken */
  lastActionResult: ActionResult | null;
  /** Available skills the agent can invoke */
  availableSkills: SkillDescriptor[];
  /** Currently executing skill (if mid-sequence) */
  activeSkill: SkillExecution | null;
  /** Arbitrary key-value observations (extensible) */
  observations: Record<string, unknown>;
}

/** A task brief passed from executive to worker */
export interface TaskBrief {
  taskId: TaskId;
  /** Human-readable description of what to do */
  description: string;
  /** Success criteria - how do we know it's done? */
  successCriteria: string[];
  /** Constraints on execution */
  constraints: string[];
  /** Context the executive wants the worker to have */
  context: Record<string, unknown>;
  /** Maximum heartbeats before timeout */
  maxHeartbeats?: number;
  /** Priority: higher = more important */
  priority: number;
}

/** Status of a child worker agent */
export interface ChildStatus {
  agentId: AgentId;
  taskId: TaskId;
  status: "idle" | "running" | "done" | "failed" | "blocked";
  progress: number;
  artifacts: string[];
  blockers: string[];
  heartbeatCount: number;
  lastUpdate: number;
}

/** An input event to be processed */
export interface Input {
  source: string;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

// ── Config ───────────────────────────────────────────────

/** Configuration for an agent loop */
export interface AgentLoopConfig {
  /** Unique ID for this agent */
  agentId: AgentId;
  /** Working directory for this agent's state */
  workDir: string;
  /** Milliseconds between heartbeats (0 = run as fast as possible) */
  heartbeatIntervalMs: number;
  /** Maximum consecutive heartbeats before forced pause */
  maxHeartbeats: number;
  /** Whether to persist state between runs */
  persistState: boolean;
  /** Directories to scan for skills */
  skillDirs?: string[];
}

// ── Impasse Tracking ─────────────────────────────────────

/** Context for policy evaluation and impasse detection */
export interface LoopContext {
  heartbeat: number;
  consecutiveFailures: number;
  repeatedActionCount: number;
  noProgressHeartbeats: number;
  lastActionType: string | null;
  recentActions: Array<{ type: string; timestamp: number; success: boolean }>;
  topCandidateValue: number;
}

// ── Events ───────────────────────────────────────────────

/** Events emitted by the agent loop for observability */
export type LoopEvent =
  | { type: "heartbeat_start"; heartbeat: number; timestamp: number }
  | { type: "observe_complete"; state: State; board: string; timestamp: number }
  | { type: "evaluate_complete"; scoredActions: ScoredAction[]; timestamp: number }
  | { type: "select_complete"; selected: Action; policyLog?: unknown[]; timestamp: number }
  | { type: "act_complete"; result: ActionResult; timestamp: number }
  | { type: "skill_step_start"; skill: string; step: number; description: string; timestamp: number }
  | { type: "skill_step_end"; skill: string; step: number; success: boolean; timestamp: number }
  | { type: "skill_complete"; skill: string; success: boolean; steps: number; timestamp: number }
  | { type: "memory_write"; store: string; key: string; timestamp: number }
  | { type: "impasse_detected"; impasseType: string; message: string; timestamp: number }
  | { type: "heartbeat_end"; heartbeat: number; timestamp: number }
  | { type: "loop_paused"; reason: string; timestamp: number }
  | { type: "loop_error"; error: string; heartbeat: number; timestamp: number };

export type LoopEventListener = (event: LoopEvent) => void;
