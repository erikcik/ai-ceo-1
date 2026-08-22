// Ported 1:1 from LongHorizon-Harness src/lh_harness/utils/agent_cli.py
//
// Resolve an agent CLI and prove it actually runs.
//
// A PATH lookup only answers "is there a file with this name on PATH", which is
// not the same question as "can I drive this agent". On Windows the gap is wide
// enough to break setup silently: a Microsoft Store App Execution Alias is a
// zero-byte reparse point under %LOCALAPPDATA%\Microsoft\WindowsApps, so the
// lookup succeeds while every real invocation fails or opens the Store.
// Everything here therefore runs `<binary> --version` and reports the outcome
// instead of trusting the lookup.
//
// Single-backend port: the Codex/dsh/OpenCode binary overrides are dropped with
// their agents; `claude` has no env override in the Python either, so
// `resolveAgentBinary` is a plain PATH lookup here.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// App Execution Aliases live here; they are reparse points, not real programs.
const _WINDOWS_STORE_ALIAS_DIR = path.join("Microsoft", "WindowsApps");
const _VERSION_RE = /\d+(?:\.\d+)+\S*/;

/** `shutil.which`: an explicit path is checked directly, otherwise PATH is scanned. */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!cmd) return null;
  const isExecutable = (candidate: string): boolean => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return false;
    } catch {
      return false;
    }
    if (process.platform === "win32") return true;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const withExt = (base: string): string | null => {
    if (process.platform !== "win32") return isExecutable(base) ? base : null;
    if (isExecutable(base) && path.extname(base)) return base;
    for (const ext of extensions) {
      const candidate = base + ext;
      if (isExecutable(candidate)) return candidate;
    }
    return isExecutable(base) ? base : null;
  };
  if (path.dirname(cmd) !== ".") return withExt(cmd);
  const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = withExt(path.join(dir, cmd));
    if (found) return found;
  }
  return null;
}

/** Resolve an agent executable using the same policy everywhere. */
export function resolveAgentBinary(
  binary: string,
  options: { environ?: NodeJS.ProcessEnv } = {},
): string | null {
  return which(binary, options.environ ?? process.env);
}

/** Return whether a resolved executable can be launched without running it. */
export function isAgentBinaryAvailable(binaryPath: string | null | undefined): boolean {
  return Boolean(binaryPath && which(binaryPath));
}

export type AgentCli = {
  binary: string;
  path: string;
  version: string;
  problem: string;
  /** `bool(self.path)` */
  found: boolean;
  /** `bool(self.path) and not self.problem` */
  usable: boolean;
};

export function agentCli(
  binary: string,
  cliPath = "",
  version = "",
  problem = "",
): AgentCli {
  return {
    binary,
    path: cliPath,
    version,
    problem,
    found: Boolean(cliPath),
    usable: Boolean(cliPath) && !problem,
  };
}

type RunOutcome =
  | { kind: "ok"; code: number; output: string }
  | { kind: "timeout" }
  | { kind: "oserror"; message: string };

function runCommand(argv: string[], timeoutSeconds: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = execFile(
      argv[0],
      argv.slice(1),
      { timeout: Math.max(0, timeoutSeconds) * 1000, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = (stdout || "") + (stderr || "");
        if (error) {
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed || (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
            resolve({ kind: "timeout" });
            return;
          }
          if (typeof (error as { code?: unknown }).code === "number") {
            resolve({ kind: "ok", code: Number((error as { code: number }).code), output });
            return;
          }
          resolve({ kind: "oserror", message: `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}`.trim() });
          return;
        }
        resolve({ kind: "ok", code: 0, output });
      },
    );
    child.on("error", () => {
      /* handled by the callback */
    });
  });
}

/**
 * Locate `binary` and confirm `--version` succeeds.
 *
 * `path` skips resolution so a caller that already chose an installation
 * verifies that exact one instead of whatever discovery would pick now.
 */
export async function probeAgentCli(
  binary: string,
  options: { timeout?: number; path?: string | null } = {},
): Promise<AgentCli> {
  const timeout = options.timeout ?? 15;
  const resolved = options.path || resolveAgentBinary(binary);
  if (!resolved) return agentCli(binary, "", "", `\`${binary}\` was not found`);

  const storeAlias = isWindowsStoreAlias(resolved);
  const outcome = await runCommand([resolved, "--version"], timeout);
  if (outcome.kind === "timeout") {
    return agentCli(binary, resolved, "", _stalledDetail(binary, resolved, storeAlias, timeout));
  }
  if (outcome.kind === "oserror") {
    return agentCli(binary, resolved, "", _brokenDetail(binary, resolved, storeAlias, outcome.message));
  }

  if (outcome.code !== 0) {
    const detail = outcome.output.trim().split(/\r\n|\r|\n/).filter((line) => line !== "");
    const tail = detail.length ? `: ${detail[detail.length - 1].slice(0, 160)}` : "";
    return agentCli(
      binary,
      resolved,
      "",
      _brokenDetail(binary, resolved, storeAlias, `exit ${outcome.code}${tail}`),
    );
  }

  const version = _parseVersion(outcome.output);
  if (!version) {
    return agentCli(
      binary,
      resolved,
      "",
      _brokenDetail(binary, resolved, storeAlias, "`--version` printed no recognisable version"),
    );
  }
  return agentCli(binary, resolved, version, "");
}

/** True when `path` looks like a Microsoft Store App Execution Alias. */
export function isWindowsStoreAlias(target: string): boolean {
  const normalised = String(target).split("/").join(path.sep).toLowerCase();
  if (!normalised.includes(_WINDOWS_STORE_ALIAS_DIR.toLowerCase())) return false;
  try {
    // Real programs have content; the alias is an empty reparse point.
    return fs.statSync(target).size === 0;
  } catch {
    return true;
  }
}

function _parseVersion(output: string): string {
  for (const line of output.trim().split(/\r\n|\r|\n/)) {
    const match = _VERSION_RE.exec(line);
    if (match) return match[0];
  }
  return "";
}

const _STORE_PACKAGES: Record<string, string> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
};

function _storeHint(binary: string): string {
  const pkg = _STORE_PACKAGES[binary];
  const install = pkg ? `Install the CLI itself (\`npm install -g ${pkg}\`)` : "Install the real CLI";
  return (
    `\`${binary}\` resolves to a Microsoft Store App Execution Alias -- the desktop app's ` +
    `stub, not the full CLI. ${install}, or turn the alias off in Settings > Apps > ` +
    "Advanced app settings > App execution aliases, so PATH finds the real binary."
  );
}

function _brokenDetail(binary: string, target: string, storeAlias: boolean, reason: string): string {
  if (storeAlias) return `${_storeHint(binary)} (\`${target} --version\` failed: ${reason})`;
  return `\`${target} --version\` failed (${reason}); the CLI is on PATH but not usable`;
}

function _stalledDetail(binary: string, target: string, storeAlias: boolean, timeout: number): string {
  if (storeAlias) return `${_storeHint(binary)} (\`${target} --version\` hung for ${timeout}s)`;
  return `\`${target} --version\` did not finish within ${timeout}s; the CLI is unresponsive`;
}

/** `~` expansion, used by the plugin state root and MCP config paths. */
export function expanduser(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/") || target.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), target.slice(2));
  }
  return target;
}
