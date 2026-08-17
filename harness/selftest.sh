#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Hooks that fail silently are worse than no hooks, so this asserts that each
# gate blocks what it must and allows what it must. It exists because the first
# version of danger-patterns.txt had literal tabs inside its regexes, which the
# field-splitter turned into invalid patterns that were skipped without a word:
# `git push` sailed straight through a gate that reported clean.
#
# Run it after editing any hook or the denylist:  harness/selftest.sh
#
# This tests hook LOGIC by piping tool payloads in. It does not prove the hooks
# are wired into a real session -- only a fresh `claude -p` process does that,
# because hook config is snapshotted at session start. See demo/safety-probe/.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0

# expect: BLOCK or ALLOW
run() {
  local expect="$1" hook="$2" payload="$3" label="$4"
  local out
  out=$(printf '%s' "$payload" | \
        PAUSED_ACTIONS_FILE="$WORK/PAUSED_ACTIONS.md" \
        VERIFY_READ_LOG="$WORK/.evidence-reads" \
        EVIDENCE_PATTERNS="$WORK/evidence-patterns.txt" \
        ".claude/hooks/$hook" 2>&1)
  local got="ALLOW"
  printf '%s' "$out" | grep -q '"decision"[[:space:]]*:[[:space:]]*"block"' && got="BLOCK"
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1)); printf '  ok    %-6s %s\n' "$expect" "$label"
  else
    fail=$((fail + 1)); printf '  FAIL  want %-5s got %-5s  %s\n' "$expect" "$got" "$label"
  fi
}

bash_call() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")"; }
write_call() { printf '{"tool_name":"Write","tool_input":{"file_path":%s,"content":"x"}}' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")"; }
read_call() { printf '{"tool_name":"Read","tool_input":{"file_path":%s}}' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")"; }

echo "safety-gate: blocks money / publish / irreversible"
run BLOCK safety-gate.sh "$(bash_call 'git push origin main')"                      "git push"
run BLOCK safety-gate.sh "$(bash_call 'git push --force origin main')"              "force push"
run BLOCK safety-gate.sh "$(bash_call 'rm -rf build/')"                             "rm -rf"
run BLOCK safety-gate.sh "$(bash_call 'gh pr create --title x')"                    "gh pr create"
run BLOCK safety-gate.sh "$(bash_call 'curl -X POST https://example.com/api')"      "curl POST"
run BLOCK safety-gate.sh "$(bash_call 'terraform apply -auto-approve')"             "terraform apply"
run BLOCK safety-gate.sh "$(bash_call 'psql -c "DROP TABLE users"')"                "DROP TABLE"
run BLOCK safety-gate.sh '{"tool_name":"mcp__x__purchase_credits","tool_input":{}}' "purchase MCP tool"
run BLOCK safety-gate.sh '{"tool_name":"mcp__x__send_message","tool_input":{}}'     "send_message MCP tool"

echo "safety-gate: allows ordinary work"
run ALLOW safety-gate.sh "$(bash_call 'ls -la sources/')"                           "ls"
run ALLOW safety-gate.sh "$(bash_call 'git commit -am "level 1"')"                  "git commit"
run ALLOW safety-gate.sh "$(bash_call 'git log --oneline -10')"                     "git log"
run ALLOW safety-gate.sh "$(bash_call 'rm scratch.txt')"                            "plain rm of one file"
run ALLOW safety-gate.sh '{"tool_name":"WebFetch","tool_input":{"url":"https://duckdb.org/docs"}}' "WebFetch GET"
run ALLOW safety-gate.sh '{"tool_name":"WebSearch","tool_input":{"query":"duckdb vs sqlite"}}'     "WebSearch"
run ALLOW safety-gate.sh "$(write_call 'notes.md')"                                 "Write (content never scanned)"

