// Ported 1:1 from LongHorizon-Harness src/lh_harness/plugins/community_computer_use.py
//
// Community computer-use MCP servers that the harness can set up for an agent.
//
// Each entry is npm-distributed. The harness installs the global package and
// grants its OS permissions, but writes the MCP wiring itself into
// `~/.lh-harness/plugins/` -- never into Claude's user config. The vendors' own
// `install-*-mcp` helpers are deliberately not used because they register the
// server globally, which would hand GUI control to every unrelated Claude
// session. Nothing here runs during `lh-harness run`; setup is always an
// explicit `lh-harness plugin` opt-in.
//
// Single-backend port: `claude_code` is the only supported agent, so the Codex
// entries in `agents` and the Codex leftover probe are dropped.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { which } from "../utils/agent_cli.js";
import { PluginError } from "./errors.js";
import {
  type NpmPackageState,
  globalPackageState,
  installGlobalPackage,
  requireNpm,
  uninstallGlobalPackage,
} from "./npm.js";
import { forgetInstall, pluginDir, recordInstall, writeMcpConfig } from "./state.js";

export type StatusCallback = (status: string, message: string) => void;

export const AGENT_CLAUDE_CODE = "claude_code";

export type CommunityPlugin = {
  plugin_id: string;
  package: string;
  summary: string;
  homepage: string;
  /**
   * Agents this server can drive. The harness writes each one's MCP config
   * itself, so no vendor registration command is involved.
   */
  agents: readonly string[];
  /** Commands the user must run themselves (consent, OS permission grants). */
  manual_steps: readonly string[];
  cli_name: string;
  mcp_server_name: string;
  /** Args the MCP host uses to spawn the stdio server. */
  mcp_args: readonly string[];
  /** `process.platform` values the plugin runs on. */
  platforms: readonly string[];
  /** Per-platform activation argv run during install; `{binary}` is resolved. */
  activation: Readonly<Record<string, readonly (readonly string[])[]>>;
  /**
   * Per-platform readiness check run after activation to confirm the grants
   * took. Platforms that need no grants are intentionally left out.
   */
  status_check: Readonly<Record<string, readonly string[]>>;
  /** Per-platform prerequisites the harness cannot install itself. */
  prerequisites: Readonly<Record<string, readonly string[]>>;
  extra_notes: readonly string[];
};

function communityPlugin(partial: Partial<CommunityPlugin> & Pick<CommunityPlugin, "plugin_id" | "package" | "summary" | "homepage" | "agents">): CommunityPlugin {
  return {
    manual_steps: [],
    cli_name: "",
    mcp_server_name: "",
    mcp_args: [],
    platforms: ["darwin", "linux", "win32"],
    activation: {},
    status_check: {},
    prerequisites: {},
    extra_notes: [],
    ...partial,
  };
}

export function commandName(plugin: CommunityPlugin): string {
  return plugin.cli_name || plugin.package;
}

export function supportsAgent(plugin: CommunityPlugin, agent: string): boolean {
  return plugin.agents.includes(agent);
}

export function supportsPlatform(plugin: CommunityPlugin, platformName: string): boolean {
  return plugin.platforms.includes(platformName);
}

export const OPEN_COMPUTER_USE: CommunityPlugin = communityPlugin({
  plugin_id: "open-computer-use",
  package: "open-computer-use",
  cli_name: "open-computer-use",
  mcp_server_name: "open-computer-use",
  summary: "Open-source Codex Computer Use alternative (macOS Swift, Windows UIA, Linux AT-SPI).",
  homepage: "https://github.com/iFurySt/open-codex-computer-use",
  agents: [AGENT_CLAUDE_CODE],
  mcp_args: ["mcp"],
  // Only the macOS runtime needs grants; the Windows/Linux `doctor` just prints
  // a session note and always exits 0, so checking it proves nothing.
  activation: { darwin: [["{binary}", "doctor"]] },
  status_check: { darwin: ["{binary}", "doctor"] },
  prerequisites: {
    darwin: ["macOS 14.0 or later."],
    linux: ["Run inside the signed-in desktop session (AT-SPI2 needs it)."],
    win32: ["Run inside the signed-in desktop session (UI Automation needs it)."],
  },
});

