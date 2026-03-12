# Agent Loop

An RL-inspired autonomous agent framework built on the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) SDK. Instead of free-running LLM conversations, the agent operates in a deterministic **heartbeat loop**: Observe → Evaluate → Select → Act → Repeat.

## Motivation

Most LLM agent frameworks let the model free-run — it thinks, calls tools, thinks again, calls more tools — until it decides it's done. This works, but it's a black box. You can't inspect the decision boundary, you can't swap the policy, and you can't audit why it chose action A over action B.

This project imposes structure. Every heartbeat, the agent:

1. **Observes** the current state of the world
2. **Evaluates** candidate actions by asking the LLM to score them
3. **Selects** the best action via a deterministic policy function
4. **Acts** by executing that single action

The key insight is the **separation between evaluation and selection**. The LLM proposes and scores. A policy function — which you control — decides. This gives you a seam for determinism, safety constraints, logging, and eventually learning.

## Architecture

```
┌─────────────────────────────────────────────┐
│                HEARTBEAT LOOP                │
│                                              │
│  ┌──────────┐    ┌──────────┐    ┌────────┐ │
│  │ OBSERVE  │───>│ EVALUATE │───>│ SELECT │ │
│  │  state   │    │  actions │    │ policy │ │
│  └──────────┘    └──────────┘    └───┬────┘ │
│       ▲                              │      │
│       │          ┌──────────┐        │      │
│       └──────────│   ACT    │<───────┘      │
│                  └──────────┘               │
└─────────────────────────────────────────────┘
```

### Phase 1 (Current): Single Agent

A single `AgentLoop` base class with a concrete `SingleAgent` implementation that wires into pi's SDK for LLM inference and tool execution.

### Phase 2 (Planned): Hierarchical Executive + Workers

