<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Initialization

One prompt starts a task. Everything the loop needs is derived from it, then approved by a
human, and then the loop runs unattended until the plan is done or you stop it.

```
your initialization prompt
        │
        ▼
`npm run plan --` (in `sdk/`) ──► planner session   ──► LEVELS.md, SCOREBOARD.seed.json,
        │                                  EVIDENCE.md, .claude/evidence-patterns.txt,
        │                                  RUBRIC.md, [evaluator.addendum.md]
        │           validate + promote ──► SCOREBOARD.json  (all rows false)
        │
        └────────► rubric-reviewer    ──► RUBRIC_REVIEW.md   (fresh session, ACCEPT/REVISE)
                            │
                            ▼
                    YOU APPROVE  ← the only manual gate
                            │
                            ▼
`npm run loop --` ──► build ──► evaluate ──► PASS: wrapper writes the scoreboard row
                      ▲                    NEEDS_WORK: findings → NEXT_FINDINGS.md
                      └────────────────────────────────┘
                    until every row passes, or AGENT_STOP, or MAX_CYCLES
```

## 1. Write the initialization prompt

Four things, and only these four. Everything else is derived.

| | |
|---|---|
| **Task** | What you want, concretely, including what the finished thing looks like. |
| **Domain** | What kind of work this is. This is what determines the evidence taxonomy. |
| **Constraints** | What must be true of the result, and what is off limits. |
| **Budget** | How many sub-levels and sessions this is worth. |

