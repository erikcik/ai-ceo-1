# ai-ceo — a long-horizon agent harness on the Claude Agent SDK

Many short-lived Claude sessions, one dumb wrapper, everything passed through
files on disk. A planner turns one initialization prompt into a levelled plan
with a default-FAIL scoreboard; a builder executes one level per fresh session;
a fresh-context evaluator with no write tools judges only what is on disk; the
wrapper — never a session — flips scoreboard rows on PASS. Safety gates
(money / publish / irreversible), a kill switch (`AGENT_STOP`), operator
steering (`STEER.md`), a hash-locked plan, and a two-tier memory
(`PROGRESS.md` state + `memory/` lessons) ride along on every session as
in-process hooks the model cannot see or edit.

The implementation lives in [`sdk/`](sdk/README.md) — TypeScript on
`@anthropic-ai/claude-agent-sdk`. Each task runs in its own directory
(`runs/<task>/`, gitignored here) with its own git history; a write sandbox
denies any session write outside it.

```bash
cd sdk && npm install
npm run selftest                              # gate assertions, no API calls
npm run plan -- ../runs/mytask -f INIT.md     # planner + adversarial rubric review, then STOPS
# read LEVELS.md / RUBRIC.md / RUBRIC_REVIEW.md, fix, and approve by running:
npm run loop -- ../runs/mytask                # build -> judge -> scoreboard, unattended
npm run status -- ../runs/mytask
```

`INIT.md` explains how to write an initialization prompt (task, domain,
constraints, budget); `MEMORY.md` is the memory doctrine the builder follows.
The original bash/hooks implementation this grew out of is preserved in git
history (up to the `sdk/` transformation).
