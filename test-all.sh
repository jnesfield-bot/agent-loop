#!/bin/bash
# Test all skills in the agent-loop / rho framework.
# Run from the repo root: ./test-all.sh
# No API keys needed — all tests are local/offline (except arXiv which hits the API).

set -e
PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭ $1"; SKIP=$((SKIP+1)); }

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║        Agent Loop / Rho — Full Test Suite        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. arXiv Research ────────────────────────────────────
echo "▸ arxiv-research"

# Search (hits arXiv API — needs network)
RESULT=$(node skills/arxiv-research/scripts/search.mjs "attention is all you need" --max 1 2>/dev/null || echo "FAIL")
if echo "$RESULT" | grep -q "1706.03762"; then
  pass "search: found Transformer paper (1706.03762)"
else
  fail "search: did not find 1706.03762"
fi

# Metadata
RESULT=$(node skills/arxiv-research/scripts/metadata.mjs 1312.5602 2>/dev/null || echo "FAIL")
if echo "$RESULT" | grep -q "Playing Atari"; then
  pass "metadata: got DQN paper title"
else
  fail "metadata: did not get DQN paper"
fi

# Download + extract (uses cached source if available)
if [ -d "/tmp/dqn-src" ]; then
  RESULT=$(node skills/arxiv-research/scripts/extract-algorithms.mjs /tmp/dqn-src 2>/dev/null || echo "FAIL")
  if echo "$RESULT" | grep -q "Deep Q-learning"; then
    pass "extract-algorithms: found DQN algorithm"
  else
    fail "extract-algorithms: did not find algorithm"
  fi
else
  skip "extract-algorithms: /tmp/dqn-src not available (run download-source first)"
fi

echo ""

# ── 2. Skill Sequencer ──────────────────────────────────
echo "▸ skill-sequencer"

# Compile
RESULT=$(node skills/skill-sequencer/scripts/compile.mjs skills/arxiv-research "Find DQN from 1312.5602" /tmp/test-seq.json 2>/dev/null || echo "FAIL")
if [ -f /tmp/test-seq.json ] && grep -q "1312.5602" /tmp/test-seq.json; then
  pass "compile: generated sequence with paper ID"
else
  fail "compile: did not produce valid sequence"
fi

# Dry run
RESULT=$(node skills/skill-sequencer/scripts/run.mjs /tmp/test-seq.json --dry-run 2>&1 || echo "FAIL")
if echo "$RESULT" | grep -q "DRY RUN"; then
  pass "run --dry-run: steps shown without execution"
else
  fail "run --dry-run: did not show dry run output"
fi

echo ""

# ── 3. Blackboard ────────────────────────────────────────
echo "▸ blackboard"

STATE='{"timestamp":1741754128000,"heartbeat":3,"currentTask":{"description":"Test task","successCriteria":["pass tests"],"constraints":[],"priority":5},"memory":{"key1":"val1"},"children":[],"inputs":[{"source":"user","content":"hello","metadata":{},"timestamp":0}],"lastActionResult":null,"availableSkills":[{"name":"test-skill","description":"test"}],"activeSkill":null,"observations":{"workspace_files":"src/main.ts"}}'

# Executive lens
RESULT=$(echo "$STATE" | node skills/blackboard/scripts/render.mjs --lens executive 2>/dev/null)
if echo "$RESULT" | grep -q "BOARD #3" && echo "$RESULT" | grep -q "TASK" && echo "$RESULT" | grep -q "INPUTS"; then
  pass "render executive: shows board, task, inputs"
else
  fail "render executive: missing sections"
fi

# Worker lens (should NOT have inputs)
RESULT=$(echo "$STATE" | node skills/blackboard/scripts/render.mjs --lens worker 2>/dev/null)
if echo "$RESULT" | grep -q "TASK" && ! echo "$RESULT" | grep -q "INPUTS"; then
  pass "render worker: shows task, hides inputs"
else
  fail "render worker: wrong segmentation"
fi

# Minimal lens
RESULT=$(echo "$STATE" | node skills/blackboard/scripts/render.mjs --lens minimal 2>/dev/null)
if echo "$RESULT" | grep -q "TASK" && ! echo "$RESULT" | grep -q "MEMORY"; then
  pass "render minimal: task only, no memory"
else
  fail "render minimal: wrong segmentation"
fi

echo ""

# ── 4. Replay Buffer ────────────────────────────────────
echo "▸ replay-buffer"