An initialization prompt cannot change the [frozen core](#what-a-prompt-cannot-change). If
it tries, the planner refuses and the hooks deny it.

Example, from the smoke test in [`demo/`](./demo/):

> **Task:** Produce a sourced, two-page comparison of SQLite and DuckDB for single-machine
> local analytics, written for a developer deciding which to use for a roughly 5 GB
> analytical workload on a laptop. The deliverable is `REPORT.md`, 900–1200 words.
>
> **Domain:** technical research and writing. No application code is to be written, built,
> benchmarked, or run — this is a documentation deliverable, and every claim must come from
> published sources rather than from experiments you perform.
>
> **Constraints:** every substantive claim must trace to a primary source (the projects'
> official documentation, their published papers, or their own release notes); vendor
> marketing copy and undated blog posts do not count as primary. No money may be spent and
> nothing may be published anywhere.
>
> **Budget:** at most 4 sub-levels; at most 8 builder sessions in total.

Be specific about what "done" looks like. The planner turns your description into acceptance
criteria an evaluator can check by opening files, and vague input produces criteria that
can't fail.

## 2. Run the planner

The short way — open a session in the repo root and describe the task:

```
/start research the current evidence on X and produce a sourced review
```

`/start` interviews you for anything missing, writes `INIT_PROMPT.md`, runs both sessions
below, and stops for your approval. The explicit way, which does exactly the same thing:

```bash
`npm run plan --` (in `sdk/`) "Task: ...  Domain: ...  Constraints: ...  Budget: ..."
`npm run plan --` (in `sdk/`) init-prompt.md          # or from a file
```

Two fresh sessions run. The planner produces:

- **`EVIDENCE.md`** — the evidence taxonomy: what artifact would convince a skeptical reader
  who wasn't there, where it lives, and what makes one valid or worthless.
- **`.claude/evidence-patterns.txt`** — the same thing as shell globs, which is what
  `track-read.sh` enforces. If these two drift apart the gate protects nothing.
- **`LEVELS.md`** — the ordered plan. Each level is one session's work with a goal,
  acceptance criteria, required evidence artifacts, and dependencies.
- **`SCOREBOARD.seed.json`** → validated and promoted to **`SCOREBOARD.json`**. One row per
  level, every row `"passes": false`, each with a `check` naming the observable evidence.
- **`RUBRIC.md`** — named scoring criteria, a 1–5 scale with concrete anchors, worked
  few-shot examples, and the passing bar.
- optionally **`.claude/agents/evaluator.addendum.md`** — domain instructions for the
  evaluator, which may add strictness but never waive a criterion.

Then a **second fresh session** that never saw the planner's reasoning reviews the rubric
for gameability and writes **`RUBRIC_REVIEW.md`**, beginning `ACCEPT` or `REVISE`. It is
looking for criteria satisfied by volume rather than substance, evidence the builder can
manufacture to order, and acceptance criteria the rubric forgot to score.

### A domain with no evidence taxonomy does not start

If the planner cannot say concretely what artifact proves work is done in this domain, it
writes nothing and says so. ``npm run loop --`` independently refuses to start when
`EVIDENCE.md` or `.claude/evidence-patterns.txt` is missing:

```
loop: refusing to start. Missing:
  - EVIDENCE.md (the evidence taxonomy for this domain)

This harness does not run a domain whose evidence taxonomy is undefined:
without one there is no way to tell finished work from claimed work, and
every verdict downstream is a guess.
```

This is deliberate. Without a taxonomy the evaluator is judging vibes, the default-FAIL
contract has nothing to check, and the whole loop degrades into an agent grading itself.
If your domain resists a taxonomy, that is worth knowing before you spend a night of compute
on it.

## 3. Approve

The only manual gate, and the one worth your attention. Read:

1. **`LEVELS.md`** — is this the right decomposition, in the right order? Would you get
   something useful if the loop stopped after level 2?
2. **`RUBRIC_REVIEW.md`** — if it says `REVISE`, fix `RUBRIC.md` before running anything.
   A gameable rubric produces a scoreboard of green rows and a worthless deliverable.
3. **`EVIDENCE.md`** — would the artifacts it names actually convince you?
4. **`.claude/agents/evaluator.addendum.md`**, if present — and add any extra tools it asks
   for to the `tools:` line in `.claude/agents/evaluator.md` yourself. The planner cannot;
   `frozen-guard.sh` denies it. For web work that usually means a browser:

   ```yaml
   tools: Read, Glob, Grep, Bash, mcp__playwright__browser_navigate, mcp__playwright__browser_take_screenshot
   ```

   An evaluator that can open the running app is strictly better than one trusting the
   builder's screenshots.

## 4. Run the loop

```bash
`npm run loop --`                          # until done
MAX_CYCLES=3 `npm run loop --`             # capped
BUILDER_MODEL=sonnet EVALUATOR_MODEL=opus `npm run loop --`
```

Each cycle is two fresh `claude -p` processes: a builder on the first level whose row is
still `false`, then an evaluator that never saw the build. On `PASS` the **wrapper** writes
the scoreboard row — no session can, `verify-gate.sh` denies them. On `NEEDS_WORK` the
verdict becomes `NEXT_FINDINGS.md` and the same level runs again with those findings as its
work list.

Running each session as a separate process is not an implementation detail: hook config is
snapshotted when a session starts, so the enforcement layer only exists because the wrapper
starts a new process every cycle.

Watching it:

```bash
watch -n 5 'harness/scoreboard.sh status'      # what has been confirmed
watch -n 2 'tail -30 PROGRESS.md'              # the agent's own notes
watch -n 5 'git log --oneline -8'              # work saved
watch -n 5 'tail -20 logs/loop.log'            # cycles and verdicts
cat PAUSED_ACTIONS.md                          # what it wanted to do and couldn't
```

Intervening:

```bash
touch AGENT_STOP                    # halt: every tool call blocked, loop exits its cycle
echo "focus on level 3 only" > STEER.md   # surfaced to the agent once, then cleared
rm AGENT_STOP                       # resume
```

## 5. When it stops

`loop.sh` exits when every row passes, `AGENT_STOP` appears, `MAX_CYCLES` is hit, or a cycle
produces no change and no `PASS` (spinning). The reason is the last line of `logs/loop.log`.

Then: read `SCOREBOARD.json` for what was independently confirmed, `PAUSED_ACTIONS.md` for
what needs a human, and `memory/` for what the run learned that outlives it. Delete
`PROGRESS.md` — it was task state and the task is over. Keep `memory/`.

## What a prompt cannot change

The [frozen core](./.claude/CLAUDE.md#frozen-core), enforced by `frozen-guard.sh`, not by
asking: the three-agent structure, the default-FAIL contract, the wrapper being the only
writer of the scoreboard, the single budgeted `PROGRESS.md`, the STATE/LESSON memory split,
the safety gates, and the requirement that evidence be defined before anything runs.

A prompt configures **the task**: what to do, in what domain, under what constraints and
budget — plus `LEVELS.md`, `EVIDENCE.md` and its patterns, `RUBRIC.md`, the evaluator
addendum, and the evaluator's tools. Nothing else. See [EXTENDING.md](./EXTENDING.md) for
three worked examples in different domains, and [SECURITY.md](./SECURITY.md) for what the
enforcement layer does and does not actually stop.
