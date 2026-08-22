# syntax=docker/dockerfile:1
#
# Containerised LongHorizon-Harness (TypeScript port on the Claude Agent SDK).
#
# Two host problems this image sidesteps by construction:
#   1. Host-global Claude instructions (~/.claude/CLAUDE.md, settings, hooks)
#      leak into every session on the host. The image never contains them,
#      CLAUDE_CONFIG_DIR points at a fresh empty dir, and every role episode is
#      spawned with settingSources:[] plus CLAUDE_CODE_DISABLE_AUTO_MEMORY=1.
#   2. Host network filters (e.g. SelfControl's /etc/hosts + pf rules) live in
#      the host network namespace; the container has its own.
#
# Auth is NOT baked in: pass CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY at run
# time (docker/.env). Third-party providers pass their own key env var
# (see sdk/providers.json, e.g. ORCA_API_KEY).

# ---- stage 1: build the React workbench -------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY sdk/frontend/core/package.json ./frontend/core/
COPY sdk/frontend/web/package.json sdk/frontend/web/package-lock.json* ./frontend/web/
RUN cd frontend/web && npm install
COPY sdk/frontend/ ./frontend/
RUN cd frontend/web && npm run build

# ---- stage 2: the harness ---------------------------------------------------
FROM node:22-bookworm-slim

# git: agents commit/inspect repos; python3/curl/jq/ca-certificates: common
# executor tooling; no GUI/computer-use stack ships in the image (CLI subtasks
# only) -- install a computer-use plugin on a desktop host instead.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 curl jq procps \
 && rm -rf /var/lib/apt/lists/*

# The Agent SDK spawns the `claude` CLI; it is not vendored in the SDK package.
RUN npm install -g @anthropic-ai/claude-code@2.1.237

# Web GUI for executors/auditors: the Playwright MCP server driving Debian's
# own Chromium. The distro package (apt) is used instead of Playwright's CDN
# download, which some host networks (e.g. DNS filters this image may build
# behind) cannot reach; `--executable-path` points the server at it.
RUN npm install -g @playwright/mcp@0.0.79 \
 && apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# MCP config the harness hands to GUI-capable roles (executors + auditors).
# LH_HARNESS_CLAUDECODE_MCP_CONFIG is the adapter's documented env override, so
# no per-project plugin install is needed inside the container.
RUN mkdir -p /app/mcp && printf '%s' '{"mcpServers":{"playwright":{"command":"playwright-mcp","args":["--headless","--isolated","--no-sandbox","--executable-path","/usr/bin/chromium","--output-dir","/tmp/playwright-mcp-output"]}}}' > /app/mcp/playwright.mcp.json
ENV LH_HARNESS_CLAUDECODE_MCP_CONFIG=/app/mcp/playwright.mcp.json

WORKDIR /app
COPY sdk/package.json sdk/package-lock.json ./sdk/
RUN cd sdk && npm ci --omit=dev --ignore-scripts && npm install --no-save tsx typescript
COPY sdk/ ./sdk/
COPY --from=web /build/frontend/web/dist ./sdk/frontend/web/dist
COPY README.md LICENSE ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh sdk/bin/lh-harness.mjs \
 && ln -s /app/sdk/bin/lh-harness.mjs /usr/local/bin/lh-harness

# A fresh, EMPTY Claude config dir: no host ~/.claude, no CLAUDE.md, no hooks.
ENV CLAUDE_CONFIG_DIR=/app/.claude-container
ENV HOME=/home/node
# Plugin + user-scoped state root (the Python default is ~/.lh-harness).
ENV LH_HARNESS_STATE_ROOT=/home/node/.lh-harness
RUN mkdir -p /app/.claude-container /work /home/node/.lh-harness \
 && chown -R node:node /app /work /home/node

# The claude CLI refuses bypassPermissions as root; run as the `node` user.
USER node

# /work is the project workspace the agents act on; its .lh-harness/runs holds
# every run record. Bind-mount a host directory here.
WORKDIR /work
VOLUME ["/work"]
EXPOSE 8799

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["help"]