export const CLAWDCURSOR: CommunityPlugin = communityPlugin({
  plugin_id: "clawdcursor",
  package: "clawdcursor",
  cli_name: "clawdcursor",
  mcp_server_name: "clawdcursor",
  summary: "Local MCP server that compiles the screen into a verified UI map and acts on element ids.",
  homepage: "https://github.com/AmrDab/clawdcursor",
  agents: [AGENT_CLAUDE_CODE],
  mcp_args: ["mcp", "--compact"],
  activation: {
    // Consent is required on every OS; `grant` walks the macOS TCC dialogs.
    darwin: [
      ["{binary}", "consent", "--accept"],
      ["{binary}", "grant"],
    ],
    linux: [["{binary}", "consent", "--accept"]],
    win32: [["{binary}", "consent", "--accept"]],
  },
  status_check: {
    darwin: ["{binary}", "status"],
    linux: ["{binary}", "status"],
    win32: ["{binary}", "status"],
  },
  prerequisites: {
    darwin: ["Xcode Command Line Tools (`xcode-select --install`) for screenshots/vision."],
    linux: [
      "apt install tesseract-ocr python3-gi gir1.2-atspi-2.0",
      "On Wayland also install ydotool (with ydotoold) or wtype.",
    ],
  },
  extra_notes: ["Requires Node.js 20 or later."],
});


export const PLAYWRIGHT_MCP: CommunityPlugin = communityPlugin({
  plugin_id: "playwright-mcp",
  package: "@playwright/mcp",
  cli_name: "playwright-mcp",
  mcp_server_name: "playwright",
  summary: "Web GUI over MCP: drives headless Chromium (navigate, click, type, snapshot, screenshot). Works in containers and on headless hosts.",
  homepage: "https://github.com/microsoft/playwright-mcp",
  agents: [AGENT_CLAUDE_CODE],
  // --no-sandbox: Chromium's sandbox needs user namespaces that containers
  // usually lack; --isolated keeps the profile in memory per episode.
  mcp_args: ["--headless", "--isolated", "--no-sandbox"],
  // The browser binary is a separate download from the npm package.
  activation: {
    darwin: [["npx", "--yes", "playwright", "install", "chromium"]],
    linux: [["npx", "--yes", "playwright", "install", "chromium"]],
    win32: [["npx", "--yes", "playwright", "install", "chromium"]],
  },
  prerequisites: {
    linux: ["Chromium system libraries (in a container: `npx playwright install-deps chromium` at image build)."],
  },
  extra_notes: [
    "Web pages only: it drives a browser, not the desktop. Use open-computer-use or clawdcursor for native apps.",
  ],
});

export const COMMUNITY_PLUGINS: readonly CommunityPlugin[] = [OPEN_COMPUTER_USE, CLAWDCURSOR, PLAYWRIGHT_MCP];
const _BY_ID = new Map(COMMUNITY_PLUGINS.map((plugin) => [plugin.plugin_id, plugin]));

export function communityPluginIds(): readonly string[] {
  return COMMUNITY_PLUGINS.map((plugin) => plugin.plugin_id);
}

export function getCommunityPlugin(pluginId: string): CommunityPlugin {
  const plugin = _BY_ID.get(pluginId);
  if (plugin === undefined) {
    throw new PluginError(
      `Unknown plugin '${pluginId}'. Available: ${communityPluginIds().join(", ")}.`,
    );
  }
  return plugin;
}

export function communityPluginState(plugin: CommunityPlugin): Promise<NpmPackageState> {
  return globalPackageState(plugin.package);
}

/**
 * Ask the vendor whether its consent and OS permissions are in place.
 *
 * Returns `[ready, detail]`; `ready` is null when this platform needs no grants.
 */
export async function communityPluginActivation(
  plugin: CommunityPlugin,
): Promise<[boolean | null, string]> {
  const template = plugin.status_check[process.platform];
  if (!template) return [null, `no grants are needed on ${process.platform}`];
  let argv: string[];
  try {
    argv = _resolveArgv(plugin, template);
  } catch (exc) {
    return [false, exc instanceof Error ? exc.message : String(exc)];
  }
  const outcome = await _capture(argv, 120);
  if ("error" in outcome) {
    return [false, `could not run \`${argv.join(" ")}\`: ${outcome.error}`];
  }
  const detail = ((outcome.stdout || "") + (outcome.stderr || "")).trim();
  const lines = detail.split(/\r\n|\r|\n/);
  const summary = detail ? lines[lines.length - 1].slice(0, 160) : `exit ${outcome.returncode}`;
  return [outcome.returncode === 0, summary];
}

