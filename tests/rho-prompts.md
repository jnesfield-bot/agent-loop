# Rho Test Prompts

Copy-paste these into the pi TUI one at a time. Each tests a specific skill or system.
All scripts and files are under `/app/` in the Docker container.

---

## 1. Policy — Validate

```
Run: node /app/skills/policy/scripts/validate.mjs --policy /app/policies/worker-default.json
```

**Expected**: Shows valid=true, 10 rules, 4 priority tiers.

---

## 2. Policy — Block Dangerous Action

```
First create /tmp/test-candidates.json with this content:
[{"action":{"kind":"primitive","type":"bash","description":"delete","params":{"command":"rm -rf /"}},"value":0.9,"reasoning":"bad"},{"action":{"kind":"primitive","type":"read","description":"read","params":{"path":"README.md"}},"value":0.7,"reasoning":"safe"}]

Then run: node /app/skills/policy/scripts/evaluate.mjs --policy /app/policies/worker-default.json --candidates /tmp/test-candidates.json

Show me which action gets selected.
```

**Expected**: The rm -rf is blocked by safety rule, read README.md is selected instead.

---

## 3. Code Search — Index + Search

```
Run these two commands:
1. node /app/skills/code-search/scripts/index-repo.mjs /app --output /tmp/cs-index.json --lang ts
2. node /app/skills/code-search/scripts/search.mjs "record a transition into replay buffer" --index /tmp/cs-index.json --top 3
```

