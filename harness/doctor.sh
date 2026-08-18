#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# A clone onto a fresh machine either works or fails confusingly, so one command
# says which -- and, where the fix is unambiguous, applies it.
#
# An audit that prints "claude not on PATH" while claude sits in ~/.local/bin is
# not an audit, it is a riddle. Everything this script can repair without a
# secret and without a judgement call, it repairs: PATH, the CLI itself, the
# hook exec bits, a missing git identity, node, headless Chromium, and the MCP
# wiring that gives a `claude -p` builder session a browser.
#
#   harness/doctor.sh              check and repair (default)
#   harness/doctor.sh --check      audit only, change nothing
#   harness/doctor.sh --no-browser skip browser provisioning (slow, pulls ~150MB)
#
# Exit 0 = ready. Exit 1 = something is broken that this script cannot fix
# without you; the line marked FAIL says what and the line under it says how.
#
# Two things it will never do, because both need a human: supply credentials,
# and pretend a capability exists that this platform does not have. See the
# "agent capabilities" section -- it writes CAPABILITIES.md so the planner
# builds a plan the builder can actually execute.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

FIX=1
BROWSER=1
for a in "$@"; do
  case "$a" in
    --check|-n|--dry-run) FIX=0 ;;
    --no-browser)         BROWSER=0 ;;
    -h|--help) sed -n '4,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "doctor: unknown option $a" >&2; exit 2 ;;
  esac
done

fail=0; warn=0; fixed=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); }
note() { printf '  warn  %s\n' "$*"; warn=$((warn+1)); }
did()  { printf '  fixed %s\n' "$*"; fixed=$((fixed+1)); }
hint() { printf '        -> %s\n' "$*"; }
# In --check mode every repair degrades to a FAIL that names the command, so the
# audit output is still actionable when you have deliberately asked for no writes.
cannot() { bad "$1"; hint "fix: $2"; }

# `timeout` is coreutils; macOS has it only via brew. Degrade rather than break.
TO=""; command -v timeout >/dev/null 2>&1 && TO="timeout"
run_to() { local s=$1; shift; if [ -n "$TO" ]; then "$TO" "$s" "$@"; else "$@"; fi; }

echo "harness doctor -- $ROOT"
[ "$FIX" = 0 ] && echo "(--check: auditing only, nothing will be changed)"
echo

# --- tools -------------------------------------------------------------------
# Order matters: claude has to be found or installed before anything downstream
# can probe a model, and node before the browser section can provision anything.
echo "tools"
for t in bash git python3; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t  ($(command -v "$t"))"; else bad "$t not on PATH"; fi
done
command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || bad "no shasum/sha256sum (the plan lock needs one)"

# Persist a PATH entry to every shell rc that exists, exactly once. The marker
# comment is what makes a second doctor run a no-op instead of a growing file.
MARK="# added by ai-ceo harness/doctor.sh"
persist_path() {
  local dir=$1 rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -e "$rc" ] || { [ "$rc" = "$HOME/.bashrc" ] || continue; : > "$rc"; }
    grep -qF "$dir" "$rc" 2>/dev/null && continue
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$MARK" "$dir" >> "$rc"
  done
}

# The bug this whole rewrite exists for. The installer puts claude in
# ~/.local/bin and tells you to edit .bashrc; a non-login shell never read it,
# so `command -v claude` fails on a box where claude is plainly installed.
# Look where it actually lands before concluding anything.
find_claude() {
  local c
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
           "/usr/local/bin/claude" "/opt/homebrew/bin/claude" \
           "$HOME/.bun/bin/claude" "$HOME/.npm-global/bin/claude"; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  # npm global prefix, wherever this machine put it.
  if command -v npm >/dev/null 2>&1; then
    c="$(npm prefix -g 2>/dev/null)/bin/claude"
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  fi
  return 1
}

if command -v claude >/dev/null 2>&1; then
  ok "claude  ($(command -v claude))"
elif found=$(find_claude); then
  dir=$(dirname "$found")
  if [ "$FIX" = 1 ]; then
    export PATH="$dir:$PATH"
    persist_path "$dir"
    did "claude was installed at $found but $dir was not on PATH -- added it to PATH and to your shell rc"
  else
    cannot "claude not on PATH (but installed at $found)" "export PATH=\"$dir:\$PATH\""
  fi
