#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# A clone onto a fresh machine either works or fails confusingly, so one command
# says which. Checks the tools the harness shells out to, that the hooks are
# executable and parse, that the CLI can actually reach a model, and that the
# session will load .claude/ from where you are standing.
#
#   harness/doctor.sh
#
# Exit 0 = ready. Exit 1 = something is broken; the line marked FAIL says what.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
fail=0; warn=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); }
note() { printf '  warn  %s\n' "$*"; warn=$((warn+1)); }

echo "harness doctor -- $ROOT"
echo
echo "tools"
for t in bash git python3 claude; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t  ($(command -v "$t"))"; else bad "$t not on PATH"; fi
done
command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || bad "no shasum/sha256sum (the plan lock needs one)"

echo
echo "repository"
git rev-parse --git-dir >/dev/null 2>&1 && ok "inside a git repo" || bad "not a git repo -- the handoff depends on git log"
if git rev-parse --git-dir >/dev/null 2>&1; then
  git config user.name  >/dev/null 2>&1 || note "git user.name unset -- commit-on-stop will fail silently"
  git config user.email >/dev/null 2>&1 || note "git user.email unset -- commit-on-stop will fail silently"
fi
[ -d .claude ] && ok ".claude/ is here (hooks load from the directory you launch claude in)" \
               || bad ".claude/ missing -- run claude from the repo root, not a subdirectory"

echo
echo "hooks"
for h in kill-switch steer safety-gate track-read verify-gate frozen-guard progress-budget commit-on-stop; do
  f=".claude/hooks/$h.sh"
  if [ ! -f "$f" ]; then bad "$f missing"
  elif [ ! -x "$f" ]; then bad "$f not executable -- chmod +x .claude/hooks/*.sh"
  elif ! bash -n "$f" 2>/dev/null; then bad "$f has a syntax error"
  else ok "$h"; fi
done
[ -s .claude/hooks/danger-patterns.txt ] && ok "danger-patterns.txt present ($(grep -cvE '^\s*#|^\s*$' .claude/hooks/danger-patterns.txt) rules)" \
                                         || bad "danger-patterns.txt missing -- the safety gate enforces nothing"
[ -s .claude/settings.json ] && python3 -c 'import json,sys; json.load(open(".claude/settings.json"))' 2>/dev/null \
  && ok "settings.json parses" || bad "settings.json missing or invalid JSON"

echo
echo "agents"
for a in planner evaluator rubric-reviewer; do
  [ -s ".claude/agents/$a.md" ] && ok "$a" || bad ".claude/agents/$a.md missing"
done
if grep -qE '^tools:.*(Write|Edit)' .claude/agents/evaluator.md 2>/dev/null; then
  bad "evaluator.md grants Write/Edit -- the judge must not be able to fix what it grades"
else ok "evaluator has no Write/Edit"; fi

echo
echo "model access"
if command -v claude >/dev/null 2>&1; then
  [ -n "${ANTHROPIC_BASE_URL:-}" ] && ok "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" \
                                   || note "ANTHROPIC_BASE_URL unset -- using the CLI's default endpoint"
  for v in BUILDER_MODEL EVALUATOR_MODEL PLANNER_MODEL REVIEWER_MODEL; do
    eval "val=\${$v:-}"; [ -n "$val" ] && ok "$v=$val"
  done
  printf '  ...  probing the endpoint with a one-word prompt (may take a moment)\n'
  probe=$(claude -p ${DOCTOR_MODEL:+--model "$DOCTOR_MODEL"} --permission-mode bypassPermissions \
          'Reply with exactly the word: READY' 2>&1 | tr -d '[:space:]')
  case "$probe" in
    *READY*) ok "the CLI reached a model and it answered" ;;
    "")      bad "the CLI returned nothing -- check auth and ANTHROPIC_BASE_URL" ;;
    *)       bad "unexpected reply from the endpoint: $(printf '%s' "$probe" | cut -c1-120)" ;;
  esac
fi

echo
echo "task state"
if [ -s SCOREBOARD.json ]; then
  note "a task is already initialized here ($(harness/scoreboard.sh remaining) level(s) unfinished) -- harness/loop.sh would resume it"
else
  ok "clean workspace -- ready for a new task"
fi
[ -e AGENT_STOP ] && note "AGENT_STOP exists: every tool call is blocked until you remove it"

echo
if [ "$fail" -gt 0 ]; then
  echo "doctor: $fail failure(s), $warn warning(s) -- fix the FAIL lines before running a task."
  exit 1
fi
echo "doctor: ready. $warn warning(s)."
echo "Next: open a claude session here and use /start, or run harness/plan.sh -f INIT_PROMPT.md"
