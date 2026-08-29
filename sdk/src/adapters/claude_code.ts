// Ported 1:1 from LongHorizon-Harness src/lh_harness/adapters/claude_code.py
/**
 * The one place the port is not literal: upstream shells out to
 * `claude --print --output-format stream-json --verbose …`, here the same
 * episode runs through `query()` from `@anthropic-ai/claude-agent-sdk`.
 *
 * Everything observable stays identical — the prompt file is still written to
 * `prompt_dir`, `actions_log` is still Claude stream-JSON (one JSON object per
 * line, exactly the shapes `agent_logs` parses), and `metadata` keeps the
 * Python key names verbatim, including a redacted human-readable equivalent of
 * the argv line that upstream would have run.
 *
 * SDK translation (see specs/00-port-plan.md and 03-auditor-adapters.md §3.8):
 *   --dangerously-skip-permissions → permissionMode "bypassPermissions" + allowDangerouslySkipPermissions
 *   --disallowedTools A B C        → disallowedTools (Agent → Task; mcp__* kept)
 *   Read(//p/**) / Edit(//p/**)    → the same rule strings in disallowedTools (SDK forwards to --disallowedTools)
 *   --mcp-config file              → mcpServers (SDK is strict by construction)
 *   env prefix                     → options.env
 *   cd <workspace> &&              → cwd
 *   budget.max_duration_seconds    → AbortController + timer
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { query, type CanUseTool, type Options, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";

// Agent A: the Claude stream-JSON visible-output parser (`agent_logs.visible_output`).
import { extractClaudeVisibleOutput } from "../agent_logs.js";
// Agent B: `normaliseReasoningEffort(value)` — the shared `^[A-Za-z0-9._:-]{1,64}$` validator.
import { normaliseReasoningEffort } from "../agent_registry.js";
import type { Environment } from "../environment/base.js";
// Agent A: `writeRemoteText(env, remotePath, text): Promise<void>`.
import { writeRemoteText } from "../environment/remote_files.js";
// Agent B: the fail-closed guard sentence (Layer D).
import { GUARD_REJECTION_MESSAGE } from "../provider_errors.js";
import { resolveModel } from "../providers.js";
import { detectRuntimeSignals } from "../runtime_signals.js";
import { ensureShim, type ShimConfig } from "../shim.js";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_TMP_DIR,
  DEFAULT_WORKSPACE_PATH,
  type EpisodeBudget,
  type EpisodeResult,
  type EpisodeStatus,
} from "../types.js";
import { pyStrip } from "../utils/pystr.js";
import {
  CommandAgentAdapter,
  episodePromptLabel,
  hiddenPathsNotice,
  monotonicMs,
  redactSecrets,
  rstripSlash,
  shlexQuote,
} from "./cli_agent.js";
import {
  type ClaudeRole,
  type ClaudeRolePolicy,
  isAuditorRole,
  pathDenyRules,
  policyForRole,
  resolvePath,
  snapshotWorkspace,
  workspaceSnapshotDiff,
} from "./claude_permissions.js";

/** Effort tiers the SDK accepts; anything else is dropped silently, as the CLI does. */
const SDK_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** `Agent` is the CLI's name for what the SDK calls `Task`. */
const TOOL_NAME_TRANSLATION: Record<string, string> = { Agent: "Task" };

/** stdout / stderr in-memory tail bounds, matching LocalEnvironment. */
const STDERR_TAIL_BYTES = 4 * 1024 * 1024;

export const ADD_DIRS_REJECTION_MESSAGE =
  "Claude Code role isolation does not allow additional directories; " +
  "put task files inside the run workspace instead.";

/** Per-episode additions the loop passes on top of the role's static plan. */
export type EpisodeQueryOptions = {
  signal?: AbortSignal;
  hooks?: unknown;
  agents?: unknown;
  systemPromptAppend?: string;
  maxBudgetUsd?: number;
};

