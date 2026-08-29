# Containerised lh-harness-eray

Runs the plan-tree loop (planner → rubric → composer ↔ evaluator) and its Web workbench inside a
container that is **isolated from the host's global Claude configuration** and
**has its own network namespace**.

## Why a container

1. **Host-global Claude instructions don't leak in.** The image has no
   `~/.claude`, `CLAUDE_CONFIG_DIR` points at an empty directory, and every role
   episode is spawned with `settingSources: []` and
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
2. **Host network filters can't reach inside.** Filters that work through the
   host's `/etc/hosts` or packet filter live in the host network namespace; the
   container has its own resolver and stack. `doctor` proves tooling and agent
   reachability from inside.

Everything a run produces (`.lh-harness/runs/<run-id>/` with `report.json`,
`events.jsonl`, `rounds/`, trajectories) lands on the bind-mounted `./workspace`.

## Setup

```bash
cp docker/.env.example docker/.env      # one auth method + LH_HARNESS_WEB_TOKEN
mkdir -p workspace                       # the project the agents will act on
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml run --rm harness doctor
```

## Web workbench (recommended)

```bash
docker compose -f docker/docker-compose.yml up web
# → http://127.0.0.1:8799/  (paste LH_HARNESS_WEB_TOKEN into the auth dialog)
```

Start a task, choose the model per role (Claude, or a `<provider>:<model>`
from `sdk/providers.json`), answer approvals, inject instructions, stop/continue,
and keep asking follow-ups after a run finishes.

## Headless run

```bash
echo "Inspect the current directory and summarize its files." > workspace/task.md
docker compose -f docker/docker-compose.yml run --rm harness run --task @/work/task.md --max-rounds 10
```

The run acts on `/work` (= `./workspace`); its record is in
`workspace/.lh-harness/runs/<run-id>/lh_harness/report.json`.

## Notes

- Non-root `node` user (the CLI blocks `bypassPermissions` as root).
- `docker/.env` is gitignored and read only at run time.
- **Web GUI works in the container.** The image bakes in the Playwright MCP
  server (`@playwright/mcp`) with headless Chromium (`--headless --isolated
  --no-sandbox`) and points `LH_HARNESS_CLAUDECODE_MCP_CONFIG` at its config,
  so GUI-capable roles (executors and both auditors — never the Manager) can
  navigate, click, type, snapshot and screenshot real web pages. Native
  desktop apps are still out of scope in a container; for those run the
  harness on a desktop host and `lh-harness-eray plugin install open-computer-use`
  (or `clawdcursor`). On any host, `lh-harness-eray plugin install playwright-mcp`
  sets up the same browser server.
