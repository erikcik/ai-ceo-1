// Ported 1:1 from LongHorizon-Harness src/lh_harness/adapters/cli_agent.py
/**
 * `CommandAgentAdapter` — the real base class behind every CLI-driven agent.
 *
 * It owns the episode sequence (per-episode prompt file, literal template
 * substitution, `cd <workspace> && …`, status mapping) and the fixed 13-key
 * metadata envelope every role episode is judged on. The Agent-SDK adapter
 * (`claude_code.ts`) produces the same envelope without a subprocess.
 */
import crypto from "node:crypto";
import path from "node:path";

import type { Environment } from "../environment/base.js";
// Agent A: `writeRemoteText(env, remotePath, text): Promise<void>` — mkdir -p the
// parent, stage the text in `env.stagingDir`, upload, chmod 0644.
import { writeRemoteText } from "../environment/remote_files.js";
// Agent A: `detectRuntimeSignals(text): {signal: string, evidence: string}[]`.
import { detectRuntimeSignals } from "../runtime_signals.js";
import {
  DEFAULT_TMP_DIR,
  DEFAULT_WORKSPACE_PATH,
  type EpisodeBudget,
  type EpisodeResult,
  type EpisodeStatus,
} from "../types.js";
import type { AgentAdapter } from "./base.js";

const SECRET_NAME = "(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|PASSWORD|TOKEN)";
const SECRET_VALUE = "(?:'[^']*'|\"[^\"]*\"|\\S+)";
const SECRET_PATTERNS = [
  new RegExp(`\\b([A-Za-z0-9_]*${SECRET_NAME}\\s*=)${SECRET_VALUE}`, "gi"),
  new RegExp(`(--[A-Za-z0-9-]*${SECRET_NAME}[= ])${SECRET_VALUE}`, "gi"),
];

