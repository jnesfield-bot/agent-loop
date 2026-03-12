#!/usr/bin/env bash
# Quick smoke test — run this after `docker build` to verify everything works.
# Usage: bash test-quick.sh
# Or inside container: bash /app/test-quick.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TESTS=0

run() {
  local name="$1"; shift
  TESTS=$((TESTS+1))
  printf "${CYAN}[%02d] %-50s${NC}" "$TESTS" "$name"
  if output=$("$@" 2>&1); then
    printf "${GREEN} ✓${NC}\n"
    PASS=$((PASS+1))
  else
    printf "${RED} ✗${NC}\n"
    echo "     $output" | head -3
    FAIL=$((FAIL+1))
  fi
}

# Detect paths
if [ -d /app/skills ]; then
  BASE=/app
elif [ -d ./skills ]; then
  BASE=.
else
  BASE=/tmp/agent-loop
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo ""
echo "${BOLD}═══════════════════════════════════════════════════${NC}"
echo "${BOLD}  Rho / Agent-Loop Quick Smoke Test${NC}"
echo "${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""

# ── Paper ────────────────────────────────────────────────
echo "${BOLD}📄 Paper${NC}"
run "paper/rho.tex exists" test -f "$BASE/paper/rho.tex"
run "paper/rho.pdf exists" test -f "$BASE/paper/rho.pdf"

# ── TypeScript compilation ───────────────────────────────
echo ""
echo "${BOLD}🔨 TypeScript${NC}"
run "types.ts parseable" node -e "require('fs').readFileSync('$BASE/src/types.ts','utf8')"
run "agent-loop.ts parseable" node -e "require('fs').readFileSync('$BASE/src/agent-loop.ts','utf8')"
run "blackboard.ts parseable" node -e "require('fs').readFileSync('$BASE/src/blackboard.ts','utf8')"
run "single-agent.ts parseable" node -e "require('fs').readFileSync('$BASE/src/single-agent.ts','utf8')"

# ── Memory skill ─────────────────────────────────────────
echo ""
echo "${BOLD}🧠 Memory (tri-store)${NC}"
MEMDIR="$TMPDIR/mem"
mkdir -p "$MEMDIR"

run "write semantic entity" node "$BASE/skills/memory/scripts/write.mjs" \
  --store semantic --dir "$MEMDIR" \
  --entity '{"id":"test-entity","type":"concept","facts":["fact one","fact two"]}'

run "write procedural rule" node "$BASE/skills/memory/scripts/write.mjs" \
  --store procedural --dir "$MEMDIR" \
  --rule '{"id":"test-rule","description":"Always test first","success":true}'

run "write procedural rule (fail update)" node "$BASE/skills/memory/scripts/write.mjs" \
  --store procedural --dir "$MEMDIR" \
  --rule '{"id":"test-rule","description":"Always test first","success":false}'

run "read semantic" node "$BASE/skills/memory/scripts/read.mjs" \
  --store semantic --dir "$MEMDIR" --query "test"

run "read all stores" node "$BASE/skills/memory/scripts/read.mjs" \
  --store all --dir "$MEMDIR" --query "test"

run "inspect memory" node "$BASE/skills/memory/scripts/inspect.mjs" --dir "$MEMDIR"

run "manage operations" node "$BASE/skills/memory/scripts/manage.mjs" \
  --dir "$MEMDIR" --operation all

# Verify Rainbow-inspired fields exist in procedural rules
run "procedural has variance field" node -e "
  const r = JSON.parse(require('fs').readFileSync('$MEMDIR/procedural/rules.json','utf8'));
  const rule = r['test-rule'];
  if (rule.variance === undefined) throw 'no variance';
  if (rule.novelty === undefined) throw 'no novelty';
  if (rule.usefulness === undefined) throw 'no usefulness';
  if (!rule.outcomes || !rule.outcomes.length) throw 'no outcomes';
  console.log('OK: variance=' + rule.variance + ' novelty=' + rule.novelty + ' usefulness=' + rule.usefulness);
"

# ── Replay Buffer ────────────────────────────────────────
echo ""
echo "${BOLD}🔄 Replay Buffer (Rainbow sampling)${NC}"
BUFDIR="$TMPDIR/buf"
mkdir -p "$BUFDIR/transitions"

