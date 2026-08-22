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
  // Directory lh-harness was started from, captured once at import. Symlinks
  // stay resolved so this agrees with the run paths derived from it.
  try {
    return process.cwd();
  } catch {
    return process.env.PWD || ".";
  }
}

// Harness bookkeeping is user-scoped; the agents work in the directory
// lh-harness was started from, so a task acts on the caller's real project.
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

export type RoleNextStep = "gui" | "cli" | "done" | "blocked" | "invalid" | "ask";
export type PromptLanguage = "en";

export type RoleName =
  | "manager"
  | "gui_executor"
  | "cli_executor"
  | "gui_auditor"
  | "cli_auditor"
  | "auditor_format_repair"
  | "final_response";

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

export type AuditStatus = "complete" | "incomplete" | "blocked";
export type IntegrityStatus = "clean" | "suspect" | "violation";
export type ContractAuditStatus = "aligned" | "unknown" | "needs_revision" | "invalid";

export type AuditReport = {
  round_id: string;
  status: AuditStatus;
  report_text: string;
  state_summary: string;
  completed: Record<string, string>[];
  missing: Record<string, unknown>[];
  blockers: Record<string, string>[];
  action_guidance: string;
  raw_commands: Record<string, string>[];
  integrity_status: IntegrityStatus;
  contract_audit_status: ContractAuditStatus;
  integrity_findings: Record<string, unknown>[];
  artifact_actions: Record<string, unknown>[];
};

export function auditReport(partial: Partial<AuditReport> & { round_id: string; status: AuditStatus }): AuditReport {
  return {
    round_id: partial.round_id,
    status: partial.status,
    report_text: partial.report_text ?? "",
    state_summary: partial.state_summary ?? "",
    completed: partial.completed ?? [],
    missing: partial.missing ?? [],
    blockers: partial.blockers ?? [],
    action_guidance: partial.action_guidance ?? "",
    raw_commands: partial.raw_commands ?? [],
    integrity_status: partial.integrity_status ?? "clean",
    contract_audit_status: partial.contract_audit_status ?? "unknown",
    integrity_findings: partial.integrity_findings ?? [],
    artifact_actions: partial.artifact_actions ?? [],
  };
}

export type ManagedRound = {
  round_index: number;
  next_step: RoleNextStep;
  plan_text: string;
  executor_output: string;
  auditor_report: string;
  harness_feedback: string;
  task_state: string;
  task_contract: string;
  related_report_refs: string[];
  manager_status: Record<string, unknown>;
  executor_status: Record<string, unknown>;
  auditor_status: Record<string, unknown>;
};

export function managedRound(
  partial: Partial<ManagedRound> & { round_index: number; next_step: RoleNextStep; plan_text: string },
): ManagedRound {
  return {
    round_index: partial.round_index,
    next_step: partial.next_step,
    plan_text: partial.plan_text,
    executor_output: partial.executor_output ?? "",
    auditor_report: partial.auditor_report ?? "",
    harness_feedback: partial.harness_feedback ?? "",
    task_state: partial.task_state ?? "",
    task_contract: partial.task_contract ?? "",
    related_report_refs: partial.related_report_refs ?? [],
    manager_status: partial.manager_status ?? {},
    executor_status: partial.executor_status ?? {},
    auditor_status: partial.auditor_status ?? {},
  };
}

export type HarnessConfig = {
  max_total_episodes: number;
  manager_budget: EpisodeBudget;
  gui_executor_budget: EpisodeBudget;
  cli_executor_budget: EpisodeBudget;
  auditor_budget: EpisodeBudget;
  workspace_path: string;
  harness_dir: string;
  log_dir: string;
  auditor_output_chars: number;
  role_verified_context_chars: number;
  role_history_chars: number;
  // English-only: the upstream Chinese prompt catalog was removed.
  prompt_language: PromptLanguage;
};

export function harnessConfig(partial: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    max_total_episodes: partial.max_total_episodes ?? 4,
    manager_budget: partial.manager_budget ?? new EpisodeBudget(900),
    gui_executor_budget: partial.gui_executor_budget ?? new EpisodeBudget(),
    cli_executor_budget: partial.cli_executor_budget ?? new EpisodeBudget(),
    auditor_budget: partial.auditor_budget ?? new EpisodeBudget(900),
    workspace_path: partial.workspace_path ?? DEFAULT_WORKSPACE_PATH,
    harness_dir: partial.harness_dir ?? DEFAULT_HARNESS_DIR,
    log_dir: partial.log_dir ?? DEFAULT_LOG_DIR,
    auditor_output_chars: partial.auditor_output_chars ?? 24_000,
    role_verified_context_chars: partial.role_verified_context_chars ?? 60_000,
    role_history_chars: partial.role_history_chars ?? 100_000,
    prompt_language: partial.prompt_language ?? "en",
  };
}

export function auditReportToDict(report: AuditReport): Record<string, unknown> {
  return { ...report };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceMissingValue(key: string, value: unknown): unknown {
  if (key === "actionable") return Boolean(value);
  if (["string", "number", "boolean"].includes(typeof value) || value === null || value === undefined) return value ?? null;
  return String(value);
}

function coerceRecordValue(value: unknown): unknown {
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[String(k)] = coerceRecordValue(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(coerceRecordValue);
  if (["string", "number", "boolean"].includes(typeof value) || value === null || value === undefined) return value ?? null;
  return String(value);
}

function strRecords(items: unknown): Record<string, string>[] {
  if (!Array.isArray(items)) return [];
  return items.filter(isPlainObject).map((item) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(item)) out[String(k)] = String(v);
    return out;
  });
}

export function auditReportFromDict(data: Record<string, unknown>): AuditReport {
  let status = data.status as AuditStatus;
  if (!["complete", "incomplete", "blocked"].includes(String(status))) status = "incomplete";
  let integrity = data.integrity_status as IntegrityStatus;
  if (!["clean", "suspect", "violation"].includes(String(integrity))) integrity = "clean";
  const contract = ["aligned", "unknown", "needs_revision", "invalid"].includes(String(data.contract_audit_status))
    ? (data.contract_audit_status as ContractAuditStatus)
    : "unknown";
  const missing = Array.isArray(data.missing)
    ? (data.missing as unknown[]).filter(isPlainObject).map((item) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(item)) out[String(k)] = coerceMissingValue(String(k), v);
        return out;
      })
    : [];
  const records = (items: unknown): Record<string, unknown>[] =>
    Array.isArray(items)
      ? (items as unknown[]).filter(isPlainObject).map((item) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(item)) out[String(k)] = coerceRecordValue(v);
          return out;
        })
      : [];
  return {
    round_id: String(data.round_id || ""),
    status,
    report_text: String(data.report_text || data.report || ""),
    state_summary: String(data.state_summary || ""),
    completed: strRecords(data.completed),
    missing,
    blockers: strRecords(data.blockers),
    action_guidance: String(data.action_guidance || ""),
    raw_commands: strRecords(data.raw_commands),
    integrity_status: integrity,
    contract_audit_status: contract,
    integrity_findings: records(data.integrity_findings),
    artifact_actions: records(data.artifact_actions),
  };
}
