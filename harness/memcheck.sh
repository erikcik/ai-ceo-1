#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# MAINTAIN needs a concrete worklist, so this reports which memory files are over
# budget, which are missing from the index, and which index lines point at files
# that no longer exist. The wrapper pastes the output into the builder's prompt;
# run it by hand any time to see the state of the wiki.
#
# Budget is per file, in characters (~4 per token). Override with MEMORY_BUDGET_TOKENS.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="${MEMORY_DIR:-$ROOT/memory}"
BUDGET_TOKENS="${MEMORY_BUDGET_TOKENS:-2000}"

[ -d "$DIR" ] || { echo "memory/ does not exist yet -- this task has no lessons recorded."; exit 0; }

MC_DIR="$DIR" MC_BUDGET="$BUDGET_TOKENS" python3 -c '
import os, re, glob

d = os.environ["MC_DIR"]
budget = int(os.environ["MC_BUDGET"]) * 4
index = os.path.join(d, "INDEX.md")

files = sorted(
    os.path.basename(p) for p in glob.glob(os.path.join(d, "*.md"))
    if os.path.basename(p) != "INDEX.md"
)

problems = []

if not os.path.exists(index):
    problems.append("INDEX.md is missing -- create it with one summary line per memory file.")
    listed = set()
else:
    text = open(index, encoding="utf-8").read()
    listed = set(re.findall(r"([A-Za-z0-9._-]+\.md)", text))
    listed.discard("INDEX.md")

for f in files:
    if f not in listed:
        problems.append(f"{f} is not in INDEX.md -- add a one-line summary for it.")
for f in sorted(listed - set(files)):
    problems.append(f"INDEX.md lists {f}, which does not exist -- remove the line or restore the file.")

for f in files:
    n = os.path.getsize(os.path.join(d, f))
    if n > budget:
        problems.append(
            f"{f} is ~{n // 4} tokens, over the {budget // 4} budget -- condense it, "
            "or split it into two topics and index both.")

print(f"memory/: {len(files)} lesson files, budget {budget // 4} tokens each")
if problems:
    print("MAINTAIN worklist:")
    for p in problems:
        print("  - " + p)
else:
    print("MAINTAIN: clean -- every file indexed, every file under budget.")
'
