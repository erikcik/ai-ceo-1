#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Safety gate. Denies any tool call that (a) spends money, (b) posts publicly or
# sends an external message, or (c) is irreversible in the real world, logs it to
# PAUSED_ACTIONS.md, and tells the agent to continue with other work. The
# operator resumes paused items by hand.
#
# The rules live in danger-patterns.txt, not here, so the denylist can be audited
# and extended without touching shell logic.
#
# Scope note: this matches a narrow haystack (Bash command, target path, URL,
# tool name) and never file contents. It is a gate, not a sandbox -- see
# SECURITY.md for what it does not catch.
patterns="${DANGER_PATTERNS:-$(dirname "$0")/danger-patterns.txt}"
paused="${PAUSED_ACTIONS_FILE:-./PAUSED_ACTIONS.md}"

[ -f "$patterns" ] || exit 0

DANGER_PATTERNS="$patterns" PAUSED_ACTIONS_FILE="$paused" python3 -c '
import json, os, re, sys, datetime

try:
    ev = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = ev.get("tool_name", "")
ti = ev.get("tool_input", {}) or {}

# Purpose-built haystack: the fields that describe what the call DOES.
# Never tool_input content/new_string -- writing prose about "git push" is not
# an attempt to push.
parts = [tool]
for key in ("command", "file_path", "path", "url", "notebook_path", "query"):
    v = ti.get(key)
    if isinstance(v, str):
        parts.append(v)
hay = "\n".join(p for p in parts if p)
if not hay.strip():
    sys.exit(0)

def block(reason):
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)

# Parse the whole denylist first and FAIL CLOSED on a malformed rule. A gate
# that silently skips a rule it could not parse is worse than no gate: it
# reports clean while enforcing nothing.
rules = []
for n, raw in enumerate(open(os.environ["DANGER_PATTERNS"], encoding="utf-8"), 1):
    line = raw.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    bits = line.split("\t")
    if len(bits) < 3:
        block(f"SAFETY GATE MISCONFIGURED: danger-patterns.txt line {n} is not "
              "CATEGORY<TAB>regex<TAB>reason. Every tool call is blocked until an operator "
              "fixes it. Stop and report this.")
    category, pattern, why = bits[0].strip(), bits[1], "\t".join(bits[2:]).strip()
    try:
        rules.append((category, re.compile(pattern, re.IGNORECASE), why))
    except re.error as e:
        block(f"SAFETY GATE MISCONFIGURED: danger-patterns.txt line {n} is not a valid "
              f"regex ({e}); a literal tab inside a pattern is the usual cause. Every tool "
              "call is blocked until an operator fixes it. Stop and report this.")

for category, rx, why in rules:
    if not rx.search(hay):
        continue

    detail = ti.get("command") or ti.get("url") or ti.get("file_path") or "(no command)"
    detail = " ".join(str(detail).split())[:300]
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    path = os.environ["PAUSED_ACTIONS_FILE"]
    new = not os.path.exists(path)
    with open(path, "a", encoding="utf-8") as fh:
        if new:
            fh.write(
                "# Paused actions\n\n"
                "Actions the safety gate blocked. Each row is something an agent tried to do\n"
                "that spends money, posts publicly, or cannot be undone. Nothing here has\n"
                "happened. Review and run anything you approve yourself, then delete the row.\n\n"
                "| when | category | tool | action | why blocked |\n"
                "|---|---|---|---|---|\n"
            )
        safe = detail.replace("|", "\\|")
        fh.write(f"| {stamp} | {category} | {tool} | `{safe}` | {why} |\n")

    reason = (
        f"BLOCKED by safety gate [{category}]: {why}. "
        f"This action has been logged to {path} for the operator to review and run manually. "
        "Do not retry it, do not look for another route to the same effect, and do not ask "
        "for permission -- note it in PROGRESS.md and continue with the rest of the level."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)
'
exit 0
