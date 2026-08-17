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

# One shell glob per line; blank lines and # comments ignored.
while IFS= read -r glob; do
  case "$glob" in ''|'#'*) continue ;; esac
  # shellcheck disable=SC2254
  case "$path" in
    $glob) printf '%s\n' "$path" >> "$log"; break ;;
  esac
done < "$patterns"
exit 0
