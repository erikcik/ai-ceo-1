#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Initialization. One command turns the initialization prompt into the plan
# artifacts and their gameability review, then stops for human approval --
# because a plan nobody read is a plan nobody agreed to.
#
#   harness/plan.sh "Task: ... Domain: ... Constraints: ... Budget: ..."
#   harness/plan.sh -f init-prompt.md
#
# Runs two fresh sessions: the planner, then a rubric-reviewer that has never
# seen the planner's reasoning and tries to find the cheapest way to score well
# without doing the work. Writes LEVELS.md, SCOREBOARD.json, EVIDENCE.md,
# .claude/evidence-patterns.txt, RUBRIC.md (planner) and RUBRIC_REVIEW.md
# (reviewer). It does not start the loop.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PLANNER_MODEL="${PLANNER_MODEL:-opus}"
REVIEWER_MODEL="${REVIEWER_MODEL:-opus}"
PERM_MODE="${PERMISSION_MODE:-bypassPermissions}"
LOGDIR="$ROOT/logs"; mkdir -p "$LOGDIR"

if [ "${1:-}" = "-f" ]; then
  [ -s "${2:-}" ] || { echo "plan: cannot read prompt file '${2:-}'" >&2; exit 2; }
  INIT_PROMPT=$(cat "$2")
elif [ -n "${1:-}" ]; then
  INIT_PROMPT="$1"
else
  echo "usage: harness/plan.sh \"<initialization prompt>\"   |   harness/plan.sh -f <file>" >&2
  echo "The prompt should contain the task, the domain, any constraints, and the budget." >&2
  exit 2
fi

command -v claude >/dev/null || { echo "plan: claude CLI not found on PATH" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "plan: not a git repository" >&2; exit 2; }

for f in LEVELS.md SCOREBOARD.json RUBRIC.md EVIDENCE.md; do
  if [ -s "$f" ]; then
    echo "plan: $f already exists. This task is already initialized; move or delete the" >&2
    echo "      existing plan artifacts before re-planning." >&2
    exit 2
  fi
done

printf '%s\n' "$INIT_PROMPT" > INIT_PROMPT.md
echo "plan: initialization prompt saved to INIT_PROMPT.md"

echo "plan: [1/2] planner session (model=$PLANNER_MODEL)"
{
  echo "### planner session | $(date '+%Y-%m-%dT%H:%M:%S')"
  echo "### command: claude --agent planner -p --model $PLANNER_MODEL --permission-mode $PERM_MODE"
  echo
} > "$LOGDIR/plan-planner.log"
claude --agent planner -p --model "$PLANNER_MODEL" --permission-mode "$PERM_MODE" \
  "Here is the initialization prompt for this task. Produce the plan artifacts per your instructions, then stop.

$INIT_PROMPT" >> "$LOGDIR/plan-planner.log" 2>&1
echo "plan: planner finished -> logs/plan-planner.log"

missing=()
for f in LEVELS.md SCOREBOARD.seed.json EVIDENCE.md .claude/evidence-patterns.txt RUBRIC.md; do
  [ -s "$f" ] || missing+=("$f")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "plan: the planner did not produce:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "Read logs/plan-planner.log -- if it refused for lack of an evidence taxonomy, that" >&2
  echo "refusal is correct and the initialization prompt needs the missing piece." >&2
  exit 3
fi

# The planner cannot write SCOREBOARD.json (verify-gate denies every session).
# Validate its seed is genuinely default-FAIL, then promote it.
harness/scoreboard.sh seed SCOREBOARD.seed.json || exit 3
rm -f SCOREBOARD.seed.json

echo "plan: [2/2] rubric gameability review (model=$REVIEWER_MODEL, fresh session)"
claude --agent rubric-reviewer -p --model "$REVIEWER_MODEL" --permission-mode "$PERM_MODE" \
  "Review RUBRIC.md for gameability against LEVELS.md, EVIDENCE.md and SCOREBOARD.json, per your instructions." \
  > RUBRIC_REVIEW.md 2>&1
review=$(head -1 RUBRIC_REVIEW.md | tr -d '\r ' | tr -d '`*#')

git add -A >/dev/null 2>&1
git commit -q -m "init: plan artifacts for this task (rubric review: ${review:-UNKNOWN})" >/dev/null 2>&1

cat <<EOF

plan: done. Nothing is running yet.

  LEVELS.md         $(grep -cE '^#{2,3} +([0-9]+|level)' LEVELS.md 2>/dev/null || echo '?') level headings
  SCOREBOARD.json   $(harness/scoreboard.sh remaining) rows, all failing (as they should be)
  EVIDENCE.md       the evidence taxonomy for this domain
  RUBRIC.md         how the evaluator scores
  RUBRIC_REVIEW.md  verdict: ${review:-UNKNOWN}

Next, and this part is yours, not the harness's:
  1. Read LEVELS.md    -- is this the right decomposition, in the right order?
  2. Read RUBRIC_REVIEW.md -- if REVISE, fix RUBRIC.md before you run anything.
  3. Check .claude/agents/evaluator.addendum.md if the planner wrote one, and add any
     extra evaluator tools it asks for to the tools: line in .claude/agents/evaluator.md.
  4. Then: harness/loop.sh
EOF
