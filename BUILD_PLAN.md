# BUILD_PLAN — AI-CEO v0

Phase 1 artifact. Nothing in this plan is implemented yet. Companion contract:
[`HARNESS_ACCEPTANCE.json`](./HARNESS_ACCEPTANCE.json) (every row currently `"passes": false`).

## What this repo becomes

Today it is a **read-and-cherry-pick demo**: five hooks and one evaluator subagent that
illustrate three primitives for web-dev sessions. There is no loop, no plan, no memory, no
safety layer, and the conventions in `CLAUDE.md` assume `npm test` and Playwright
screenshots.

AI-CEO v0 is the same primitives assembled into **one runnable, domain-general loop**:
a planner turns one initialization prompt into a plan, a wrapper script drives
builder→evaluator cycles until the plan is done, and hooks — not prose — enforce the parts
that must not be negotiable. It stays bash + markdown + JSON. No framework, no Python
runtime, no daemon.

The design rule I'm holding myself to: **every file below carries a one-sentence
justification, and any file I can't justify doesn't get built.** Those sentences are copied
verbatim into the shipped docs so a reader can audit the same way.

## First: delete the abandoned scaffolding

The working tree contains leftovers from an earlier, aborted attempt at this same task
(directory timestamps 00:24–00:28, untracked, plus a stale 8-item task list in the session
task store describing an `hcli.py` "kernel" design):

| Path | State | Action |
|---|---|---|
| `kernel/MANIFEST.sha256` | Seals 7 files, **none of which exist** (`harness/hcli.py`, `kernel/KERNEL.md`, 4 schemas) | delete |
| `kernel/schemas/` | empty | delete |
| `harness/lib/` | empty | delete |

That design (a sealed Python kernel, JSON schemas, integrity manifests, per-domain profile
files) is the opposite of the brief. I am not resurrecting any of it. The stale task list is
already cleared.

## Layout after the build

```
README.md                    rewritten: what AI-CEO v0 is + quickstart
INIT.md                      the initialization flow, end to end
MEMORY.md                    GROW / MAINTAIN / FETCH, and the two memory kinds
SECURITY.md                  read-only .claude/ in real deployments + known bypass gaps
EXTENDING.md                 three fully worked initialization examples
BUILD_PLAN.md                (this file — meta, about the build task)
HARNESS_ACCEPTANCE.json      (the build task's own default-FAIL contract)

harness/plan.sh              init: initialization prompt -> plan artifacts -> stop for approval
harness/loop.sh              the wrapper: preflight, build, evaluate, write scoreboard, repeat
harness/scoreboard.sh        the only writer of SCOREBOARD.json
harness/memcheck.sh          reports oversize / unindexed memory files

.claude/CLAUDE.md            builder conventions (rewritten domain-general) + FROZEN CORE
.claude/settings.json        hook wiring
.claude/agents/planner.md    expands the init prompt into the plan artifacts
.claude/agents/evaluator.md  fresh-context judge, no Write/Edit  (FROZEN)
.claude/agents/rubric-reviewer.md   one-shot gameability review of a generated rubric
.claude/hooks/kill-switch.sh        (kept as-is)
.claude/hooks/steer.sh              (kept as-is)
.claude/hooks/track-read.sh         (edited: patterns come from the domain's taxonomy)
.claude/hooks/verify-gate.sh        (edited: guards the evidence claim file)
.claude/hooks/frozen-guard.sh       (new: denies writes to the frozen core)
.claude/hooks/safety-gate.sh        (new: money / publish / irreversible -> PAUSED_ACTIONS.md)
.claude/hooks/danger-patterns.txt   (new: the denylist, one tagged regex per line)
.claude/hooks/progress-budget.sh    (new: over-budget PROGRESS.md -> condense first)
.claude/hooks/commit-on-stop.sh     (kept as-is)

templates/                   RUBRIC / EVIDENCE / LEVELS starting points the planner fills in
demo/                        preserved smoke-test artifacts (see Verification)
```

Generated per task, not shipped (gitignored in the template, committed in `demo/`):
`LEVELS.md`, `SCOREBOARD.json`, `EVIDENCE.md`, `RUBRIC.md`, `RUBRIC_REVIEW.md`,
`PROGRESS.md`, `PAUSED_ACTIONS.md`, `NEXT_FINDINGS.md`, `memory/`, `evidence/`, `logs/`.

