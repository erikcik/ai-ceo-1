#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# A session that opens with a bloated handoff spends its context re-reading
# history instead of working, so when PROGRESS.md is over budget this makes
# condensing it the session's first task.
#
# Runs at SessionStart and injects the instruction as context. The budget is a
# character count, since that is what a shell can measure; ~4 chars per token is
# close enough for a guardrail. Override with PROGRESS_BUDGET_TOKENS.
progress="${PROGRESS_FILE:-./PROGRESS.md}"
budget_tokens="${PROGRESS_BUDGET_TOKENS:-8000}"

[ -f "$progress" ] || exit 0

chars=$(wc -c < "$progress" | tr -d ' ')
limit=$((budget_tokens * 4))
[ "$chars" -gt "$limit" ] || exit 0

tokens=$((chars / 4))
PB_MSG="PROGRESS.md is over its size budget: roughly ${tokens} tokens against a ${budget_tokens} limit.

Your FIRST task this session, before any other work, is to condense it back under budget:
edit it in place (never append), keep the current state and what the next session must
know, and delete narration of work that is already committed -- git log is the record of
what happened, PROGRESS.md is the record of where things stand. Anything durable and
cross-task belongs in memory/ as a lesson, not here. Then start the level." \
python3 -c '
import json, os
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": os.environ["PB_MSG"],
}}))
'
exit 0
