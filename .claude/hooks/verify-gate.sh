#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Two rules, both about who is allowed to say a level passed.
#
# 1. SCOREBOARD.json is never writable from inside a session. Only
#    harness/scoreboard.sh writes it, and only the wrapper calls that, and only
#    after the evaluator returned PASS. That is what makes "passes": true mean
#    "independently confirmed" rather than "the builder felt good about it".
#
# 2. evidence/level-*/CLAIM.md -- the builder's written claim about what its
#    artifacts show -- can only be written after the agent has actually opened
#    an evidence file this session (track-read.sh keeps that list). The read is
#    then consumed, so the next claim needs fresh proof.
#
# This is a teaching gate, not a security boundary. Known gaps, all listed in
# SECURITY.md: it only sees Write/Edit (a Bash `sed -i` or `>` bypasses it); any
# evidence read unlocks any claim rather than the matching one; and an agent can
# create a file that matches the evidence patterns and then read its own forgery.
log="${VERIFY_READ_LOG:-./.claude/.evidence-reads}"
scoreboard="${SCOREBOARD_FILE:-SCOREBOARD.json}"

input=$(cat)
target=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
[ -n "$target" ] || exit 0

# Rule 1: the scoreboard is wrapper-only, unconditionally.
case "$target" in
  "$scoreboard"|*/"$scoreboard")
    cat <<'JSON'
{"decision":"block","reason":"BLOCKED: SCOREBOARD.json is written by the wrapper (harness/scoreboard.sh), never by a session. A level is marked passing only when the fresh-context evaluator returns PASS on the evidence you left on disk. Finish the level, write your evidence and evidence/level-<N>/CLAIM.md, and let the evaluator decide."}
JSON
    exit 0 ;;
esac

# Rule 2: an evidence claim needs an evidence read behind it.
case "$target" in
  */evidence/level-*/CLAIM.md|evidence/level-*/CLAIM.md) ;;
  *) exit 0 ;;
esac

if [ ! -s "$log" ]; then
  cat <<'JSON'
{"decision":"block","reason":"BLOCKED: you have not opened any evidence file this session, so there is nothing behind this claim. Produce the artifacts your level requires (see EVIDENCE.md for what counts in this domain), open one with the Read tool, confirm it shows what you are about to claim, then write CLAIM.md."}
JSON
  exit 0
fi
# consume the evidence so the next claim needs fresh proof
: > "$log"
exit 0
