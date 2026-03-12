---
name: policy
description: Production-rule policy system for agent decision-making. A structured policy file defines codified rules (precondition → action) that the select phase evaluates deterministically before falling back to the LLM. Inspired by Soar/CoALA (arXiv:2309.02427) production systems and LLM-MAS (arXiv:2412.17481) environmental rules.
---

# Policy — Codified Rules for Agent Decision-Making

The policy file is the agent's "operating manual" — a set of codified
production rules that the select phase checks before asking the LLM to decide.

This is the Soar decision cycle applied to language agents:

1. **Match**: Check which rules' preconditions are satisfied by current state
2. **Propose**: Matching rules propose actions (override, filter, boost, block)
3. **Select**: Apply the highest-priority matching rule
4. **Fallback**: If no rules match, fall through to LLM-scored greedy selection
5. **Impasse**: If the agent is stuck (no progress, repeated failures), escalate

## Policy File Format

The policy file is a JSON document with ordered rules. Rules are evaluated
top-to-bottom; first match wins (like Soar's priority ordering, like iptables).

```json
{
  "version": 1,
  "name": "worker-default",
  "description": "Default policy for worker agents",
  "rules": [
    {
      "id": "safety-no-rm-rf",
      "description": "Never run rm -rf on root paths",
      "priority": 1000,
      "precondition": {
        "type": "action_match",
        "field": "params.command",
        "pattern": "rm\\s+-rf\\s+/"
      },
      "effect": "block",
      "message": "Blocked: dangerous rm -rf on root path"
    },
    {
      "id": "escalate-on-stuck",
      "description": "Escalate to executive after 3 consecutive failures",
      "priority": 900,
      "precondition": {
        "type": "consecutive_failures",
        "count": 3
      },
      "effect": "escalate",
      "message": "3 consecutive failures — requesting executive guidance"
    },
    {
      "id": "prefer-grep-over-bash-grep",
      "description": "When searching files, prefer grep primitive over bash grep",
      "priority": 100,
      "precondition": {
        "type": "action_match",
        "field": "params.command",
        "pattern": "^grep\\s"
      },
      "effect": "rewrite",
      "rewrite": {
        "type": "grep",
        "extractPattern": true
      }
    },
    {
      "id": "complete-when-criteria-met",
      "description": "Auto-complete when all success criteria are satisfied",
      "priority": 800,
      "precondition": {
        "type": "all_criteria_met"
      },
      "effect": "override",
      "action": {
        "kind": "primitive",
        "type": "complete",
        "description": "All success criteria met",
        "params": { "summary": "All success criteria satisfied" }
      }
    },
    {
      "id": "rate-limit-api-calls",
      "description": "Insert wait between rapid API calls",
      "priority": 200,
      "precondition": {
        "type": "rapid_actions",
        "actionType": "bash",
        "withinMs": 1000,
        "count": 5
      },
      "effect": "override",
      "action": {
        "kind": "primitive",
        "type": "wait",
        "description": "Rate limiting — too many rapid actions",
        "params": {}
      }
    },
    {
      "id": "boost-skill-for-research",
      "description": "Boost arxiv-research skill when task mentions papers or algorithms",
      "priority": 50,
      "precondition": {
        "type": "task_match",
        "pattern": "paper|arxiv|algorithm|implement.*from|research"
      },
      "effect": "boost",
      "skillName": "arxiv-research",
      "boostValue": 0.3
    }
  ],
  "impasse": {
    "noProgressHeartbeats": 5,
    "repeatedActionThreshold": 3,
    "escalateTarget": "parent",
    "escalateMessage": "Worker is stuck — requesting guidance"
  },
  "defaults": {
    "maxCandidates": 5,
    "minActionValue": 0.1,
    "explorationRate": 0.0
  }
}
```

## Rule Anatomy

Each rule has:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for logging/tracing |
| `description` | Human-readable purpose |
| `priority` | Higher = checked first. 1000+ = safety, 100-999 = behavioral, 1-99 = preference |
| `precondition` | When this rule fires (see precondition types below) |
| `effect` | What happens: `block`, `override`, `boost`, `filter`, `rewrite`, `escalate`, `log` |
| `message` | Optional message for logging/audit |

## Precondition Types

| Type | Fields | Matches when... |
|------|--------|-----------------|
| `action_match` | `field`, `pattern` | Selected action's field matches regex pattern |
| `state_match` | `field`, `pattern` | State field matches regex |
| `task_match` | `pattern` | Task description matches regex |
| `memory_match` | `key`, `pattern` | Memory key's value matches regex |
| `consecutive_failures` | `count` | N consecutive heartbeats failed |
| `all_criteria_met` | — | All task success criteria are satisfied |
| `rapid_actions` | `actionType`, `withinMs`, `count` | N actions of type within time window |
| `heartbeat_range` | `min`, `max` | Current heartbeat is in range |
| `child_status` | `status`, `count` | N children have given status |
| `value_below` | `threshold` | Top candidate value is below threshold |
| `always` | — | Always matches (default/fallback rules) |
| `custom` | `expression` | Evaluate a simple expression against state |

## Effect Types

| Effect | Description |
|--------|-------------|
| `block` | Reject the selected action. Fall to next candidate. |
| `override` | Replace the selected action with the rule's action. |
| `boost` | Add `boostValue` to candidates matching `skillName` or `actionType`. |
| `filter` | Remove candidates matching `actionType` or `pattern`. |
| `rewrite` | Transform the selected action (e.g., bash grep → structured grep). |
| `escalate` | Send a message to `escalateTarget` (parent/executive). |
| `log` | Log but don't change the action. For audit trails. |

## Using the Policy

### Load and evaluate

```bash
# Check which rules match a given state + action
node {baseDir}/scripts/evaluate.mjs --policy policy.json --state state.json --action action.json

# Validate a policy file
node {baseDir}/scripts/validate.mjs --policy policy.json
```

### Apply during select phase

The policy is loaded by the agent on startup and checked in the `select()` method:

1. Sort candidates by LLM-assigned value (as before)
2. For each candidate (highest value first):
   a. Run through policy rules top-to-bottom
   b. If a `block` rule matches → skip this candidate, try next
   c. If an `override` rule matches → use the override action instead
   d. If a `boost` rule matches → adjust value, re-sort
   e. If a `rewrite` rule matches → transform the action
   f. If a `filter` rule matches → remove matching candidates
3. If no candidates survive → check impasse rules → escalate or wait
4. Return the surviving action

### Escalation (impasse handling)

From Soar: when the agent can't decide (no rules match, no candidates above
threshold, or repeated failures), it creates a **subgoal** — in our case,
it escalates to the executive agent.

