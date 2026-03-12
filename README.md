# Agent Loop

A standalone RL-inspired autonomous agent framework. The heartbeat engine, types, skills, and replay buffer — **no pi TUI, no interactive mode**. Just the autonomous loop you can embed in any system.

> **Looking for the full coding agent?** See [rho](https://github.com/jnesfield-bot/rho) — pi + agent-loop integrated into a complete autonomous coding agent with TUI, extensions, and interactive mode.

## What This Is

A library that provides:

- **Heartbeat loop**: Observe → Evaluate → Select → Act → Record
- **Type system**: State, Action (primitive + skill), ScoredAction, TaskBrief, SkillExecution
- **Skills**: Self-contained capability packages (arxiv-research, skill-sequencer, blackboard, replay-buffer)
- **Replay buffer**: Multimodal experience memory with indexing, querying, sampling
- **Blackboard**: Segmented observation board with lens-based visibility

This is the **engine**. It doesn't have opinions about how you talk to users or what editor you use. It's the structured decision-making layer that sits between an LLM and the world.

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

## Quick Start

### npm

```bash
git clone https://github.com/jnesfield-bot/agent-loop.git
cd agent-loop
npm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/main.ts [work-directory]
```

### Docker

```bash
git clone https://github.com/jnesfield-bot/agent-loop.git
cd agent-loop
docker build -t agent-loop .
docker run -it -e ANTHROPIC_API_KEY=sk-ant-... agent-loop
```

Or use the provided script:

```bash
chmod +x run.sh
ANTHROPIC_API_KEY=sk-ant-... ./run.sh
```

## Core Concepts

### Actions: Primitives and Skills

Actions come in two forms — the **Options framework** (Sutton, Precup & Singh 1999):

**Primitive** (one step, one heartbeat):

| Category | Actions |
|----------|---------|
| File I/O | `bash`, `read`, `write`, `edit` |
| Search   | `grep`, `find`, `ls` |
| Control  | `update_memory`, `delegate`, `message`, `complete`, `wait` |

**Skill** (multi-step sequence, one heartbeat):

```json
{ "kind": "skill", "skillName": "arxiv-research", "goal": "Extract DQN algorithm from 1312.5602" }
```

### Blackboard (Observation)

Segmented observation board. Each segment has visibility tags; agents carry a **lens** that filters what they see.

| Lens | Sees | For |
|------|------|-----|
| `executive` | Everything | Top-level agent |
| `worker` | task, action, memory, workspace, skills | Focused executor |
| `monitor` | task, children, inputs | Oversight |
| `minimal` | task, action | Constrained sub-agent |

### Replay Buffer

Every heartbeat records a transition: board snapshot, candidates, selected action, result, attachments. Stored in an indexed archive.

```bash
# Query
node skills/replay-buffer/scripts/query.mjs --buffer ./buffer --action-type bash --latest 10

# Random sample (DQN-style)
node skills/replay-buffer/scripts/sample.mjs --buffer ./buffer --size 32 --strategy prioritized

# Replay an episode
node skills/replay-buffer/scripts/replay.mjs --buffer ./buffer --episode ep-001
```

### Skill Sequencer

Compile skills into deterministic, replayable sequences:

```bash
# Compile
node skills/skill-sequencer/scripts/compile.mjs skills/arxiv-research \
  "Find and implement DQN from arXiv:1312.5602" sequences/dqn.json

# Run
node skills/skill-sequencer/scripts/run.mjs sequences/dqn.json

# Dry run
node skills/skill-sequencer/scripts/run.mjs sequences/dqn.json --dry-run
```

## Project Structure

```
src/
├── types.ts          Core types (State, Action, Skill*, TaskBrief, LoopEvent, ...)
├── agent-loop.ts     Abstract base class — the heartbeat loop + recordTransition hook
├── single-agent.ts   Concrete implementation with skills, replay buffer, blackboard
├── main.ts           Demo runner
└── index.ts          Public API

skills/
├── arxiv-research/   Search arXiv, download LaTeX, extract algorithms
├── skill-sequencer/  Compile skills → deterministic JSON sequences
├── blackboard/       Segmented observation board with lens rendering
└── replay-buffer/    Multimodal experience replay with query/sample/replay
```

## Embedding in Your Own System

```typescript
import { SingleAgent } from "./src/single-agent.js";

const agent = new SingleAgent({
  agentId: "my-agent",
  workDir: "/tmp/my-agent",
  heartbeatIntervalMs: 0,
  maxHeartbeats: 50,
  persistState: true,
  skillDirs: ["./skills"],
  replayBufferDir: "/tmp/my-agent/buffer",
  task: {
    taskId: "t1",
    description: "Build a REST API",
    successCriteria: ["Server starts", "GET /health returns 200"],
    constraints: [],
    context: {},
    priority: 5,
  },
});

agent.run();
```

## References

- **Learning by Cheating** — Chen et al. [arXiv:1912.12294](https://arxiv.org/abs/1912.12294)
- **Glyph** — Cheng et al. [arXiv:2510.17800](https://arxiv.org/abs/2510.17800). Blackboard rendering principle.
- **Options Framework** — Sutton, Precup & Singh (1999). Primitive/skill action model.
- **DQN** — Mnih et al. [arXiv:1312.5602](https://arxiv.org/abs/1312.5602). Experience replay.
- **Pi & Mom** — [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono). SDK foundation.

## Status

- ✅ Heartbeat loop with primitives + skills
- ✅ Blackboard with segmented lens rendering
- ✅ Replay buffer with query/sample/replay
- ✅ Skill sequencer (compile → run)
- 🔜 Executive + Worker agents with delegation
- 📋 Trace distillation, learned policies

## License

MIT