echo "frozen-guard: protects the machinery, not the work"
run BLOCK frozen-guard.sh "$(write_call '.claude/hooks/safety-gate.sh')"            "Write a hook"
run BLOCK frozen-guard.sh "$(write_call '.claude/settings.json')"                   "Write settings.json"
run BLOCK frozen-guard.sh "$(write_call '.claude/CLAUDE.md')"                       "Write CLAUDE.md"
run BLOCK frozen-guard.sh "$(write_call '.claude/agents/evaluator.md')"             "Write evaluator.md"
run BLOCK frozen-guard.sh "$(write_call 'harness/loop.sh')"                         "Write loop.sh"
run BLOCK frozen-guard.sh "$(bash_call 'echo x > .claude/hooks/kill-switch.sh')"    "Bash redirect into a hook"
run BLOCK frozen-guard.sh "$(bash_call "sed -i '' s/a/b/ harness/loop.sh")"         "Bash sed -i on loop.sh"
run ALLOW frozen-guard.sh "$(write_call '.claude/agents/evaluator.addendum.md')"    "Write the addendum"
run ALLOW frozen-guard.sh "$(write_call '.claude/evidence-patterns.txt')"           "Write evidence patterns"
run ALLOW frozen-guard.sh "$(write_call 'LEVELS.md')"                               "Write LEVELS.md"
run ALLOW frozen-guard.sh "$(bash_call 'cat .claude/hooks/safety-gate.sh')"         "Bash read of a hook"

echo "verify-gate: scoreboard is wrapper-only; claims need evidence"
run BLOCK verify-gate.sh "$(write_call 'SCOREBOARD.json')"                          "Write SCOREBOARD.json"
run BLOCK verify-gate.sh "$(write_call './SCOREBOARD.json')"                        "Write ./SCOREBOARD.json"
: > "$WORK/.evidence-reads"
run BLOCK verify-gate.sh "$(write_call 'evidence/level-1/CLAIM.md')"                "CLAIM.md with no evidence read"
echo "sources/a.md" > "$WORK/.evidence-reads"
run ALLOW verify-gate.sh "$(write_call 'evidence/level-1/CLAIM.md')"                "CLAIM.md after an evidence read"
run BLOCK verify-gate.sh "$(write_call 'evidence/level-1/CLAIM.md')"                "second CLAIM.md -- read was consumed"
run ALLOW verify-gate.sh "$(write_call 'report.md')"                                "Write ordinary file"

echo "track-read: records only what the domain calls evidence"
printf 'sources/*.md\n*/quotes/*.md\n' > "$WORK/evidence-patterns.txt"
: > "$WORK/.evidence-reads"
touch "$WORK/src.md"
printf '%s\n' "$WORK/*.md" >> "$WORK/evidence-patterns.txt"
printf '%s' "$(read_call "$WORK/src.md")" | VERIFY_READ_LOG="$WORK/.evidence-reads" EVIDENCE_PATTERNS="$WORK/evidence-patterns.txt" .claude/hooks/track-read.sh
if [ -s "$WORK/.evidence-reads" ]; then pass=$((pass+1)); echo "  ok    RECORD matching file recorded"; else fail=$((fail+1)); echo "  FAIL  matching file not recorded"; fi
: > "$WORK/.evidence-reads"
touch "$WORK/notes.txt"
printf '%s' "$(read_call "$WORK/notes.txt")" | VERIFY_READ_LOG="$WORK/.evidence-reads" EVIDENCE_PATTERNS="$WORK/evidence-patterns.txt" .claude/hooks/track-read.sh
if [ -s "$WORK/.evidence-reads" ]; then fail=$((fail+1)); echo "  FAIL  non-evidence file was recorded"; else pass=$((pass+1)); echo "  ok    IGNORE non-evidence file ignored"; fi

