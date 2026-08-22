// Ported 1:1 from LongHorizon-Harness src/lh_harness/webapi/snapshot.py
//
// Project existing DashboardState data into the stable Web snapshot.

import path from "node:path";
// Written by the dashboard/supervisor agent; expected surface:
//   class DashboardState { snapshot(); readEvents({limit}); listApprovals();
//     readReport(); role_dir: string; runsRoot: string|null; log_dir: string;
//     currentRunId: string; control_bus: { readOwner(): Record<string, unknown> } }
import type { DashboardState } from "../dashboard/state.js";
import { canonicalLifecycleStatus } from "../supervisor/lifecycle.js";
import { pyStrip } from "../utils/pystr.js";
import { EventTailer } from "./events.js";

const _PROVENANCE_FIELDS = ["agent", "model", "role_configs", "workspace", "max_rounds", "prompt_language"] as const;
const _MAX_FINAL_RESPONSE_CHARS = 512 * 1024;
// Mirrors agent_registry's rule; owner records are untrusted input here.
const _REASONING_EFFORT_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const NUL = "\u0000";

type Dict = Record<string, unknown>;

function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Select the durable user-facing reply without falling back to audit text. */
function _finalResponse(raw: Dict, report: Dict, rounds: unknown[]): string {
  const candidates: unknown[] = [raw.final_response, report.final_response];
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const item = rounds[index];
    if (isRecord(item)) candidates.push(item.final_response);
  }
  for (const value of candidates) {
    if (typeof value !== "string" || !pyStrip(value)) continue;
    return value.slice(0, _MAX_FINAL_RESPONSE_CHARS);
  }
  return "";
}

/**
 * Select bounded, durable run provenance from newest-authority sources.
 *
 * Supervisor ``owner.json`` is the primary source for managed runs; report
 * and start-event data are useful fallbacks for historical/legacy runs.  The
 * projection deliberately omits malformed or overlong values so an
 * agent-written metadata file cannot inflate a run summary response.
 */
export function _provenance(...sources: (Dict | null | undefined)[]): Dict {
  const result: Dict = {};
  const limits: Record<string, number> = { agent: 64, model: 256, workspace: 4096 };
  for (const field of _PROVENANCE_FIELDS) {
    for (const source of sources) {
      if (!isRecord(source) || !(field in source)) continue;
      const value = source[field];
      if (field === "role_configs") {
        const cleaned = _safeRoleConfigs(value);
        if (Object.keys(cleaned).length) {
          result[field] = cleaned;
          break;
        }
        continue;
      }
      if (field === "max_rounds") {
        if (typeof value === "boolean") continue;
        if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000) {
          result[field] = value;
          break;
        }
        // JSON written by older integrations occasionally encoded an
        // integer as a decimal string. Accept only canonical digits.
        if (typeof value === "string" && /^\d+$/.test(value)) {
          const parsed = Number.parseInt(value, 10);
          if (parsed >= 1 && parsed <= 1_000_000) {
            result[field] = parsed;
            break;
          }
        }
        continue;
      }
      if (field === "prompt_language") {
        if (value === "en" || value === "zh") {
          result[field] = value;
          break;
        }
        continue;
      }
      if ((value === null || value === undefined) && field === "model") {
        // ``None`` is meaningful: the run followed the agent/provider
        // default rather than selecting a custom model.
        result[field] = null;
        break;
      }
      if (typeof value !== "string") continue;
      const text = pyStrip(value);
      if (!text || text.length > limits[field] || text.includes(NUL)) continue;
      result[field] = text;
      break;
    }
  }
  return result;
}

export function _safeRoleConfigs(value: unknown): Record<string, Record<string, string>> {
  if (!isRecord(value)) return {};
  const result: Record<string, Record<string, string>> = {};
  for (const role of ["manager", "executor", "auditor"]) {
    const raw = value[role];
    if (!isRecord(raw)) continue;
    const agent = raw.agent;
    const model = raw.model;
    if (typeof agent !== "string" || !["codex", "claude_code", "deepseek_harness", "opencode"].includes(agent)) continue;
    if (typeof model !== "string" || !pyStrip(model) || pyStrip(model).length > 256 || model.includes(NUL)) continue;
    result[role] = { agent, model: pyStrip(model) };
    const effort = raw.reasoning_effort;
    if (typeof effort === "string" && _REASONING_EFFORT_RE.test(pyStrip(effort))) {
      result[role].reasoning_effort = pyStrip(effort);
    }
  }
  return Object.keys(result).length === 3 ? result : {};
}

