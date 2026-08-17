#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# The builder is judged against LEVELS.md and RUBRIC.md, so it must not be able to
# edit them -- while a change made deliberately by an operator has to stay possible.
# This records a sha256 of the plan at approval; frozen-guard.sh denies writes to
# anything listed, and loop.sh verifies before and after every cycle.
#
# Found the hard way: in the first smoke run the builder edited LEVELS.md seven
# minutes into its first session. The edits happened to be honest corrections, but
# nothing distinguished them from an edit that lowers the bar -- and the evaluator,
# which reads LEVELS.md fresh each cycle, would have graded against the rewritten
# criteria without ever knowing they had changed.
#
#   harness/planlock.sh lock      record the current plan (run once, at approval)
#   harness/planlock.sh verify    exit 0 if the plan is untouched, 1 if not
#   harness/planlock.sh relock    accept a deliberate operator change
#   harness/planlock.sh paths     list the locked paths (used by frozen-guard.sh)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK="${PLAN_LOCK_FILE:-$ROOT/.claude/plan-lock.sha256}"

# The per-task standard: what the work must achieve, what counts as proof, and how
# it is scored. Not SCOREBOARD.json -- that one is unwritable from a session already.
PLAN_PATHS=(LEVELS.md RUBRIC.md EVIDENCE.md .claude/evidence-patterns.txt)

case "${1:-verify}" in
  paths)
    printf '%s\n' "${PLAN_PATHS[@]}"
    ;;

  lock|relock)
    if [ "$1" = "lock" ] && [ -e "$LOCK" ]; then
      echo "planlock: $LOCK already exists. Use 'relock' to accept a deliberate change." >&2
      exit 2
    fi
    missing=()
    for p in "${PLAN_PATHS[@]}"; do [ -s "$ROOT/$p" ] || missing+=("$p"); done
    if [ ${#missing[@]} -gt 0 ]; then
      echo "planlock: cannot lock, missing:" >&2; printf '  - %s\n' "${missing[@]}" >&2; exit 2
    fi
    { echo "# Plan lock -- the standard this task is judged against, as approved."
      echo "# Written by harness/planlock.sh. frozen-guard.sh denies writes to these paths;"
      echo "# loop.sh halts if any hash stops matching. Operator: 'planlock.sh relock' to"
      echo "# accept a change you made on purpose."
      echo "# locked: $(date '+%Y-%m-%dT%H:%M:%S')"
      for p in "${PLAN_PATHS[@]}"; do ( cd "$ROOT" && shasum -a 256 "$p" ); done
    } > "$LOCK"
    echo "planlock: locked ${#PLAN_PATHS[@]} plan files -> ${LOCK#$ROOT/}"
    ;;

  verify)
    [ -e "$LOCK" ] || { echo "planlock: no lock file; nothing to verify" >&2; exit 2; }
    if ( cd "$ROOT" && grep -v '^#' "$LOCK" | shasum -a 256 -c --status - ); then
      exit 0
    fi
    echo "planlock: THE PLAN HAS CHANGED since it was approved." >&2
    ( cd "$ROOT" && grep -v '^#' "$LOCK" | shasum -a 256 -c - 2>&1 | grep -v ': OK$' ) >&2
    echo >&2
    echo "The acceptance criteria and rubric are the standard the evaluator grades against." >&2
    echo "If you changed them on purpose: harness/planlock.sh relock" >&2
    echo "If you did not, something inside a session edited the bar it is judged by --" >&2
    echo "check 'git log -p' on those files before continuing." >&2
    exit 1
    ;;

  *) echo "usage: planlock.sh {lock|relock|verify|paths}" >&2; exit 2 ;;
esac