Inspired by [Learning by Cheating](#references), the base loop becomes the parent class for two specializations:

```
┌─────────────────────────────────────────────────────┐
│            EXECUTIVE AGENT (Privileged)              │
│                                                     │
│  Full state visibility, plan/goal graph,            │
│  resource constraints, all child statuses            │
│                                                     │
│  Action space: spawn_worker, steer_worker,          │
│  abort_worker, merge_results, update_plan, wait     │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │   WORKER 1   │  │   WORKER N   │                 │
│  │              │  │              │                 │
│  │ Scoped task  │  │ Scoped task  │                 │
│  │ brief only   │  │ brief only   │                 │
│  │              │  │              │                 │
│  │ Action space:│  │ Action space:│                 │
│  │ bash, read,  │  │ bash, read,  │                 │
│  │ write, edit  │  │ write, edit  │                 │
│  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────┘
```

The **executive** is the privileged agent — it "cheats" by having access to the full picture (all memory, all child statuses, the complete plan graph). Workers operate with scoped task briefs and limited context. Each side solves an easier problem.

The executive doesn't need to know *how* to do the work in detail. Workers don't need to understand the full picture. Over time, worker execution traces accumulate and patterns can be distilled — workers get smarter, the executive can delegate more abstractly.

### Phase 3 (Planned): Distillation & Learning

Log every executive→worker interaction. Build feedback loops. Swap in smaller/cheaper models for well-understood worker tasks. The "Learning by Cheating" payoff.

## Project Structure

```
src/
├── types.ts          Core type definitions (State, Action, ScoredAction,
│                     TaskBrief, ChildStatus, LoopEvent, etc.)
├── agent-loop.ts     Abstract base class — the heartbeat loop
├── single-agent.ts   Concrete implementation wired to pi's SDK
├── main.ts           Demo runner with formatted heartbeat logging
└── index.ts          Public API exports
```

### `AgentLoop` (Base Class)

The abstract heartbeat. Subclasses implement four methods:

```typescript
abstract class AgentLoop {
  protected abstract observe(): Promise<State>;
  protected abstract evaluate(state: State): Promise<ScoredAction[]>;
  protected abstract select(scoredActions: ScoredAction[]): Action;
  protected abstract act(action: Action): Promise<ActionResult>;
}
```

Lifecycle hooks for setup/teardown, a `shouldBeat()` gate, error handling, and an event system for full observability. Supports both single-tick execution (`tick()`) and continuous running (`run()`) with configurable heartbeat intervals and max-heartbeat limits.

### `SingleAgent`

The Phase 1 concrete implementation:

- **Observe**: Reads workspace files, persistent memory, and pending inputs
- **Evaluate**: Sends structured state to the LLM, receives scored action candidates as JSON
- **Select**: Greedy policy — picks the highest-valued action. Deliberately simple and deterministic. Future: epsilon-greedy, UCB, constraint-based filtering
- **Act**: Dispatches to bash, read, write, edit, memory update, complete, or wait

Uses pi's SDK for LLM inference and tool execution. Memory persists to disk. Full action history is logged per run.

### Action Space

| Action | Params | Description |
|--------|--------|-------------|
| `bash` | `command` | Execute a shell command |
| `read` | `path` | Read a file |
| `write` | `path`, `content` | Write/create a file |
| `edit` | `path`, `oldText`, `newText` | Surgical file edit |
| `update_memory` | `key`, `value` | Persist to working memory |
| `complete` | `summary` | Mark task done, stop loop |
| `wait` | — | Do nothing this heartbeat |

## Quick Start

```bash
# Clone
git clone https://github.com/jnesfield-bot/agent-loop.git
cd agent-loop

# Install
npm install

# Run the demo
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/main.ts [work-directory]
```

The demo creates an agent tasked with exploring its environment and writing a report. You'll see each heartbeat's Observe → Evaluate → Select → Act cycle logged with timing and scoring.

## Dependencies

- **[@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)** — The pi SDK for LLM sessions, tool execution, session management, and extensions
- **[@mariozechner/pi-agent-core](https://github.com/badlogic/pi-mono)** — Core agent primitives (Agent, messages, types)
- **[@mariozechner/pi-ai](https://github.com/badlogic/pi-mono)** — Model registry and LLM provider abstraction

## References & Influences

### Learning by Cheating

> Chen, D., Zhou, B., Koltun, V., & Krähenbühl, P. (2019). *Learning by Cheating*. CoRL 2020.
> [arXiv:1912.12294](https://arxiv.org/abs/1912.12294)

The core idea: decompose a hard problem (raw input → actions) into two easier problems by introducing a **privileged agent** that has access to ground truth state. The privileged agent learns an optimal policy trivially. A sensorimotor agent then learns to imitate it. Applied here: the executive agent is privileged (full state, all context), workers are sensorimotor (scoped briefs, local context). Each solves an easier problem. The executive's rich task briefs are the imitation signal.

### Pi Coding Agent & Mom (Master of Mischief)

- **[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)** — A minimal terminal coding harness by Mario Zechner. Extensible via skills, extensions, prompt templates, and themes. Provides the SDK this project builds on.
- **[Mom](https://github.com/badlogic/pi-mono/tree/main/packages/mom)** — A self-managing Slack bot built on pi. Installs its own tools, writes its own scripts, maintains workspace memory. Demonstrates the pattern of an autonomous agent with persistent state and skill creation. Mom's architecture — particularly its memory system, skills model, and sandbox execution — directly informed the design here.
- **[OpenClaw](https://github.com/openclaw/openclaw)** — A real-world pi SDK integration that demonstrated the programmatic embedding pattern we follow.

### Browser_use

[Browser_use](https://github.com/browser-use/browser-use) runs a dual-loop architecture: a planner that decomposes page interactions into steps, and an executor that drives the browser. The planner has privileged access to goals and DOM structure; the executor has the concrete action space (click, type, scroll). Same separation of concerns applied here between executive and worker.

### Figure AI

[Figure](https://www.figure.ai/) uses hierarchical control in their humanoid robots: high-level task planners that understand goals and context, paired with low-level motor controllers that execute physical actions. The planner doesn't need to know joint torques; the motor controller doesn't need to know why it's picking up a cup. This strategic/tactical split is the same pattern at a different scale.

### Reinforcement Learning Foundations

The heartbeat loop directly mirrors the standard RL agent-environment interaction:

1. Agent observes state *s_t*
2. Agent selects action *a_t* = π(*s_t*) according to policy
3. Environment returns reward *r_t* and next state *s_{t+1}*
4. Repeat

We replace the reward signal with LLM-generated action values (the evaluate phase) and use a greedy policy for selection. The architecture is designed so that as execution traces accumulate, more sophisticated policies can be plugged in — epsilon-greedy for exploration, constraint-based filtering for safety, or learned value functions for efficiency.

> Sutton, R. S., & Barto, A. G. (2018). *Reinforcement Learning: An Introduction* (2nd ed.). MIT Press.
> [incompleteideas.net/book/the-book-2nd.html](http://incompleteideas.net/book/the-book-2nd.html)

## Design Notes

**Why not just let the LLM free-run?** Free-running works well for interactive coding sessions. But for autonomous agents operating on business tasks — especially ones that spawn sub-agents — you need a decision boundary you can inspect, log, constrain, and override. The evaluate/select split gives you that.

**Why greedy policy?** Start simple. The greedy policy is fully deterministic and easy to reason about. It's the right default before you have enough trace data to justify something more sophisticated. The `select()` method is a single function override away from any policy you want.

**Why one action per heartbeat?** Atomicity. Each heartbeat is one observable state transition. You can replay the full history, you can intervene between any two actions, and you can attribute outcomes to specific decisions. Batching multiple actions per heartbeat is a future optimization once the single-action loop is proven.

**Why not use pi's tools directly in the evaluate phase?** The evaluate phase is pure reasoning — "what should I do next?" The act phase is impure execution — "do it." Keeping them separate means the LLM's tool use in evaluate is constrained to proposing, not executing. This prevents runaway tool chains in the evaluation step.

**On the executive/worker hierarchy:** Both inherit from the same `AgentLoop` base class. A worker could theoretically spawn its own sub-workers (depth-limited). The executive is itself a worker from the perspective of a higher-level system. This gives you fractal composability — the same pattern at every scale.

## Status

**Phase 1** — ✅ Complete. Single agent heartbeat loop, compiles and runs against pi SDK.

**Phase 2** — 🔜 Next. Executive + Worker specializations, task delegation, structured status reporting.

**Phase 3** — 📋 Planned. Trace logging, distillation, learned policies.

## License

MIT
