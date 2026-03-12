/**
 * Core types for the Agent Loop system.
 * 
 * The loop follows an RL-inspired heartbeat:
 *   Observe → Evaluate → Select → Act → (repeat)
 */

/** Unique identifier for an agent instance */
export type AgentId = string;

/** Unique identifier for a task */
export type TaskId = string;

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
  progress: number; // 0.0 - 1.0
  artifacts: string[]; // file paths or identifiers
  blockers: string[];
  heartbeatCount: number;
  lastUpdate: number;
}

/** An input event to be processed */
export interface Input {
  source: string; // "slack", "api", "event", "child_report", etc.
  content: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

/** A candidate action with an estimated value */
export interface ScoredAction {
  action: Action;
  /** Estimated value/utility of taking this action (higher = better) */
  value: number;
  /** LLM's reasoning for this score */
  reasoning: string;
}

/** An action the agent can take */
export interface Action {
  type: string;
  /** Human-readable description of what this action does */
  description: string;
  /** Parameters for the action */
  params: Record<string, unknown>;
}

/** Result of executing an action */
export interface ActionResult {
  action: Action;
  success: boolean;
  output: string;
  artifacts: string[]; // files created/modified
  error?: string;
  durationMs: number;
  timestamp: number;
}

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
}

/** Events emitted by the agent loop for observability */
export type LoopEvent =
  | { type: "heartbeat_start"; heartbeat: number; timestamp: number }
  | { type: "observe_complete"; state: State; timestamp: number }
  | { type: "evaluate_complete"; scoredActions: ScoredAction[]; timestamp: number }
  | { type: "select_complete"; selected: Action; timestamp: number }
  | { type: "act_complete"; result: ActionResult; timestamp: number }
  | { type: "heartbeat_end"; heartbeat: number; timestamp: number }
  | { type: "loop_paused"; reason: string; timestamp: number }
  | { type: "loop_error"; error: string; heartbeat: number; timestamp: number };

export type LoopEventListener = (event: LoopEvent) => void;