else
  if [ "$FIX" = 1 ]; then
    printf '  ...  claude not found anywhere -- installing from https://claude.ai/install.sh\n'
    if run_to 300 bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/tmp/claude-install.$$ 2>&1; then
      if found=$(find_claude); then
        dir=$(dirname "$found"); export PATH="$dir:$PATH"; persist_path "$dir"
        did "installed claude ($("$found" --version 2>/dev/null | head -1)) and put $dir on PATH"
      else
        bad "the installer reported success but no claude binary turned up"
        hint "see /tmp/claude-install.$$ for its output"
      fi
    else
      bad "could not install claude (network blocked, or the installer failed)"
      hint "output: /tmp/claude-install.$$"
      hint "fix by hand: curl -fsSL https://claude.ai/install.sh | bash"
    fi
  else
    cannot "claude not on PATH and not found in any known install location" \
           "curl -fsSL https://claude.ai/install.sh | bash"
  fi
fi

# node/npx underpins the browser section only. Missing node is not a failure
# unless you asked for a browser, so it is reported there, not here.
if command -v npx >/dev/null 2>&1; then ok "node   ($(node --version 2>/dev/null))"; fi

# --- repository --------------------------------------------------------------
echo
echo "repository"
if git rev-parse --git-dir >/dev/null 2>&1; then
  ok "inside a git repo"
  # An unset identity does not fail loudly -- `git commit` just errors inside
  # commit-on-stop.sh where nobody reads it, and the handoff trail silently
  # stops. A repo-local fallback is better than a silent hole; you can
  # override it any time with a real `git config user.email`.
  if ! git config user.name >/dev/null 2>&1 || ! git config user.email >/dev/null 2>&1; then
    if [ "$FIX" = 1 ]; then
      git config user.name  >/dev/null 2>&1 || git config user.name  "ai-ceo harness"
      git config user.email >/dev/null 2>&1 || git config user.email "harness@localhost"
      did "git identity was unset (commit-on-stop would have failed silently) -- set a repo-local fallback"
      hint "override with: git config user.email you@example.com"
    else
      cannot "git user.name/user.email unset -- commit-on-stop will fail silently" \
             "git config user.email you@example.com && git config user.name you"
    fi
  else
    ok "git identity ($(git config user.name) <$(git config user.email)>)"
  fi
else
  bad "not a git repo -- the handoff depends on git log"
  hint "you are probably one directory above the clone"
fi
[ -d .claude ] && ok ".claude/ is here (hooks load from the directory you launch claude in)" \
               || bad ".claude/ missing -- run claude from the repo root, not a subdirectory"

# --- hooks -------------------------------------------------------------------
echo
echo "hooks"
for h in kill-switch steer safety-gate track-read verify-gate frozen-guard progress-budget commit-on-stop; do
  f=".claude/hooks/$h.sh"
  if [ ! -f "$f" ]; then bad "$f missing"
  elif [ ! -x "$f" ]; then
    # git preserves the exec bit, but archives, some Windows checkouts and a
    # umask-hostile CI do not. A non-executable hook does not error, it just
    # never fires -- the worst possible failure for an enforcement layer.
    if [ "$FIX" = 1 ] && chmod +x "$f" 2>/dev/null; then did "$h was not executable (it would have silently never fired) -- chmod +x"
    else cannot "$f not executable" "chmod +x .claude/hooks/*.sh"; fi
  elif ! bash -n "$f" 2>/dev/null; then bad "$f has a syntax error"
  else ok "$h"; fi
done
[ -s .claude/hooks/danger-patterns.txt ] && ok "danger-patterns.txt present ($(grep -cvE '^\s*#|^\s*$' .claude/hooks/danger-patterns.txt) rules)" \
                                         || bad "danger-patterns.txt missing -- the safety gate enforces nothing"
[ -s .claude/settings.json ] && python3 -c 'import json,sys; json.load(open(".claude/settings.json"))' 2>/dev/null \
  && ok "settings.json parses" || bad "settings.json missing or invalid JSON"

# --- agents ------------------------------------------------------------------
echo
echo "agents"
for a in planner evaluator rubric-reviewer; do
  [ -s ".claude/agents/$a.md" ] && ok "$a" || bad ".claude/agents/$a.md missing"
