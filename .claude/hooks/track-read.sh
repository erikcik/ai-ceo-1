#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Records which evidence files the agent has opened this session. verify-gate.sh
# consults this list before allowing an evidence claim to be written.
#
# What counts as evidence is domain-specific, so the patterns come from
# .claude/evidence-patterns.txt -- written by the planner at init from the
# taxonomy in EVIDENCE.md -- instead of being hardcoded to screenshots. If that
# file is missing, nothing is ever recorded and every claim stays blocked; the
# loop's preflight is what refuses to start, so the failure is loud, not silent.
log="${VERIFY_READ_LOG:-./.claude/.evidence-reads}"
patterns="${EVIDENCE_PATTERNS:-./.claude/evidence-patterns.txt}"

path=$(cat | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
[ -n "$path" ] || exit 0
[ -f "$path" ] || exit 0
[ -f "$patterns" ] || exit 0

# The Read tool reports an ABSOLUTE path, but a taxonomy is naturally written in
# project-relative globs ("sources/*.md"). Matching only one form is a silent
# deadlock: no read ever counts, so the evidence gate can never be satisfied and
# no level can ever be claimed. So test both forms of the path against each glob.
root="${CLAUDE_PROJECT_DIR:-$PWD}"
rel="${path#"$root"/}"
rel="${rel#./}"

# One shell glob per line; blank lines and # comments ignored.
while IFS= read -r glob; do
  case "$glob" in ''|'#'*) continue ;; esac
  # shellcheck disable=SC2254
  case "$path" in $glob) printf '%s\n' "$path" >> "$log"; exit 0 ;; esac
  # shellcheck disable=SC2254
  case "$rel"  in $glob) printf '%s\n' "$path" >> "$log"; exit 0 ;; esac
done < "$patterns"
exit 0
