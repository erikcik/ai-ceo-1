# lh-harness

A long-horizon agent harness: give it a goal once and it works in rounds —
**Manager** plans one bounded step, an **Executor** does it with fresh context,
a read-only **Auditor** verifies the result in the real workspace, and only
verified progress becomes trusted state, until the task is honestly done. A
TypeScript port of [LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness)
(arXiv 2608.01964) running on the Claude Agent SDK. This document is the
deployment guide; the loop's design belongs to the paper and the module map to
[sdk/README.md](sdk/README.md).

## Prerequisites

| | Needed for |
|---|---|
| Node.js ≥ 22 and npm | running the harness |
| the `claude` CLI, logged in (`npm i -g @anthropic-ai/claude-code`) | executing agent episodes on the host |
| Docker Desktop (only for `--docker`) | the sandboxed deployment |
| an Anthropic OAuth token or API key (only for `--docker`) | agent auth inside the container |

## Install once

```bash
git clone <this repo> && cd <repo>/sdk
npm install
npm run build:web        # builds the React workbench bundle
npm link                 # puts `lh-harness` on PATH
lh-harness doctor        # environment report; fix anything marked FAIL
```

## Daily use

Make a folder per project. Everything the agents read, build, and record lives
in that folder — the harness never writes outside it.

```bash
mkdir ~/Desktop/my-project && cd ~/Desktop/my-project
lh-harness start
```

`start` creates `./.lh-harness/config.toml` on first use, serves the workbench
at `http://127.0.0.1:8799/`, and opens it. In the browser: **Start task** →
describe the goal → **Attach files** (they are stored under `./inbox/` and
referenced in the task) → pick a model per role → run. Mid-run you can answer
approvals, inject instructions, stop, and continue; after a run finishes, a
follow-up message continues the same run.

Everything is plain files in your folder: deliverables at the top level,
attachments in `inbox/`, and the complete record of every run in
`.lh-harness/runs/<run-id>/` (`report.json`, `events.jsonl`, per-round plans,
outputs and audits). The UI is only a window onto those files.

### Sandboxed: `lh-harness start --docker`

Same workflow, but the entire stack — workbench, supervisor, workers, and a
headless Chromium the agents can browse with — runs inside a per-folder Docker
container. The container sees **only** your project folder (mounted at
`/work`); the host's Claude configuration, credentials and the rest of the
filesystem do not exist inside it. That is the security model: the container
is the agent sandbox, your folder is the only shared surface.

```bash
cd ~/Desktop/my-project
lh-harness start --docker
```

First-time setup, printed by the command itself when missing: put one agent
credential into `~/.lh-harness/docker.env`
(`CLAUDE_CODE_OAUTH_TOKEN=` from `claude setup-token`, or
`ANTHROPIC_API_KEY=`). Third-party provider keys (see `sdk/providers.json`)
go in the same file.

What `start --docker` guarantees:

- **State is yours and survives anything.** All runs, uploads and deliverables
  are on your Mac in the project folder. Stop the container, restart Docker,
  reboot — rerun `lh-harness start --docker` in the folder and the workbench
  shows the same history; interrupted runs offer *Continue*. The container
  itself holds nothing worth keeping.
- **It comes back on its own.** The container restarts `unless-stopped`, so a
  Docker engine restart re-serves the workbench without your involvement.
- **Access is tokened.** A per-folder bearer token is generated into
  `.lh-harness/web-token` and printed; paste it into the key dialog
  (bottom-left) once per browser. The port binds to `127.0.0.1` only.
- **It always runs the current harness.** The harness source is mounted
  read-only into the container, so edits to this repo apply on the next
  restart — no image rebuild (rebuilds happen automatically on `start` and
  matter only when dependencies change).

One container per folder (`docker ps` shows it as `lh-harness-<folder>-<id>`);
run several projects side by side with `--port`.

### Reloading after harness changes

The workbench's **reload button** (circular arrow, bottom-left) restarts the
service on the current source of this repo: on the host the `start` wrapper
respawns the server; in Docker the container restarts. Runs are separate
worker processes — a reload does not touch them, and new workers always launch
from current source anyway.

### CLI instead of the UI

```bash
lh-harness run --task @task.md --max-rounds 20 \
  --manager-model claude-opus-5 --executor-model claude-sonnet-5
lh-harness web / dashboard / doctor / init / plugin / check-update   # see --help
```

`docker/` also carries a plain docker-compose deployment of the same image
([docker/README.md](docker/README.md)) if you prefer compose over
`start --docker`.

### Worth setting per project

In `.lh-harness/config.toml`: `[run.timeouts] auditor = 900` for tasks whose
verification builds code, and `guard_exclude_paths = ["node_modules", ".next"]`
so build churn is not mistaken for auditor tampering. Every field has a
matching CLI flag; CLI > config > defaults.

### GUI / browser tasks

Inside `--docker`, web-GUI subtasks work out of the box (Playwright MCP +
headless Chromium are baked into the image; executors and auditors can
navigate, click, type and screenshot). On the host, install a computer-use
plugin instead: `lh-harness plugin install playwright-mcp` (web) or
`open-computer-use` / `clawdcursor` (native desktop).

## License / provenance

The harness design, prompts and protocols are the work of the
LongHorizon-Harness authors (MIT, arXiv 2608.01964); this repository is a
TypeScript port on the Claude Agent SDK with additions noted in
[sdk/README.md](sdk/README.md).