### Two structural moves

1. **`claude-code-config/.claude/` → `.claude/` at the repo root.** Hooks only load from the
   directory you launch `claude` in, and in AI-CEO the repo root *is* the workspace, so the
   config has to live there. `claude-code-config/` and its README are deleted; the parts of
   that README that still apply move into the new `README.md`.
2. **`test-results.json` → `SCOREBOARD.json`.** Renamed because it is no longer about tests,
   and because its writer changes: the builder is now denied write access outright and the
   wrapper writes it. (`HARNESS_ACCEPTANCE.json`, this build's own contract, is a separate
   file and stays separate.)

## File-by-file, with justifications

### Wrapper scripts

| File | Justification (one sentence) |
|---|---|
| `harness/loop.sh` | Something outside the agent has to start each fresh session, run the evaluator, and write the scoreboard, and that something is 60 lines of bash. |
| `harness/plan.sh` | One command turns the initialization prompt into the plan artifacts and their gameability review, then stops for human approval. |
| `harness/scoreboard.sh` | Concentrating every scoreboard write in one script called only by the wrapper is what makes `"passes": true` mean "independently confirmed". |
| `harness/memcheck.sh` | MAINTAIN needs a concrete worklist, so one script reports which memory files are over budget or missing from the index. |

`loop.sh` shape:

```
preflight:  LEVELS.md, SCOREBOARD.json, EVIDENCE.md, .claude/evidence-patterns.txt,
            RUBRIC.md all present and non-empty  ->  else exit 2 with what's missing
loop:       while SCOREBOARD.json has a false row, no AGENT_STOP, iterations < MAX_CYCLES
  level  := first false row
  prompt := level text + acceptance + NEXT_FINDINGS.md (if any) + memcheck output
  claude -p "$prompt"                          # fresh session -> hooks load here
  verdict := claude --agent evaluator -p "..." # fresh session, no Write/Edit
  PASS       -> harness/scoreboard.sh pass <level> <evidence-path>   ; rm NEXT_FINDINGS.md
  NEEDS_WORK -> verdict > NEXT_FINDINGS.md     ; same level runs again
  git commit checkpoint; append to logs/loop.log
```

Exit conditions: no false rows left, `AGENT_STOP` exists, `MAX_CYCLES` hit, or a cycle
produces no git change. `BUILDER_MODEL` / `EVALUATOR_MODEL` env vars so routine runs can use
Sonnet.

### Agents

| File | Justification |
|---|---|
| `.claude/agents/planner.md` | A one-line ask has to become an ordered plan with per-level acceptance before any building starts, and that is a different job from building. |
| `.claude/agents/evaluator.md` | The builder cannot grade itself, so a context that never saw the build judges the artifacts on disk instead. |
| `.claude/agents/rubric-reviewer.md` | A rubric written by the same session that wrote the plan is a rubric written to be passable, so a second fresh session attacks it for gameability first. |

The planner's output contract (all four, or it refuses):

1. `LEVELS.md` — ordered sub-levels, each with a goal, acceptance criteria, and the
   evidence artifacts required.
2. `SCOREBOARD.json` — one `{"passes": false, "check": "..."}` row per level, `check`
   stating the observable evidence.
3. `EVIDENCE.md` + `.claude/evidence-patterns.txt` — the evidence taxonomy in writing, and
   the glob patterns `track-read.sh` will treat as evidence. **A domain with no defined
   evidence taxonomy must refuse to start** — the planner refuses to emit the other files,
   and `loop.sh` preflight exits 2 if either is missing.
4. `RUBRIC.md` — scoring principles plus few-shot examples of a 1, a 3, and a 5, per the
   harness-design article. `plan.sh` then runs `rubric-reviewer` → `RUBRIC_REVIEW.md`, and
   the human approves both before `loop.sh` may start.

Evaluator customization without touching the frozen file: the planner writes
`.claude/agents/evaluator.addendum.md`, and the shipped `evaluator.md` reads it if present.
Extra evaluator tools (Playwright MCP for web, other MCPs elsewhere) are added by the human
to `tools:` at approval time — documented in INIT.md and EXTENDING.md.

