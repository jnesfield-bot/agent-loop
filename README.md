# Agent Loop

A standalone RL-inspired autonomous agent framework. Heartbeat engine, tri-store cognitive memory, Rainbow-inspired priority scoring, policy rules, skills, replay buffer, and semantic code search — **no pi TUI, no interactive mode**. Just the autonomous loop you can embed in any system.

> **Looking for the full coding agent?** See [rho](https://github.com/jnesfield-bot/rho) — pi + agent-loop integrated into a complete autonomous coding agent.

> **📄 Paper**: See [`paper/rho.tex`](paper/rho.tex) ([PDF](paper/rho.pdf)) — *"Rho: A Cognitive Architecture for Autonomous LLM Agents with Reinforcement Learning–Inspired Memory and Policy"* by J. Nesfield & Claude.

## What This Is

A library that provides:

- **Heartbeat loop**: Observe → Evaluate → Select → Act → Record
- **Tri-store memory**: Episodic (what happened), semantic (what I know), procedural (how to do things) — with write, read, manage (merge/reflect/forget) operations. Inspired by human cognitive memory and arXiv:2404.13501.
- **Rainbow-inspired replay**: Priority = novelty × usefulness (arXiv:1710.02298). Multi-step chaining, importance sampling correction, outcome distributions for procedural rules.
- **Policy engine**: Production-rule system (Soar-style) that constrains the select phase — safety blocks, escalation, skill boosts, impasse handling
- **Skills**: Self-contained capability packages (memory, policy, code-search, arxiv-research, skill-sequencer, blackboard, replay-buffer)
- **Replay buffer**: Multimodal experience memory with indexing, querying, 5 sampling strategies (episodic memory backing store)
- **Blackboard**: Segmented observation board with lens-based visibility — unified read surface for all 3 memory stores
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
│            │+ rainbow │  └──────────────────┘            │
│            │ priority │                                   │
│            └──────────┘                                   │
└───────────────────────────────────────────────────────────┘
```

## Quick Start

### Docker (interactive pi session)

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

## Rainbow-Inspired Memory Prioritization

Adapted from Rainbow DQN (arXiv:1710.02298) — the idea that **not all experiences are equally worth replaying**. Six DQN improvements mapped to agent memory:

| Rainbow Component | DQN Role | Agent Memory Analog |
|---|---|---|
| **Prioritized Replay** | Sample ∝ \|TD error\| | Priority = novelty × usefulness |
| **Multi-step Returns** | n-step reward propagation | Temporal chaining (±3 heartbeats) |
| **Distributional RL** | Learn return distribution | Outcome variance per rule |
| **Double Q** | Decouple select from eval | Our evaluate/select separation |
| **Dueling Networks** | State value vs action advantage | State vs action attribution |
| **Noisy Nets** | Learned exploration | Exploration policy tuning |

### Priority Scoring

```
P(i) ∝ (novelty × usefulness × recency)^ω

Novelty   = 0.6·(1 - freq(action)) + 0.4·|outcome - E[outcome]|
Usefulness = min(1, fail_bonus + rarity_bonus + 0.5)
Recency   = 0.3 + 0.7·(rank / N)
```

New transitions enter with maximum priority (bias towards recent). Importance sampling weights correct for non-uniform sampling: `w_i = (N·P(i))^(-β) / max(w)`.

### 5 Sampling Strategies

```bash
node skills/replay-buffer/scripts/sample.mjs --buffer ./buf --size 32 --strategy rainbow
# Strategies: uniform, prioritized, recent, failures, rainbow
# Rainbow params: --omega 0.6 --beta 0.4
```

### Outcome Distributions (Distributional RL Analog)

Procedural rules track a sliding window of outcomes, not just mean confidence:

```
confidence = (successes + 1) / (total + 2)    # Laplace smoothing
variance   = Σ(outcome - mean)² / N           # How reliable?
novelty    = |actual - expected|               # How surprising?
usefulness = √variance + (1-confidence)·0.5    # Learning potential
```

High-variance rules have more to teach. Surprising outcomes get prioritized for replay.

## Tri-Store Cognitive Memory

Three memory stores modeled after human cognition (episodic, semantic, procedural),
with structured Write/Read/Manage operations from arXiv:2404.13501.

```
Replay Buffer (raw transitions)       ← Episodic: "what happened"
    ↓ [reflection]
Semantic Memory (entities, facts)      ← Semantic: "what I know"
    ↓ [distillation]
Procedural Memory (rules, procedures)  ← Procedural: "how to do things"
    ↓ [policy integration]
Select Phase (codified decisions)
```

**Manage operations** (the missing piece most agents lack):
- **Merge**: Deduplicate entities, combine overlapping facts
- **Reflect**: Promote episodic patterns → semantic facts → procedural rules
- **Forget**: Ebbinghaus-inspired decay — prune stale, low-confidence entries
- **Compact**: Enforce budgets (1000 episodic, 500 semantic, 200 procedural)

```bash
# Write to stores
node skills/memory/scripts/write.mjs --store semantic --dir /tmp/mem \
  --entity '{"id":"react","type":"framework","facts":["component-based","uses JSX"]}'
node skills/memory/scripts/write.mjs --store procedural --dir /tmp/mem \
  --rule '{"id":"read-docs-first","description":"Read docs before implementing","confidence":0.85}'

# Read across all stores
node skills/memory/scripts/read.mjs --store all --dir /tmp/mem --query "authentication"

# Manage: reflect, merge, forget, compact
node skills/memory/scripts/manage.mjs --dir /tmp/mem --operation all

# Inspect full memory state
node skills/memory/scripts/inspect.mjs --dir /tmp/mem
```

## Policy Engine

Production-rule system inspired by Soar/CoALA (arXiv:2309.02427). The policy file
is a set of codified rules that the `select()` phase checks **before** falling back
to LLM-scored greedy selection.

**Priority tiers**: 1000+ safety, 500-999 lifecycle, 100-499 behavioral, 1-99 preference.

**Effects**: `block`, `override`, `boost`, `filter`, `rewrite`, `escalate`, `log`.

**Impasse handling** (from Soar): Consecutive failures, repeated actions, no-progress → escalate. Workers know their limits.

```bash
node skills/policy/scripts/validate.mjs policies/worker-default.json
node skills/policy/scripts/evaluate.mjs --policy policies/worker-default.json --candidates candidates.json
```

## Skills

| Skill | Scripts | Purpose |
|-------|---------|---------|
| **memory** | write, read, manage, inspect | Tri-store cognitive memory (episodic/semantic/procedural) |
| **policy** | evaluate, validate | Production-rule policy engine |
| **code-search** | index-repo, search, batch-search | Multi-stream semantic code search across git repos |
| **arxiv-research** | search, metadata, download-source, extract-algorithms | Academic paper pipeline |
| **skill-sequencer** | compile, run, list | Compile skills → deterministic sequences |
| **blackboard** | render, read-scratchpad, read-memory | Segmented observation board (legacy — now in src/blackboard.ts) |
| **replay-buffer** | record, query, replay, sample | Rainbow-prioritized experience replay |

## Actions

**Primitives** (one step, one heartbeat):

| Category | Actions |
|----------|---------|
| File I/O | `bash`, `read`, `write`, `edit` |
| Search | `grep`, `find`, `ls` |
| Control | `update_memory`, `delegate`, `message`, `complete`, `wait` |

**Skills** (multi-step sequence via Options framework — Sutton, Precup & Singh 1999):

```json
{ "kind": "skill", "skillName": "arxiv-research", "goal": "Extract DQN algorithm from 1312.5602" }
```

## Project Structure

```
paper/
├── rho.tex           LaTeX source — our arXiv paper
└── rho.pdf           Compiled PDF

src/
├── types.ts          Core types (State, Action, LoopContext, LoopEvent, ...)
├── agent-loop.ts     Abstract base class — heartbeat loop + recordTransition
├── blackboard.ts     Zoned canvas — observe surface with lens rendering + HTML output
├── single-agent.ts   Full agent: blackboard observe, policy select, tri-memory record
├── main.ts           Demo runner
└── index.ts          Public API

skills/
├── memory/           Tri-store cognitive memory (write/read/manage/inspect)
├── policy/           Production-rule policy engine (evaluate, validate)
├── code-search/      Semantic search across git repos (index, search, batch-search)
├── arxiv-research/   Search arXiv, download LaTeX, extract algorithms
├── skill-sequencer/  Compile skills → deterministic JSON sequences
├── blackboard/       Legacy lens rendering (superseded by src/blackboard.ts)
└── replay-buffer/    Rainbow-prioritized experience replay (record/query/sample/replay)

policies/
└── worker-default.json   Default worker policy (safety + escalation + preferences)

tests/
├── rho-prompts.md    13 interactive test prompts for TUI
└── ...
```

## References

- **Rainbow** — Hessel et al. [arXiv:1710.02298](https://arxiv.org/abs/1710.02298). Prioritized replay, distributional RL → novelty × usefulness scoring.
- **CoALA** — Sumers, Yao et al. [arXiv:2309.02427](https://arxiv.org/abs/2309.02427). Cognitive architectures → production-rule policy.
- **Memory Survey** — Zhang et al. [arXiv:2404.13501](https://arxiv.org/abs/2404.13501). Tri-store memory (write/manage/read).
- **Glyph** — Cheng et al. [arXiv:2510.17800](https://arxiv.org/abs/2510.17800). Visual context compression → dense layout principles.
- **DQN** — Mnih et al. [arXiv:1312.5602](https://arxiv.org/abs/1312.5602). Experience replay buffer.
- **MACLA** — Forouzandeh et al. [arXiv:2512.18950](https://arxiv.org/abs/2512.18950). Hierarchical procedural memory with Bayesian selection.
- **Latent Context Compilation** — [arXiv:2602.21221](https://arxiv.org/abs/2602.21221). Context compression into portable buffer tokens. Analogous to memory compaction.
- **C3 (Context Cascade Compression)** — [arXiv:2511.15244](https://arxiv.org/abs/2511.15244). 40× text compression; forgetting pattern mirrors Ebbinghaus human memory decay.
- **IC-Former (In-Context Former)** — [arXiv:2406.13618](https://arxiv.org/abs/2406.13618). Cross-attention context compression with learnable digest tokens.
- **Learning by Cheating** — Chen et al. [arXiv:1912.12294](https://arxiv.org/abs/1912.12294). Executive/worker hierarchy.
- **Options Framework** — Sutton, Precup & Singh (1999). Primitive + skill actions.
- **RepoRift** — Jain et al. [arXiv:2408.11058](https://arxiv.org/abs/2408.11058). Multi-stream semantic code search.
- **Pi & Mom** — [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono). SDK foundation.

## Status

- ✅ Heartbeat loop with primitives + skills (Options framework)
- ✅ Blackboard canvas (zoned, lens-filtered, text+HTML dual render, Glyph-dense layout)
- ✅ Tri-store cognitive memory (episodic/semantic/procedural + merge/reflect/forget)
- ✅ Rainbow-inspired replay: novelty × usefulness priority, multi-step chaining, IS weights, outcome distributions
- ✅ Policy engine (production rules, safety, escalation, impasse detection)
- ✅ Replay buffer with 5 strategies (uniform/prioritized/recent/failures/rainbow)
- ✅ Skill sequencer (compile → run)
- ✅ Semantic code search (multi-stream, multi-repo)
- ✅ arXiv paper ([`paper/rho.pdf`](paper/rho.pdf))
- 🔜 Executive + Worker agents with delegation and policy propagation
- 🔜 Context compression integration (Latent Context Compilation / C3 / IC-Former)
- 📋 Trace distillation, learned policies, self-modifying rules

## License

MIT
