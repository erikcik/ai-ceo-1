// Ported 1:1 from LongHorizon-Harness src/lh_harness/supervisor/lifecycle.py
//
// Shared lifecycle vocabulary for supervised runs.
//
// The manager's report is an *audit result* (and historically used ``complete``),
// whereas the supervisor is responsible for the process lifecycle.  Keeping the
// normalisation in one tiny module prevents each API surface from inventing a
// slightly different set of terminal states.
//
// ``_merge_lifecycle_status`` lives in service.py upstream; it is hosted here so
// every consumer of the status vocabulary gets the monotonic merge with it.

import { pyStrip } from "../utils/pystr.js";

// ``completed`` is the public spelling of the successful process lifecycle;
// ``complete`` remains accepted as an input for old reports and clients.
export const STATUS_ALIASES: Record<string, string> = {
  complete: "completed",
  done: "completed",
  success: "completed",
  succeeded: "completed",
  finished: "completed",
  canceled: "cancelled",
};

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  // These two are manager/auditor outcomes.  They are terminal from the
  // supervisor's point of view and may be retried/resumed.
  "blocked",
  "incomplete",
]);

// ``creating`` is written before the worker is spawned.  It belongs here so a
// run that died inside the launch transaction is reconciled as an interrupted
// active run instead of lingering in a state that is neither active nor
// terminal (which left it unresumable and spinning in the UI).
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "creating",
  "starting",
  "running",
  "waiting_approval",
  "stopping",
]);

// One resume reopens a terminal run in place.  Command ids are scoped by epoch so
// a previous epoch's `lifecycle-stop` receipt cannot make the next epoch's stop
// look already-delivered.
export const RESUME_EPOCH_KEY = "resume_epoch";
export const MAX_RESUME_EPOCH = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the resume generation from an owner/status record, defaulting to 0. */
export function resumeEpoch(record: unknown): number {
  if (!isRecord(record)) return 0;
  const value = record[RESUME_EPOCH_KEY];
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return Math.min(value, MAX_RESUME_EPOCH);
}

/**
 * Return the stable public spelling for a lifecycle status.
 *
 * Unknown values are deliberately preserved (rather than guessed as
 * ``completed``); this makes malformed or future states visible to clients.
 * Empty/non-string values use ``default``.
 */
export function canonicalLifecycleStatus(value: unknown, defaultValue = "idle"): string {
  if (value === null || value === undefined) return defaultValue;
  const text = pyStrip(String(value)).toLowerCase().split(" ").join("_");
  if (!text) return defaultValue;
  return STATUS_ALIASES[text] ?? text;
}

export function isTerminalStatus(value: unknown): boolean {
  return TERMINAL_STATUSES.has(canonicalLifecycleStatus(value));
}

export function isActiveStatus(value: unknown): boolean {
  return ACTIVE_STATUSES.has(canonicalLifecycleStatus(value));
}

/**
 * Merge a process observation without regressing a newer decision.
 *
 * Supervisor instances may coexist briefly during a restart, and HTTP
 * status polling can race a stop/abort request.  Atomic JSON replacement
 * prevents torn reads, but a stale poll could still overwrite ``stopping``
 * (or a terminal result) with ``running``.  This merge runs under the
 * ControlBus process lock and makes those lifecycle decisions monotonic.
 */
export function mergeLifecycleStatus(
  current: Record<string, unknown>,
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...candidate };
  const currentLifecycle = canonicalLifecycleStatus(current.status, "");
  const candidateLifecycle = canonicalLifecycleStatus(candidate.status, "");
  const currentAction = pyStrip(String(current.requested_action ?? "")).toLowerCase();

  if (resumeEpoch(candidate) > resumeEpoch(current)) {
    // A resume is the one legitimate way out of a terminal state.  The
    // monotonic guards below exist to stop *stale* observations from
    // regressing a newer decision; a higher epoch is by definition newer,
    // so it supersedes the previous generation's terminal record and its
    // stop/abort intent (which belonged to the run we just reopened).
    for (const field of [
      "requested_action",
      "stop_requested_at",
      "abort_requested_at",
      "finished_at",
      "failure_reason",
      "exit_code",
    ]) {
      delete merged[field];
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (value !== null && value !== undefined) merged[key] = value;
    }
    return merged;
  }

  if (TERMINAL_STATUSES.has(currentLifecycle)) {
    merged.status = currentLifecycle;
    merged.alive = false;
    if (current.finished_at !== null && current.finished_at !== undefined) {
      merged.finished_at = current.finished_at;
    }
    return merged;
  }

  if (currentAction === "stop" || currentAction === "abort" || currentAction === "cancel") {
    merged.requested_action = currentAction;
    for (const field of ["stop_requested_at", "abort_requested_at"]) {
      if (current[field] !== null && current[field] !== undefined) merged[field] = current[field];
    }
  }

  if (
    currentLifecycle === "stopping" ||
    currentAction === "stop" ||
    currentAction === "abort" ||
    currentAction === "cancel"
  ) {
    if (TERMINAL_STATUSES.has(candidateLifecycle)) {
      // The operator action has the same precedence here as it has in
      // _terminal_status_for_exit().  This covers the race where a poll
      // observed the exit just before it saw the persisted stop request.
      merged.status = "cancelled";
      delete merged.failure_reason;
    } else {
      merged.status = "stopping";
    }
    return merged;
  }

  // A stale poll can also report ``starting``/``idle`` after another
  // supervisor has observed the first event and advanced the run.  Preserve
  // forward progress for active states while still allowing a real
  // waiting_approval <-> running transition at the same phase.
  const activeRank: Record<string, number> = {
    idle: 0,
    creating: 0,
    starting: 1,
    running: 2,
    waiting_approval: 2,
  };
  if (
    currentLifecycle in activeRank &&
    candidateLifecycle in activeRank &&
    activeRank[candidateLifecycle] < activeRank[currentLifecycle]
  ) {
    merged.status = currentLifecycle;
  }

  return merged;
}
