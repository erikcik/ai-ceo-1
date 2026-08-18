---
description: Turn a task description into a plan, review it, and stop for your approval.
---
<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

The operator wants to start a new task on this harness. Their description:

$ARGUMENTS

Do exactly this, in order. You are the operator's assistant, not the builder — do not
attempt the task itself, and do not hand-write any plan artifact.

**1. Check the environment.** Run `harness/doctor.sh`. If it reports a hard failure, stop and
show them; nothing else will work until it is fixed.

**2. Check nothing is already running here.** If `LEVELS.md` or `SCOREBOARD.json` already
exist, this workspace holds an unfinished task. Say so, show `harness/scoreboard.sh status`,
and ask whether to resume it (`harness/loop.sh`) or archive it before starting fresh. Do not
overwrite.

**3. Build the initialization prompt.** It needs four parts, per `INIT.md`:

- **Task** — what they want, concretely, including what the finished thing looks like.
- **Domain** — what kind of work this is. This decides the evidence taxonomy.
- **Constraints** — what must be true of the result, and what is off limits.
- **Budget** — how many sub-levels and sessions this is worth.

If any is missing or vague, **ask before proceeding**. This is the one place where asking is
cheaper than guessing: a task described loosely produces acceptance criteria that cannot
fail, and the whole run is then theatre. Pay particular attention to what would count as
proof in their domain — if neither of you can name an artifact that would convince a
skeptical stranger, say so plainly, because the planner will refuse and the loop will not
start.

Write the finished prompt to `INIT_PROMPT.md` and show it to them.

**4. Plan.** Run `harness/plan.sh -f INIT_PROMPT.md`. This spawns two fresh sessions (the
planner, then an independent rubric reviewer) and takes a few minutes.

**5. Report and stop.** Summarize for them:

- the levels the planner chose and why that decomposition
- what it defined as evidence in this domain
- the `RUBRIC_REVIEW.md` verdict — **if `REVISE`, the findings must be applied to
  `RUBRIC.md` before anything runs**; offer to apply them
- whether the planner wrote `.claude/agents/evaluator.addendum.md`, and any extra evaluator
  tools it asked for, which only they can add to `.claude/agents/evaluator.md`

Then **stop and wait**. Approval is theirs, and it is the only manual gate in the system.

**6. On their approval only**, run `harness/loop.sh`. Tell them it runs unattended until every
level is confirmed or it hits `MAX_CYCLES`, that `touch AGENT_STOP` halts it after the current
step, and that `logs/loop.log` and `harness/scoreboard.sh status` show where it is.