/** Install the npm package, activate it, then wire it to each agent. */
export async function installCommunityPlugin(
  plugin: CommunityPlugin,
  options: { agents: readonly string[]; onStatus?: StatusCallback | null; activate?: boolean },
): Promise<NpmPackageState> {
  const agents = options.agents;
  const onStatus = options.onStatus ?? null;
  const activate = options.activate ?? true;
  const npm = requireNpm();
  const unsupported = agents.filter((agent) => !supportsAgent(plugin, agent));
  if (unsupported.length) {
    throw new PluginError(
      `${plugin.plugin_id} does not support: ${unsupported.join(", ")}. ` +
        `Supported: ${[...plugin.agents].sort().join(", ")}.`,
    );
  }
  if (!supportsPlatform(plugin, process.platform)) {
    throw new PluginError(
      `${plugin.plugin_id} does not support ${process.platform}. ` +
        `Supported platforms: ${[...plugin.platforms].sort().join(", ")}.`,
    );
  }

  for (const line of plugin.prerequisites[process.platform] ?? []) {
    _notify(onStatus, "note", `Prerequisite: ${line}`);
  }

  let state = await globalPackageState(plugin.package, { npm });
  if (state.installed) {
    _notify(onStatus, "ok", `${plugin.package} ${state.version} is already installed`);
  } else {
    _notify(onStatus, "installing", `Installing ${plugin.package} globally via npm…`);
    state = await installGlobalPackage(plugin.package, { npm });
    if (!state.installed) {
      throw new PluginError(`npm reported success but ${plugin.package} is still not installed.`);
    }
    _notify(onStatus, "ok", `Installed ${plugin.package} ${state.version}`);
  }

  if (activate) await _activate(plugin, onStatus);

  const mcpConfigs: Record<string, string> = {};
  for (const agent of agents) {
    const config = writeMcpConfig(plugin.plugin_id, agent, {
      serverName: plugin.mcp_server_name,
      command: commandName(plugin),
      args: [...plugin.mcp_args],
    });
    mcpConfigs[agent] = config;
    _notify(onStatus, "ok", `Wrote ${agent} MCP config: ${config}`);
  }

  recordInstall(plugin.plugin_id, {
    agents: [...agents],
    mcpConfigs,
    mcpServerName: plugin.mcp_server_name,
  });
  _warnAboutGlobalRegistration(plugin, onStatus);
  for (const step of plugin.manual_steps) _notify(onStatus, "todo", `Run manually: ${step}`);
  for (const note of plugin.extra_notes) _notify(onStatus, "note", note);
  return state;
}

/** Run the vendor's consent / OS-permission commands, then verify them. */
async function _activate(plugin: CommunityPlugin, onStatus: StatusCallback | null): Promise<void> {
  for (const template of plugin.activation[process.platform] ?? []) {
    const argv = _resolveArgv(plugin, template);
    _notify(onStatus, "activating", argv.join(" "));
    let returncode: number;
    try {
      returncode = await _inherit(argv, 600);
    } catch (exc) {
      throw new PluginError(
        `Could not activate ${plugin.plugin_id}: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
    if (returncode !== 0) {
      // Permission dialogs are user-driven and may be declined or deferred, so
      // a non-zero exit must not undo an otherwise good install.
      _notify(
        onStatus,
        "warn",
        `\`${argv.join(" ")}\` exited ${returncode}; ` +
          "grant the OS permissions manually and re-run it if GUI control fails",
      );
    }
  }
  await _verifyActivation(plugin, onStatus);
}

