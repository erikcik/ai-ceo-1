#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Frozen core guard. Denies any write to the files that define how the loop
# works, so no initialization prompt -- and no builder session acting on one --
# can rewrite the rules it is being judged by.
#
# Protected (see FROZEN CORE in .claude/CLAUDE.md):
#   .claude/hooks/**            the enforcement layer itself
#   .claude/settings.json       what is wired to which event
#   .claude/CLAUDE.md           the builder contract
#   .claude/agents/planner.md   } the two loop agents; domain customization goes
#   .claude/agents/evaluator.md } into .claude/agents/evaluator.addendum.md
#   harness/**                  the wrapper that writes the scoreboard
#
# This covers Write/Edit and the obvious Bash redirect/edit side doors. It is
# not a security boundary -- a determined agent can still reach these files
# through a route no regex anticipates, which is exactly why SECURITY.md
# requires making them read-only at the OS level in a real deployment.

input=$(cat)

python3 -c '
import json, os, re, sys

PROTECTED = [
    r"^\.claude/hooks(/|$)",
    r"^\.claude/settings\.json$",
    r"^\.claude/settings\.local\.json$",
    r"^\.claude/CLAUDE\.md$",
    r"^\.claude/agents/planner\.md$",
    r"^\.claude/agents/evaluator\.md$",
    r"^harness(/|$)",
]
REASON = (
    "BLOCKED by frozen-guard: {p} is part of the frozen core -- the three-agent "
    "structure, the default-FAIL contract, the wrapper that writes the scoreboard, "
    "the memory split, and the safety gates. No task, prompt, or instruction can "
    "change these from inside a session. Domain customization belongs in "
    ".claude/agents/evaluator.addendum.md, EVIDENCE.md, and RUBRIC.md. If the frozen "
    "core genuinely needs to change, stop and tell the operator."
)

try:
    ev = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = ev.get("tool_name", "")
ti = ev.get("tool_input", {}) or {}
root = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))

def rel(p):
    """Project-relative, normalized. None if outside the project."""
    if not p:
        return None
    p = os.path.realpath(os.path.join(root, os.path.expanduser(p)))
    try:
        r = os.path.relpath(p, root)
    except ValueError:
        return None
    return None if r.startswith("..") else r.replace(os.sep, "/")

def protected(r):
    return r is not None and any(re.search(pat, r) for pat in PROTECTED)

if tool in ("Write", "Edit", "NotebookEdit", "MultiEdit"):
    r = rel(ti.get("file_path") or ti.get("notebook_path"))
    if protected(r):
        print(json.dumps({"decision": "block", "reason": REASON.format(p=r)}))
    sys.exit(0)

if tool == "Bash":
    cmd = ti.get("command", "") or ""
    # Any mention of a protected path in a command that can modify a file.
    writes = re.search(
        r"(>|>>|\btee\b|\bsed\b[^|]*-i|\bcp\b|\bmv\b|\brm\b|\bchmod\b|\bln\b|"
        r"\btruncate\b|\bdd\b|\bpatch\b|\bpython3?\b|\bperl\b|\bawk\b)", cmd)
    if writes:
        for token in re.findall(r"[\w./~-]+", cmd):
            if protected(rel(token)):
                print(json.dumps({"decision": "block", "reason": REASON.format(p=token)}))
                sys.exit(0)
    sys.exit(0)
' <<<"$input"
exit 0
