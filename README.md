# ρ (rho)

**Pi, but autonomous.** A coding agent that extends [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) with a structured heartbeat loop, visual blackboard, experience replay, and skill sequences. Everything pi can do, plus a brain that decides what to do next.

> **ρ comes after π** — same foundation, more structure.

## What This Is vs. What Pi Is

| | **pi** | **rho** |
|---|---|---|
| Interactive TUI | ✅ | ✅ (inherited) |
| LLM tool calling | ✅ free-running | ✅ structured heartbeat |
| Extensions & themes | ✅ | ✅ (inherited) |
| Skills | ✅ documentation-based | ✅ + executable sequences |
| Decision audit trail | ❌ | ✅ replay buffer |
| Observation structure | ❌ (context window) | ✅ blackboard + lenses |
| Multi-agent | ❌ | 🔜 executive + workers |
| Policy control | ❌ (LLM decides) | ✅ deterministic select |

**Pi** is a minimal terminal coding harness. The LLM gets tools (bash, read, write, edit) and free-runs until it's done. Great for interactive coding.

**Rho** adds structure on top: every action goes through Observe → Evaluate → Select → Act → Record. The LLM proposes, a policy function decides, and everything is logged to a replay buffer. Skills can be compiled into deterministic sequences. The observation is a segmented blackboard where different agents see different views of the same state.

## Quick Start

### Interactive (pi mode)

```bash
git clone https://github.com/jnesfield-bot/rho.git
cd rho
npm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/main.ts
```

### Docker (interactive pi session)

Opens a full interactive pi TUI — the same experience as running `pi` normally,
but with the agent-loop extension loaded. You can chat, use all pi tools, AND
use `/loop <task>` to drive structured heartbeat execution.

```bash
git clone https://github.com/jnesfield-bot/rho.git
cd rho
docker build -t rho .
docker run -it -e ANTHROPIC_API_KEY=sk-ant-... rho
```

Once inside you'll see the pi prompt. Available commands:
- `/loop <task>` — Run a task through the heartbeat loop
- `/loop-status` — Show current loop state
- `/loop-stop` — Stop a running loop
- `/loop-memory` — Show agent memory
- `/loop-config max-heartbeats 20` — Configure limits

Or just chat normally — all pi features work alongside the loop.

### Autonomous (heartbeat mode)

```typescript
import { SingleAgent } from "./src/single-agent.js";

const agent = new SingleAgent({
  agentId: "rho-1",
  workDir: "/tmp/rho-work",
  heartbeatIntervalMs: 0,
  maxHeartbeats: 100,
  persistState: true,
  skillDirs: ["./skills"],
  replayBufferDir: "/tmp/rho-work/buffer",
  task: {
    taskId: "t1",
    description: "Build and test a REST API server",
    successCriteria: ["Server starts", "GET /health returns 200", "Tests pass"],
    constraints: ["Use TypeScript", "No external databases"],
    context: {},
    priority: 5,
  },
});

agent.run();
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   HEARTBEAT LOOP                      │
│                                                      │
│  ┌───────────┐  ┌──────────┐  ┌────────┐            │
│  │  OBSERVE  │─>│ EVALUATE │─>│ SELECT │            │
│  │ blackboard│  │  scored  │  │ greedy │            │
│  │  + lens   │  │  actions │  │ policy │            │
│  └───────────┘  └──────────┘  └───┬────┘            │
│       ▲                           │                  │
│       │    ┌──────────┐  ┌───────┴──────┐           │
│       └────│  RECORD  │<─│     ACT      │           │
│            │  replay  │  │ primitive OR │           │
│            │  buffer  │  │ skill seq.   │           │
│            └──────────┘  └──────────────┘           │
└──────────────────────────────────────────────────────┘
```

### What Rho Adds to Pi

**1. The Heartbeat Loop** (`src/agent-loop.ts`)

Instead of letting the LLM free-run, every action goes through a 5-phase cycle:
- **Observe**: Render state onto the blackboard
- **Evaluate**: LLM scores candidate actions
- **Select**: Deterministic policy picks the best (greedy, constraint-filtered)
- **Act**: Execute one primitive or one skill sequence
- **Record**: Store transition in replay buffer

**2. The Blackboard** (`skills/blackboard/`)

