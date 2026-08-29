/**
 * Ported 1:1 from LongHorizon-Harness src/lh_harness/types.py.
 *
 * Every record that reaches disk (report.json, events.jsonl, rounds/, control/)
 * keeps the Python field names verbatim, so the on-disk formats stay
 * byte-compatible with the original harness.
 */
import os from "node:os";
import path from "node:path";

function launchDirectory(): string {
  // Directory lh-harness-eray was started from, captured once at import. Symlinks
  // stay resolved so this agrees with the run paths derived from it.
  try {
    return process.cwd();
  } catch {
    return process.env.PWD || ".";
  }
}

// Harness bookkeeping is user-scoped; the agents work in the directory
// lh-harness-eray was started from, so a task acts on the caller's real project.
export const DEFAULT_STATE_ROOT = process.env.LH_HARNESS_STATE_ROOT || path.join(os.homedir(), ".lh-harness");
export const DEFAULT_WORKSPACE_PATH = launchDirectory();
export const DEFAULT_HARNESS_DIR = `${DEFAULT_STATE_ROOT}/harness`;
export const DEFAULT_LOG_DIR = `${DEFAULT_STATE_ROOT}/lh_harness`;
export const DEFAULT_TMP_DIR = `${DEFAULT_STATE_ROOT}/tmp`;

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

// A run is intentionally bounded at every ingress point. Without a shared
// ceiling, a malformed Web/CLI request can reserve an effectively unbounded
// amount of work and disk/event pressure. CLI, config, supervisor and Web
// validation all use this one value.
export const MAX_ROUNDS = 1000;
export const DEFAULT_MAX_ROUNDS = 25;

export const HOMEPAGE = "https://github.com/AMAP-ML/LongHorizon-Harness";
export const ISSUES_URL = `${HOMEPAGE}/issues`;
export const VERSION = "0.1.7";

export type PromptLanguage = "en";

/** The six agent roles of the loop (see loop/prompts/*.md). */
export type RoleName = "prompt_tailor" | "planner" | "rubric" | "composer" | "evaluator" | "final_response";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  termination_reason?: string | null;
};

export class EpisodeBudget {
  max_duration_seconds: number;
  constructor(max_duration_seconds = 1800) {
    if (max_duration_seconds < 1) throw new Error("max_duration_seconds must be at least 1");
    this.max_duration_seconds = max_duration_seconds;
  }
}

export type EpisodeStatus = "done" | "timeout" | "error" | "cancelled";

export type EpisodeResult = {
  status: EpisodeStatus;
  actions_log: string;
  error: string | null;
  duration_ms: number;
  metadata: Record<string, unknown>;
};

export function episodeResult(partial: Partial<EpisodeResult> & { status: EpisodeStatus }): EpisodeResult {
  return {
    status: partial.status,
    actions_log: partial.actions_log ?? "",
    error: partial.error ?? null,
    duration_ms: partial.duration_ms ?? 0,
    metadata: partial.metadata ?? {},
  };
}

export type RoleBudgets = Record<RoleName, EpisodeBudget>;

export type HarnessConfig = {
  /** Maximum composer episodes for the whole run (the "rounds" budget). */
  max_total_episodes: number;
  budgets: RoleBudgets;
  workspace_path: string;
  harness_dir: string;
  log_dir: string;
  /** Operator-provided reference material (rubric examples, standards, briefs). */
  sources_dir: string;
  /** The Karpathy-style memory wiki. */
  memory_dir: string;
  /** Composer↔evaluator rounds per subtask before it is marked blocked. */
  max_eval_rounds: number;
  /** Minimum research subagents the planner/rubric/evaluator must spawn. */
  min_research_agents: number;
  /** Model alias for research subagents ("sonnet" keeps fan-out cheap). */
  research_model: string;
  /** Optional per-episode dollar ceiling (0 = provider default). */
  episode_budget_usd: number;
  prompt_language: PromptLanguage;
  /** "Provisioned external tools" section injected into role prompts ("" = omit). */
  capability_note: string;
  capability_note_read_only: string;
  /** Volatile paths the evaluator snapshot guard skips. */
  guard_exclude_paths: string[];
};

export function defaultRoleBudgets(): RoleBudgets {
  return {
    prompt_tailor: new EpisodeBudget(900),
    planner: new EpisodeBudget(3600),
    rubric: new EpisodeBudget(1800),
    composer: new EpisodeBudget(3600),
    evaluator: new EpisodeBudget(3600),
    final_response: new EpisodeBudget(900),
  };
}

export function harnessConfig(partial: Partial<HarnessConfig> = {}): HarnessConfig {
  const workspace = partial.workspace_path ?? DEFAULT_WORKSPACE_PATH;
  return {
    max_total_episodes: partial.max_total_episodes ?? DEFAULT_MAX_ROUNDS,
    budgets: { ...defaultRoleBudgets(), ...(partial.budgets ?? {}) },
    workspace_path: workspace,
    harness_dir: partial.harness_dir ?? DEFAULT_HARNESS_DIR,
    log_dir: partial.log_dir ?? DEFAULT_LOG_DIR,
    sources_dir: partial.sources_dir ?? path.join(workspace, "sources"),
    memory_dir: partial.memory_dir ?? path.join(workspace, "memory"),
    max_eval_rounds: partial.max_eval_rounds ?? 3,
    min_research_agents: partial.min_research_agents ?? 10,
    research_model: partial.research_model ?? "sonnet",
    episode_budget_usd: partial.episode_budget_usd ?? 0,
    prompt_language: partial.prompt_language ?? "en",
    capability_note: partial.capability_note ?? "",
    capability_note_read_only: partial.capability_note_read_only ?? "",
    guard_exclude_paths: partial.guard_exclude_paths ?? [],
  };
}