export type ClaudeCodeAdapterOptions = {
  model?: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  workspacePath?: string;
  promptDir?: string;
  mcpConfig?: string | null;
  addDirs?: string[] | null;
  role?: ClaudeRole;
  hiddenPaths?: readonly string[];
  guardExcludePaths?: readonly string[];
  reasoningEffort?: string | null;
  /** Process environment to read the `LH_HARNESS_CLAUDECODE_*` overrides from. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Everything derived from the constructor arguments, with no I/O beyond
 * reading `providers.json`. Exported so the option building can be unit-tested
 * without touching the API.
 */
export type ClaudeQueryPlan = {
  /** Model id handed to the SDK (a `<provider>:<model>` ref is already resolved). */
  model: string;
  /** Provider name when the model was routed through providers.json. */
  provider?: string;
  /** Local shim to start before the episode; its URL replaces ANTHROPIC_BASE_URL. */
  shim?: ShimConfig;
  /** Full replacement env for provider-routed sessions (Anthropic creds stripped). */
  providerEnv?: Record<string, string | undefined>;
  /** The `VAR=value` prefix upstream inlines before `claude`, in Python's order. */
  envAdditions: Record<string, string>;
  policy: ClaudeRolePolicy;
  /** `metadata.claude_disallowed_tools` — the policy list verbatim (`Agent`, not `Task`). */
  policyDisallowedTools: string[];
  /** What the SDK gets: the policy list with `Agent` translated to `Task`. */
  disallowedTools: string[];
  /** `Read(//p)` / `Read(//p/**)` / `Edit(//p)` / `Edit(//p/**)`; metadata + command line only. */
  pathDenyRules: string[];
  mcpConfigPath: string | null;
  computerMcpConfigured: boolean;
  reasoningEffort: string;
  /** Only set when the normalized effort is one the SDK knows. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  workspacePath: string;
  promptDir: string;
  hiddenPaths: string[];
  guardExcludePaths: string[];
  /** `<env prefix>claude … < {prompt_path}` — the base class wraps it in `cd <ws> && …`. */
  commandTemplate: string;
  /**
   * Everything handed to `query()` that does not depend on the episode: the
   * per-episode `env`, `abortController`, `stderr`, `canUseTool` and
   * `mcpServers` are merged on top at launch.
   */
  sdkOptions: SdkStaticOptions;
};

export type SdkStaticOptions = {
  model: string;
  cwd: string;
  settingSources: [];
  systemPrompt: { type: "preset"; preset: "claude_code" };
  permissionMode: "bypassPermissions";
  allowDangerouslySkipPermissions: true;
  disallowedTools: string[];
  strictMcpConfig: true;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

/**
 * Build the whole query configuration from the constructor arguments.
 *
 * Pure apart from `providers.json` / env lookups, so the option shape can be
 * asserted in tests without an API call.
 */
export function buildQueryOptions(options: ClaudeCodeAdapterOptions = {}): ClaudeQueryPlan {
  const processEnv = options.env ?? process.env;
  const role: ClaudeRole = options.role ?? "composer";
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  const apiKey = options.apiKey ?? null;
  const baseUrl = options.baseUrl ?? null;
  const workspacePath = rstripSlash(options.workspacePath ?? DEFAULT_WORKSPACE_PATH);
  const promptDir = rstripSlash(options.promptDir ?? `${DEFAULT_TMP_DIR}/prompts`) || ".";
  const hiddenPaths = [...(options.hiddenPaths ?? [])];
  const guardExcludePaths = [...(options.guardExcludePaths ?? [])];

  const policy = policyForRole(role);
  const effort = normaliseReasoningEffort(options.reasoningEffort ?? null);

  // A "<provider>:<model>" ref routes this episode to an Anthropic-compatible
  // third-party API; a plain id passes through untouched. Throws here (before
  // anything runs) when the provider or its key is unknown.
  const resolved = resolveModel(model, undefined, processEnv);
  const provider = resolved.provider;
  const resolvedModel = resolved.model ?? model;

  const envAdditions: Record<string, string> = {};
  if (!provider) {
    // Provider-routed sessions get their credentials from providers.json and
    // must never see the operator's Anthropic key.
    if (apiKey) {
      envAdditions.ANTHROPIC_API_KEY = apiKey;
      envAdditions.ANTHROPIC_AUTH_TOKEN = apiKey;
    }
    if (baseUrl) {
      let rawUrl = rstripSlash(baseUrl);
      if (rawUrl.endsWith("/v1")) rawUrl = rawUrl.slice(0, -3);
      envAdditions.ANTHROPIC_BASE_URL = rawUrl;
    }
  }
  envAdditions.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  envAdditions.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  envAdditions.LH_HARNESS_CLAUDE_ROLE = role;

  // MCP support remains opt-in. The SDK is strict by construction, so no
  // unrelated user/project MCP servers reach any role.
  let mcpConfig = options.mcpConfig || processEnv.LH_HARNESS_CLAUDECODE_MCP_CONFIG || null;
  if (mcpConfig) {
    const candidate = expandUserPath(mcpConfig);
    if (isFile(candidate)) mcpConfig = resolvePath(candidate);
  }
  const resolvedAddDirs = [...(options.addDirs ?? [])];
  const envAddDirs =
    processEnv.LH_HARNESS_CLAUDECODE_ADD_DIRS || processEnv.LH_HARNESS_MCP_ADD_DIRS || "";
  if (envAddDirs) {
    resolvedAddDirs.push(...envAddDirs.split(path.delimiter).filter((part) => part));
  }
  if (resolvedAddDirs.length > 0) {
    throw new Error(ADD_DIRS_REJECTION_MESSAGE);
  }

  if (isAuditorRole(role)) {
    envAdditions.GIT_OPTIONAL_LOCKS = "0";
    envAdditions.GIT_PAGER = "cat";
    envAdditions.PAGER = "cat";
  }

  const envPrefixParts = Object.entries(envAdditions).map(
    ([name, value]) => `${name}=${shlexQuote(value)}`,
  );
  const envPrefix = envPrefixParts.length > 0 ? `${envPrefixParts.join(" ")} ` : "";
  const commandParts = [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  const policyDisallowedTools = [...policy.disallowed_tools];
  const denyPathRules = pathDenyRules(hiddenPaths);
  const denyTools = [...policyDisallowedTools, ...denyPathRules];
  if (denyTools.length > 0) {
    commandParts.push("--disallowedTools");
    commandParts.push(...denyTools.map(shlexQuote));
  }
  const computerMcpConfigured = Boolean(policy.load_computer_mcp && mcpConfig);
  if (computerMcpConfigured && mcpConfig) {
    commandParts.push("--mcp-config", shlexQuote(mcpConfig));
  }
  commandParts.push("--model", shlexQuote(resolvedModel));
  // Claude Code warns and continues at its default when the value is not one
  // it knows, so an unusable effort will not fail the run here.
  if (effort) {
    commandParts.push("--effort", shlexQuote(effort));
  }

  const sdkEffort = SDK_EFFORT_LEVELS.has(effort)
    ? (effort as "low" | "medium" | "high" | "xhigh" | "max")
    : undefined;
  const disallowedTools = policyDisallowedTools.map((tool) => TOOL_NAME_TRANSLATION[tool] ?? tool);

  return {
    model: resolvedModel,
    ...(provider ? { provider } : {}),
    ...(resolved.shim ? { shim: resolved.shim } : {}),
    ...(resolved.env ? { providerEnv: resolved.env } : {}),
    envAdditions,
    policy,
    policyDisallowedTools,
    disallowedTools,
    sdkOptions: {
      model: resolvedModel,
      // `cd <workspace> && …` — the episode's only working set.
      cwd: workspacePath,
      // The episode inherits NOTHING from any settings file or CLAUDE.md; this
      // is the SDK equivalent of CLAUDE_CODE_DISABLE_AUTO_MEMORY.
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // The SDK forwards this list to the same `--disallowedTools` flag the
      // Python adapter used, so the `Read(//p/**)` / `Edit(//p/**)` deny rules
      // for harness-owned paths apply for real, not only in metadata.
      disallowedTools: [...disallowedTools, ...denyPathRules],
      // `--strict-mcp-config` in intent: no user/project MCP servers leak in.
      strictMcpConfig: true,
      ...(sdkEffort ? { effort: sdkEffort } : {}),
    },
    pathDenyRules: denyPathRules,
    mcpConfigPath: computerMcpConfigured ? mcpConfig : null,
    computerMcpConfigured,
    reasoningEffort: effort,
    ...(sdkEffort ? { effort: sdkEffort } : {}),
    workspacePath,
    promptDir,
    hiddenPaths,
    guardExcludePaths,
    commandTemplate: `${envPrefix}${commandParts.join(" ")} < {prompt_path}`,
  };
}

export class ClaudeCodeAdapter extends CommandAgentAdapter {
  role: ClaudeRole;
  policy: ClaudeRolePolicy;
  reasoningEffort: string;
  guardExcludePaths: readonly string[];
  computerMcpConfigured: boolean;
  plan: ClaudeQueryPlan;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    const plan = buildQueryOptions(options);
    super({
      command_template: plan.commandTemplate,
      prompt_dir: plan.promptDir,
      workspace_path: plan.workspacePath,
      visible_output_parser: extractClaudeVisibleOutput,
      hidden_paths: plan.hiddenPaths,
    });
    this.role = options.role ?? "composer";
    this.policy = plan.policy;
    this.reasoningEffort = plan.reasoningEffort;
    // Snapshot-only exclusions: unlike hiddenPaths these are not denied to the
    // agent — the guard just refrains from walking directories that
    // legitimately churn (build outputs) during an audit window.
    this.guardExcludePaths = plan.guardExcludePaths;
    this.computerMcpConfigured = plan.computerMcpConfigured;
    this.plan = plan;
  }

  async runEpisode(
    prompt: string,
    env: Environment,
    budget: EpisodeBudget,
    liveTrajectoryPath: string | null = null,
    options: EpisodeQueryOptions = {},
  ): Promise<EpisodeResult> {
    const guardPaths = [...this.hiddenPaths, ...this.guardExcludePaths];
    const before = isAuditorRole(this.role)
      ? snapshotWorkspace(this.workspacePath, guardPaths)
      : null;

    const result = await this.runQueryEpisode(prompt, env, budget, liveTrajectoryPath, options);

    Object.assign(result.metadata, {
      claude_role: this.role,
      claude_permission_mode: this.policy.permission_mode,
      claude_dangerously_skip_permissions: true,
      claude_hooks_enabled: false,
      claude_native_sandbox_enabled: false,
      claude_tool_policy: "default-minus-disallowed",
      claude_disallowed_tools: [...this.plan.policyDisallowedTools],
      claude_computer_mcp_loaded: this.computerMcpConfigured,
      claude_workspace_read_only: this.policy.workspace_read_only,
      claude_reasoning_effort: this.reasoningEffort,
    });
    if (before !== null) {
      const after = snapshotWorkspace(this.workspacePath, guardPaths);
      const diff = workspaceSnapshotDiff(before, after);
      Object.assign(result.metadata, diff);
      // Record the effective exclusions with every audited episode so the
      // guard's reduced coverage is visible in the run artifacts.
      result.metadata.verifier_guard_exclude_paths = [...this.guardExcludePaths];
      const snapshotErrors = diff.verifier_workspace_snapshot_errors as string[] | undefined;
      if (snapshotErrors && snapshotErrors.length > 0) {
        // Escalate only a successful status: a real timeout (or cancellation)
        // is stronger evidence and must stay visible to the runtime-failure
        // classifier.
        if (result.status === "done") result.status = "error";
        const guardError = GUARD_REJECTION_MESSAGE;
        result.error = result.error ? pyStrip(`${result.error}\n${guardError}`) : guardError;
      }
    }
    return result;
  }

  /** The `CommandAgentAdapter.run_episode` body, with `query()` in place of `env.exec`. */
  protected async runQueryEpisode(
    prompt: string,
    env: Environment,
    budget: EpisodeBudget,
    liveTrajectoryPath: string | null,
    options: EpisodeQueryOptions,
  ): Promise<EpisodeResult> {
    const start = monotonicMs();
    const promptPath = `${this.promptDir}/${episodePromptLabel(liveTrajectoryPath)}_${uuid12()}.md`;
    // The prompt file is not what the SDK reads, but every artifact consumer
    // (and `metadata.prompt_path`) still expects it on disk.
    await writeRemoteText(env, promptPath, prompt + hiddenPathsNotice(this.hiddenPaths));

    let commandBody = this.commandTemplate;
    for (const [placeholder, value] of [
      ["{prompt_path}", shlexQuote(promptPath)],
      ["{timeout}", String(budget.max_duration_seconds)],
    ] as const) {
      commandBody = commandBody.split(placeholder).join(value);
    }
    const command = `cd ${shlexQuote(this.workspacePath)} && ${commandBody}`;

    const queryEnv = await this.resolveEnv();
    const abortController = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, budget.max_duration_seconds * 1000);
    const onExternalAbort = () => {
      cancelled = true;
      abortController.abort();
    };
    if (options.signal?.aborted) onExternalAbort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const tee = openTrajectoryFile(liveTrajectoryPath);
    const lines: string[] = [];
    let stderrBuffer = "";
    const appendStderr = (data: string) => {
      stderrBuffer = (stderrBuffer + data).slice(-STDERR_TAIL_BYTES);
    };

    let exitCode = 0;
    let status: EpisodeStatus = "done";
    let error: string | null = null;
    let totalCostUsd: number | null = null;
    let numTurns: number | null = null;
    let sessionId: string | null = null;

    try {
      const queryOptions: Options = {
        ...this.plan.sdkOptions,
        env: queryEnv,
        abortController,
        stderr: appendStderr,
      };
      // Per-episode additions from the loop: in-process hooks (evidence
      // ledger, write scopes, stop gate), harness-defined subagents, a
      // task-specific system prompt suffix and a hard dollar ceiling.
      if (options.hooks) queryOptions.hooks = options.hooks as Options["hooks"];
      if (options.agents && this.policy.subagents) queryOptions.agents = options.agents as Options["agents"];
      if (options.systemPromptAppend) {
        queryOptions.systemPrompt = { type: "preset", preset: "claude_code", append: options.systemPromptAppend };
      }
      if (typeof options.maxBudgetUsd === "number" && options.maxBudgetUsd > 0) {
        queryOptions.maxBudgetUsd = options.maxBudgetUsd;
      }
      // No canUseTool: under bypassPermissions the SDK never consults it; the
      // Read(//p/**)/Edit(//p/**) deny rules in `disallowedTools` do the work.
      const mcpServers = this.loadMcpServers();
      if (mcpServers) queryOptions.mcpServers = mcpServers as Options["mcpServers"];

      for await (const message of query({ prompt, options: queryOptions })) {
        const line = `${safeJson(message)}\n`;
        lines.push(line);
        tee.write(line);
        if ((message as { type?: string }).type === "result") {
          const record = message as {
            subtype?: string;
            total_cost_usd?: number;
            num_turns?: number;
            session_id?: string;
          };
          exitCode = record.subtype === "success" ? 0 : 1;
          totalCostUsd = typeof record.total_cost_usd === "number" ? record.total_cost_usd : null;
          numTurns = typeof record.num_turns === "number" ? record.num_turns : null;
          sessionId = typeof record.session_id === "string" ? record.session_id : null;
        }
      }
    } catch (exc) {
      // A transport/API failure mid-episode is the SDK's equivalent of a
      // non-zero exit with the message on stderr.
      if (!timedOut && !cancelled) {
        exitCode = 1;
        appendStderr(`${exc instanceof Error ? exc.message : String(exc)}\n`);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      tee.close();
    }

    let terminationReason: string | null = null;
    if (timedOut) {
      terminationReason = "timeout";
      exitCode = -1;
    } else if (cancelled) {
      terminationReason = "cancelled";
      exitCode = -1;
    }

    const durationMs = Math.trunc(monotonicMs() - start);
    if (timedOut) {
      status = "timeout";
    } else if (cancelled) {
      status = "cancelled";
    } else {
      status = exitCode === 0 ? "done" : "error";
    }
    const actionsLog = lines.join("");
    const visibleOutput = pyStrip(extractClaudeVisibleOutput(actionsLog));
    const runtimeSignals = detectRuntimeSignals(actionsLog);
    if (timedOut) {
      error = `Episode timed out after ${budget.max_duration_seconds}s.`;
    } else if (cancelled) {
      error = null;
    } else {
      error = exitCode !== 0 ? redactSecrets(stderrBuffer.slice(-2000)) : null;
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
        exit_code: exitCode,
        termination_reason: terminationReason,
        actions_log_chars: actionsLog.length,
        trajectory_format: "jsonl",
        assistant_visible_output: visibleOutput,
        runtime_signals: runtimeSignals,
        actions_log_diagnostics_only: Boolean(!visibleOutput),
        stderr_chars: stderrBuffer.length,
        stderr_tail: redactSecrets(stderrBuffer.slice(-2000)),
        total_cost_usd: totalCostUsd,
        num_turns: numTurns,
        session_id: sessionId,
        ...(this.plan.provider ? { claude_provider: this.plan.provider } : {}),
      },
    };
  }

  /** `{...process.env minus LH_HARNESS_WEB_TOKEN, ...env prefix}` (+ shim base URL). */
  private async resolveEnv(): Promise<Record<string, string | undefined>> {
    const base: Record<string, string | undefined> = { ...(this.plan.providerEnv ?? process.env) };
    // The supervisor bearer token must never reach an agent.
    delete base.LH_HARNESS_WEB_TOKEN;
    Object.assign(base, this.plan.envAdditions);
    if (this.plan.shim) {
      base.ANTHROPIC_BASE_URL = await ensureShim(this.plan.shim);
    }
    return base;
  }

  /** The MCP servers this role will hand to the SDK (null for no-tool roles). */
  computerUseServers(): Record<string, unknown> | null {
    return this.loadMcpServers();
  }

  private loadMcpServers(): Record<string, unknown> | null {
    if (!this.plan.mcpConfigPath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.plan.mcpConfigPath, "utf-8"));
      const servers = parsed?.mcpServers;
      return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : null;
    } catch {
      // Upstream hands the path to the CLI and lets it complain; an unreadable
      // config must not take the episode down before it starts.
      return null;
    }
  }

  /**
   * The SDK counterpart of the `Read(//p/**)` / `Edit(//p/**)` deny rules.
   *
   * It also covers `Bash` commands that name a harness-owned path, which the
   * CLI rules never could. (Note: with `permissionMode: "bypassPermissions"`
   * the callback is a best-effort layer — the prompt notice, the deny rules
   * recorded in metadata, and the auditor snapshot guard remain the other
   * three layers.)
   */
  private buildCanUseTool(): CanUseTool | null {
    const hidden = this.hiddenPaths.map((item) => resolvePath(item));
    if (hidden.length === 0) return null;
    const workspace = this.workspacePath;
    const deny = (hit: string): PermissionResult => ({
      behavior: "deny",
      message:
        `Harness-owned path (off limits): ${hit}. ` +
        "This holds this run's own logs, prompts, and harness state. Never read, list, " +
        "search, or modify it, and never treat its contents as task input or evidence.",
    });
    return async (_toolName: string, input: Record<string, unknown>) => {
      for (const candidate of referencedPaths(input)) {
        const resolvedCandidate = path.resolve(workspace, expandUserPath(candidate));
        for (const hiddenPath of hidden) {
          if (resolvedCandidate === hiddenPath || resolvedCandidate.startsWith(`${hiddenPath}/`)) {
            return deny(hiddenPath);
          }
        }
      }
      const command = typeof input.command === "string" ? input.command : "";
      if (command) {
        for (const hiddenPath of hidden) {
          if (command.includes(hiddenPath)) return deny(hiddenPath);
        }
      }
      return { behavior: "allow", updatedInput: input };
    };
  }
}