### Hooks

| File | Justification |
|---|---|
| `kill-switch.sh` | Unchanged: one `touch AGENT_STOP` has to be able to halt everything. |
| `steer.sh` | Unchanged: redirecting a running loop shouldn't require restarting it. |
| `track-read.sh` | Edited so the "what counts as evidence" patterns come from the domain's taxonomy file instead of being hardcoded to screenshots and `.png`. |
| `verify-gate.sh` | Edited to guard `evidence/level-*/CLAIM.md` — the builder's written claim about what its artifacts show — so a claim cannot be written before the artifact has been opened. |
| `frozen-guard.sh` | The frozen core is enforced by a hook rather than by asking nicely, so no initialization prompt can rewrite the loop's own rules. |
| `safety-gate.sh` | Spending, publishing, and irreversible actions are blocked and logged rather than trusted to prompt text, and the session continues on other work. |
| `danger-patterns.txt` | One auditable file lists every blocked pattern so operators can review and extend the gate without editing shell logic. |
| `progress-budget.sh` | A session that opens with a bloated handoff spends its context on history, so an over-budget `PROGRESS.md` makes condensing the session's first task. |
| `commit-on-stop.sh` | Unchanged: the backstop that catches whatever the agent forgot to commit. |

Details worth stating now:

- **`verify-gate.sh` gains a hard denial:** any Write/Edit targeting `SCOREBOARD.json` is
  refused unconditionally, with a reason pointing the agent at the evaluator. Combined with
  `scoreboard.sh` being wrapper-only, the frozen-core requirement "the wrapper, not the
  builder, writes the scoreboard" becomes structural.
- **`frozen-guard.sh` protected set:** `.claude/hooks/**`, `.claude/settings.json`,
  `.claude/CLAUDE.md`, `.claude/agents/evaluator.md`, `.claude/agents/planner.md`,
  `harness/**`. Allowed: `.claude/agents/evaluator.addendum.md`, everything else.
- **`safety-gate.sh` categories** (matcher `*`, so it sees Bash, Write, WebFetch and MCP
  tools alike): `MONEY` (payment/billing/purchase CLIs and MCP tool names),
  `PUBLISH` (`git push`, `gh pr create`, send/post/tweet/publish MCP tools, `curl -X POST`
  to non-localhost, mail senders), `IRREVERSIBLE` (`rm -rf`, force push, `DROP TABLE`,
  `terraform apply`, `kubectl delete`, cloud `delete` subcommands). On match it appends a
  timestamped row to `PAUSED_ACTIONS.md` (tool, command, category, level) and returns a
  block whose reason tells the agent to log it and move on — not to retry, not to work
  around it. Read-only network use (WebSearch, WebFetch GET) is deliberately *not* blocked;
  research domains need it.
- **Not built:** no hook that hashes or seals `.claude/` (a `chmod` and the SECURITY.md
  guidance do that job honestly, and an agent-writable integrity manifest is theatre); no
  per-row evidence binding in `verify-gate.sh` (it stays session-level, and that gap is
  listed in SECURITY.md rather than half-fixed).

### Memory

`MEMORY.md` defines the two kinds and three operations. Enforcement is deliberately split:

- **STATE** = `PROGRESS.md`. Single file, **edited not appended**, ~8k-token budget,
  overwritten as the task moves, deleted when the task ends. Budget enforced by
  `progress-budget.sh` at SessionStart.
- **LESSON** = `memory/*.md` + `memory/INDEX.md`. Durable across tasks, one topic per file,
  ~2k tokens per file, one-line summary per file in the index.
- **GROW** (level end): builder writes new lessons — facts learned, mistakes to avoid — as
  wiki entries and updates `INDEX.md`.
- **MAINTAIN** (before writing): merge duplicates, delete stale entries, keep each file
  under budget; `memcheck.sh` output is handed to the builder as the worklist. Curation over
  accumulation.
- **FETCH** (level start): read `INDEX.md` only, then pull the 2–5 full files relevant to
  this level. Never load `memory/` wholesale.

