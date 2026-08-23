// Ported 1:1 from LongHorizon-Harness src/lh_harness/plugins/state.py
//
// User-scoped record of which computer-use plugins are installed.
//
// Plugins are installed once per machine, never per project, so the state and
// the generated MCP configs live under `~/.lh-harness/plugins/`. Each install
// writes one config per agent in that agent's own format -- `.mcp.json` for
// Claude Code -- so nothing is translated at run time. `lh-harness run` picks
// the highest-priority installed plugin for the agent it is about to start and
// passes that agent's own file along.
//
// Single-backend port: the bundled Codex GUI plugin is not ported, so
// PLUGIN_PRIORITY starts at the community plugins and `activePluginForAgent`
// never has to re-query Codex's own plugin registry.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_STATE_ROOT } from "../types.js";
import { expanduser } from "../utils/agent_cli.js";
import { PluginError } from "./errors.js";

// Preference order when several plugins are installed.
export const PLUGIN_PRIORITY: readonly string[] = ["open-computer-use", "clawdcursor", "playwright-mcp"];

const _STATE_FILE = "installed.json";

export type InstalledPlugin = {
  plugin_id: string;
  agents: readonly string[];
  /** agent -> generated MCP config path; empty for agents wired natively. */
  mcp_configs: Record<string, string>;
  mcp_server_name: string;
};

export function pluginsRoot(): string {
  const root = process.env.LH_HARNESS_STATE_ROOT || DEFAULT_STATE_ROOT;
  return path.join(expanduser(root), "plugins");
}

export function pluginDir(pluginId: string): string {
  return path.join(pluginsRoot(), pluginId);
}

export function statePath(): string {
  return path.join(pluginsRoot(), _STATE_FILE);
}

export function mcpConfigPath(pluginId: string, agent: string): string {
  // Each agent gets its own native format; nothing is translated at run time.
  const suffix = agent === "codex" ? "toml" : "mcp.json";
  return path.join(pluginDir(pluginId), agent, `${pluginId}.${suffix}`);
}

/** Write one MCP config in the requested agent's own configuration format. */
export function writeMcpConfig(
  pluginId: string,
  agent: string,
  options: { serverName: string; command: string; args: string[] },
): string {
  const target = mcpConfigPath(pluginId, agent);
  if (agent === "codex") {
    // codex_config.py is not ported with the Codex backend; no registry plugin
    // declares `codex` any more, so reaching this branch is a caller bug.
    throw new PluginError("The Codex backend is not part of this port; no TOML MCP config is written.");
  }
  const entry: Record<string, unknown> = { command: options.command };
  if (options.args.length) entry.args = [...options.args];
  const payload = { mcpServers: { [options.serverName]: entry } };
  _atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`);
  return target;
}

/** Merge one plugin into the installed-plugin record. */
export function recordInstall(
  pluginId: string,
  options: { agents: string[]; mcpConfigs: Record<string, string>; mcpServerName: string },
): void {
  const state = _load();
  const raw = state[pluginId];
  const entry = isObject(raw) ? raw : {};
  const knownAgents = new Set<string>(
    Array.isArray(entry.agents) ? (entry.agents as unknown[]).map((item) => String(item)) : [],
  );
  const knownConfigs: Record<string, string> = isObject(entry.mcp_configs)
    ? Object.fromEntries(Object.entries(entry.mcp_configs).map(([k, v]) => [k, String(v)]))
    : {};
  for (const agent of options.agents) knownAgents.add(agent);
  Object.assign(knownConfigs, options.mcpConfigs);
  state[pluginId] = {
    agents: [...knownAgents].sort(),
    mcp_configs: knownConfigs,
    mcp_server_name: options.mcpServerName,
  };
  _save(state);
}

export function forgetInstall(pluginId: string): void {
  const state = _load();
  if (pluginId in state) {
    delete state[pluginId];
    _save(state);
  }
}

export function installedPlugins(): Record<string, InstalledPlugin> {
  const result: Record<string, InstalledPlugin> = {};
  for (const [rawId, entry] of Object.entries(_load())) {
    if (!isObject(entry)) continue;
    const configs = entry.mcp_configs;
    result[String(rawId)] = {
      plugin_id: String(rawId),
      agents: (Array.isArray(entry.agents) ? entry.agents : [])
        .map((a) => String(a))
        .filter((a) => a !== ""),
      mcp_configs: Object.fromEntries(
        Object.entries(isObject(configs) ? configs : {}).map(([k, v]) => [String(k), String(v)]),
      ),
      mcp_server_name: String(entry.mcp_server_name || ""),
    };
  }
  return result;
}

/**
 * Return `[plugin_id, mcp_config_path]` for the agent, honouring priority.
 *
 * A plugin whose generated MCP config no longer exists on disk is skipped, so
 * the record can never point a run at a file that was deleted by hand.
 */
export function activePluginForAgent(agent: string): [string, string] | null {
  const state = _load();
  for (const pluginId of PLUGIN_PRIORITY) {
    const entry = state[pluginId];
    if (!isObject(entry)) continue;
    const agents = Array.isArray(entry.agents) ? entry.agents.map((a) => String(a)) : [];
    if (!agents.includes(agent)) continue;
    const configs = entry.mcp_configs;
    const raw = isObject(configs) ? configs[agent] : undefined;
    if (raw === undefined || raw === null) return [pluginId, ""];
    const target = expanduser(String(raw));
    try {
      if (!fs.statSync(target).isFile()) continue;
    } catch {
      continue;
    }
    return [pluginId, target];
  }
  return null;
}

function _load(): Record<string, unknown> {
  const target = statePath();
  try {
    if (!fs.statSync(target).isFile()) return {};
  } catch {
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(target, "utf-8"));
  } catch (exc) {
    throw new PluginError(
      `Could not read the plugin state at ${target}: ${exc instanceof Error ? exc.message : String(exc)}. ` +
        "Delete the file to reset it, then reinstall the plugins you need.",
    );
  }
  return isObject(data) ? data : {};
}

function _save(state: Record<string, unknown>): void {
  _atomicWrite(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function _atomicWrite(target: string, text: string): void {
  try {
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = path.join(parent, `.${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, target);
  } catch (exc) {
    throw new PluginError(`Could not write ${target}: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