done
if [ ! -s .claude/agents/evaluator.md ]; then
  : # already reported missing above; do not also claim its tools line is clean
elif grep -qE '^tools:.*(Write|Edit)' .claude/agents/evaluator.md 2>/dev/null; then
  bad "evaluator.md grants Write/Edit -- the judge must not be able to fix what it grades"
else ok "evaluator has no Write/Edit"; fi

# --- model access ------------------------------------------------------------
# This section used to print nothing at all when claude was missing, which is
# how a fresh box gets a clean-looking report with a hole in the middle of it.
echo
echo "model access"
if ! command -v claude >/dev/null 2>&1; then
  bad "skipped: no claude CLI (fix the tools section first)"
else
  [ -n "${ANTHROPIC_BASE_URL:-}" ] && ok "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" \
                                   || note "ANTHROPIC_BASE_URL unset -- using the CLI's default endpoint"
  for v in BUILDER_MODEL EVALUATOR_MODEL PLANNER_MODEL REVIEWER_MODEL; do
    eval "val=\${$v:-}"; [ -n "$val" ] && ok "$v=$val"
  done

  # Credentials are the one thing this script cannot invent. Say so precisely
  # -- "check auth" is not a fix, `claude setup-token` is.
  authed=0
  [ -n "${ANTHROPIC_API_KEY:-}" ]        && { ok "ANTHROPIC_API_KEY is set";        authed=1; }
  [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]     && { ok "ANTHROPIC_AUTH_TOKEN is set";     authed=1; }
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]  && { ok "CLAUDE_CODE_OAUTH_TOKEN is set";  authed=1; }
  [ -s "$HOME/.claude/.credentials.json" ] && { ok "stored credentials from a previous login"; authed=1; }
  [ "$authed" = 0 ] && note "no credential found in the environment -- the probe below is the real test"

  printf '  ...  probing the endpoint with a one-word prompt (may take a moment)\n'
  probe=$(run_to 180 claude -p ${DOCTOR_MODEL:+--model "$DOCTOR_MODEL"} --permission-mode bypassPermissions \
          'Reply with exactly the word: READY' 2>&1 | tr -d '[:space:]')
  case "$probe" in
    *READY*) ok "the CLI reached a model and it answered" ;;
    "")      bad "the CLI returned nothing -- it is not authenticated, or ANTHROPIC_BASE_URL is wrong"
             hint "headless box, subscription:  claude setup-token   (then export CLAUDE_CODE_OAUTH_TOKEN=...)"
             hint "headless box, API billing:   export ANTHROPIC_API_KEY=sk-ant-...  (add it to ~/.bashrc)"
             hint "this is deliberately not auto-fixed: a secret is yours to supply" ;;
    *)       bad "unexpected reply from the endpoint: $(printf '%s' "$probe" | cut -c1-160)"
             hint "if that text mentions login or credit, the account -- not the harness -- is the problem" ;;
  esac
fi

# --- agent capabilities ------------------------------------------------------
# What can a builder session actually DO on this machine? The planner writes
# LEVELS.md against this, so an honest answer here is worth more than an
# optimistic one: a level whose acceptance criteria need a GUI on a box with no
# GUI cannot be passed, and the loop will burn every cycle discovering that.
echo
echo "agent capabilities"

