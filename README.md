# AI-CEO v0 — a minimal harness for long-horizon agent loops

Give it one prompt describing a task. It plans the work, executes it one sub-level per
session across as many fresh sessions as it takes, and judges each one with an agent that
never saw the work being done. It refuses to mark anything complete on its own say-so, it
blocks itself from spending money or posting or breaking things, and it keeps its own notes
so the next session picks up cleanly.

It is bash scripts, markdown files, and Claude Code hooks. There is no framework, no
runtime, and no state outside the working tree. You can read all of it in half an hour, and
that is deliberate: a harness you can't audit is a harness you can't trust with a night of
unattended compute.

**Domain-general.** Nothing in the loop knows what web development is. The task, the domain,
what counts as evidence, and how quality is scored are all configured per task; the loop, the
gates, and the memory system are fixed. Worked examples in medical research, small-business
strategy, and web development are in [EXTENDING.md](./EXTENDING.md).

```bash
harness/plan.sh "Task: ...  Domain: ...  Constraints: ...  Budget: ..."
#   → LEVELS.md, EVIDENCE.md, RUBRIC.md, SCOREBOARD.json (every row false), RUBRIC_REVIEW.md
#   → you read them and approve
harness/loop.sh
#   → build → evaluate → rebuild, until every row is confirmed or you stop it
```

