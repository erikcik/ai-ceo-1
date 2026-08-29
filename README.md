# lh-harness-eray

Give it one task; it plans, builds and verifies until the work passes an independent
evaluation — and it shows you, in a graph, exactly what it is doing and why.

The loop (every box is one fresh agent session on the Claude Agent SDK):

```
task ─► prompt tailor ─► planner ─► plan tree
                                       │  for each leaf subtask, in dependency order
                                       ▼
                     rubric agent ─► contract (every criterion starts FAIL)
                                       │
                     context selector (python) ─► what the composer sees this round
                                       │
                     composer ─► work + evidence ledger + progress note
                                       │
                     evaluator ─► PASS / NEEDS_WORK per criterion (may reshape the plan)
                                       │  repeat composer ↔ evaluator up to max_eval_rounds
                                       ▼
                                 final response
```

- **Prompt tailor** writes a task-specific briefing for every role (domain, tools, traps).
- **Planner** researches with web-research subagents (reputable authors only), reads your
  `sources/` and the memory wiki, and writes a **tree** where every node is backed by
  reasoning, a web source, one of your sources, or a memory page. Leaves are the smallest
  independently verifiable units of work.
- **Rubric agent** turns one leaf into a rubric + a default-FAIL contract, after studying
  rubric examples (yours in `sources/`, plus web research on how experts grade that kind
  of deliverable).
- **Composer** does the work. Hooks (not prompts) record every file it touches with hashes,
  deny edits to the contract, and refuse to let the session end until a progress note
  covers every criterion.
- **Evaluator** verifies with the same tools a human reviewer would use (files, shell,
  browser, computer use), never trusts the composer's note, grades each criterion, and can
  add/remove/modify plan nodes. The harness applies the contract's pass rule to its verdict.
- **Memory** is a Karpathy-style wiki in `memory/` (index, pages with frontmatter, log).
  Every role may write pages when it learns something durable; the harness keeps the index.
- **Operator gates**: the planner's open questions, blocked subtasks, budget exhaustion,
  repeated failures and completion all pause for you in the workbench; your answers land in a
  standing decisions ledger every role reads.

The design follows Anthropic's [long-running-agent harness primitives](https://github.com/anthropics/cwc-long-running-agents)
(default-FAIL contract, fresh-context evaluator, agent-maintained handoff, sprint contracts,
grading rubrics, browser-verified evaluation) plus the ideas above. The prompts are plain
markdown in [`sdk/src/loop/prompts/`](sdk/src/loop/prompts/); the loop is one readable file,
[`sdk/src/loop/runner.ts`](sdk/src/loop/runner.ts).

## Prerequisites

| | Needed for |
|---|---|
| Node.js ≥ 22 and npm | running the harness |
| the `claude` CLI, logged in (`npm i -g @anthropic-ai/claude-code`) | agent sessions on the host |
| `python3` | the context selector |
| Docker Desktop (only for `--docker`) | the sandboxed deployment |
| an Anthropic OAuth token or API key (only for `--docker`) | agent auth inside the container |

## Install once

```bash
git clone <this repo> && cd <repo>/sdk
npm install
npm run build:web        # builds the React workbench
npm link                 # puts `lh-harness-eray` on PATH
lh-harness-eray doctor
```

## Daily use

One folder per project. Everything the agents read, build and record lives there.

```bash
mkdir ~/Desktop/my-project && cd ~/Desktop/my-project
lh-harness-eray start            # host
lh-harness-eray start --docker   # sandboxed (recommended)
```

`start` writes `./.lh-harness/config.toml` on first use and serves the workbench at
`http://127.0.0.1:8799/`. In the browser: **New task** → describe the goal → attach files
(stored in `./inbox/`) → pick a model for the planner, composer and evaluator → toggle the
external tools the run may use → run.

Put reference material you want the agents to respect in `./sources/` (rubric examples,
specs, briefs, style guides — the rubric agent and evaluator look there first). Seed
`./memory/` with pages from earlier runs if you have them.

### What you see

- **Plan graph** — the tree the planner wrote, coloured by status; the active subtask pulses.
  Click any node: why it exists and what backs it, its contract (criteria, pass/fail,
  scores), the rubric, **what the composer was shown** each round, its progress note, the
  evidence files and hook-written ledger, every evaluator verdict, and every agent session
  (with trajectory and screenshots).
- **Phase strip** — intake → tailoring → planning → executing → finalizing → finished.
- **Attention** — the operator gates (answer the planner's questions, re-open a blocked
  subtask with instructions, grant more composer episodes, add a follow-up after completion).
- **Details** — events, trajectories, the tailored briefings, research notes, plan revisions.

### What is on disk

```
<project>/
  inbox/            attachments          sources/   your reference material
  memory/           the wiki (index.md, pages, log.md)
  <deliverables>    wherever the plan puts them
  .lh-harness/runs/<run-id>/
    state/          plan/plan.json + PLAN.md + revisions/, prompts/, research/, rubrics/,
                    contracts/, context/, progress/, evidence/<subtask>/ledger.jsonl,
                    evaluations/<subtask>/rN.md, task/TASK.md + DECISIONS.md, episodes.jsonl
    lh_harness/     report.json, <role>_episodes/epNNN/ (prompt, output, trajectory, screenshots),
                    role_orchestration/events.jsonl + approvals.jsonl
```

The UI is only a window onto these files.

### CLI instead of the UI

```bash
lh-harness-eray run --task @task.md --max-rounds 20 --max-eval-rounds 3 \
  --planner-model claude-opus-5 --composer-model claude-opus-5 --evaluator-model claude-opus-5
lh-harness-eray web / dashboard / doctor / init / plugin / check-update   # see --help
```

`--max-rounds` caps composer episodes for the whole run; `--max-eval-rounds` caps
composer↔evaluator rounds per subtask; `--min-research-agents` (default 10) is the research
fan-out the planner, rubric agent and evaluator must spawn; `--research-model` (default
`sonnet`) keeps that fan-out cheap; `--episode-budget-usd` puts a dollar ceiling on every
session. All have `config.toml` equivalents.

### Sandboxed: `start --docker`

The whole stack — workbench, supervisor, agent sessions, headless Chromium, ffmpeg — runs in
a per-folder container that sees only your project folder (mounted at `/work`). Credentials
go in `~/.lh-harness/docker.env` (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or
`ANTHROPIC_API_KEY`); external-tool credentials in `~/.lh-harness/secrets.env`. The harness
source is bind-mounted, so edits apply on the workbench's reload button; the image is rebuilt
only when dependencies change. See [docker/README.md](docker/README.md).

### External tools

Per task you toggle what the run may use: the browser (always on), GitHub, Vercel,
Higgsfield, email. Each role's prompt says which are provisioned; unselected credentials
never reach a worker. Third-party models (`sdk/providers.json`, e.g. an OpenAI-wire Qwen
endpoint) are picked per role as `<provider>:<model>`; subagent web research is unavailable
behind a third-party base URL.

## Repo map

- `sdk/src/loop/` — the loop: `runner.ts` (schedule), `plan.ts` (tree), `state.ts` (files +
  workbench projection), `hooks.ts` (enforcement), `context.ts` + `context_selector.py`,
  `memory.ts`, `subagents.ts`, `prompts/*.md`.
- `sdk/src/adapters/` — the Agent SDK backend (`query()`), role policies, snapshot guard.
- `sdk/src/supervisor/`, `sdk/src/webapi/`, `sdk/src/dashboard/` — run supervision, HTTP/WS
  API, approvals; `sdk/frontend/` — the workbench.
- `docker/` — the sandbox image.