```json
{
  "impasse": {
    "noProgressHeartbeats": 5,
    "repeatedActionThreshold": 3,
    "escalateTarget": "parent",
    "escalateMessage": "Worker is stuck — requesting guidance"
  }
}
```

The executive receives the escalation as an input and can:
- Provide a new task brief with more specific instructions
- Override the worker's policy with additional rules
- Abort the worker and reassign the task

## Policy Priority Tiers

| Range | Purpose | Examples |
|-------|---------|---------|
| 1000+ | **Safety** | Block dangerous commands, prevent data loss |
| 500-999 | **Lifecycle** | Escalate on failure, auto-complete on success |
| 100-499 | **Behavioral** | Prefer structured tools, rate limiting |
| 1-99 | **Preference** | Boost relevant skills, style preferences |

## Self-Modifying Policy

From Soar's chunking mechanism: the agent can write new rules into its
policy file based on experience. After a successful skill execution, the
agent might add:

```json
{
  "id": "learned-use-arxiv-for-papers",
  "description": "Learned: arxiv-research skill works well for paper tasks",
  "priority": 60,
  "precondition": { "type": "task_match", "pattern": "paper|arxiv|citation" },
  "effect": "boost",
  "skillName": "arxiv-research",
  "boostValue": 0.4,
  "source": "learned",
  "learnedAt": "2026-03-12T06:00:00Z",
  "evidence": "ep-abc123, heartbeat 7: arxiv-research completed successfully"
}
```

This is the distillation mechanism from Phase 3: trace data → codified rules.

## Design Principles

1. **Rules are data, not code.** The policy file is JSON — readable, editable,
   versionable, shareable. An executive can send a policy to a worker.

2. **Production systems, not if/else trees.** Rules have preconditions and
   effects. The engine matches, proposes, and selects — like Soar.

3. **Safety first.** High-priority rules can block dangerous actions regardless
   of what the LLM wants. The LLM proposes, the policy constrains.

4. **Escalation is not failure.** Impasse → escalate is healthy. It means the
   worker knows its limits. Better than flailing.

5. **Learnable.** Rules can be added from experience. The policy grows over
   time. This is the bridge from Phase 1 (static rules) to Phase 3 (learned).
