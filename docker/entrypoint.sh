#!/usr/bin/env bash
#
# Container entrypoint. Validates auth, sets a git identity, then dispatches to
# the `lh-harness-eray` CLI. Auth is read from the environment and never written to
# disk or logged.
set -euo pipefail

if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "[entrypoint] auth: CLAUDE_CODE_OAUTH_TOKEN present (subscription OAuth)"
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "[entrypoint] auth: ANTHROPIC_API_KEY present (API billing)"
elif [[ "${1:-help}" == "help" || "${1:-}" == "doctor" || "${1:-}" == "shell" || "${1:-}" == "bash" || "${1:-}" == "test" ]]; then
  echo "[entrypoint] auth: none (ok for '$1')"
else
  echo "[entrypoint] FATAL: no auth in environment." >&2
  echo "             Set CLAUDE_CODE_OAUTH_TOKEN (from 'claude setup-token')" >&2
  echo "             or ANTHROPIC_API_KEY, e.g. via docker/.env or -e." >&2
  exit 78
fi

git config --global user.email "${GIT_AUTHOR_EMAIL:-harness@ai-ceo.local}" >/dev/null 2>&1 || true
git config --global user.name  "${GIT_AUTHOR_NAME:-lh-harness}"             >/dev/null 2>&1 || true
git config --global init.defaultBranch main                                  >/dev/null 2>&1 || true
git config --global --add safe.directory '*'                                 >/dev/null 2>&1 || true

cmd="${1:-help}"; shift || true
WEB_PORT="${LH_HARNESS_WEB_PORT:-8799}"

case "$cmd" in
  web|dashboard)
    # The workbench is the control plane. Binding beyond loopback requires a
    # bearer token (LH_HARNESS_WEB_TOKEN) -- the CLI refuses otherwise.
    exec lh-harness-eray web --host 0.0.0.0 --port "$WEB_PORT" --no-open \
      --workspace-root /work --runs-root /work/.lh-harness/runs "$@"
    ;;
  run)
    # lh-harness-eray run --task "@task.md" [--max-rounds N] [--model ...] ...
    exec lh-harness-eray run --no-dashboard "$@"
    ;;
  doctor|init|plugin|check-update)
    exec lh-harness-eray "$cmd" "$@"
    ;;
  test)
    cd /app/sdk && exec npm test
    ;;
  shell|bash)
    exec bash
    ;;
  help|*)
    cat <<'USAGE'
lh-harness-eray (containerised). Usage: docker compose -f docker/docker-compose.yml run --rm harness <command>

  web [opts]            serve the Web workbench on :8799 (needs LH_HARNESS_WEB_TOKEN)
  run --task @task.md   run one task headless in /work (the mounted workspace)
  doctor                environment + agent-CLI + plugin report (no API calls)
  init [--force]        write /work/.lh-harness/config.toml
  plugin list|install|uninstall <name>
  check-update
  test                  run the harness test-suite
  shell                 bash inside the sandbox

Runs live under /work/.lh-harness/runs/<run-id>/ on the bind mount.
The loop: prompt tailor -> planner (plan tree) -> per subtask: rubric -> composer <-> evaluator -> reply.
Browser: the image ships the Playwright MCP server with headless Chromium; the planner,
composer and evaluator can browse, click, type and screenshot web pages. ffmpeg/ffprobe,
ImageMagick and python3 are available for media deliverables.
USAGE
    ;;
esac
