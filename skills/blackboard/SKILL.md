---
name: blackboard
description: Visual observation board for the agent loop. Renders agent state into a segmented layout with lens-based visibility control. Each agent sees only the segments its lens permits. Always read first in the observation step. Inspired by Glyph (arXiv:2510.17800).
---

# Blackboard — Segmented Visual Observation Board

The blackboard is the agent's primary observation surface. Every heartbeat, the
observation step follows this skill sequence:

1. **Gather** raw state (task, memory, workspace, last result, children, inputs)
2. **Render** the state onto the board through the agent's lens
3. **Read** the rendered board (always first, before any other observation)
4. **Supplement** with scratchpad files, memory stores

## Segmentation

The board is divided into **segments**. Each segment has a name and one or more
**visibility tags**. An agent carries a **lens** — a set of tags that determines
which segments it can see. Same underlying state, different views.

### Segments

| Segment        | Tags                    | Contains                              |
|----------------|-------------------------|---------------------------------------|
| `header`       | _(all tags)_            | Heartbeat number, time, lens name     |
| `task`         | `task`                  | Description, criteria, constraints    |
| `action`       | `action`                | Last action type, status, output      |
| `memory`       | `memory`                | Key-value pairs from working memory   |
| `workspace`    | `workspace`             | File listing, recent changes          |
| `inputs`       | `inputs`                | Pending messages, events, signals     |
| `children`     | `children`              | Child agent statuses and progress     |
| `skills`       | `skills`                | Available skill names                 |
| `active_skill` | `skills`, `action`      | Currently executing skill state       |
| `footer`       | `meta`                  | Board boundary                        |

### Lens Presets

| Lens        | Tags                                                          | Use Case                         |
|-------------|---------------------------------------------------------------|----------------------------------|
| `executive` | meta, task, action, memory, workspace, children, inputs, skills | Full visibility — top-level agent |
| `worker`    | task, action, memory, workspace, skills                        | Focused execution — no children/inputs |
| `monitor`   | meta, task, children, inputs                                   | Oversight — watches children     |
| `minimal`   | task, action                                                   | Constrained — only task + result |

Custom lenses: pass `--lens tag1,tag2,tag3` for any combination.

### Why Segments?

1. **Least privilege**: Workers don't see other workers' statuses or executive inputs.
   They see their task, their tools, their workspace. Nothing else.
2. **Token efficiency**: A worker's board is ~40% smaller than the executive's.
   Less context = faster inference = lower cost. (Glyph principle: compress.)
3. **Composability**: New segments can be added without changing existing lenses.
   A "security" tag could gate access to credentials. A "debug" tag shows traces.
4. **Shared state**: All agents write to the same state. The board is a view, not
   a copy. One source of truth, many projections.

## Render the Board

```bash
node {baseDir}/scripts/render.mjs --state <state.json> [options]
```

### Options

| Flag                | Description                                    |
|---------------------|------------------------------------------------|
| `--state <file>`    | Path to State JSON (or pipe via stdin)          |
| `--format text`     | Output format: `text`, `markdown`, `json`       |
| `--lens <preset>`   | Lens preset or comma-separated tags             |
| `--diff <file>`     | Previous board file for change highlighting     |
| `--segments`        | List all segments and their tags, then exit     |

### Examples

```bash
# Executive view (full board)
node {baseDir}/scripts/render.mjs --state state.json --lens executive

# Worker view (task + action + memory + workspace + skills only)
node {baseDir}/scripts/render.mjs --state state.json --lens worker

# Monitor view (task + children + inputs)
node {baseDir}/scripts/render.mjs --state state.json --lens monitor

# Minimal view (just task + last action)
node {baseDir}/scripts/render.mjs --state state.json --lens minimal

# Custom lens (only memory and workspace)
node {baseDir}/scripts/render.mjs --state state.json --lens memory,workspace

# JSON format for programmatic use
node {baseDir}/scripts/render.mjs --state state.json --format json --lens worker

# List segments and check visibility
node {baseDir}/scripts/render.mjs --segments --lens worker
```

## Board Layout (text format, executive lens)

```
╔══════════════════════════════════════════════════════╗
║  BOARD #7  [executive]                       05:12  ║
╠══════════════════════════════════════════════════════╣
║  TASK                                               ║
║  ┌─────────────────────────────────────────────────┐ ║
║  │ Description: Implement DQN from arXiv:1312.5602 │ ║
║  │   ☐ Extract algorithm from paper                │ ║
║  │   ☑ Implement replay buffer                     │ ║
║  │   ☐ Implement Q-network                         │ ║
║  └─────────────────────────────────────────────────┘ ║
╠══════════════════════════════════════════════════════╣
║  LAST ACTION                                        ║
║  ┌─────────────────────────────────────────────────┐ ║
║  │ bash ✓  (230ms)                                 │ ║
║  │ $ node extract-algorithms.mjs /tmp/dqn-src      │ ║
║  │   Found 1 algorithm: "Deep Q-learning..."       │ ║
║  └─────────────────────────────────────────────────┘ ║
╠══════════════════════════════════════════════════════╣
║  MEMORY (2 keys)                                    ║
║  WORKSPACE (8 files)                                ║
║  CHILDREN (2)                                       ║
║  ┌─────────────────────────────────────────────────┐ ║
║  │ worker-1 [running] ████░░░░░░ 40% task:replay   │ ║
║  │ worker-2 [idle]    ░░░░░░░░░░  0% task:qnet     │ ║
║  └─────────────────────────────────────────────────┘ ║
║  SKILLS (3 available)                               ║
╚══════════════════════════════════════════════════════╝
```

**Worker lens** for the same state would show only: header, task, action, memory, workspace, skills.
No children, no inputs. Smaller board, focused view.

## Read Supplementary Sources

After the board, the agent may consult secondary sources:

```bash
# Scratchpad files (working notes, intermediate reasoning)
node {baseDir}/scripts/read-scratchpad.mjs [scratchpad-dir] [--agent <id>] [--latest N]

# Memory store (persistent key-value state)
node {baseDir}/scripts/read-memory.mjs [memory-dir] [--keys key1,key2] [--agent <id>]
```

## Observation Sequence

The full observation step is a 4-step skill sequence:

1. `gather-state` — Collect raw state from workspace, memory, task, children
2. `render-board` — Format state through the agent's lens into the board layout
3. `read-board` — Present the board as the primary observation
4. `read-supplements` — Optionally read scratchpads, memory files

This sequence is deterministic and runs every heartbeat. The agent does not
choose what to observe — it always sees the full board (through its lens) first.
Choice comes in the evaluate/select phases.

## Design Principles

1. **Board first, always.** Before any decision, the agent reads the board.
   This is non-negotiable. The board is the ground truth.

2. **Lens, not filter.** The lens doesn't hide information — it shapes what's
   presented. Like a camera angle, not a censor. The state is the same.

3. **Dense over verbose.** Inspired by Glyph: pack maximum signal into minimum
   tokens. Progress bars over paragraphs. Symbols over sentences.

4. **Consistent layout.** The agent knows where to look. Task is always first.
   Action is always second. Memory third. No surprises. This is the rendering
   configuration θ from Glyph — fixed structure, varying content.

5. **Diff is signal.** What changed since last heartbeat tells the agent more
   than what exists. Delta over snapshot when possible.