export function _status(raw: Dict, events: Dict[], approvals: Dict[]): string {
  const report = isRecord(raw.report) ? raw.report : null;
  const reportStatus = report ? report.status : null;
  if (reportStatus) {
    return canonicalLifecycleStatus(reportStatus);
  }
  if (approvals.some((item) => isRecord(item) && item.status === "pending")) {
    return "waiting_approval";
  }
  const names = new Set(events.map((item) => String((item as Dict).event)));
  if (names.has("role_harness_cancelled")) return "cancelled";
  if (names.has("role_harness_done")) return "completed";
  if (events.length) return "running";
  return "idle";
}

export function buildRunSummary(item: Dict, options: { state?: DashboardState | null } = {}): Dict {
  const state = options.state ?? null;
  const runId = String(item.id || "");
  let status = String(item.status || "");
  let task = String(item.task || "");
  const provenanceSources: (Dict | null)[] = [item];
  if (state !== null && (!status || !task)) {
    const raw = state.snapshot() as Dict;
    if (!status) {
      status = _status(raw, state.readEvents({ limit: 5000 }) as Dict[], state.listApprovals() as Dict[]);
    }
    if (!task) {
      const report = isRecord(raw.report) ? raw.report : {};
      task = String(raw.task || report.task || "");
    }
  }
  if (state !== null && state.runsRoot !== null && state.runsRoot !== undefined) {
    let owner: unknown = {};
    try {
      owner = state.control_bus.readOwner();
    } catch {
      owner = {};
    }
    if (isRecord(owner)) {
      provenanceSources.unshift(owner);
    }
    let report: unknown = {};
    try {
      report = state.readReport();
    } catch {
      report = {};
    }
    provenanceSources.push(isRecord(report) ? report : null);
  }
  const summary: Dict = {
    id: runId,
    task,
    status: status || "unknown",
    updated_at: "mtime" in item ? item.mtime : 0.0,
    log_dir: "log_dir" in item ? item.log_dir : "",
  };
  Object.assign(summary, _provenance(...provenanceSources));
  return summary;
}

