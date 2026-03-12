---
name: memory
description: Tri-store memory system inspired by human cognitive memory types (episodic, semantic, procedural) and the memory survey (arXiv:2404.13501). Provides structured Write/Manage/Read operations with merging, reflection, and forgetting.
---

# Memory — Tri-Store Cognitive Memory System

Three memory stores modeled after human cognition, each with different
retention, access patterns, and management strategies.

## The Three Stores

### 1. Episodic Memory — "What happened"
Personal experiences in chronological order. Each entry is a timestamped
event with context. Used for pattern recognition, failure analysis, and
"have I seen this before?" queries.

**Backed by**: Replay buffer (already exists). Every heartbeat transition
is an episode. This store adds indexing and retrieval on top.

```
┌──────────────────────────────────────────────────┐
│ EPISODIC: ep-abc123, heartbeat 7                  │
│ task: "implement login page"                      │
│ action: bash("npm test")                          │
│ result: FAIL — "Cannot find module './auth'"      │
│ context: was trying to run tests before writing   │
│ lesson: "write the module before testing it"      │
│ similarity: [ep-xyz456/hb3, ep-def789/hb12]       │
└──────────────────────────────────────────────────┘
```

**Operations**:
- Write: Auto-captured every heartbeat (replay buffer)
- Read: Similarity search ("when did I last fail at X?"), temporal range, episode replay
- Manage: Summarize old episodes into "lessons learned", forget details but keep insights

### 2. Semantic Memory — "What I know"
General knowledge, facts, and concepts extracted from experience and
external sources. Not tied to specific episodes. Structured as a
knowledge graph of entities and relationships.

**Backed by**: JSON store with entity nodes and relationship edges.
Populated by reflection over episodic memory and external knowledge.

```
┌──────────────────────────────────────────────────┐
│ SEMANTIC: entities                                │
│ ├── "React" → {type: framework, facts: [...]}     │
│ ├── "auth" → {type: module, deps: ["jwt","bcrypt"]}│
│ ├── "npm test" → {type: command, runs: "jest"}     │
│ └── "login" → {type: feature, requires: ["auth"]}  │
│                                                    │
│ relationships:                                     │
│ ├── "React" --uses--> "jsx"                        │
│ ├── "login" --requires--> "auth"                   │
│ └── "auth" --tested-by--> "npm test"               │
└──────────────────────────────────────────────────┘
```

**Operations**:
- Write: Extract entities/facts from episodic reflections or external sources
- Read: Entity lookup, relationship traversal, fact retrieval
- Manage: Merge duplicate entities, update confidence scores, prune stale facts

### 3. Procedural Memory — "How to do things"
Learned action patterns, rules, and skills. Represents "knowing how"
rather than "knowing what". Includes both explicit rules (policy file)
and learned patterns (from successful episodes).

**Backed by**: Policy rules (already exist) + learned procedure library.

```
┌──────────────────────────────────────────────────┐
│ PROCEDURAL: patterns                              │
│ ├── rule: "before testing, ensure module exists"   │
│ │   source: learned from ep-abc123                 │
│ │   confidence: 0.85 (3 successes, 1 failure)     │
│ ├── rule: "use arxiv-research for paper tasks"     │
│ │   source: policy/worker-default                  │
│ │   confidence: 1.0 (static rule)                  │
│ └── procedure: "setup-react-project"               │
│     steps: [npx create-react-app, npm install, ..]│
│     success_rate: 0.9 (9/10 episodes)             │
└──────────────────────────────────────────────────┘
```

**Operations**:
- Write: Extract patterns from successful episodes (distillation)
- Read: Match current state to known procedures, retrieve relevant rules
- Manage: Update confidence via Bayesian posteriors (like MACLA), prune low-confidence rules

## Memory Operations (from arXiv:2404.13501)

### Write (W)
Transform raw observations into stored memory entries.

```
m_t = W(action_t, observation_t)
```

- **Episodic**: Full transition → replay buffer (already automatic)
- **Semantic**: Extract entities, facts, relationships from the transition
- **Procedural**: If action succeeded → reinforce pattern; if failed → record anti-pattern

### Manage (P) — The Missing Piece
Process stored memory to make it more useful. Three sub-operations:

#### Merging
Combine redundant or overlapping entries:
- Episodic: Summarize sequences of similar episodes into "I tried X, it failed N times"
- Semantic: Merge duplicate entity references ("React.js" = "React" = "react")
- Procedural: Merge similar procedures into generalized patterns

#### Reflection
Generate higher-level insights from raw data:
- Episodic → Semantic: "I've failed at auth 3 times" → "auth module is complex, needs careful setup"
- Episodic → Procedural: "These 5 successful episodes all started with reading docs" → rule: "read docs first"
- Semantic → Procedural: "React requires jsx" + "project uses React" → "ensure jsx support is configured"