UNAME=$(uname -s)
HEADLESS=0
if [ "$UNAME" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then HEADLESS=1; fi
CAP_WEB="none"; CAP_BROWSER="none"; CAP_COMPUTER="no"

ok "platform: $UNAME$( [ "$HEADLESS" = 1 ] && echo ' (headless -- no DISPLAY)')"
ok "WebFetch / WebSearch: built in, always available to a builder session"
CAP_WEB="WebFetch + WebSearch (built in)"

# -- claude-in-chrome. It is a built-in MCP server, but it drives a REAL Chrome
# through the Web Store extension and a native-messaging host, and it refuses to
# enable on api-key auth. None of that exists in a headless container, so on a
# server the honest report is "unavailable", not "not configured".
CIC_HOST_LINUX="$HOME/.config/google-chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json"
CIC_HOST_MAC="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json"
if [ "$HEADLESS" = 1 ]; then
  note "claude-in-chrome: UNAVAILABLE on this box, and not fixable here"
  hint "it needs a running desktop Chrome + the Web Store extension + native messaging,"
  hint "and it stays off under API-key auth. A headless container has none of those."
  hint "the working substitute on a server is the Playwright MCP provisioned below."
elif [ -s "$CIC_HOST_MAC" ] || [ -s "$CIC_HOST_LINUX" ]; then
  ok "claude-in-chrome: native messaging host installed -- run 'claude --chrome' in an INTERACTIVE session"
  hint "note: loop.sh builders run 'claude -p', so the loop itself still uses Playwright, not this"
  CAP_BROWSER="claude-in-chrome (interactive sessions only)"
else
  note "claude-in-chrome: desktop present but the extension is not connected yet"
  hint "run 'claude --chrome' once interactively and follow the install prompt"
fi

# -- computer-use. macOS only, and explicitly unavailable under -p. Since every
# builder session in this harness IS a -p session, this is off for the loop even
# on a Mac. Stating that up front stops a level being planned around it.
if [ "$UNAME" = "Darwin" ]; then
  note "computer-use: macOS supports it, but ONLY in an interactive session"
  hint "loop.sh runs builders as 'claude -p', where computer use is unavailable by design"
  hint "to use it by hand: run 'claude', then '/mcp' -> computer-use -> Enable"
else
  note "computer-use: UNAVAILABLE -- the CLI supports it on macOS only, never Linux"
  hint "there is no flag, plan, or config that turns it on here"
fi

# -- Playwright MCP: the capability that actually survives a headless VPS and a
# -p session. Registered at USER scope on purpose -- project scope lands in
# .mcp.json and waits for an interactive trust prompt that a loop never gets.
if [ "$BROWSER" = 0 ]; then
  note "browser provisioning skipped (--no-browser)"
elif ! command -v claude >/dev/null 2>&1; then
  bad "cannot provision a browser without the claude CLI"
else
  if ! command -v npx >/dev/null 2>&1; then
    if [ "$FIX" = 1 ] && command -v apt-get >/dev/null 2>&1; then
      printf '  ...  installing nodejs/npm (needed by the Playwright MCP server)\n'
      SUDO=""; [ "$(id -u)" != 0 ] && SUDO="sudo"
      run_to 600 $SUDO apt-get update -qq >/dev/null 2>&1
      run_to 600 $SUDO apt-get install -y -qq nodejs npm >/dev/null 2>&1
      command -v npx >/dev/null 2>&1 && did "installed node $(node --version 2>/dev/null)" \
                                     || bad "node install failed -- install Node 18+ and re-run"
    else
      cannot "npx not found -- the Playwright MCP server needs Node 18+" \
             "apt-get install -y nodejs npm   (or use nvm)"
    fi
  fi

  if command -v npx >/dev/null 2>&1; then
    # `claude mcp list` health-checks by spawning every registered server, so it
    # can hang on an unrelated broken one. Cap it and treat a timeout as unknown.
    if run_to 60 claude mcp list 2>/dev/null | grep -qi '^playwright[[:space:]:]'; then
      ok "playwright MCP already registered"
      CAP_BROWSER="playwright MCP (headless chromium)"
    elif [ "$FIX" = 1 ]; then
      # --headless because there is no display; user scope because a -p session
      # never sees the project-scope approval prompt.
      addout=$(claude mcp add playwright --scope user -- npx -y @playwright/mcp@latest --headless 2>&1)
      if [ $? -eq 0 ]; then
        did "registered the playwright MCP server at user scope (headless chromium)"
        CAP_BROWSER="playwright MCP (headless chromium)"
      elif printf '%s' "$addout" | grep -qi 'already exists'; then
        # The list probe above timed out or was filtered; the server is there.
        ok "playwright MCP already registered"
        CAP_BROWSER="playwright MCP (headless chromium)"
      else
        bad "could not register the playwright MCP server"
        hint "$(printf '%s' "$addout" | head -2)"
        hint "run it by hand: claude mcp add playwright --scope user -- npx -y @playwright/mcp@latest --headless"
      fi
    else
      cannot "playwright MCP not registered -- the builder has no browser" \
             "claude mcp add playwright --scope user -- npx -y @playwright/mcp@latest --headless"
    fi

    # Chromium and its shared libraries. Playwright pulls the browser on first
    # launch, but doing it now converts a mid-run 3-minute stall (or a cryptic
    # libnss3 error at cycle 4) into a one-time cost you can watch.
    if [ "$FIX" = 1 ] && [ "$CAP_BROWSER" != "none" ]; then
      if [ -d "$HOME/.cache/ms-playwright" ] && ls "$HOME/.cache/ms-playwright" 2>/dev/null | grep -q chromium; then
        ok "chromium already downloaded ($HOME/.cache/ms-playwright)"
      else
        printf '  ...  downloading chromium + system libs (one time, ~150MB)\n'
        if [ "$UNAME" = "Linux" ] && command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
          run_to 900 npx -y playwright install --with-deps chromium >/tmp/pw-install.$$ 2>&1
        else
          run_to 900 npx -y playwright install chromium >/tmp/pw-install.$$ 2>&1
        fi
        if ls "$HOME/.cache/ms-playwright" 2>/dev/null | grep -q chromium; then
          did "downloaded headless chromium"
        else
          note "chromium download did not complete -- the MCP will retry on first use"
          hint "log: /tmp/pw-install.$$"
          hint "debian/ubuntu also needs: apt-get install -y libnss3 libasound2t64"
        fi
      fi

      # End-to-end proof, not an inventory check. Loading a real page is the
      # only thing that catches a missing libnss3, a blocked egress, or a
      # sandbox that kills chromium on launch.
      printf '  ...  smoke-testing a real headless page load\n'
      shot="${TMPDIR:-/tmp}/doctor-browser-probe.png"
      rm -f "$shot"
      if run_to 180 npx -y playwright screenshot --browser chromium https://example.com "$shot" >/tmp/pw-probe.$$ 2>&1 \
         && [ -s "$shot" ]; then
        ok "headless chromium loaded a live page and screenshotted it ($(wc -c <"$shot" | tr -d ' ') bytes)"
        rm -f "$shot"
      else
        note "the headless page-load probe failed -- the builder may have no working browser"
        hint "log: /tmp/pw-probe.$$"
        hint "usual causes: missing libnss3/libasound2t64, or egress blocked from this host"
        CAP_BROWSER="playwright MCP (registered, NOT verified)"
      fi
    fi
  fi
fi

# CAPABILITIES.md is read by the planner. Writing it is the whole point of this
# section: the plan should be built against what this machine can do, not
# against what the docs say Claude Code can do somewhere else.
if [ "$FIX" = 1 ]; then
  {
    echo "# Capabilities of this machine"
    echo
    echo "Written by \`harness/doctor.sh\`. The planner must not write a level whose"
    echo "acceptance criteria need a capability marked unavailable here."
    echo
    echo "- platform: $UNAME$( [ "$HEADLESS" = 1 ] && echo ' (headless, no DISPLAY)')"
    echo "- web access: $CAP_WEB"
    echo "- browser automation: $CAP_BROWSER"
    echo "- desktop/computer use: unavailable (CLI computer use is macOS-only and never available under \`claude -p\`)"
    echo "- claude-in-chrome: $( [ "$HEADLESS" = 1 ] && echo 'unavailable (needs desktop Chrome + extension + interactive login)' || echo 'possible in interactive sessions only, not in the loop' )"
    echo
    echo "Builder sessions are non-interactive (\`claude -p\`). Any capability that"
    echo "requires an interactive prompt is unavailable to the loop by construction."
  } > CAPABILITIES.md
  did "wrote CAPABILITIES.md (the planner reads this)"
fi

# --- task state --------------------------------------------------------------
echo
echo "task state"
if [ -s SCOREBOARD.json ]; then
  note "a task is already initialized here ($(harness/scoreboard.sh remaining) level(s) unfinished) -- harness/loop.sh would resume it"
else
  ok "clean workspace -- ready for a new task"
fi
[ -e AGENT_STOP ] && note "AGENT_STOP exists: every tool call is blocked until you remove it"

# --- verdict -----------------------------------------------------------------
echo
[ "$fixed" -gt 0 ] && echo "doctor: repaired $fixed thing(s) on this machine."
if [ "$fail" -gt 0 ]; then
  echo "doctor: $fail failure(s), $warn warning(s) -- the FAIL lines above could not be fixed automatically."
  echo "        Each one has a '->' line under it with the exact command."
  exit 1
fi
echo "doctor: ready. $warn warning(s)."
echo "Next: open a claude session here and use /start, or run harness/plan.sh -f INIT_PROMPT.md"