> Built on [`anthropics/cwc-long-running-agents`](https://github.com/anthropics/cwc-long-running-agents),
> the take-home for the Long-Running Agents station at Code with Claude 2026, which shipped
> these primitives as standalone examples to cherry-pick. This assembles them into one
> runnable loop. The patterns come from [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
> (Nov 2025) and [Harness Design for Long-Running Application Development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
> (Mar 2026).

## How it works

```
    initialization prompt
            │
   ┌────────▼────────┐
   │  PLANNER        │  one session. Expands the prompt into an ordered plan,
   │  (fresh)        │  defines what counts as evidence in this domain, and
   └────────┬────────┘  writes the rubric it will be scored against.
            │
   ┌────────▼────────┐
   │ RUBRIC REVIEWER │  a second fresh session that tries to find the cheapest
   │  (fresh)        │  way to score well without doing the work.
   └────────┬────────┘
            │
      YOU APPROVE ◄── the only manual gate
            │
   ┌────────▼────────┐
   │  BUILDER        │  one sub-level per session. Fetches memory, does the work,
   │  (fresh, each   │  leaves evidence on disk, writes its claim, updates the
   │   cycle)        │  handoff, commits.
   └────────┬────────┘
            │
   ┌────────▼────────┐
   │  EVALUATOR      │  no Write/Edit tools, never saw the build. Opens every
   │  (fresh, each   │  artifact and checks it against the claim.
   │   cycle)        │  → PASS or NEEDS_WORK with specific findings
   └────────┬────────┘
            │
      the WRAPPER writes the scoreboard ── only on PASS, never the builder
            │
            └──► next level, or the same level again with the findings
```

Three properties do the actual work:

**Nothing marks itself done.** Every sub-level starts `"passes": false` in `SCOREBOARD.json`
with a `check` naming the evidence that would prove it. The builder cannot write that file —
a hook denies it outright. Only `harness/scoreboard.sh` writes it, only from the wrapper,
only after the evaluator returned `PASS`. So a green row means *someone else looked*.

**The judge is a stranger.** The evaluator runs in a fresh context with no Write or Edit
tools. It reads the acceptance criteria, the rubric, and the builder's written claim, then
opens every artifact and checks the claim against it. The most common failure it catches is
not broken work — it's work that is fine paired with a claim that overstates it.

**The agent maintains its own handoff.** A fresh session remembers nothing, and a long
session's context gets summarized. So the agent writes `PROGRESS.md` (current state, edited
in place, hard size budget) and commits at checkpoints, and a `Stop` hook commits whatever
is left. Durable learnings go somewhere else entirely — see below.

## What's in the box

| | Justification |
|---|---|
| **`harness/plan.sh`** | One command turns the initialization prompt into the plan artifacts and their gameability review, then stops for human approval. |
| **`harness/loop.sh`** | Something outside the agent has to start each fresh session, run the evaluator, and write the scoreboard, and that something is 60 lines of bash. |
| **`harness/scoreboard.sh`** | Concentrating every scoreboard write in one script called only by the wrapper is what makes `"passes": true` mean "independently confirmed". |
| **`harness/memcheck.sh`** | MAINTAIN needs a concrete worklist, so one script reports which memory files are over budget or missing from the index. |
| **`harness/selftest.sh`** | Hooks that fail silently are worse than no hooks, so one script asserts each gate blocks what it must and allows what it must. |
| **`.claude/agents/planner.md`** | A one-line ask has to become an ordered plan with per-level acceptance before any building starts, and that is a different job from building. |
| **`.claude/agents/evaluator.md`** | The builder cannot grade itself, so a context that never saw the build judges the artifacts on disk instead. |
| **`.claude/agents/rubric-reviewer.md`** | A rubric written by the same session that wrote the plan is a rubric written to be passable, so a second fresh session attacks it for gameability first. |
| **`.claude/CLAUDE.md`** | The builder contract, and the written statement of what no prompt can change. |
| **`hooks/verify-gate.sh`** | The scoreboard is unwritable from inside a session, and an evidence claim cannot be written before the evidence has been opened. |
| **`hooks/track-read.sh`** | What counts as evidence is domain-specific, so the patterns come from the task's taxonomy rather than being hardcoded to screenshots. |
| **`hooks/frozen-guard.sh`** | The frozen core is enforced by a hook rather than by asking nicely, so no initialization prompt can rewrite the loop's own rules. |
| **`hooks/safety-gate.sh`** | Spending, publishing, and irreversible actions are blocked and logged rather than trusted to prompt text, and the session continues on other work. |
| **`hooks/danger-patterns.txt`** | One auditable file lists every blocked pattern so operators can review and extend the gate without editing shell logic. |
| **`hooks/progress-budget.sh`** | A session that opens with a bloated handoff spends its context on history, so an over-budget `PROGRESS.md` makes condensing the session's first task. |
| **`hooks/kill-switch.sh`** | One `touch AGENT_STOP` has to be able to halt everything. |
| **`hooks/steer.sh`** | Redirecting a running loop shouldn't require restarting it. |
| **`hooks/commit-on-stop.sh`** | The backstop that catches whatever the agent forgot to commit. |
| **`.claude/settings.json`** | One file says which hook runs on which event, so the enforcement layer can be read in ten lines. |
| **`.gitignore`** | Only the hooks' runtime scratch files are excluded; everything a run produces is committed on purpose, because `git log` is the second record. |

If a file isn't in that table, it shouldn't be in the repo. Two exceptions, both about the
build of this repo rather than the harness itself: `BUILD_PLAN.md` is the plan this rewrite
was executed against, and `HARNESS_ACCEPTANCE.json` is that plan's own default-FAIL contract
— the harness applied to its own construction. Neither is used at runtime.

## Two kinds of memory

The failure this prevents is one growing file that is part status report, part notebook,
part diary — too stale to trust and too task-specific to reuse.

- **STATE** is `PROGRESS.md`: this task only, overwritten in place, ~8k tokens, deleted when
  the task ends.
- **LESSON** is `memory/*.md` plus a one-line-per-file `INDEX.md`: durable across tasks,
  ~2k tokens per file.

Three operations at fixed points: **FETCH** at the start of a level (read the index, then
open 2–5 relevant files — never the whole directory), **GROW** at the end (write what this
level taught), **MAINTAIN** before every write (merge duplicates, delete what's now wrong,
condense). Curation over accumulation: a wiki that only grows is a wiki nobody reads.

Full detail in [MEMORY.md](./MEMORY.md).

## Safety

Three categories are blocked by a `PreToolUse` hook, not by prompt text: anything that
**spends money**, **posts publicly or sends an external message**, or is **irreversible in
the real world**. A blocked action is appended to `PAUSED_ACTIONS.md` — what it wanted to do
and why it was stopped — and the session is told to carry on with the rest of the level. You
run whatever you approve, by hand.

The rules live in [`danger-patterns.txt`](./.claude/hooks/danger-patterns.txt), one tagged
regex per line. It fails closed: a rule it can't parse blocks everything until a human fixes
it, because the alternative is a gate that reports clean while enforcing nothing.

Plus `touch AGENT_STOP` to halt every tool call, and `echo "..." > STEER.md` to redirect a
running loop once.

**Read [SECURITY.md](./SECURITY.md) before running this unattended against anything you
care about.** It states the deployment requirement — `.claude/` and `harness/` must be
read-only to the agent process — and lists the gaps the shipped hooks do not close.

## Requirements

`bash`, `git`, `python3`, and the [Claude Code CLI](https://code.claude.com/docs) on your
`PATH`. Run everything from the directory containing `.claude/`; hooks are not loaded when
you launch from a subdirectory.

```bash
harness/selftest.sh     # 46 assertions over the hook logic — run after editing any gate
```

## Docs

| | |
|---|---|
| [INIT.md](./INIT.md) | Writing the initialization prompt; what the planner produces; approving it; running and watching the loop. |
| [MEMORY.md](./MEMORY.md) | STATE vs. LESSON, and the GROW / MAINTAIN / FETCH operations. |
| [SECURITY.md](./SECURITY.md) | The read-only requirement, the known bypass gaps, and the honest threat model. |
| [EXTENDING.md](./EXTENDING.md) | Three fully worked initializations in unrelated domains. |
| [demo/](./demo/) | A real run, preserved: plan, verdicts, a `NEEDS_WORK` rework, memory, git log. |
| [`.claude/CLAUDE.md`](./.claude/CLAUDE.md) | The builder contract and the frozen core. |

## Related

If you want the loop without the harness, Claude Code ships
[`/goal`](https://code.claude.com/docs/en/goal): set a completion condition and a separate
fast model checks it after every turn. One line, no contract file, no hooks — and no
domain-defined evidence, no rubric, and no independent judge. Try both.

On the [Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk), these hooks translate
one-to-one to `PreToolUse`/`Stop` callbacks and the evaluator to a separate `query()`; see
[`evaluator_optimizer`](https://github.com/anthropics/claude-cookbooks/blob/main/patterns/agents/evaluator_optimizer.ipynb).
For a hosted version of the whole idea, see [Claude Managed
Agents](https://docs.claude.com/en/docs/managed-agents).

---

Apache-2.0. Built as an event demo; not maintained and not accepting contributions.