/** Path-ish tool inputs, plus the tokens of a Bash command line. */
function referencedPaths(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value) found.push(value);
  }
  const command = input.command;
  if (typeof command === "string" && command) {
    for (const token of command.split(/[\s;|&()<>]+/)) {
      const bare = token.replace(/^['"]+/, "").replace(/['"]+$/, "");
      if (bare && (bare.startsWith("/") || bare.startsWith("~") || bare.includes("/"))) {
        found.push(bare);
      }
    }
  }
  return found;
}

type TrajectoryTee = { write(line: string): void; close(): void };

/**
 * Symlink-hardened live trajectory file (`_open_trajectory_file`): open the
 * parent without following links, verify a private regular file with one link,
 * and only then truncate. Any failure disables the tee instead of aborting.
 */
function openTrajectoryFile(livePath: string | null): TrajectoryTee {
  if (!livePath) return { write() {}, close() {} };
  let fd: number | null = null;
  try {
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    fd = fs.openSync(
      livePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      fs.closeSync(fd);
      return { write() {}, close() {} };
    }
    fs.ftruncateSync(fd, 0);
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
    return { write() {}, close() {} };
  }
  const handle = fd;
  let open = true;
  return {
    write(line: string) {
      if (!open) return;
      try {
        fs.writeSync(handle, line);
      } catch {
        open = false;
      }
    },
    close() {
      if (!open) return;
      open = false;
      try {
        fs.closeSync(handle);
      } catch {
        /* already gone */
      }
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    const type = (value as { type?: string } | null)?.type;
    return JSON.stringify({ type: typeof type === "string" ? type : "unknown" });
  }
}

function uuid12(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function expandUserPath(raw: string): string {
  if (raw === "~") return process.env.HOME ?? raw;
  if (raw.startsWith("~/") && process.env.HOME) return path.join(process.env.HOME, raw.slice(2));
  return raw;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
