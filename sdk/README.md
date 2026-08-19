# ai-ceo harness on the Claude Agent SDK

The original bash harness (`harness/*.sh` + `.claude/hooks/*.sh`, now only in git history), re-implemented as a
TypeScript program on `@anthropic-ai/claude-agent-sdk`. Same three-agent design,
same file-based state, same gates -- different enforcement point.

## What moved where

| bash harness | sdk harness |
|---|---|
| `.claude/settings.json` wiring 8 hook scripts | `src/gates.ts` -- one module, passed to every `query()` as in-process hooks |
| `harness/plan.sh` (planner + rubric reviewer) | `src/plan.ts` |
| `harness/loop.sh` (build -> judge -> scoreboard) | `src/loop.ts` |
| `harness/scoreboard.sh` (only writer) | `src/scoreboard.ts` (only caller: the loop) |
| `harness/planlock.sh` | `src/planlock.ts` |
| `harness/memcheck.sh` | `src/memcheck.ts` |
| `harness/selftest.sh` (64 checks) | `src/selftest.ts` (48 checks, pure functions) |
| `.claude/agents/*.md` + `.claude/CLAUDE.md` contract | `prompts/*.md`, prepended per session |
| `.claude/hooks/danger-patterns.txt` | `danger-patterns.txt` (same format, fail-closed) |
| repo root doubles as task workspace | **separate task directory** (`../runs/<task>/`, own git repo) |

## Why the SDK version is structurally stronger

1. **The frozen core is now out of reach, not just guarded.** Hooks used to be
   files inside the workspace, defended by a regex (`frozen-guard.sh`) that
   SECURITY.md admitted was not a boundary. Now the gates run in the harness
   *process*; a session cannot read, edit, or route around them, and
   `settingSources: []` means no `.claude/` directory influences a session at all.
2. **The operator's own sessions are free.** Opening `claude` in this repo
   loads no hooks at all -- the bash implementation was removed after the
   transformation (it survives in git history). Editing the harness happens in
   a normal session; only the sessions the harness *spawns* are gated. The
   "why can't I edit doctor.sh" confusion is gone because the answer is now:
   you can.
3. **Typed verdicts.** The judge's verdict is read from the SDK's `result`
   message, not scraped from a log file. A crashed judge (no verdict) and a
   failing verdict are different values by construction; the loop retries one
   and halts on two, exactly like the bash version, minus the awk.
4. **Harness ≠ workspace.** Each task lives in its own directory with its own
   git history; the write sandbox denies any session write outside it. Running
   the harness on itself is no longer a special case to defend against.

What did NOT change: every file the PDF explains -- `LEVELS.md`, `EVIDENCE.md`,
`RUBRIC.md`, `SCOREBOARD.json` (default-FAIL, wrapper-written), `PROGRESS.md`
(8k budget), `NEXT_FINDINGS.md`, `PAUSED_ACTIONS.md`, `AGENT_STOP`, `STEER.md`,
`memory/` with GROW/MAINTAIN/FETCH, `evidence/level-*/CLAIM.md` -- keeps its
name, location (task dir root), and meaning. Files-as-state is the design;
only the enforcement moved.

## Use

```bash
cd sdk && npm install
npm run selftest                       # gate assertions, no API calls

npm run plan -- ../runs/mytask -f INIT_PROMPT.md   # or an inline "Task: ..." string
# read LEVELS.md / RUBRIC.md / RUBRIC_REVIEW.md, fix, then approve by running:
npm run loop -- ../runs/mytask
npm run status -- ../runs/mytask
```

Env (all opt-in, unset = the claude CLI's configured default):
`PLANNER_MODEL`, `REVIEWER_MODEL`, `BUILDER_MODEL`, `EVALUATOR_MODEL`,
`MAX_CYCLES` (12), `PROGRESS_BUDGET_TOKENS` (8000).

Mid-run controls, unchanged: `touch <taskdir>/AGENT_STOP` halts after the
current call; write to `<taskdir>/STEER.md` to redirect the builder; progress in
`<taskdir>/logs/loop.log`.