#### Forgetting (Ebbinghaus-inspired)
Remove stale or irrelevant information:
- Episodic: Decay old episodes — keep summaries, drop raw details after N heartbeats
- Semantic: Reduce confidence on facts not accessed recently
- Procedural: Decay unused rules, prune procedures with low success rates

```
Retention(t) = e^(-t/τ) · importance + recency_boost
```

Where τ is the decay constant, importance is based on usage frequency,
and recency_boost rewards recently accessed entries.

### Read (R)
Retrieve relevant memory for the current decision:

```
M_hat = R(M_t, context_{t+1})
```

- **Episodic**: Similarity search — "what happened last time I tried this?"
- **Semantic**: Entity/fact lookup — "what do I know about this module?"
- **Procedural**: Rule matching — "is there a known procedure for this?"

The blackboard's MEMORY segment is populated by Read operations across all 3 stores.

## Integration with Blackboard

The blackboard already has a MEMORY segment. Now it becomes a **unified view**
across all three stores, with the lens controlling what's visible:

```
══════ MEMORY ══════
[episodic] Last similar task: ep-xyz (5 heartbeats ago) — succeeded with read-first approach
[semantic] auth module: requires jwt, bcrypt; tested via "npm test"  
[procedural] Known procedure: "setup-react-project" (90% success rate)
[procedural] Rule: "read docs before implementing" (confidence: 0.85)
```

Executive lens: sees all 3 stores + cross-agent memory
Worker lens: sees own episodic + relevant semantic + matched procedural
Monitor lens: sees episodic summaries + procedural rule usage stats
Minimal lens: sees only matched procedural rules

## Integration with Replay Buffer

The replay buffer IS the episodic memory backing store. The memory skill
adds a retrieval layer on top:

```
Replay Buffer (raw transitions)
    ↓ [reflection]
Episodic Memory (indexed, summarized, with lessons)
    ↓ [reflection]  
Semantic Memory (extracted facts and relationships)
    ↓ [distillation]
Procedural Memory (learned rules and procedures)
```

## Integration with Policy

Procedural memory feeds the policy system:
- Static rules (hand-written) live in policy files
- Learned rules (from experience) are distilled into procedural memory
- Both are checked during the select phase
- Learned rules have confidence scores; static rules have confidence 1.0

## Memory Budget & Compaction

Each store has a budget (max entries). When exceeded, manage operations run:

| Store | Budget | Compaction Strategy |
|-------|--------|-------------------|
| Episodic | 1000 transitions | Summarize old episodes, keep last 100 raw |
| Semantic | 500 entities | Merge duplicates, prune low-confidence |
| Procedural | 200 rules | Prune unused, merge similar patterns |

Compaction is triggered when budget is exceeded OR every N heartbeats
(configurable). This directly addresses the context window problem —
instead of stuffing everything into the prompt, we reflect and compress.

## Scripts

| Script | Purpose |
|--------|---------|
| `write.mjs` | Write to any memory store (episodic auto-captured; semantic/procedural manual or via reflection) |
| `read.mjs` | Read from any store — similarity search, entity lookup, rule matching |
| `manage.mjs` | Run management operations — merge, reflect, forget |
| `inspect.mjs` | Dump memory state for debugging |

## Design Principles

1. **Three stores, one system.** Episodic, semantic, procedural are views on
   the same experience stream, at different abstraction levels.

2. **Reflection bridges stores.** Raw episodes → semantic facts → procedural
   rules. This is the learning loop. (Generative Agents, ExpeL, MACLA)

3. **Forgetting is healthy.** Ebbinghaus decay + importance weighting.
   Not everything needs to be remembered. Compaction > accumulation.

4. **Budget-constrained.** Each store has limits. Forces quality over quantity.
   This is the answer to unbounded context growth.

5. **Blackboard is the read surface.** Memory stores are internal. The
   blackboard is how the agent sees its memory during the heartbeat.

## References

- Memory Survey — Zhang et al. [arXiv:2404.13501](https://arxiv.org/abs/2404.13501)
- MACLA (procedural memory) — Forouzandeh et al. [arXiv:2512.18950](https://arxiv.org/abs/2512.18950)
- Generative Agents — Park et al. (2023). Reflection + importance + recency.
- MemGPT — Packer et al. [arXiv:2310.08560](https://arxiv.org/abs/2310.08560). OS-like memory management.
- ExpeL — Zhao et al. (2023). Cross-trial experience extraction.
- Ebbinghaus forgetting curve (1885). Retention decay model.
- CoALA — Sumers, Yao et al. [arXiv:2309.02427](https://arxiv.org/abs/2309.02427). Working + long-term memory.
