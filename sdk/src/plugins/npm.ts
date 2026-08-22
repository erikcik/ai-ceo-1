// Ported 1:1 from LongHorizon-Harness src/lh_harness/plugins/npm.py
//
// Global npm package checks and installs for the community GUI plugins.
//
// Both community computer-use servers ship on npm, so the harness only needs to
// know whether a global package is present and how to add or remove it.
import { execFile } from "node:child_process";

import { which } from "../utils/agent_cli.js";
import { PluginError } from "./errors.js";

export type NpmPackageState = {
  name: string;
  installed: boolean;
  version: string;
};

function npmPackageState(name: string, installed: boolean, version = ""): NpmPackageState {
  return { name, installed, version };
}

export function npmBinary(): string | null {
  return which("npm");
}

type CompletedProcess = { returncode: number; stdout: string; stderr: string };

function spawn(command: string[], timeoutSeconds: number): Promise<CompletedProcess | { error: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    execFile(
      command[0],
      command.slice(1),
      { timeout: timeoutSeconds * 1000, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean };
          // A `timeout` kill reports `killed` with no numeric exit code.
          if (failure.killed && !failure.code) failure.code = "ETIMEDOUT";
          resolve({ error: failure });
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

/** Best-effort `<binary> --version`; an unusable tool must not raise. */
async function _toolVersion(binary: string): Promise<string> {
  const target = which(binary);
  if (!target) return "";
  const result = await spawn([target, "--version"], 10);
  if ("error" in result) return "";
  return result.returncode === 0 ? result.stdout.trim().replace(/^v/, "") : "";
}

export function nodeVersion(): Promise<string> {
  return _toolVersion("node");
}

export function npmVersion(): Promise<string> {
  return _toolVersion("npm");
}

export function requireNpm(): string {
  const npm = npmBinary();
  if (!npm) {
    throw new PluginError(
      "npm was not found on PATH. Install Node.js 20 or later " +
        "(https://nodejs.org) and re-run this command.",
    );
  }
  return npm;
}

/** Read one global package's installed state from `npm ls --json`. */
export async function globalPackageState(
  name: string,
  options: { npm?: string | null } = {},
): Promise<NpmPackageState> {
  const binary = options.npm || requireNpm();
  // `npm ls` exits 1 when the package is absent, so the JSON body decides.
  const result = await _run([binary, "ls", "--global", "--depth=0", "--json", name], {
    timeout: 120,
    operation: `query global npm package ${name}`,
    allowFailure: true,
  });
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    throw new PluginError(`npm returned invalid JSON while listing ${name}.`);
  }
  const dependencies = isObject(payload) ? payload.dependencies : null;
  const entry = isObject(dependencies) ? dependencies[name] : null;
  if (!isObject(entry)) return npmPackageState(name, false);
  return npmPackageState(name, true, String(entry.version || ""));
}

export async function installGlobalPackage(
  name: string,
  options: { npm?: string | null } = {},
): Promise<NpmPackageState> {
  const binary = options.npm || requireNpm();
  await _run([binary, "install", "--global", name], {
    timeout: 900,
    operation: `install npm package ${name}`,
  });
  return globalPackageState(name, { npm: binary });
}

export async function uninstallGlobalPackage(
  name: string,
  options: { npm?: string | null } = {},
): Promise<NpmPackageState> {
  const binary = options.npm || requireNpm();
  await _run([binary, "uninstall", "--global", name], {
    timeout: 300,
    operation: `uninstall npm package ${name}`,
  });
  return globalPackageState(name, { npm: binary });
}

async function _run(
  command: string[],
  options: { timeout: number; operation: string; allowFailure?: boolean },
): Promise<CompletedProcess> {
  const outcome = await spawn(command, options.timeout);
  if ("error" in outcome) {
    const code = outcome.error.code;
    if (code === "ENOENT") throw new PluginError(`npm disappeared while trying to ${options.operation}.`);
    if (code === "ETIMEDOUT") throw new PluginError(`Timed out while trying to ${options.operation}.`);
    throw new PluginError(`Could not ${options.operation}: ${outcome.error.message}`);
  }
  if (outcome.returncode !== 0 && !options.allowFailure) {
    throw new PluginError(`Failed to ${options.operation}${_detail(outcome)}`);
  }
  return outcome;
}

function _detail(result: CompletedProcess): string {
  const text = (result.stderr || result.stdout).trim();
  if (!text) return "";
  return `: ${text.slice(-800)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
