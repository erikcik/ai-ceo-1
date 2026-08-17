#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# The only writer of SCOREBOARD.json. Concentrating every scoreboard write in one
# script, called only by the wrapper and only after an evaluator PASS, is what
# makes "passes": true mean "independently confirmed" instead of "the builder
# said so". verify-gate.sh denies every other route.
#
#   scoreboard.sh seed <file>                 -> validate + promote a planner seed
#   scoreboard.sh next                        -> id of the first level still false
#   scoreboard.sh remaining                   -> count of levels still false
#   scoreboard.sh status                      -> one line per level
#   scoreboard.sh pass <level-id> <evidence>  -> flip one row, recording evidence
#
# `pass` refuses to run unless PASS_VERDICT_FILE points at an evaluator verdict
# whose first line is PASS, so the flag cannot be set from a shell by accident.
#
# `seed` exists because the planner cannot write SCOREBOARD.json either -- it
# writes SCOREBOARD.seed.json, and this validates that every row is default-FAIL
# with a non-empty check before promoting it, so no session ever authors the
# file that says what passed.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FILE="${SCOREBOARD_FILE:-$ROOT/SCOREBOARD.json}"
cmd="${1:-status}"

if [ "$cmd" = "seed" ]; then
  seed="${2:-$ROOT/SCOREBOARD.seed.json}"
  [ -s "$seed" ] || { echo "scoreboard: seed file '$seed' not found or empty" >&2; exit 2; }
  [ -e "$FILE" ] && { echo "scoreboard: $FILE already exists; refusing to overwrite a live contract" >&2; exit 2; }
  SB_SEED="$seed" SB_FILE="$FILE" python3 -c '
import json, os, sys
seed = json.load(open(os.environ["SB_SEED"]))
rows = {k: v for k, v in seed.items() if not k.startswith("_")}
if not rows:
    sys.exit("scoreboard: seed has no level rows")
for k, v in rows.items():
    if not isinstance(v, dict):
        sys.exit(f"scoreboard: row {k} is not an object")
    if v.get("passes") is not False:
        sys.exit(f"scoreboard: row {k} does not start false -- a contract is default-FAIL or it is not a contract")
    if not str(v.get("check", "")).strip():
        sys.exit(f"scoreboard: row {k} has no check -- state the observable evidence that proves this level")
json.dump(seed, open(os.environ["SB_FILE"], "w"), indent=2)
open(os.environ["SB_FILE"], "a").write("\n")
print(f"scoreboard: promoted {len(rows)} default-FAIL rows to " + os.path.basename(os.environ["SB_FILE"]))
' || exit 3
  exit 0
fi

[ -f "$FILE" ] || { echo "scoreboard: $FILE not found" >&2; exit 2; }

case "$cmd" in
  next|remaining|status)
    SB_FILE="$FILE" SB_CMD="$cmd" python3 -c '
import json, os, sys
d = json.load(open(os.environ["SB_FILE"]))
rows = [(k, v) for k, v in d.items() if not k.startswith("_") and isinstance(v, dict)]
todo = [k for k, v in rows if not v.get("passes")]
cmd = os.environ["SB_CMD"]
if cmd == "next":
    print(todo[0] if todo else "")
elif cmd == "remaining":
    print(len(todo))
else:
    for k, v in rows:
        print(("PASS " if v.get("passes") else "todo ") + k + "  " + str(v.get("check", ""))[:100])
'
    ;;

  pass)
    level="${2:-}"; evidence="${3:-}"
    [ -n "$level" ] || { echo "usage: scoreboard.sh pass <level-id> <evidence>" >&2; exit 2; }
    verdict="${PASS_VERDICT_FILE:-}"
    if [ -z "$verdict" ] || [ ! -s "$verdict" ] || [ "$(head -1 "$verdict" | tr -d '\r ')" != "PASS" ]; then
      echo "scoreboard: refusing to pass '$level' -- PASS_VERDICT_FILE must name an evaluator verdict whose first line is PASS" >&2
      exit 3
    fi
    SB_FILE="$FILE" SB_LEVEL="$level" SB_EV="$evidence" SB_VERDICT="$verdict" python3 -c '
import json, os, sys, datetime
p = os.environ["SB_FILE"]; lvl = os.environ["SB_LEVEL"]
d = json.load(open(p))
if lvl not in d:
    sys.exit("scoreboard: no such level: " + lvl)
d[lvl]["passes"] = True
d[lvl]["evidence"] = os.environ["SB_EV"]
d[lvl]["verdict_file"] = os.environ["SB_VERDICT"]
d[lvl]["confirmed_at"] = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
print("scoreboard: " + lvl + " -> passes: true (evaluator PASS)")
'
    ;;

  *) echo "usage: scoreboard.sh {seed <file>|next|remaining|status|pass <level-id> <evidence>}" >&2; exit 2 ;;
esac
