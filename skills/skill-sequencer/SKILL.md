---
name: skill-sequencer
description: Compile a skill into a deterministic step sequence. Takes a SKILL.md and a goal, produces a replayable JSON sequence file that the agent can execute without re-planning. Use when you want to turn a skill into a repeatable, auditable, editable recipe.
---

# Skill Sequencer

Compiles skills into deterministic execution sequences.

## Why

Skills describe *what's possible*. Sequences describe *exactly what to do*. A sequence is:
- **Deterministic** — same steps every time, no LLM re-planning
- **Auditable** — review every step before execution
- **Editable** — modify steps, reorder, add conditions
- **Replayable** — run the same sequence again on different inputs
- **Composable** — chain sequences together

## Compile a Skill into a Sequence

```bash
node {baseDir}/scripts/compile.mjs <skill-dir> "<goal>" [output-path]
```

Examples:
```bash
# Compile arxiv-research for a specific goal
node {baseDir}/scripts/compile.mjs ./skills/arxiv-research "Find and implement the DQN algorithm from arXiv:1312.5602" ./sequences/implement-dqn.json

# Compile with variables for reuse
node {baseDir}/scripts/compile.mjs ./skills/arxiv-research "Find and implement the algorithm from paper {{paper_id}}" ./sequences/implement-from-paper.json
```

## Run a Sequence

```bash
node {baseDir}/scripts/run.mjs <sequence-file> [--var key=value ...]
```

Examples:
```bash
# Run a compiled sequence
node {baseDir}/scripts/run.mjs ./sequences/implement-dqn.json

# Run with variable substitution
node {baseDir}/scripts/run.mjs ./sequences/implement-from-paper.json --var paper_id=1706.03762

# Dry run — show steps without executing
node {baseDir}/scripts/run.mjs ./sequences/implement-dqn.json --dry-run
```

## List Available Sequences

```bash
node {baseDir}/scripts/list.mjs [sequences-dir]
```

## Sequence File Format

Sequences are JSON files:

```json
{
  "name": "implement-dqn",
  "description": "Find and implement the DQN algorithm",
  "sourceSkill": "arxiv-research",
  "goal": "Find and implement the DQN algorithm from arXiv:1312.5602",
  "variables": {},
  "steps": [
    {
      "index": 0,
      "description": "Search for the DQN paper",
      "action": {
        "kind": "primitive",
        "type": "bash",
        "description": "Search arXiv for the paper",
        "params": { "command": "node ./skills/arxiv-research/scripts/search.mjs \"1312.5602\"" }
      },
      "onFailure": "abort",
      "captureAs": "search_result"
    }
  ],
  "compiledAt": "2026-03-12T05:00:00Z",
  "compiledFrom": "./skills/arxiv-research/SKILL.md"
}
```

### Step Fields

- `index` — Execution order
- `description` — What this step does
- `action` — The primitive action to run
- `onFailure` — `"abort"` (default), `"continue"`, or `"retry:N"`
- `captureAs` — Save step output to a named variable for later steps
- `condition` — Only run if expression is truthy (e.g. `"{{search_result}}"`)

### Variables

Use `{{variable_name}}` in any string field. Variables come from:
1. `--var key=value` on the command line
2. `captureAs` from prior steps (output becomes the variable value)
3. The `variables` object in the sequence file (defaults)

## Editing Sequences

After compiling, edit the JSON directly to:
- Remove unnecessary steps
- Add error handling (`onFailure: "retry:3"`)
- Insert conditions (`condition: "{{paper_found}}"`)
- Capture intermediate results (`captureAs: "latex_dir"`)
- Add steps the compiler missed
- Reorder steps

The sequence is just data. The agent doesn't need to think about it — it just executes.