A segmented visual observation board. Fixed layout, dense information, consistent structure. Inspired by [Glyph](https://arxiv.org/abs/2510.17800) (arXiv:2510.17800).

Segments: header, task, action, memory, workspace, inputs, children, skills, active_skill, footer.

Lenses filter visibility: `executive` (everything), `worker` (task-focused), `monitor` (children), `minimal` (task + action only).

```bash
# Executive sees everything
node skills/blackboard/scripts/render.mjs --state state.json --lens executive

# Worker sees only their task
node skills/blackboard/scripts/render.mjs --state state.json --lens worker
```

**3. The Replay Buffer** (`skills/replay-buffer/`)

Every heartbeat records a full transition: board snapshot, candidate actions and scores, selected action, result, file attachments, skill traces. Multimodal and indexed.

```bash
# Record
echo '{"board":"...","action":{...},"result":{...}}' | node skills/replay-buffer/scripts/record.mjs --buffer ./buffer

# Query failures
node skills/replay-buffer/scripts/query.mjs --buffer ./buffer --success false

# DQN-style random minibatch
node skills/replay-buffer/scripts/sample.mjs --buffer ./buffer --size 32 --strategy prioritized

# Replay an episode step-by-step
node skills/replay-buffer/scripts/replay.mjs --buffer ./buffer --episode ep-001
```

**4. Skill Sequences** (`skills/skill-sequencer/`)

Compile skills into deterministic, replayable step sequences. Review, edit, version, replay.

```bash
# Compile a skill + goal into a sequence
node skills/skill-sequencer/scripts/compile.mjs skills/arxiv-research \
  "Find and implement DQN from arXiv:1312.5602" sequences/dqn.json

# Execute it
node skills/skill-sequencer/scripts/run.mjs sequences/dqn.json

# Reuse with variables
node skills/skill-sequencer/scripts/run.mjs sequences/template.json --var paper_id=1706.03762
```

**5. Extended Action Space**

Pi gives you: `bash`, `read`, `write`, `edit`

Rho adds:

| Category | Actions |
|----------|---------|
| Search | `grep`, `find`, `ls` (structured, not shell one-liners) |
| Agent Control | `delegate`, `message`, `update_memory`, `complete`, `wait` |
| Skills | Any skill as a multi-step action |

## Project Structure

```
src/
├── types.ts          Core types (State, Action, Skill*, TaskBrief, LoopEvent, ...)
├── agent-loop.ts     Abstract base class — heartbeat loop + recordTransition
├── single-agent.ts   Pi SDK wiring + skills + replay buffer + blackboard
├── extension.ts      Pi extension for interactive TUI heartbeat mode
├── main.ts           Demo runner
└── index.ts          Public API

skills/
├── arxiv-research/   Search arXiv, download LaTeX, extract algorithms
├── skill-sequencer/  Compile skills → deterministic JSON sequences
├── blackboard/       Segmented observation board with lens rendering
└── replay-buffer/    Multimodal experience replay (record/query/sample/replay)

sequences/            Compiled skill sequences (version-controlled recipes)
```

## Skills

| Skill | Scripts | Purpose |
|-------|---------|---------|
| **arxiv-research** | search, metadata, download-source, extract-algorithms | Academic paper pipeline |
| **skill-sequencer** | compile, run, list | Deterministic skill compilation |
| **blackboard** | render, read-scratchpad, read-memory | Segmented observation |
| **replay-buffer** | record, query, replay, sample | Experience memory |

## Roadmap

- ✅ **Phase 1** — Heartbeat loop, skills, blackboard, replay buffer
- 🔜 **Phase 2** — Executive + Worker agents with lens-based observation and delegation
- 📋 **Phase 3** — Trace distillation, learned policies, model swapping

## References

- **Pi** — [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono). The foundation we build on.
- **Learning by Cheating** — [arXiv:1912.12294](https://arxiv.org/abs/1912.12294). Executive/worker hierarchy.
- **Glyph** — [arXiv:2510.17800](https://arxiv.org/abs/2510.17800). Visual-text compression → blackboard.
- **DQN** — [arXiv:1312.5602](https://arxiv.org/abs/1312.5602). Experience replay buffer.
- **Options Framework** — Sutton, Precup & Singh (1999). Primitive + skill actions.

## License

MIT