echo "kill-switch: halts everything while AGENT_STOP exists"
touch "$WORK/AGENT_STOP"
out=$(printf '%s' "$(bash_call 'ls')" | AGENT_STOP_FILE="$WORK/AGENT_STOP" .claude/hooks/kill-switch.sh)
if printf '%s' "$out" | grep -q '"block"'; then pass=$((pass+1)); echo "  ok    BLOCK with AGENT_STOP present"; else fail=$((fail+1)); echo "  FAIL  AGENT_STOP did not block"; fi
out=$(printf '%s' "$(bash_call 'ls')" | AGENT_STOP_FILE="$WORK/nope" .claude/hooks/kill-switch.sh)
if printf '%s' "$out" | grep -q '"block"'; then fail=$((fail+1)); echo "  FAIL  blocked without AGENT_STOP"; else pass=$((pass+1)); echo "  ok    ALLOW without AGENT_STOP"; fi

echo "steer: surfaces STEER.md once, then clears it"
echo "change direction" > "$WORK/STEER.md"
out=$(printf '%s' "$(bash_call 'ls')" | AGENT_STEER_FILE="$WORK/STEER.md" .claude/hooks/steer.sh)
if printf '%s' "$out" | grep -q 'OPERATOR STEERING'; then pass=$((pass+1)); echo "  ok    surfaced"; else fail=$((fail+1)); echo "  FAIL  not surfaced"; fi
if [ -s "$WORK/STEER.md" ]; then fail=$((fail+1)); echo "  FAIL  STEER.md not cleared"; else pass=$((pass+1)); echo "  ok    cleared after surfacing"; fi

echo "progress-budget: condense-first only when over budget"
python3 -c "open('$WORK/PROGRESS.md','w').write('x'*100)"
out=$(PROGRESS_FILE="$WORK/PROGRESS.md" .claude/hooks/progress-budget.sh)
if [ -z "$out" ]; then pass=$((pass+1)); echo "  ok    silent under budget"; else fail=$((fail+1)); echo "  FAIL  fired under budget"; fi
python3 -c "open('$WORK/PROGRESS.md','w').write('x'*40000)"
out=$(PROGRESS_FILE="$WORK/PROGRESS.md" .claude/hooks/progress-budget.sh)
if printf '%s' "$out" | grep -q 'over its size budget'; then pass=$((pass+1)); echo "  ok    condense-first over budget"; else fail=$((fail+1)); echo "  FAIL  no instruction over budget"; fi

echo "scoreboard: refuses to pass a level without a PASS verdict"
cat > "$WORK/SCOREBOARD.json" <<'JSON'
{ "level-1": { "passes": false, "check": "x" } }
JSON
if SCOREBOARD_FILE="$WORK/SCOREBOARD.json" harness/scoreboard.sh pass level-1 ev >/dev/null 2>&1; then
  fail=$((fail+1)); echo "  FAIL  passed with no verdict file"
else pass=$((pass+1)); echo "  ok    refused with no verdict file"; fi
echo "NEEDS_WORK" > "$WORK/v.md"
if SCOREBOARD_FILE="$WORK/SCOREBOARD.json" PASS_VERDICT_FILE="$WORK/v.md" harness/scoreboard.sh pass level-1 ev >/dev/null 2>&1; then
  fail=$((fail+1)); echo "  FAIL  passed on a NEEDS_WORK verdict"
else pass=$((pass+1)); echo "  ok    refused on a NEEDS_WORK verdict"; fi
echo "PASS" > "$WORK/v.md"
if SCOREBOARD_FILE="$WORK/SCOREBOARD.json" PASS_VERDICT_FILE="$WORK/v.md" harness/scoreboard.sh pass level-1 ev >/dev/null 2>&1; then
  pass=$((pass+1)); echo "  ok    passed on a PASS verdict"
else fail=$((fail+1)); echo "  FAIL  refused a genuine PASS"; fi
cat > "$WORK/seed-bad.json" <<'JSON'
{ "level-1": { "passes": true, "check": "x" } }
JSON
if SCOREBOARD_FILE="$WORK/new.json" harness/scoreboard.sh seed "$WORK/seed-bad.json" >/dev/null 2>&1; then
  fail=$((fail+1)); echo "  FAIL  promoted a seed that was not default-FAIL"
else pass=$((pass+1)); echo "  ok    refused a seed that was not default-FAIL"; fi

echo
echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