/** Mask credential values in text before it is logged or shown to a role. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "$1***REDACTED***");
  }
  return out;
}

// Python's `shlex.quote`: `_find_unsafe = re.compile(r'[^\w@%+=:,./-]', re.ASCII)`.
const SHLEX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** `shlex.quote` — POSIX-safe single-argument quoting. */
export function shlexQuote(value: string): string {
  if (value === "") return "''";
  if (SHLEX_SAFE.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** `posixpath.join(directory, name)` for a single relative `name` (no normalisation). */
function posixJoin(directory: string, name: string): string {
  if (name.startsWith("/")) return name;
  if (!directory) return name;
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** Python `str.rstrip("/")`. */
export function rstripSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export type CommandAgentAdapterOptions = {
  command_template: string;
  prompt_dir?: string;
  workspace_path?: string;
  visible_output_parser?: ((raw: string) => string) | null;
  hidden_paths?: readonly string[];
};

export class CommandAgentAdapter implements AgentAdapter {
  commandTemplate: string;
  promptDir: string;
  workspacePath: string;
  visibleOutputParser: ((raw: string) => string) | null;
  hiddenPaths: readonly string[];

  constructor(options: CommandAgentAdapterOptions) {
    this.commandTemplate = options.command_template;
    this.promptDir = rstripSlash(options.prompt_dir ?? `${DEFAULT_TMP_DIR}/prompts`) || ".";
    this.workspacePath = rstripSlash(options.workspace_path ?? DEFAULT_WORKSPACE_PATH);
    this.visibleOutputParser = options.visible_output_parser ?? null;
    this.hiddenPaths = [...(options.hidden_paths ?? [])];
  }

  async runEpisode(
    prompt: string,
    env: Environment,
    budget: EpisodeBudget,
    liveTrajectoryPath: string | null = null,
  ): Promise<EpisodeResult> {
    const start = monotonicMs();
    // Never reuse one global prompt.md. A run owns its prompt directory and
    // every role episode gets a distinct filename, so concurrent harnesses
    // (and future concurrent roles within one harness) cannot overwrite the
    // input while an agent CLI is still reading it.
    const promptPath = posixJoin(
      this.promptDir,
      `${episodePromptLabel(liveTrajectoryPath)}_${uuid4Hex().slice(0, 12)}.md`,
    );
    await writeRemoteText(env, promptPath, prompt + hiddenPathsNotice(this.hiddenPaths));
    // Substituted by explicit replace, not a format string: templates embed
    // literal braces (e.g. Codex passes inline-TOML `-c` overrides) that a
    // formatter would try to interpret as placeholders.
    let commandBody = this.commandTemplate;
    for (const [placeholder, value] of [
      ["{prompt_path}", shlexQuote(promptPath)],
      ["{timeout}", String(budget.max_duration_seconds)],
    ] as const) {
      commandBody = commandBody.split(placeholder).join(value);
    }
    const command = `cd ${shlexQuote(this.workspacePath)} && ${commandBody}`;
    // When a live path is given (local runs), the environment mirrors stdout
    // to that file line-by-line so the dashboard shows the trajectory live.
    const result = await env.exec(command, budget.max_duration_seconds, liveTrajectoryPath);
    const durationMs = Math.trunc(monotonicMs() - start);
    let status: EpisodeStatus;
    if (result.termination_reason === "timeout") {
      status = "timeout";
    } else {
      status = result.exit_code === 0 ? "done" : "error";
    }
    const stdoutLog = result.stdout;
    const actionsLog = stdoutLog;
    const visibleOutput =
      this.visibleOutputParser !== null ? this.visibleOutputParser(stdoutLog).trim() : "";
    const runtimeSignals = detectRuntimeSignals(stdoutLog);
    let error: string | null;
    if (result.termination_reason === "timeout") {
      error = `Episode timed out after ${budget.max_duration_seconds}s.`;
    } else {
      error = result.exit_code !== 0 ? redactSecrets(result.stderr.slice(-2000)) : null;
    }
    return {
      status,
      actions_log: actionsLog,
      error,
      duration_ms: durationMs,
      metadata: {
        command: redactSecrets(command),
        workspace: this.workspacePath,
        prompt_path: promptPath,
        exit_code: result.exit_code,
        termination_reason: result.termination_reason ?? null,
        actions_log_chars: actionsLog.length,
        trajectory_format: "jsonl",
        assistant_visible_output: visibleOutput,
        runtime_signals: runtimeSignals,
        actions_log_diagnostics_only: Boolean(this.visibleOutputParser !== null && !visibleOutput),
        stderr_chars: result.stderr.length,
        stderr_tail: redactSecrets(result.stderr.slice(-2000)),
      },
    };
  }
}

/**
 * Tell the agent to stay out of the harness's own run directories.
 *
 * The run's logs, prompts and harness state may sit inside the workspace. They
 * are not task content, and reading them would leak other roles' context.
 */
export function hiddenPathsNotice(hiddenPaths: readonly string[]): string {
  if (hiddenPaths.length === 0) return "";
  const listed = hiddenPaths.map((p) => `- ${p}`).join("\n");
  return (
    "\n\nHarness-owned paths (off limits):\n" +
    `${listed}\n` +
    "These hold this run's own logs, prompts, and harness state. Never read, list, " +
    "search, or modify them, and never treat their contents as task input or evidence."
  );
}

/** Derive a readable round/role label without relying on it for uniqueness. */
export function episodePromptLabel(liveTrajectoryPath: string | null | undefined): string {
  if (!liveTrajectoryPath) return "episode_agent";
  const base = path.posix.basename(liveTrajectoryPath);
  const ext = path.posix.extname(base);
  let role = ext && ext !== base ? base.slice(0, -ext.length) : base;
  const suffix = "_raw_trajectory";
  if (role.endsWith(suffix)) role = role.slice(0, -suffix.length);
  const parentName = path.posix.basename(path.posix.dirname(liveTrajectoryPath));
  const roundName = /^round_\d+$/.test(parentName) ? parentName : "episode";
  const label = `${roundName}_${role}`;
  return pyStripChars(label.replace(/[^A-Za-z0-9_.-]+/g, "_"), "._") || "episode_agent";
}

/** Python `str.strip(chars)` for a small character set. */
function pyStripChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function uuid4Hex(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** `time.monotonic()` in milliseconds. */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