**Expected**: Indexes src/*.ts, finds SingleAgent class and/or recordTransition method.

---

## 4. arXiv — Search

```
Run: node /app/skills/arxiv-research/scripts/search.mjs "attention is all you need" --max 1
```

**Expected**: Finds paper 1706.03762 (Vaswani et al., "Attention Is All You Need").

---

## 5. arXiv — Metadata

```
Run: node /app/skills/arxiv-research/scripts/metadata.mjs 2309.02427
```

**Expected**: Returns CoALA paper — "Cognitive Architectures for Language Agents" by Sumers, Yao et al.

---

## 6. Skill Sequencer — Compile + Dry Run

```
Run these two commands:
1. node /app/skills/skill-sequencer/scripts/compile.mjs /app/skills/arxiv-research "Download and extract algorithms from DQN paper arXiv:1312.5602" /tmp/test-seq.json
2. node /app/skills/skill-sequencer/scripts/run.mjs /tmp/test-seq.json --dry-run
```

**Expected**: Generates a 4-5 step sequence. Dry run shows each step without executing.

---

## 7. Blackboard — Render All Lenses

```
Run these 4 commands to compare lens outputs:

echo '{"timestamp":1741754128000,"heartbeat":5,"currentTask":{"description":"implement login page","successCriteria":["tests pass"],"constraints":[],"priority":5},"memory":{"framework":"react"},"children":[{"id":"c1","status":"running","task":"build form"}],"inputs":[{"source":"user","content":"use React","metadata":{},"timestamp":0}],"lastActionResult":{"success":true,"output":"compiled","durationMs":500},"availableSkills":[{"name":"code-search","description":"search code"}],"activeSkill":null,"observations":{"workspace_files":"src/App.tsx"}}' | node /app/skills/blackboard/scripts/render.mjs --lens executive

echo '{"timestamp":1741754128000,"heartbeat":5,"currentTask":{"description":"implement login page","successCriteria":["tests pass"],"constraints":[],"priority":5},"memory":{"framework":"react"},"children":[{"id":"c1","status":"running","task":"build form"}],"inputs":[{"source":"user","content":"use React","metadata":{},"timestamp":0}],"lastActionResult":{"success":true,"output":"compiled","durationMs":500},"availableSkills":[{"name":"code-search","description":"search code"}],"activeSkill":null,"observations":{"workspace_files":"src/App.tsx"}}' | node /app/skills/blackboard/scripts/render.mjs --lens worker

echo '{"timestamp":1741754128000,"heartbeat":5,"currentTask":{"description":"implement login page","successCriteria":["tests pass"],"constraints":[],"priority":5},"memory":{"framework":"react"},"children":[{"id":"c1","status":"running","task":"build form"}],"inputs":[{"source":"user","content":"use React","metadata":{},"timestamp":0}],"lastActionResult":{"success":true,"output":"compiled","durationMs":500},"availableSkills":[{"name":"code-search","description":"search code"}],"activeSkill":null,"observations":{"workspace_files":"src/App.tsx"}}' | node /app/skills/blackboard/scripts/render.mjs --lens monitor

echo '{"timestamp":1741754128000,"heartbeat":5,"currentTask":{"description":"implement login page","successCriteria":["tests pass"],"constraints":[],"priority":5},"memory":{"framework":"react"},"children":[{"id":"c1","status":"running","task":"build form"}],"inputs":[{"source":"user","content":"use React","metadata":{},"timestamp":0}],"lastActionResult":{"success":true,"output":"compiled","durationMs":500},"availableSkills":[{"name":"code-search","description":"search code"}],"activeSkill":null,"observations":{"workspace_files":"src/App.tsx"}}' | node /app/skills/blackboard/scripts/render.mjs --lens minimal
```

**Expected**: Executive shows everything. Worker shows task+memory+skills but not inputs. Monitor shows task+children+last result. Minimal shows only task.

---

## 8. Replay Buffer — Record + Query + Sample

```
Run these commands in order:

echo '{"heartbeat":1,"board":"board 1","agentId":"test","episodeId":"ep-test","action":{"kind":"primitive","type":"bash","params":{}},"result":{"success":true,"output":"ok","durationMs":100},"candidates":[]}' | node /app/skills/replay-buffer/scripts/record.mjs --buffer /tmp/test-buf

echo '{"heartbeat":2,"board":"board 2","agentId":"test","episodeId":"ep-test","action":{"kind":"primitive","type":"bash","params":{}},"result":{"success":false,"output":"error","durationMs":200},"candidates":[]}' | node /app/skills/replay-buffer/scripts/record.mjs --buffer /tmp/test-buf

echo '{"heartbeat":3,"board":"board 3","agentId":"test","episodeId":"ep-test","action":{"kind":"primitive","type":"read","params":{}},"result":{"success":true,"output":"content","durationMs":50},"candidates":[]}' | node /app/skills/replay-buffer/scripts/record.mjs --buffer /tmp/test-buf

node /app/skills/replay-buffer/scripts/query.mjs --buffer /tmp/test-buf --stats
node /app/skills/replay-buffer/scripts/query.mjs --buffer /tmp/test-buf --success false
node /app/skills/replay-buffer/scripts/sample.mjs --buffer /tmp/test-buf --size 2 --strategy prioritized
```

**Expected**: 3 transitions stored. 1 failure found. 2 prioritized samples returned.

---

## 9. Replay Buffer — Episode Replay

```
Run: node /app/skills/replay-buffer/scripts/replay.mjs --buffer /tmp/test-buf --episode ep-test
```

**Expected**: Shows all 3 steps in order. (Run after prompt 8.)

---

## 10. End-to-End — Full Research Pipeline

```
Run these commands:
1. node /app/skills/skill-sequencer/scripts/compile.mjs /app/skills/arxiv-research "Find the PPO algorithm from arXiv:1707.06347" /tmp/ppo-seq.json
2. node /app/skills/skill-sequencer/scripts/run.mjs /tmp/ppo-seq.json
```

**Expected**: Compiles sequence → runs all steps → searches, gets metadata, downloads source, extracts algorithms from the PPO paper.

---

## 11. Code Search — Batch Search External Repo

```
Run: node /app/skills/code-search/scripts/batch-search.mjs "evaluate policy rules against state" --repo https://github.com/jnesfield-bot/agent-loop.git --top 5
```

**Expected**: Clones repo, indexes it, finds evaluatePolicy function in policy evaluate script.

---

## 12. Policy — Custom Rule Test

```
Write this to /tmp/custom-policy.json:
{"version":1,"name":"custom-test","rules":[{"id":"block-curl","priority":1000,"precondition":{"type":"action_match","field":"params.command","pattern":"curl"},"effect":"block","message":"No curl allowed"},{"id":"testing-override","priority":500,"precondition":{"type":"task_match","pattern":"testing"},"effect":"override","action":{"kind":"primitive","type":"read","description":"read test file","params":{"path":"test-all.sh"}}},{"id":"boost-search","priority":50,"precondition":{"type":"task_match","pattern":"find function"},"effect":"boost","skillName":"code-search","boostValue":0.5}]}

Then run: node /app/skills/policy/scripts/validate.mjs --policy /tmp/custom-policy.json
```

**Expected**: Valid policy, 3 rules, 1 safety, 1 lifecycle, 1 preference tier.

---

## Quick Smoke Test (one prompt, all skills)

```
Run all 6 of these commands and tell me if each succeeds:
1. node /app/skills/policy/scripts/validate.mjs --policy /app/policies/worker-default.json
2. node /app/skills/code-search/scripts/index-repo.mjs /app --output /tmp/smoke-idx.json --lang ts
3. node /app/skills/code-search/scripts/search.mjs "heartbeat loop" --index /tmp/smoke-idx.json --top 1
4. node /app/skills/arxiv-research/scripts/metadata.mjs 1312.5602
5. echo '{"heartbeat":1,"currentTask":{"description":"smoke test"},"memory":{},"children":[],"inputs":[],"lastActionResult":null,"availableSkills":[],"activeSkill":null,"observations":{}}' | node /app/skills/blackboard/scripts/render.mjs --lens minimal
6. echo '{"heartbeat":1,"board":"test","agentId":"smoke","episodeId":"ep-smoke","action":{"kind":"primitive","type":"bash","params":{}},"result":{"success":true,"output":"ok","durationMs":10},"candidates":[]}' | node /app/skills/replay-buffer/scripts/record.mjs --buffer /tmp/smoke-buf
```

**Expected**: All 6 succeed.

---

## Notes

- All paths use `/app/` (Docker workdir)
- Prompts 8-9 are sequential (9 depends on 8's data)
- arXiv prompts (4, 5, 10) need network access
- No extra API keys needed — just the Anthropic key for pi itself