The wrapper's builder prompt template names FETCH as step 1 and GROW+MAINTAIN as the last
step, and the evaluator's checklist includes "did the builder leave the memory index
consistent with `memory/`" — so it is checked, not just requested.

### Docs

| File | Justification |
|---|---|
| `INIT.md` | The whole system has to be reachable from one initialization prompt, so the flow from that prompt to a running loop is written down in one place. |
| `MEMORY.md` | Two kinds of memory with different lifetimes get conflated unless the difference is stated explicitly. |
| `SECURITY.md` | A harness whose enforcement layer the agent can edit isn't enforcing anything, so the deployment requirement and the known gaps are documented rather than implied. |
| `EXTENDING.md` | The claim "domain-general" is only credible if three unrelated domains are worked end to end. |
| `README.md` | The entry point has to describe what this repo now is, not what it used to be. |

`SECURITY.md` will list, at minimum, the bypass gaps the brief names:
stale evidence (a read from earlier in the session unlocks a later unrelated claim), forged
evidence (the agent can write a file that matches the evidence pattern and then read it),
bash side-door writes (`sed`/`jq`/`>` bypass Write/Edit hooks entirely), ledger tampering
(`PAUSED_ACTIONS.md`, `PROGRESS.md`, `memory/` are all agent-writable), and settings edits
(an agent that can write `.claude/settings.json` can unhook itself — hence `frozen-guard.sh`
*and* the `chmod` requirement, since `frozen-guard.sh` shares the bash side-door gap).

`EXTENDING.md` works three initializations end to end — medical literature research, growing
a furniture business, building a website — each showing its initialization prompt, evidence
taxonomy, `track-read.sh` patterns, rubric excerpt, evaluator addendum, and which
`safety-gate.sh` categories will fire in normal operation.

## Frozen core vs. per-task layer

Stated in `.claude/CLAUDE.md` under a `## FROZEN CORE` heading, and enforced by
`frozen-guard.sh`.

| Frozen — no init prompt may change | Per-task — the init prompt configures |
|---|---|
| three-agent structure (planner / builder / evaluator) | the task, domain, constraints, budgets |
| evaluator has no Write/Edit and judges only disk artifacts | `evaluator.addendum.md` (domain instructions) |
| default-FAIL contract, one row per sub-level | extra evaluator tools (Playwright MCP, others) |
| wrapper — never the builder — writes the scoreboard | the evidence taxonomy + `track-read.sh` patterns |
| single `PROGRESS.md`, edited, size-budgeted | `RUBRIC.md` (reviewed for gameability) |
| memory split: STATE vs. LESSON, GROW/MAINTAIN/FETCH | `LEVELS.md` content and ordering |
| safety gates, kill switch, steer | — |

## Verification plan

Nothing flips to `true` in `HARNESS_ACCEPTANCE.json` without a named file, command output,
or log excerpt in the row's `evidence` field.

**Smoke test — non-web-dev, no money, no posting.** Task: *"Research and produce a sourced
two-page comparison of SQLite vs. DuckDB for single-machine local analytics."* Sources are
reachable from this machine (verified: `duckdb.org` and `sqlite.org` both return 200 through
the SelfControl filter). Fallback if the network degrades mid-run: the same deliverable
sourced from a local corpus, with file+line citations instead of URLs — the harness doesn't
care which, since the evidence taxonomy is what defines "sourced".

Its evidence taxonomy: cited sources (`sources/*.md`, one file per source with URL, access
timestamp, and verbatim extracted quotes) plus a claim→citation map. That exercises the
taxonomy machinery on something that is *not* screenshots, which is the point.

Execution constraints I'm binding myself to:

- **Every smoke-test session runs as a fresh `claude -p` process launched by
  `harness/loop.sh`, never inside this session.** Hook config is snapshotted at session
  start, so this session cannot demonstrate anything about the new hooks.
- **At least two complete builder→evaluator cycles, including one genuine `NEEDS_WORK` and
  the rework that follows it.** If the natural run produces no `NEEDS_WORK`, I will not
  manufacture one by editing a verdict; I'll extend the run with a level whose acceptance
  bar is higher and say plainly in `demo/README.md` that it was added to exercise rework.
