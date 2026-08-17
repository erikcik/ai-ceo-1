#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# The wrapper. Something outside the agent has to start each fresh session, run
# the evaluator, and write the scoreboard, and that something is this script.
#
# Each cycle: one builder session on the first unpassed level, then one
# evaluator session in a fresh context. PASS flips the scoreboard row (via
# scoreboard.sh, the only writer). NEEDS_WORK becomes NEXT_FINDINGS.md and the
# same level runs again. Every session is a separate `claude -p` process, which
# is also the only way the hooks in .claude/ are loaded -- hook config is
# snapshotted when a session starts.
#
#   harness/loop.sh              run until the plan is done
#   MAX_CYCLES=3 harness/loop.sh cap the run
#   touch AGENT_STOP             stop after the current step
#
# Env: MAX_CYCLES (12), BUILDER_MODEL (sonnet), EVALUATOR_MODEL (opus).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

MAX_CYCLES="${MAX_CYCLES:-12}"
BUILDER_MODEL="${BUILDER_MODEL:-sonnet}"
EVALUATOR_MODEL="${EVALUATOR_MODEL:-opus}"
PERM_MODE="${PERMISSION_MODE:-bypassPermissions}"
LOGDIR="$ROOT/logs"
LOOPLOG="$LOGDIR/loop.log"

mkdir -p "$LOGDIR"
say() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOOPLOG"; }

# --- preflight ---------------------------------------------------------------
# A domain with no written evidence taxonomy cannot tell finished from claimed,
# so the loop refuses to start rather than running blind.
missing=()
[ -s LEVELS.md ]                      || missing+=("LEVELS.md (the ordered plan -- run harness/plan.sh)")
[ -s SCOREBOARD.json ]                || missing+=("SCOREBOARD.json (the default-FAIL contract)")
[ -s EVIDENCE.md ]                    || missing+=("EVIDENCE.md (the evidence taxonomy for this domain)")
[ -s .claude/evidence-patterns.txt ]  || missing+=(".claude/evidence-patterns.txt (machine-readable evidence patterns)")
[ -s RUBRIC.md ]                      || missing+=("RUBRIC.md (how quality is scored)")
if [ ${#missing[@]} -gt 0 ]; then
  echo "loop: refusing to start. Missing:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo >&2
  echo "This harness does not run a domain whose evidence taxonomy is undefined:" >&2
  echo "without one there is no way to tell finished work from claimed work, and" >&2
  echo "every verdict downstream is a guess. Run harness/plan.sh with your" >&2
  echo "initialization prompt, review what it produces, then start the loop." >&2
  exit 2
fi
command -v claude >/dev/null || { echo "loop: claude CLI not found on PATH" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "loop: not a git repository (the handoff depends on git log)" >&2; exit 2; }

say "loop start | builder=$BUILDER_MODEL evaluator=$EVALUATOR_MODEL max_cycles=$MAX_CYCLES"
say "preflight ok | $(harness/scoreboard.sh remaining) level(s) still failing"

# --- cycles ------------------------------------------------------------------
cycle=0
while :; do
  if [ -e AGENT_STOP ]; then say "exit: AGENT_STOP present"; exit 0; fi

  level=$(harness/scoreboard.sh next)
  if [ -z "$level" ]; then say "exit: every level in SCOREBOARD.json passes"; exit 0; fi

  cycle=$((cycle + 1))
  if [ "$cycle" -gt "$MAX_CYCLES" ]; then say "exit: MAX_CYCLES=$MAX_CYCLES reached with $level unfinished"; exit 1; fi

  before=$(git rev-parse HEAD 2>/dev/null || echo "")
  say "cycle $cycle | level=$level | build"

  # ---- build session (fresh process; hooks load here) ----
  findings=""
  [ -s NEXT_FINDINGS.md ] && findings="
The previous session attempted this same level and the evaluator returned NEEDS_WORK.
Its findings are in NEXT_FINDINGS.md -- read that file first and treat it as your work list.
"
  prompt="You are the builder. Execute level '$level' from LEVELS.md, following .claude/CLAUDE.md exactly.
$findings
Memory state (harness/memcheck.sh) -- fold any MAINTAIN worklist into your end-of-session memory pass:
$(harness/memcheck.sh 2>&1)

Work only on '$level'. Leave the evidence artifacts its acceptance criteria require, write
evidence/$level/CLAIM.md, update PROGRESS.md and memory/, and commit. A fresh evaluator that
never saw this session will judge only what is on disk."

  buildlog="$LOGDIR/cycle-$cycle-$level-build.log"
  {
    echo "### builder session | cycle $cycle | level $level | $(date '+%Y-%m-%dT%H:%M:%S')"
    echo "### command: claude -p --model $BUILDER_MODEL --permission-mode $PERM_MODE"
    echo "### cwd: $ROOT"
    echo
  } > "$buildlog"
  claude -p --model "$BUILDER_MODEL" --permission-mode "$PERM_MODE" "$prompt" >> "$buildlog" 2>&1
  say "cycle $cycle | build finished (rc=$?) | log=${buildlog#$ROOT/}"

  if [ -e AGENT_STOP ]; then say "exit: AGENT_STOP present after build"; exit 0; fi

  # ---- evaluator session (fresh context, no Write/Edit) ----
  say "cycle $cycle | level=$level | evaluate"
  verdictfile="$LOGDIR/cycle-$cycle-$level-verdict.md"
  evalprompt="Review level '$level'. Read its acceptance criteria in LEVELS.md, the taxonomy in
EVIDENCE.md, the scoring in RUBRIC.md, and the builder's claim in evidence/$level/CLAIM.md.
Open every artifact it names and check the claim against what the artifact actually shows.
Compare against the baseline commit ${before:-HEAD~1}. Return PASS or NEEDS_WORK per your instructions."

  claude --agent evaluator -p --model "$EVALUATOR_MODEL" --permission-mode "$PERM_MODE" "$evalprompt" > "$verdictfile" 2>&1
  verdict=$(head -1 "$verdictfile" | tr -d '\r ' | tr -d '`*#')
  say "cycle $cycle | verdict=$verdict | file=${verdictfile#$ROOT/}"

  # ---- act on the verdict ----
  if [ "$verdict" = "PASS" ]; then
    PASS_VERDICT_FILE="$verdictfile" harness/scoreboard.sh pass "$level" "evidence/$level/ (see ${verdictfile#$ROOT/})" | tee -a "$LOOPLOG"
    rm -f NEXT_FINDINGS.md
  else
    cp "$verdictfile" NEXT_FINDINGS.md
    say "cycle $cycle | $level stays false; findings handed to the next session"
  fi

  git add -A >/dev/null 2>&1
  git commit -q -m "loop cycle $cycle: $level -> ${verdict:-NO_VERDICT}" >/dev/null 2>&1
  after=$(git rev-parse HEAD 2>/dev/null || echo "")

  if [ "$before" = "$after" ] && [ "$verdict" != "PASS" ]; then
    say "exit: cycle $cycle produced no change and no PASS -- stopping rather than spinning"
    exit 1
  fi
done