export function buildSnapshot(state: DashboardState, options: { run_id?: string | null } = {}): Dict {
  const runId = options.run_id ?? null;
  const raw = state.snapshot() as Dict;
  const effectiveRunId = runId || state.currentRunId || "local";
  // Read the event log through the same tailer used by REST/WS replay.  This
  // keeps event ids absolute when the dashboard snapshot is limited to the
  // last 200 records and isolates malformed records to a diagnostic warning.
  const tailer = new EventTailer(path.join(String(state.role_dir), "events.jsonl"), { run_id: effectiveRunId });
  const envelopes = tailer.read({ limit: 200 });
  const events = envelopes.map((item) => item.toDict());
  const legacyEvents = (Array.isArray(raw.events) ? raw.events : []) as Dict[];
  const approvals = (Array.isArray(raw.approvals) ? raw.approvals : []) as Dict[];
  const operatorMessages = Array.isArray(raw.operator_messages) ? raw.operator_messages : [];
  const rounds = (Array.isArray(raw.rounds) ? raw.rounds : []) as unknown[];
  const status = canonicalLifecycleStatus(_status(raw, legacyEvents, approvals));
  const report = isRecord(raw.report) ? raw.report : {};
  let owner: Dict = {};
  if (state.runsRoot !== null && state.runsRoot !== undefined) {
    try {
      const candidateOwner = state.control_bus.readOwner();
      if (isRecord(candidateOwner)) owner = candidateOwner;
    } catch {
      owner = {};
    }
  }
  // A supervised worker owns the task before its first Manager report exists.
  // Project that durable value immediately so Web does not render an active
  // run as "no task selected" while the first round is still in progress.
  const task = String(raw.task || report.task || owner.task || "");
  const finalResponse = _finalResponse(raw, report, rounds);
  let startPayload: Dict = {};
  for (let index = legacyEvents.length - 1; index >= 0; index -= 1) {
    const event = legacyEvents[index];
    if (!isRecord(event) || event.event !== "role_harness_start") continue;
    if (isRecord(event.payload)) {
      startPayload = event.payload;
    } else {
      startPayload = event;
    }
    // Legacy event records store ``workspace_path`` rather than
    // ``workspace``. Normalize just this safe, bounded field.
    if (!("workspace" in startPayload) && "workspace_path" in startPayload) {
      startPayload = { ...startPayload, workspace: startPayload.workspace_path };
    }
    break;
  }
  const provenance = _provenance(owner, report, startPayload);
  // ``active_*`` means work that can still change, never merely the newest
  // durable round.  A final Manager-only round is often appended after the
  // Auditor has already satisfied the task; falling back to that round made
  // clients render stale roles as active/waiting forever.
  let activeRound: unknown = null;
  if (!["completed", "failed", "cancelled", "blocked", "incomplete"].includes(status)) {
    for (let index = rounds.length - 1; index >= 0; index -= 1) {
      const item = rounds[index];
      if (isRecord(item) && item.in_progress) {
        activeRound = item.round_index ?? null;
        break;
      }
    }
  }
  let activeRole: unknown = null;
  if (activeRound !== null && activeRound !== undefined) {
    for (let index = rounds.length - 1; index >= 0; index -= 1) {
      const item = rounds[index];
      if (isRecord(item) && item.round_index === activeRound && item.active_role) {
        activeRole = item.active_role;
        break;
      }
    }
  }
  let completionSatisfied: unknown = report.completion_satisfied;
  if (typeof completionSatisfied !== "boolean") completionSatisfied = null;
  let completionAuthority: unknown = report.completion_authority;
  if (completionAuthority !== null && completionAuthority !== undefined) {
    completionAuthority = String(completionAuthority);
  } else {
    completionAuthority = null;
  }
  let reportStatus: unknown = report.status;
  if (reportStatus !== null && reportStatus !== undefined) {
    reportStatus = canonicalLifecycleStatus(String(reportStatus));
  } else {
    reportStatus = null;
  }
  let exitCode: unknown = report.exit_code;
  if (typeof exitCode === "boolean" || typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    exitCode = null;
  }
  let failureReason: unknown = report.failure_reason;
  if (failureReason !== null && failureReason !== undefined) {
    failureReason = String(failureReason);
  } else {
    failureReason = null;
  }
  return {
    schema_version: 1,
    run: {
      id: effectiveRunId,
      status: canonicalLifecycleStatus(status),
      started_at: report.started_at ?? null,
      finished_at: report.finished_at ?? null,
      log_dir: "log_dir" in raw ? raw.log_dir : "",
      completion_satisfied: completionSatisfied,
      completion_authority: completionAuthority,
      report_status: reportStatus,
      exit_code: exitCode,
      failure_reason: failureReason,
      final_response: finalResponse,
      ...provenance,
    },
    mission: {
      task,
      contract_path: "task_contract.txt",
      plan_path: "manager_plan.txt",
      verified_state_path: "task_state.txt",
      report_path: "report.json",
    },
    rounds,
    active_round: activeRound ?? null,
    active_role: activeRole ?? null,
    events,
    approvals,
    operator_messages: operatorMessages,
    controls: {
      can_inject: Boolean(raw.control_enabled),
      // Approval/instruction control can attach directly to a worker,
      // while lifecycle signals require a RunSupervisor-owned process.
      // Supervised snapshots overlay this value in the API server.
      can_abort: false,
      can_resume: false,
    },
    diagnostics: {
      last_event_id: events.length ? events[events.length - 1].event_id : null,
      event_count: events.length,
      warnings: tailer.last_warnings,
      cursor_gap: false,
      resync_required: false,
    },
    legacy: raw,
  };
}
