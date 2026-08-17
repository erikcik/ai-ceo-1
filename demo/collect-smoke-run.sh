#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Copies the smoke-run workspace into demo/smoke-run/ so the artifacts survive
# the scratch directory. Kept as a script rather than done by hand so the mapping
# from "what the run produced" to "what is preserved here" is auditable.
#
#   demo/collect-smoke-run.sh [workspace]
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC="${1:-/tmp/aiceo-smoke}"
DST="$REPO/demo/smoke-run"

[ -d "$SRC" ] || { echo "collect: no workspace at $SRC" >&2; exit 2; }
rm -rf "$DST"; mkdir -p "$DST/.claude/agents"

# Plan artifacts, contract, handoff, memory, evidence, logs.
for f in INIT_PROMPT.md LEVELS.md EVIDENCE.md RUBRIC.md RUBRIC_REVIEW.md \
         SCOREBOARD.json PROGRESS.md PAUSED_ACTIONS.md NEXT_FINDINGS.md \
         REPORT.md SCOREBOARD_CHECK_PATCH.md; do
  [ -e "$SRC/$f" ] && cp "$SRC/$f" "$DST/$f"
done
for d in memory evidence sources claims logs; do
  [ -d "$SRC/$d" ] && cp -R "$SRC/$d" "$DST/$d"
done
[ -e "$SRC/.claude/evidence-patterns.txt" ] && cp "$SRC/.claude/evidence-patterns.txt" "$DST/.claude/"
[ -e "$SRC/.claude/agents/evaluator.addendum.md" ] && cp "$SRC/.claude/agents/evaluator.addendum.md" "$DST/.claude/agents/"

# The evaluator's tools line, as the operator left it at approval time.
if [ -e "$SRC/.claude/agents/evaluator.md" ]; then
  grep -m1 '^tools:' "$SRC/.claude/agents/evaluator.md" > "$DST/.claude/agents/evaluator-tools-line.txt"
fi

# git log is the second record; preserve it as text since demo/ cannot hold a repo.
( cd "$SRC" && git log --stat --date=iso --pretty=format:'%h %ad %s' ) > "$DST/git-log.txt" 2>/dev/null
( cd "$SRC" && git log --oneline ) > "$DST/git-log-oneline.txt" 2>/dev/null

echo "collected into $DST:"
find "$DST" -type f | sed "s|$DST/|  |" | sort
