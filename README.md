# Agent Loop

An RL-inspired autonomous agent framework built on the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) SDK. Instead of free-running LLM conversations, the agent operates in a deterministic **heartbeat loop**: Observe → Evaluate → Select → Act → Repeat.

> Also available at [github.com/jnesfield-bot/rho](https://github.com/jnesfield-bot/rho) — ρ, because it comes after π.

## Motivation

Most LLM agent frameworks let the model free-run — it thinks, calls tools, thinks again, calls more tools — until it decides it's done. This works, but it's a black box. You can't inspect the decision boundary, you can't swap the policy, and you can't audit why it chose action A over action B.

This project imposes structure. Every heartbeat, the agent:

1. **Observes** the current state of the world (via the **blackboard**)
2. **Evaluates** candidate actions by asking the LLM to score them
3. **Selects** the best action via a deterministic policy function
4. **Acts** by executing that single action (primitive or skill sequence)

The key insight is the **separation between evaluation and selection**. The LLM proposes and scores. A policy function — which you control — decides. This gives you a seam for determinism, safety constraints, logging, and eventually learning.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   HEARTBEAT LOOP                      │
│                                                      │
│  ┌───────────┐    ┌──────────┐    ┌────────┐        │
│  │  OBSERVE  │───>│ EVALUATE │───>│ SELECT │        │
│  │ blackboard│    │  scored  │    │ greedy │        │
│  │   + lens  │    │  actions │    │ policy │        │
│  └───────────┘    └──────────┘    └───┬────┘        │
│       ▲                               │             │
│       │          ┌──────────────┐     │             │
│       └──────────│     ACT      │<────┘             │
│                  │ primitive OR │                    │
│                  │ skill seq.   │                    │
│                  └──────────────┘                    │
└──────────────────────────────────────────────────────┘
```

## The Blackboard (Observation)

The agent's primary observation surface, inspired by [Glyph](https://arxiv.org/abs/2510.17800) (arXiv:2510.17800). Every heartbeat, the observation step runs as a deterministic skill sequence:

1. **Gather** raw state (task, memory, workspace, last result, children, inputs)
2. **Render** the state through the agent's **lens** into the board layout
3. **Read** the rendered board (always first)
4. **Supplement** with scratchpads and memory stores

### Segmentation

The board is divided into **segments** with visibility tags. Agents carry a **lens** — a set of tags that determines which segments they see. Same state, different views.

| Segment        | Tags                    | Contains                          |
|----------------|-------------------------|-----------------------------------|
| `header`       | _(all)_                 | Heartbeat #, time, lens name      |
| `task`         | `task`                  | Description, criteria, progress   |
| `action`       | `action`                | Last action, status, output       |
| `memory`       | `memory`                | Working memory key-values         |
| `workspace`    | `workspace`             | File listing, recent changes      |
| `inputs`       | `inputs`                | Pending messages/events           |
| `children`     | `children`              | Child agent statuses              |
| `skills`       | `skills`                | Available skill names             |
| `active_skill` | `skills`, `action`      | Currently executing skill         |

**Lens presets:**

| Lens        | Sees                                              | For              |
|-------------|---------------------------------------------------|------------------|
| `executive` | Everything                                         | Top-level agent  |
| `worker`    | task, action, memory, workspace, skills            | Focused executor |
| `monitor`   | task, children, inputs, meta                       | Oversight role   |
| `minimal`   | task, action only                                  | Constrained sub-agent |

**Why segments?** Least privilege (workers don't see siblings), token efficiency (smaller board = faster inference), and composability (add segments without changing lenses).

## Actions: Primitives and Skills

Actions come in two forms — the **Options framework** from Sutton, Precup & Singh (1999):

### Primitive Actions (one step, one heartbeat)

Three categories of primitives:

**File I/O (pi tools):**

| Action  | Params                          | Description            |
|---------|---------------------------------|------------------------|
| `bash`  | `command`                       | Execute shell command  |
| `read`  | `path`                          | Read a file            |
| `write` | `path`, `content`               | Write/create a file    |
| `edit`  | `path`, `oldText`, `newText`    | Surgical file edit     |

**Search (structured queries):**

| Action  | Params                                    | Description            |
|---------|-------------------------------------------|------------------------|
| `grep`  | `pattern`, `path`, `options`              | Search file contents   |
| `find`  | `path`, `pattern`, `type`, `maxDepth`     | Find files by pattern  |
| `ls`    | `path`, `options`                         | List directory         |

**Agent Control:**

| Action          | Params                                    | Description                |
|-----------------|-------------------------------------------|----------------------------|
| `update_memory` | `key`, `value`                            | Persist to working memory  |
| `delegate`      | `description`, `targetAgent`, `priority`  | Assign task to child agent |
| `message`       | `to`, `content`, `channel`                | Inter-agent communication  |
| `complete`      | `summary`                                 | Mark task done, stop loop  |
| `wait`          | —                                         | Do nothing this heartbeat  |

### Skill Actions (multi-step sequences, one heartbeat)

Skills are coherent multi-step workflows that execute within a single heartbeat. The agent selects a skill by name and goal, the LLM plans the concrete steps, then each step executes sequentially with per-step events for observability.

```json
{
  "kind": "skill",
  "type": "skill",
  "skillName": "arxiv-research",
  "goal": "Find and extract the DQN algorithm from arXiv:1312.5602",
  "description": "Use the research skill to get the algorithm",
  "params": {}
}
```

## Skills

Skills are self-contained capability packages with SKILL.md documentation and executable scripts. The agent discovers them on startup and can invoke them as actions.

### arxiv-research

Search arXiv, download LaTeX source, extract algorithms and pseudocode.

| Script                 | Purpose                              |
|------------------------|--------------------------------------|
| `search.mjs`           | Query arXiv API with field prefixes  |
| `metadata.mjs`         | Get full paper metadata by ID        |
| `download-source.mjs`  | Download and extract LaTeX source    |
| `extract-algorithms.mjs` | Parse algorithm/pseudocode blocks  |

### skill-sequencer

Compile skills into deterministic, replayable step sequences.

| Script        | Purpose                                          |
|---------------|--------------------------------------------------|
| `compile.mjs` | SKILL.md + goal → JSON sequence file             |
| `run.mjs`     | Execute sequences with variable substitution     |
| `list.mjs`    | List compiled sequences                          |

**Features:** `{{variable}}` templates, `captureAs` for chaining step outputs, `onFailure` policies (abort/continue/retry:N), conditional steps, `--dry-run`, step ranges.

```bash
# Compile
node skills/skill-sequencer/scripts/compile.mjs skills/arxiv-research \
  "Find and implement DQN from arXiv:1312.5602" sequences/dqn.json

# Run
node skills/skill-sequencer/scripts/run.mjs sequences/dqn.json

# Run with variables
node skills/skill-sequencer/scripts/run.mjs sequences/template.json --var paper_id=1706.03762
```

### blackboard

Visual observation board with segmented rendering and lens-based visibility.

| Script                | Purpose                              |
|-----------------------|--------------------------------------|
| `render.mjs`          | Render state → board (text/md/json)  |
| `read-scratchpad.mjs` | Read working notes                   |
| `read-memory.mjs`     | Read persistent key-value store      |

```bash
# Executive view
node skills/blackboard/scripts/render.mjs --state state.json --lens executive

# Worker view (smaller, focused)
node skills/blackboard/scripts/render.mjs --state state.json --lens worker

# JSON for programmatic use
node skills/blackboard/scripts/render.mjs --state state.json --format json --lens minimal
```

## Project Structure

```
src/
├── types.ts          Core types (State, Action, SkillAction, SkillDescriptor,
│                     SkillExecution, TaskBrief, ChildStatus, LoopEvent, ...)
├── agent-loop.ts     Abstract base class — the heartbeat loop
├── single-agent.ts   Concrete implementation wired to pi SDK
├── main.ts           Demo runner with formatted heartbeat logging
└── index.ts          Public API exports

skills/
├── arxiv-research/   Search arXiv, download LaTeX, extract algorithms
│   ├── SKILL.md
│   └── scripts/      search, metadata, download-source, extract-algorithms
├── skill-sequencer/  Compile skills into deterministic sequences
│   ├── SKILL.md
│   └── scripts/      compile, run, list
└── blackboard/       Visual observation board with segmented rendering
    ├── SKILL.md
    └── scripts/      render, read-scratchpad, read-memory

sequences/            Compiled skill sequences (JSON)
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

### `SingleAgent`

The Phase 1 concrete implementation:

- **Observe**: Reads workspace, memory, inputs; discovers available skills
- **Evaluate**: Sends state + available skills to LLM, receives scored candidates (primitive or skill) as JSON
- **Select**: Greedy policy — picks highest-valued action. Deterministic. Future: epsilon-greedy, UCB, constraints
- **Act**: Dispatches primitives (bash/read/write/edit/grep/find/ls/memory/delegate/message/complete/wait) or executes skill sequences (plan steps via LLM → execute sequentially → aggregate result)

## Hierarchical Architecture (Planned)

### Phase 2: Executive + Workers

```
┌─────────────────────────────────────────────────────┐
│            EXECUTIVE AGENT [executive lens]          │
│                                                     │
│  Full board visibility, plan graph, all children    │
│  Actions: delegate, steer, abort, merge, plan       │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │   WORKER 1   │  │   WORKER N   │                 │
│  │ [worker lens]│  │ [worker lens]│                 │
│  │              │  │              │                 │
│  │ Scoped task  │  │ Scoped task  │                 │
│  │ + workspace  │  │ + workspace  │                 │
│  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────┘
```

The executive is privileged (sees everything via `executive` lens). Workers see only their task via `worker` lens. The blackboard segmentation makes this trivial — same state, different lenses.

### Phase 3: Distillation & Learning

Log executive→worker interactions. Build feedback loops. Swap cheaper models for well-understood worker tasks.

## Quick Start

```bash
git clone https://github.com/jnesfield-bot/agent-loop.git
cd agent-loop
npm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/main.ts [work-directory]
```

## References

- **Learning by Cheating** — Chen et al. (2019). [arXiv:1912.12294](https://arxiv.org/abs/1912.12294). Privileged agent → sensorimotor imitation. Our executive/worker split.
- **Glyph** — Cheng et al. (2025). [arXiv:2510.17800](https://arxiv.org/abs/2510.17800). Visual-text compression for dense context. Our blackboard rendering principle.
- **Options Framework** — Sutton, Precup & Singh (1999). Temporally extended actions. Our primitive/skill action model.
- **Pi & Mom** — [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono). The SDK we build on. Mom's autonomous agent patterns informed the design.
- **Sutton & Barto** — *Reinforcement Learning: An Introduction* (2018). The observe→select→act loop.

## Design Notes

**Why not just let the LLM free-run?** For autonomous agents on business tasks — especially with sub-agents — you need a decision boundary you can inspect, log, constrain, and override. The evaluate/select split gives you that.

**Why greedy policy?** Start simple. Fully deterministic, easy to reason about. The `select()` method is one override away from any policy.

**Why one action per heartbeat?** Atomicity. Each heartbeat is one observable state transition. Replay the full history, intervene between any two actions, attribute outcomes to specific decisions.

**Why skills as sequences, not free-form?** A skill is a recipe, not a conversation. Compile it to a deterministic sequence, review it, edit it, replay it. The LLM plans once; execution is mechanical.

**Why the blackboard?** The agent needs a consistent, structured view of its world. Not a blob of text — a fixed-layout board where it knows where to look. Dense over verbose. Symbols over sentences. Glyph's principle: maximize information per token.

## Status

- ✅ **Phase 1** — Single agent heartbeat loop with primitives + skills + blackboard
- 🔜 **Phase 2** — Executive + Worker with lens-based observation, delegation
- 📋 **Phase 3** — Trace logging, distillation, learned policies

## License

MIT
