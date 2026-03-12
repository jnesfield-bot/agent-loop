---
name: replay-buffer
description: Multimodal experience replay buffer. Records every heartbeat transition (board, action, result, attachments) into an indexed store. Supports random sampling, time-range queries, and full episode replay. The RL memory — but for rich multimedia agent state.
---

# Replay Buffer — Multimodal Experience Memory

Every heartbeat produces a **transition**: what the agent saw (board), what it
chose (action), what happened (result), and any supporting context (files, text,
media). The replay buffer stores all of these in an indexed, queryable archive.

This is the experience replay memory D from DQN (arXiv:1312.5602), extended
for multimodal agent state:

```
D = { (φ_t, a_t, r_t, φ_{t+1}, context_t) }
```

Where:
- `φ_t` — the board snapshot (rendered observation through the agent's lens)
- `a_t` — the action taken (primitive or skill)
- `r_t` — the result (success, output, duration, artifacts)
- `φ_{t+1}` — the next board snapshot (after the action)
- `context_t` — any attachments: files read, LLM responses, skill traces, etc.

## Storage Layout

```
buffer/
├── index.json           Master index — lightweight, always loaded
├── transitions/
│   ├── 000001.json      Transition records (one per heartbeat)
│   ├── 000002.json
│   └── ...
├── boards/
│   ├── 000001.txt       Board snapshots (text renders)
│   ├── 000002.txt
│   └── ...
├── media/
│   ├── 000001/          Per-transition attachment directory
│   │   ├── file-read.py
│   │   ├── llm-response.txt
│   │   └── skill-trace.json
│   └── ...
└── episodes/
    ├── episode-001.json  Episode boundaries (start → complete/fail)
    └── ...
```

## Record a Transition

```bash
node {baseDir}/scripts/record.mjs --buffer <buffer-dir> \
  --board <board-snapshot> \
  --action <action.json> \
  --result <result.json> \
  [--attach <file> ...] \
  [--tag key=value ...] \
  [--episode <episode-id>]
```

Or pipe a full transition JSON via stdin:

```bash
echo '{"board":"...","action":{...},"result":{...}}' | \
  node {baseDir}/scripts/record.mjs --buffer ./buffer
```

## Query the Buffer

```bash
# All transitions
node {baseDir}/scripts/query.mjs --buffer ./buffer

# By heartbeat range
node {baseDir}/scripts/query.mjs --buffer ./buffer --from 10 --to 20

# By time range
node {baseDir}/scripts/query.mjs --buffer ./buffer --after 2026-03-12T00:00:00Z

# By action type
node {baseDir}/scripts/query.mjs --buffer ./buffer --action-type bash

# By success/failure
node {baseDir}/scripts/query.mjs --buffer ./buffer --success false

# By tag
node {baseDir}/scripts/query.mjs --buffer ./buffer --tag phase=research

# By episode
node {baseDir}/scripts/query.mjs --buffer ./buffer --episode ep-001

# Full text search across board snapshots
node {baseDir}/scripts/query.mjs --buffer ./buffer --search "DQN"

# Random sample (for training/analysis)
node {baseDir}/scripts/query.mjs --buffer ./buffer --sample 32

# Most recent N
node {baseDir}/scripts/query.mjs --buffer ./buffer --latest 5
```

## Replay an Episode

```bash
# Print the full episode step-by-step
node {baseDir}/scripts/replay.mjs --buffer ./buffer --episode ep-001

# Replay a heartbeat range
node {baseDir}/scripts/replay.mjs --buffer ./buffer --from 5 --to 15

# Replay with board diffs (show what changed)
node {baseDir}/scripts/replay.mjs --buffer ./buffer --episode ep-001 --diff

# Export for analysis (JSONL format)
node {baseDir}/scripts/replay.mjs --buffer ./buffer --format jsonl > trace.jsonl
```

## Transition Record Format

Each transition JSON:

```json
{
  "id": 42,
  "heartbeat": 42,
  "timestamp": 1741754128000,
  "agentId": "agent-1",
  "episodeId": "ep-001",

  "board": "╔══════... (full rendered board text)",
  "boardRef": "boards/000042.txt",

  "state": {
    "taskDescription": "Implement DQN",
    "memoryKeys": ["approach", "iteration"],
    "fileCount": 8,
    "inputCount": 0,
    "childCount": 2
  },

  "candidates": [
    { "action": { "type": "bash", "..." : "..." }, "value": 0.9, "reasoning": "..." },
    { "action": { "type": "read", "..." : "..." }, "value": 0.6, "reasoning": "..." }
  ],

  "selected": {
    "kind": "primitive",
    "type": "bash",
    "description": "Run tests",
    "params": { "command": "npm test" }
  },

  "result": {
    "success": true,
    "output": "All 12 tests passed",
    "durationMs": 2300,
    "artifacts": ["test-results.json"]
  },

  "attachments": [
    { "name": "file-read.py", "type": "file", "ref": "media/000042/file-read.py", "size": 1234 },
    { "name": "llm-response.txt", "type": "text", "ref": "media/000042/llm-response.txt", "size": 567 },
    { "name": "skill-trace.json", "type": "json", "ref": "media/000042/skill-trace.json", "size": 890 }
  ],

  "tags": {
    "phase": "implementation",
    "skill": null,
    "actionType": "bash"
  },

  "metrics": {
    "selectedValue": 0.9,
    "candidateCount": 2,
    "evaluateMs": 1200,
    "actMs": 2300,
    "totalMs": 3500
  }
}
```

## Index Format

The master index is a lightweight summary for fast queries without loading
full transition records:

```json
{
  "bufferVersion": 1,
  "agentId": "agent-1",
  "created": "2026-03-12T05:00:00Z",
  "transitions": [
    { "id": 1, "heartbeat": 1, "timestamp": 1741754000, "actionType": "bash", "success": true, "episode": "ep-001", "tags": {} },
    { "id": 2, "heartbeat": 2, "timestamp": 1741754003, "actionType": "read", "success": true, "episode": "ep-001", "tags": {} }
  ],
  "episodes": [
    { "id": "ep-001", "start": 1, "end": null, "status": "running", "task": "Implement DQN" }
  ],
  "stats": {
    "totalTransitions": 2,
    "totalEpisodes": 1,
    "successRate": 1.0,
    "avgDurationMs": 1500
  }
}
```

## Design Principles

1. **Record everything.** Disk is cheap, context is precious. Every heartbeat
   gets a full transition record. Compress later if needed.

2. **Index for speed.** The master index fits in memory. Query the index first,
   load full transitions only when needed.

3. **Attachments by reference.** Large files (code, images, traces) are stored
   once in `media/` and referenced by path. No duplication.

4. **Episodes are boundaries.** An episode starts when a task begins and ends
   when it completes or fails. Episodes group related transitions for replay.

5. **Tags are free.** Tag transitions with anything — phase, skill, error type,
   model used. Tags make the buffer queryable for analysis and training.

6. **Sampling is first-class.** Random minibatch sampling (like DQN) is a
   built-in query mode. Future: prioritized replay (weight by |δ| or surprise).
