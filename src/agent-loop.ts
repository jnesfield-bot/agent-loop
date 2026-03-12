/**
 * Abstract AgentLoop base class.
 * 
 * Implements the RL-inspired heartbeat:
 *   Observe → Evaluate → Select → Act → (repeat)
 * 
 * Subclasses implement the four phases. This becomes the parent class
 * for both ExecutiveAgent and WorkerAgent.
 */

import type {
  Action,
  ActionResult,
  AgentLoopConfig,
  LoopEvent,
  LoopEventListener,
  ScoredAction,
  State,
} from "./types.js";

export abstract class AgentLoop {
  protected config: AgentLoopConfig;
  protected heartbeatCount = 0;
  protected running = false;
  protected aborted = false;
  protected lastState: State | null = null;
  protected lastResult: ActionResult | null = null;
  private listeners: LoopEventListener[] = [];

  constructor(config: AgentLoopConfig) {
    this.config = config;
  }

  // ── The Four Phases (implement in subclasses) ──────────────

  /** Phase 1: Gather current state of the world */
  protected abstract observe(): Promise<State>;

  /** Phase 2: Given state, score candidate actions (LLM call) */
  protected abstract evaluate(state: State): Promise<ScoredAction[]>;

  /** Phase 3: Pick the best action according to policy */
  protected abstract select(scoredActions: ScoredAction[]): Action;

  /** Phase 4: Execute the chosen action */
  protected abstract act(action: Action): Promise<ActionResult>;

  // ── Lifecycle hooks (optional overrides) ───────────────────

  /** Called before the loop starts. Set up resources. */
  protected async setup(): Promise<void> {}

  /** Called after the loop ends. Clean up resources. */
  protected async teardown(): Promise<void> {}

  /** Called at the start of each heartbeat. Return false to skip this beat. */
  protected async shouldBeat(): Promise<boolean> {
    return true;
  }

  /** Called when the loop encounters an error. Return true to continue. */
  protected async onError(error: Error, heartbeat: number): Promise<boolean> {
    this.emit({
      type: "loop_error",
      error: error.message,
      heartbeat,
      timestamp: Date.now(),
    });
    return false; // stop by default
  }

  // ── The Heartbeat ──────────────────────────────────────────

  /** Execute a single heartbeat: Observe → Evaluate → Select → Act */
  async tick(): Promise<ActionResult | null> {
    if (this.aborted) return null;

    this.heartbeatCount++;
    this.emit({
      type: "heartbeat_start",
      heartbeat: this.heartbeatCount,
      timestamp: Date.now(),
    });

    try {
      // 1. OBSERVE
      const state = await this.observe();
      state.lastActionResult = this.lastResult;
      this.lastState = state;
      this.emit({ type: "observe_complete", state, timestamp: Date.now() });

      // 2. EVALUATE
      const scoredActions = await this.evaluate(state);
      this.emit({
        type: "evaluate_complete",
        scoredActions,
        timestamp: Date.now(),
      });

      // If no actions to take, skip
      if (scoredActions.length === 0) {
        this.emit({
          type: "heartbeat_end",
          heartbeat: this.heartbeatCount,
          timestamp: Date.now(),
        });
        return null;
      }

      // 3. SELECT
      const action = this.select(scoredActions);
      this.emit({ type: "select_complete", selected: action, timestamp: Date.now() });

      // 4. ACT
      const result = await this.act(action);
      this.lastResult = result;
      this.emit({ type: "act_complete", result, timestamp: Date.now() });

      this.emit({
        type: "heartbeat_end",
        heartbeat: this.heartbeatCount,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      const shouldContinue = await this.onError(
        error instanceof Error ? error : new Error(String(error)),
        this.heartbeatCount,
      );
      if (!shouldContinue) {
        this.running = false;
      }
      return null;
    }
  }

  /** Run the loop continuously until stopped or max heartbeats reached */
  async run(): Promise<void> {
    this.running = true;
    this.aborted = false;
    this.heartbeatCount = 0;

    await this.setup();

    try {
      while (this.running && !this.aborted) {
        // Check max heartbeats
        if (this.heartbeatCount >= this.config.maxHeartbeats) {
          this.emit({
            type: "loop_paused",
            reason: `Max heartbeats reached (${this.config.maxHeartbeats})`,
            timestamp: Date.now(),
          });
          break;
        }

        // Check if we should beat
        if (!(await this.shouldBeat())) {
          // Wait before checking again
          if (this.config.heartbeatIntervalMs > 0) {
            await this.sleep(this.config.heartbeatIntervalMs);
          }
          continue;
        }

        // Execute one heartbeat
        await this.tick();

        // Wait between heartbeats
        if (this.running && this.config.heartbeatIntervalMs > 0) {
          await this.sleep(this.config.heartbeatIntervalMs);
        }
      }
    } finally {
      this.running = false;
      await this.teardown();
    }
  }

  /** Stop the loop gracefully after the current heartbeat completes */
  stop(): void {
    this.running = false;
  }

  /** Abort the loop immediately */
  abort(): void {
    this.aborted = true;
    this.running = false;
  }

  // ── Event System ───────────────────────────────────────────

  subscribe(listener: LoopEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  protected emit(event: LoopEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the loop
      }
    }
  }

  // ── Utilities ──────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow abort to break sleep
      const check = setInterval(() => {
        if (this.aborted) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentHeartbeat(): number {
    return this.heartbeatCount;
  }

  get id(): string {
    return this.config.agentId;
  }
}
