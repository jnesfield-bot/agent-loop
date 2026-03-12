# Rho Test Prompts

Copy-paste these into the pi TUI one at a time. Each tests a specific skill or system.

---

## 1. Policy — Validate

```
Run the policy validator on policies/worker-default.json and show me the results.
```

**Expected**: Shows valid=true, 10 rules, 4 priority tiers (2 safety, 4 lifecycle, 1 behavioral, 3 preference). May show warnings about duplicate priorities.

---

## 2. Policy — Block Dangerous Action

```
Create a file /tmp/test-candidates.json with two candidate actions: one that runs "rm -rf /" with value 0.9, and one that runs "cat README.md" with value 0.5. Then run the policy evaluator against policies/worker-default.json with those candidates and show me which action gets selected.
```

**Expected**: The rm -rf is blocked by safety rule, cat README.md is selected instead.

---

## 3. Code Search — Index + Search

```
Use the code-search skill to index this repo's TypeScript source, then search for "record a transition into replay buffer". Show me the top 3 results.
```

**Expected**: Indexes src/*.ts, finds SingleAgent class and/or recordTransition method.

---

## 4. arXiv — Search

```
Use the arxiv-research skill to search for "attention is all you need" and show me the top result.
```

**Expected**: Finds paper 1706.03762 (Vaswani et al., "Attention Is All You Need").

---

## 5. arXiv — Metadata

```
Get the metadata for arXiv paper 2309.02427 using the arxiv-research skill.
```

**Expected**: Returns CoALA paper — "Cognitive Architectures for Language Agents" by Sumers, Yao et al.

---

## 6. Skill Sequencer — Compile + Dry Run

```
Compile the arxiv-research skill into a sequence for the goal "Download and extract algorithms from the DQN paper arXiv:1312.5602", save it to /tmp/test-seq.json, then do a dry run of that sequence.
```

**Expected**: Generates a 4-5 step sequence (search → metadata → download → extract). Dry run shows each step without executing.

---

## 7. Blackboard — Render All Lenses

```
Create a sample agent state as JSON with heartbeat 5, a task "implement login page", memory key "framework" = "react", one child with status "running", and one available skill "code-search". Then render it through all 4 blackboard lenses (executive, worker, monitor, minimal) and compare what each shows.
```

**Expected**: Executive shows everything. Worker shows task + memory + skills but not inputs. Monitor shows task + children + last result. Minimal shows only task.

---

## 8. Replay Buffer — Record + Query + Sample

```
Record 5 transitions into a replay buffer at /tmp/test-replay: heartbeats 1-5, alternating success/failure, all with action type "bash" and episode "ep-test". Then query for just the failures, and sample 2 transitions using the "prioritized" strategy.
```

**Expected**: 5 transitions stored. Query returns 2 failures (heartbeats 2, 4). Prioritized sample returns 2 transitions biased toward failures.

---

## 9. Replay Buffer — Episode Replay

```
Replay episode "ep-test" from /tmp/test-replay step by step.
```

**Expected**: Shows all 5 steps in order with heartbeat numbers, actions, results, and success/failure status. (Run after prompt 8.)

---

## 10. End-to-End — Full Research Pipeline

```
Use the skill sequencer to compile and run a full arxiv-research sequence for the goal "Find the PPO algorithm from arXiv:1707.06347". Execute all steps.
```

**Expected**: Compiles sequence → runs search (finds PPO paper) → gets metadata → downloads source → extracts algorithms. Should find the PPO clipping objective.

---

## 11. Code Search — Batch Search External Repo

```
Use the code-search batch-search to clone https://github.com/jnesfield-bot/agent-loop.git and search for "evaluate policy rules against state" with top 5 results.
```

**Expected**: Clones repo, indexes it, finds the evaluatePolicy function in skills/policy/scripts/evaluate.mjs.

---

## 12. Policy — Custom Rule Test

```
Create a custom policy file at /tmp/test-policy.json with these rules:
1. Block any bash command containing "curl" (priority 1000)
2. Override: if task mentions "testing", always select a "read" action on "test-all.sh" (priority 500)
3. Boost code-search by 0.5 when task mentions "find function" (priority 50)

Then validate it.
```

**Expected**: Creates valid policy. Validator shows 3 rules, 1 safety tier, 1 lifecycle tier, 1 preference tier.

---

## Quick Smoke Test (all skills, one prompt)

```
Run these commands in sequence and tell me if each succeeds:
1. node skills/policy/scripts/validate.mjs policies/worker-default.json
2. node skills/code-search/scripts/index-repo.mjs . --output /tmp/smoke-idx.json --lang ts
3. node skills/code-search/scripts/search.mjs "heartbeat loop" --index /tmp/smoke-idx.json --top 1
4. node skills/arxiv-research/scripts/metadata.mjs 1312.5602
5. echo '{"heartbeat":1,"currentTask":{"description":"smoke test"},"memory":{},"children":[],"inputs":[],"lastActionResult":null,"availableSkills":[],"activeSkill":null,"observations":{}}' | node skills/blackboard/scripts/render.mjs --lens minimal
6. echo '{"heartbeat":1,"board":"test","agentId":"smoke","episodeId":"ep-smoke","action":{"kind":"primitive","type":"bash","params":{}},"result":{"success":true,"output":"ok","durationMs":10},"candidates":[]}' | node skills/replay-buffer/scripts/record.mjs --buffer /tmp/smoke-buf
```

**Expected**: All 6 succeed. Quick confirmation that every skill's scripts are functional.

---

## Notes

- All prompts work from the repo root (`/tmp/agent-loop/`)
- Prompts 8-9 are sequential (9 depends on 8's data)
- arXiv prompts (4, 5, 10) need network access
- No API keys needed except the Anthropic key for pi itself