- **A separate `demo/safety-probe/` run:** a fresh `claude -p` session told to attempt a
  `PUBLISH`-category action (`git push`), capturing the hook's block message and the
  resulting `PAUSED_ACTIONS.md` row. Same for a `frozen-guard.sh` write attempt. These are
  the only credible evidence that the new hooks fire.
- The smoke run happens in a scratch workspace with its own git repo; `demo/` receives the
  resulting `LEVELS.md`, `SCOREBOARD.json`, `PROGRESS.md`, `memory/`, `evidence/`, every
  evaluator verdict, the raw `logs/`, and `git-log.txt`.

**Budget note:** the smoke test is roughly 6–10 fresh `claude -p` sessions. I'll default
`BUILDER_MODEL=sonnet` and keep the evaluator on the stronger model, since judging is where
capability pays.

## Order of work (Phase 2)

1. Delete stale scaffolding; move `.claude/` to root.
2. Hooks + `settings.json` + `danger-patterns.txt`.
3. Agents (planner, evaluator, rubric-reviewer) + rewritten `CLAUDE.md`.
4. Wrapper scripts + templates.
5. Docs: `INIT.md`, `MEMORY.md`, `SECURITY.md`, `EXTENDING.md`, `README.md`.
6. Smoke test + safety probes in fresh processes; preserve `demo/`.
7. Flip `HARNESS_ACCEPTANCE.json` rows with evidence; report anything that stays `false`.

## Deviations from this plan, and why

Recorded during Phase 2. The plan was approved as written; these are the places the
implementation departed from it.

1. **`templates/` was not built.** The plan listed `RUBRIC.template.md` /
   `EVIDENCE.template.md` starting points. `planner.md` already specifies the required
   structure of each artifact in more detail than a template could, so templates would have
   been a second copy of the same spec, free to drift from the first. Dropped under the
   repo's own rule: a piece that can't be justified in one sentence doesn't get built.

2. **`harness/selftest.sh` was added** (not in the plan). Justification: *hooks that fail
   silently are worse than no hooks, so one script asserts each gate blocks what it must and
   allows what it must.* It earned its place immediately — the first `danger-patterns.txt`
   had literal tabs inside its regexes, which the TAB field-splitter turned into invalid
   patterns that `except re.error: continue` skipped without a word. `git push` and `rm -rf`
   passed straight through a gate that reported clean. Two fixes followed: `\s` instead of
   literal tabs, and **fail closed** — an unparseable rule now blocks every tool call until a
   human fixes it.

3. **The planner writes `SCOREBOARD.seed.json`, not `SCOREBOARD.json`.** The plan had
   `verify-gate.sh` deny every session write to the scoreboard, and had the planner create
   it — which cannot both be true. Rather than punching a planner-shaped hole in the gate,
   the planner writes a seed and `harness/scoreboard.sh seed` validates that every row is
   genuinely default-FAIL with a non-empty `check` before promoting it. The rule stays
   absolute (no session ever writes the scoreboard) and the contract gains a validation step.

4. **`frozen-guard.sh` also inspects `Bash`**, which the plan mentioned only as a documented
   gap. It now blocks redirects, `sed -i`, `cp`/`mv`/`rm` and interpreter invocations naming a
   protected path. This closes the obvious side door; the gap is still documented in
   SECURITY.md, because regexes over shell commands cannot be made complete.

## Assumptions — override any of these at approval

1. `.claude/` moves to the repo root and `claude-code-config/` is deleted (the repo becomes
   the workspace rather than a config to copy elsewhere).
2. The runtime scoreboard is `SCOREBOARD.json`; `test-results.json` disappears entirely.
3. The smoke-test topic is SQLite vs. DuckDB. Any other non-web-dev, no-money, no-posting
   research topic works equally well — say the word and I'll swap it.
4. The Apache-2.0 license, copyright headers, and attribution to the two Anthropic
   harness-design articles stay; the README credits its origin as this event demo.
5. `git push` stays blocked by `safety-gate.sh` and I never push (consistent with your
   standing rule).

## Finding during the smoke run: the plan itself was not protected

Recorded at the point of discovery, before it was fixed.

