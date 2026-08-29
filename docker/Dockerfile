# syntax=docker/dockerfile:1
#
# Containerised lh-harness-eray (plan-tree loop on the Claude Agent SDK).
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

# git: agents commit/inspect repos; curl/jq/ca-certificates: common composer
# tooling. Native desktop computer-use is out of scope in a container; the
# browser (Playwright MCP + Chromium, below) is the GUI surface here.
# ffmpeg/ffprobe + ImageMagick + fonts: media deliverables (ad videos, thumbnails)
# are rendered and verified inside the sandbox; python3 also runs the loop's
# context selector (sdk/src/loop/context_selector.py).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git gh ca-certificates python3 curl jq procps unzip \
      ffmpeg imagemagick fonts-dejavu fonts-liberation fonts-noto-core \
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

# MCP config the harness hands to browser-capable roles (planner, composer, evaluator).
# LH_HARNESS_CLAUDECODE_MCP_CONFIG is the adapter's documented env override, so
# no per-project plugin install is needed inside the container.
RUN mkdir -p /app/mcp && printf '%s' '{"mcpServers":{"playwright":{"command":"playwright-mcp","args":["--headless","--isolated","--no-sandbox","--executable-path","/usr/bin/chromium","--output-dir","/tmp/playwright-mcp-output"]}}}' > /app/mcp/playwright.mcp.json
ENV LH_HARNESS_CLAUDECODE_MCP_CONFIG=/app/mcp/playwright.mcp.json
# The container is brought back by its restart policy after an exit, so the
# workbench's Reload button (exit 87 on current source) is safe to enable.
ENV LH_HARNESS_ENABLE_RELOAD=1

WORKDIR /app
COPY sdk/package.json sdk/package-lock.json ./sdk/
RUN cd sdk && npm ci --omit=dev --ignore-scripts && npm install --no-save tsx typescript
COPY sdk/ ./sdk/
COPY --from=web /build/frontend/web/dist ./sdk/frontend/web/dist
COPY README.md LICENSE ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh sdk/bin/lh-harness-eray.mjs \
 && ln -s /app/sdk/bin/lh-harness-eray.mjs /usr/local/bin/lh-harness-eray

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