BUFDIR="/tmp/test-buffer-$$"

# Record 3 transitions
for i in 1 2 3; do
  SUCCESS=$( [ $i -eq 3 ] && echo "false" || echo "true" )
  echo "{\"heartbeat\":$i,\"board\":\"board $i\",\"agentId\":\"test\",\"episodeId\":\"ep-t\",\"action\":{\"kind\":\"primitive\",\"type\":\"bash\",\"params\":{}},\"result\":{\"success\":$SUCCESS,\"output\":\"out $i\",\"durationMs\":$((i*100))},\"candidates\":[{\"action\":{\"type\":\"bash\"},\"value\":0.$i,\"reasoning\":\"r\"}]}" | \
    node skills/replay-buffer/scripts/record.mjs --buffer "$BUFDIR" >/dev/null 2>&1
done

RESULT=$(node skills/replay-buffer/scripts/query.mjs --buffer "$BUFDIR" --stats 2>/dev/null)
if echo "$RESULT" | grep -q '"totalTransitions": 3'; then
  pass "record + query: 3 transitions stored"
else
  fail "record + query: wrong count"
fi

# Failures
RESULT=$(node skills/replay-buffer/scripts/query.mjs --buffer "$BUFDIR" --success false 2>/dev/null)
if echo "$RESULT" | grep -q '"count": 1'; then
  pass "query failures: found 1 failure"
else
  fail "query failures: wrong count"
fi

# Replay
RESULT=$(node skills/replay-buffer/scripts/replay.mjs --buffer "$BUFDIR" --episode ep-t 2>&1)
if echo "$RESULT" | grep -q "Heartbeat #1" && echo "$RESULT" | grep -q "3 steps"; then
  pass "replay: shows all 3 steps"
else
  fail "replay: incomplete output"
fi

# Sample
RESULT=$(node skills/replay-buffer/scripts/sample.mjs --buffer "$BUFDIR" --size 2 --strategy uniform 2>/dev/null)
if echo "$RESULT" | grep -q '"sampled": 2'; then
  pass "sample: got 2 uniform samples"
else
  fail "sample: wrong sample count"
fi

rm -rf "$BUFDIR"
echo ""

# ── 5. Policy Engine ────────────────────────────────────
echo "▸ policy"

# Validate
RESULT=$(node skills/policy/scripts/validate.mjs policies/worker-default.json 2>/dev/null)
if echo "$RESULT" | grep -q '"valid": true'; then
  pass "validate: worker-default.json is valid"
else
  fail "validate: worker-default.json has errors"
fi

# Block rm -rf
CANDIDATES='[{"action":{"kind":"primitive","type":"bash","description":"delete","params":{"command":"rm -rf /"}},"value":0.9,"reasoning":"bad"},{"action":{"kind":"primitive","type":"read","description":"read","params":{"path":"README.md"}},"value":0.7,"reasoning":"safe"}]'
RESULT=$(echo "" | node skills/policy/scripts/evaluate.mjs --policy policies/worker-default.json --candidates <(echo "$CANDIDATES") 2>/dev/null)
if echo "$RESULT" | grep -q '"type": "read"' && echo "$RESULT" | grep -q "block"; then
  pass "apply: blocks rm -rf, selects read instead"
else
  fail "apply: did not block dangerous action"
fi

echo ""

# ── 6. Code Search ───────────────────────────────────────
echo "▸ code-search"

# Index our own repo
RESULT=$(node skills/code-search/scripts/index-repo.mjs . --output /tmp/test-cs-index.json --lang ts 2>&1)
if echo "$RESULT" | grep -q "Indexed:" && [ -f /tmp/test-cs-index.json ]; then
  pass "index-repo: indexed agent-loop TypeScript"
else
  fail "index-repo: indexing failed"
fi

# Search
RESULT=$(node skills/code-search/scripts/search.mjs "discover skills from directories" --index /tmp/test-cs-index.json --top 3 2>/dev/null)
if echo "$RESULT" | grep -q "resultCount"; then
  pass "search: returned results"
else
  fail "search: no results"
fi

rm -f /tmp/test-cs-index.json
echo ""

# ── Summary ──────────────────────────────────────────────
echo "─── Summary ───"
echo "  ✓ $PASS passed   ✗ $FAIL failed   ⏭ $SKIP skipped"
echo ""

[ $FAIL -eq 0 ] && echo "  All tests passed! 🎉" || echo "  Some tests failed."
exit $FAIL