/** Confirm the grants actually took, instead of trusting the exit code. */
async function _verifyActivation(plugin: CommunityPlugin, onStatus: StatusCallback | null): Promise<void> {
  const [ready, detail] = await communityPluginActivation(plugin);
  if (ready === null) return;
  if (ready) {
    _notify(onStatus, "ok", `Activation verified: ${detail}`);
    return;
  }
  _notify(
    onStatus,
    "warn",
    `The plugin reports it is not ready (${detail}). ` +
      "GUI control will fail until consent and the OS permissions are granted.",
  );
}

export async function uninstallCommunityPlugin(
  plugin: CommunityPlugin,
  options: { onStatus?: StatusCallback | null } = {},
): Promise<NpmPackageState> {
  const onStatus = options.onStatus ?? null;
  const npm = requireNpm();
  let state = await globalPackageState(plugin.package, { npm });
  if (!state.installed) {
    _notify(onStatus, "ok", `${plugin.package} is not installed`);
  } else {
    _notify(onStatus, "removing", `Removing ${plugin.package}…`);
    state = await uninstallGlobalPackage(plugin.package, { npm });
    if (state.installed) {
      throw new PluginError(`${plugin.package} is still installed after npm reported success.`);
    }
    _notify(onStatus, "ok", `Removed ${plugin.package}`);
  }

  forgetInstall(plugin.plugin_id);
  const generated = pluginDir(plugin.plugin_id);
  let isDir = false;
  try {
    isDir = fs.statSync(generated).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    fs.rmSync(generated, { recursive: true, force: true });
    _notify(onStatus, "ok", `Removed generated MCP configs under ${generated}`);
  }
  _warnAboutGlobalRegistration(plugin, onStatus);
  return state;
}

/**
 * Find leftovers in the agents' own configs, e.g. from a vendor installer.
 *
 * The harness never writes there, but earlier versions did and the vendors'
 * `install-*-mcp` helpers still do, so report them instead of editing them.
 */
export function globalRegistrations(plugin: CommunityPlugin): string[] {
  const found: string[] = [];
  const name = plugin.mcp_server_name;
  for (const [target, needle] of _globalConfigProbes(name)) {
    let text: string;
    try {
      text = fs.readFileSync(target, "utf-8");
    } catch {
      continue;
    }
    if (text.includes(needle)) found.push(target);
  }
  return found;
}

function _globalConfigProbes(name: string): [string, string][] {
  return [[path.join(os.homedir(), ".claude.json"), `"${name}"`]];
}

function _warnAboutGlobalRegistration(plugin: CommunityPlugin, onStatus: StatusCallback | null): void {
  const leftovers = globalRegistrations(plugin);
  if (!leftovers.length) return;
  _notify(
    onStatus,
    "todo",
    `${plugin.mcp_server_name} is still registered globally in ` +
      `${[...new Set(leftovers)].sort().join(", ")}; the harness never writes there, so remove it ` +
      `yourself (\`claude mcp remove ${plugin.mcp_server_name} -s user\`, or delete the ` +
      `[mcp_servers.${plugin.mcp_server_name}] block) to keep GUI control out of unrelated sessions`,
  );
}

function _resolveArgv(plugin: CommunityPlugin, template: readonly string[]): string[] {
  const argv: string[] = [];
  template.forEach((item, index) => {
    if (item !== "{binary}") {
      argv.push(item);
      return;
    }
    const resolved = which(commandName(plugin));
    if (!resolved) {
      throw new PluginError(
        `\`${commandName(plugin)}\` was not found on PATH after installing ` +
          `${plugin.package}. Ensure npm's global bin directory is on PATH.`,
      );
    }
    // A leading {binary} is the executable; later ones are arguments.
    argv.push(index === 0 ? resolved : commandName(plugin));
  });
  return argv;
}

function _notify(callback: StatusCallback | null, status: string, message: string): void {
  if (callback !== null) callback(status, message);
}

function _capture(
  argv: string[],
  timeoutSeconds: number,
): Promise<{ returncode: number; stdout: string; stderr: string } | { error: string }> {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: timeoutSeconds * 1000, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          resolve({ error: error.message });
          return;
        }
        resolve({
          returncode: error ? Number((error as { code: number }).code) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      },
    );
  });
}

/** `subprocess.run(argv, timeout=..., check=False)` with inherited stdio. */
function _inherit(argv: string[], timeoutSeconds: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", timeout: timeoutSeconds * 1000 });
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`killed by ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}
