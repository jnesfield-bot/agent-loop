# Agent Loop

A standalone RL-inspired autonomous agent framework. The heartbeat engine, types, skills, replay buffer, policy rules, and semantic code search — **no pi TUI, no interactive mode**. Just the autonomous loop you can embed in any system.

> **Looking for the full coding agent?** See [rho](https://github.com/jnesfield-bot/rho) — pi + agent-loop integrated into a complete autonomous coding agent.

## What This Is

A library that provides:

- **Heartbeat loop**: Observe → Evaluate → Select → Act → Record
- **Policy engine**: Production-rule system (Soar-style) that constrains the select phase — safety blocks, escalation, skill boosts, impasse handling
- **Skills**: Self-contained capability packages (arxiv-research, code-search, skill-sequencer, blackboard, replay-buffer, policy)
- **Replay buffer**: Multimodal experience memory with indexing, querying, sampling
- **Blackboard**: Segmented observation board with lens-based visibility
- **Code search**: Multi-stream semantic search across git repos

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                     HEARTBEAT LOOP                         │
│                                                           │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐           │
│  │  OBSERVE  │─>│ EVALUATE │─>│    SELECT    │           │
│  │ blackboard│  │  scored  │  │ policy rules │           │
│  │  + lens   │  │  actions │  │ + greedy     │           │
│  └───────────┘  └──────────┘  └──────┬───────┘           │
│       ▲                              │                    │
│       │    ┌──────────┐  ┌───────────┴──────┐            │
│       └────│  RECORD  │<─│      ACT         │            │
│            │  replay  │  │ primitive | skill │            │
│            │  buffer  │  └──────────────────┘            │
│            └──────────┘                                   │
└───────────────────────────────────────────────────────────┘
```

## Quick Start

### Docker (interactive pi session)

Opens a full interactive pi TUI — same experience as running `pi` locally.

```bash
git clone https://github.com/jnesfield-bot/agent-loop.git
cd agent-loop
docker build -t agent-loop .
docker run -it -e ANTHROPIC_API_KEY=sk-ant-... agent-loop
```

### npm

```bash
git clone https://github.com/jnesfield-bot/agent-loop.git
cd agent-loop && npm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/main.ts [work-directory]
```

## Policy Engine

Production-rule system inspired by Soar/CoALA (arXiv:2309.02427). The policy file
is a set of codified rules that the `select()` phase checks **before** falling back
to LLM-scored greedy selection. Rules have preconditions and effects.

```json
{
  "rules": [
    {
      "id": "safety-no-rm-rf",
      "priority": 1000,
      "precondition": { "type": "action_match", "field": "params.command", "pattern": "rm\\s+-rf\\s+/" },
      "effect": "block",
      "message": "Blocked: dangerous rm command"
    },
    {
      "id": "escalate-on-stuck",
      "priority": 900,
      "precondition": { "type": "consecutive_failures", "count": 3 },
      "effect": "escalate",
      "message": "3 failures — requesting executive guidance"
    }
  ]
}
```

**Priority tiers**: 1000+ safety, 500-999 lifecycle, 100-499 behavioral, 1-99 preference.

**Effects**: `block` (reject action), `override` (replace), `boost` (adjust score), `filter` (remove candidates), `rewrite` (transform), `escalate` (ask parent), `log` (audit).

**Impasse handling** (from Soar): When no rules match, candidates exhausted, or repeated failures → escalate to executive. Workers know their limits.

**Self-modifying**: Agents can write new rules from experience — the bridge from static policy to learned policy.

```bash
# Validate a policy
node skills/policy/scripts/validate.mjs policies/worker-default.json

# Evaluate rules against candidates (blocks rm -rf, selects safe alternative)
node skills/policy/scripts/evaluate.mjs --policy policies/worker-default.json --candidates candidates.json
```

## Skills

| Skill | Scripts | Purpose |
|-------|---------|---------|
| **policy** | evaluate, validate | Production-rule policy engine |
| **code-search** | index-repo, search, batch-search | Multi-stream semantic code search across git repos |
| **arxiv-research** | search, metadata, download-source, extract-algorithms | Academic paper pipeline |
| **skill-sequencer** | compile, run, list | Compile skills → deterministic sequences |
| **blackboard** | render, read-scratchpad, read-memory | Segmented observation board |
| **replay-buffer** | record, query, replay, sample | Multimodal experience memory |

### Code Search (arXiv:2408.11058)

Search functions/classes by natural language across git repos. Multi-stream
scoring: TF-IDF, name/docstring identity matching, component decomposition.

```bash
# Single-strip: clone + index + search in one action
node skills/code-search/scripts/batch-search.mjs "handle authentication" \
  --repo https://github.com/user/repo.git --top 5

# Or step-by-step
node skills/code-search/scripts/index-repo.mjs ./my-project --output index.json
node skills/code-search/scripts/search.mjs "parse URL parameters" --index index.json
```

### Other Skills

```bash
# arXiv: search + download + extract algorithms
node skills/arxiv-research/scripts/search.mjs "attention is all you need"
node skills/arxiv-research/scripts/download-source.mjs 1706.03762 /tmp/src
node skills/arxiv-research/scripts/extract-algorithms.mjs /tmp/src

# Compile a skill into a deterministic sequence
node skills/skill-sequencer/scripts/compile.mjs skills/arxiv-research \
  "Find and implement DQN from arXiv:1312.5602" sequences/dqn.json
node skills/skill-sequencer/scripts/run.mjs sequences/dqn.json

# Blackboard: render state through a lens
echo '{"heartbeat":1,"currentTask":{"description":"test"},...}' | \
  node skills/blackboard/scripts/render.mjs --lens worker

# Replay buffer: query and sample
node skills/replay-buffer/scripts/query.mjs --buffer ./buffer --success false
node skills/replay-buffer/scripts/sample.mjs --buffer ./buffer --size 32 --strategy prioritized
```

## Actions

**Primitives** (one step, one heartbeat):

| Category | Actions |
|----------|---------|
| File I/O | `bash`, `read`, `write`, `edit` |
| Search | `grep`, `find`, `ls` |
| Control | `update_memory`, `delegate`, `message`, `complete`, `wait` |

**Skills** (multi-step sequence, one heartbeat):

```json
{ "kind": "skill", "skillName": "arxiv-research", "goal": "Extract DQN algorithm from 1312.5602" }
```

## Project Structure

```
src/
├── types.ts          Core types (State, Action, Skill*, TaskBrief, LoopEvent, ...)
├── agent-loop.ts     Abstract base class — heartbeat loop + recordTransition
├── single-agent.ts   Pi SDK wiring + skills + replay buffer + blackboard + policy
├── main.ts           Demo runner
└── index.ts          Public API

skills/
├── policy/           Production-rule policy engine (evaluate, validate)
├── code-search/      Semantic search across git repos (index, search, batch-search)
├── arxiv-research/   Search arXiv, download LaTeX, extract algorithms
├── skill-sequencer/  Compile skills → deterministic JSON sequences
├── blackboard/       Segmented observation board with lens rendering
└── replay-buffer/    Multimodal experience replay (record/query/sample/replay)

policies/
└── worker-default.json   Default worker policy (safety + escalation + preferences)

sequences/
└── implement-dqn.json    Example compiled sequence
```

## References

- **CoALA** — Sumers, Yao et al. [arXiv:2309.02427](https://arxiv.org/abs/2309.02427). Cognitive architectures → production-rule policy.
- **LLM-MAS** — Chen et al. [arXiv:2412.17481](https://arxiv.org/abs/2412.17481). Multi-agent rules, intervention, communication.
- **RepoRift** — Jain et al. [arXiv:2408.11058](https://arxiv.org/abs/2408.11058). Multi-stream semantic code search.
- **Glyph** — Cheng et al. [arXiv:2510.17800](https://arxiv.org/abs/2510.17800). Blackboard rendering.
- **DQN** — Mnih et al. [arXiv:1312.5602](https://arxiv.org/abs/1312.5602). Experience replay buffer.
- **Learning by Cheating** — Chen et al. [arXiv:1912.12294](https://arxiv.org/abs/1912.12294). Executive/worker hierarchy.
- **Options Framework** — Sutton, Precup & Singh (1999). Primitive + skill actions.
- **Pi & Mom** — [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono). SDK foundation.

## Status

- ✅ Heartbeat loop with primitives + skills
- ✅ Blackboard with segmented lens rendering
- ✅ Replay buffer with query/sample/replay
- ✅ Skill sequencer (compile → run)
- ✅ Policy engine (production rules, safety, escalation, impasse)
- ✅ Semantic code search (multi-stream, multi-repo)
- 🔜 Executive + Worker agents with delegation and policy propagation
- 📋 Trace distillation, learned policies, self-modifying rules

## License

MIT