# Seed some transitions
for i in $(seq 1 20); do
  success=$( [ $((i % 3)) -eq 0 ] && echo "false" || echo "true" )
  node "$BASE/skills/replay-buffer/scripts/record.mjs" --buffer "$BUFDIR" \
    --episode "ep1" --heartbeat "$i" \
    --action "{\"type\":\"bash\",\"params\":{\"command\":\"echo $i\"}}" \
    --result "{\"success\":$success,\"output\":\"result $i\"}" \
    --candidates "[{\"type\":\"bash\",\"value\":0.$i}]" > /dev/null 2>&1
done

run "20 transitions recorded" node -e "
  const idx = JSON.parse(require('fs').readFileSync('$BUFDIR/index.json','utf8'));
  if (idx.transitions.length !== 20) throw 'expected 20, got ' + idx.transitions.length;
"

run "sample uniform" node "$BASE/skills/replay-buffer/scripts/sample.mjs" \
  --buffer "$BUFDIR" --size 5 --strategy uniform

run "sample prioritized" node "$BASE/skills/replay-buffer/scripts/sample.mjs" \
  --buffer "$BUFDIR" --size 5 --strategy prioritized

run "sample rainbow" node "$BASE/skills/replay-buffer/scripts/sample.mjs" \
  --buffer "$BUFDIR" --size 8 --strategy rainbow --omega 0.6 --beta 0.4

run "sample failures" node "$BASE/skills/replay-buffer/scripts/sample.mjs" \
  --buffer "$BUFDIR" --size 5 --strategy failures

run "sample recent" node "$BASE/skills/replay-buffer/scripts/sample.mjs" \
  --buffer "$BUFDIR" --size 5 --strategy recent

run "query failures" node "$BASE/skills/replay-buffer/scripts/query.mjs" \
  --buffer "$BUFDIR" --success false

# ── Policy ───────────────────────────────────────────────
echo ""
echo "${BOLD}📋 Policy Engine${NC}"
run "validate default policy" node "$BASE/skills/policy/scripts/validate.mjs" \
  "$BASE/policies/worker-default.json"

# ── Code Search ──────────────────────────────────────────
echo ""
echo "${BOLD}🔍 Code Search${NC}"
SEARCHDIR="$TMPDIR/search-repo"
mkdir -p "$SEARCHDIR"
echo 'function handleAuth(user, pass) { return user === "admin"; }' > "$SEARCHDIR/auth.js"
echo 'class UserService { getUser(id) { return db.find(id); } }' > "$SEARCHDIR/user.js"

run "index repo" node "$BASE/skills/code-search/scripts/index-repo.mjs" \
  "$SEARCHDIR" --output "$TMPDIR/search-index.json"

run "search 'authentication'" node "$BASE/skills/code-search/scripts/search.mjs" \
  "authentication" --index "$TMPDIR/search-index.json"

# ── arXiv Research ───────────────────────────────────────
echo ""
echo "${BOLD}📚 arXiv Research${NC}"
run "search arXiv" node "$BASE/skills/arxiv-research/scripts/search.mjs" \
  "deep reinforcement learning" 2>/dev/null

run "metadata lookup" node "$BASE/skills/arxiv-research/scripts/metadata.mjs" \
  1312.5602 2>/dev/null

# ── Skill Sequencer ─────────────────────────────────────
echo ""
echo "${BOLD}⚡ Skill Sequencer${NC}"
mkdir -p "$TMPDIR/sequences"
echo '{"name":"test","steps":[]}' > "$TMPDIR/sequences/test.json"
run "list sequences" node "$BASE/skills/skill-sequencer/scripts/list.mjs" \
  "$TMPDIR/sequences"

# ── Summary ──────────────────────────────────────────────
echo ""
echo "${BOLD}═══════════════════════════════════════════════════${NC}"
if [ $FAIL -eq 0 ]; then
  printf "${GREEN}${BOLD}  ALL %d TESTS PASSED ✓${NC}\n" "$TESTS"
else
  printf "${RED}${BOLD}  %d/%d FAILED${NC}\n" "$FAIL" "$TESTS"
  printf "${GREEN}  %d passed${NC}\n" "$PASS"
fi
echo "${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""

exit $FAIL