`frozen-guard.sh` as designed protects the *machinery* — hooks, settings, the builder
contract, the two loop agents, the wrapper. It does not protect the *plan*: `LEVELS.md`,
`RUBRIC.md`, and `EVIDENCE.md` are per-task files, written by the planner and approved by the
operator, and therefore left writable.

Seven minutes into the smoke run's first builder session, `commit-on-stop.sh` produced
checkpoint `baab191`, which modified `LEVELS.md`. The builder had edited the acceptance
criteria it was about to be judged against.

The edits were, in this case, honest corrections: it caught that the operator's scoping
decision (5–8 source entries, down from 8–12) contradicts level 2 criterion 3 and level 3
criterion 4, both of which require ≥6 distinct source keys — so a dossier of exactly 5 would
satisfy level 1 and make levels 2 and 3 unreachable. That is a real defect I introduced at
the approval gate, and the builder caught it. It also fixed stale "≥8" and "12 sources"
strings I had missed.

Helpful, and beside the point. **Nothing in the harness distinguished that edit from one
that lowers the bar.** A builder that finds a criterion inconvenient can rewrite it, and the
evaluator — which reads `LEVELS.md` fresh, with no memory of what it said at approval — would
grade against the rewritten version and never know. The whole default-FAIL construction rests
on the criteria being fixed at approval; `SCOREBOARD.json` being unwritable protects the
*verdict* while leaving the *standard* open.

**Fix: a plan lock.** `harness/planlock.sh` records a sha256 of the plan files at approval;
`frozen-guard.sh` denies writes to any locked path; `loop.sh` verifies the lock before and
after every cycle and halts on a mismatch. The operator relocks deliberately when the plan
genuinely needs to change. Justification: *the builder is judged against `LEVELS.md` and
`RUBRIC.md`, so it must not be able to edit them, and a change made deliberately by an
operator has to remain possible.*

The running smoke test was deliberately **not** interrupted to apply this — changing the
rules mid-experiment would have invalidated the evidence it was producing. The fix landed
after the loop finished and was verified by its own fresh-session probe.

## Second finding: a crashed evaluator was laundered into a review finding

Also caught live, in cycle 2 of the smoke run.

The evaluator session died on an API error after printing one line of narration, so
`logs/cycle-2-level-2-verdict.md` read, in full:

```
I'll start by reading the core framework files.
API Error: Server error mid-response. The response above may be incomplete.
```

`loop.sh` parsed line 1, found it was not `PASS`, and did what the plan said to do with a
non-`PASS` verdict: copied the whole thing to `NEXT_FINDINGS.md` and started a fresh builder
session whose work list was *"API Error: Server error mid-response."*

**An infrastructure failure had been converted into a quality judgement.** That is worse than
a crash. A crash is visible and stops you; this quietly spends a full builder session — thirty
minutes of Opus, in this run — on nothing, leaves the level `false`, and would do it again
next cycle. On a longer unattended run it is an infinite loop that looks like normal
operation, and every cycle of it lands in `git log` as if it were work.

The bug had two halves, and the second is the one that matters:

1. **Brittle parsing.** Reading only line 1 fails whenever a model narrates before its
   verdict — which the very same evaluator had not done in cycle 1, so the run looked fine
   until it wasn't. `read_verdict` now scans for a line that is exactly `PASS` or
   `NEEDS_WORK` anywhere in the output, tolerating markdown emphasis, and refuses prose that
   merely contains the words.
2. **No distinction between "failed the work" and "failed to run".** Absence of a verdict is
   now its own outcome: retry the evaluator once, and if there is still no verdict, **halt**
   with the level untouched, the scoreboard unchanged, and a message saying this is an
   evaluator failure rather than a finding. `NEXT_FINDINGS.md` is never written from output
   that contains no verdict.

Seven assertions in `harness/selftest.sh` cover it, including the exact two-line output that
caused it. The run was halted, the wrapper fixed, the garbage findings discarded, and the loop
resumed against the level-2 artifacts cycle 2 had already produced — which were good; only
the evaluation had failed.

**The general lesson, which is why this is written up rather than just fixed:** a harness that
turns every non-success into "the work needs improvement" will keep itself busy forever. Any
gate that produces a verdict needs a third outcome — *did not run* — and it has to stop the
loop rather than feed it.
