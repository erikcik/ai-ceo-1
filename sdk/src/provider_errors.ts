// Ported 1:1 from LongHorizon-Harness src/lh_harness/provider_errors.py
//
// Classify terminal agent-CLI failures into operator-facing reasons.
import { hardSignalLabels } from "./runtime_signals.js";
// runtime_signals.ts (owned by the core-runtime task) must export:
//   export function hardSignalLabels(raw: unknown): string[]
import type { EpisodeResult } from "./types.js";

// The exact sentence the Claude Code adapter appends when the read-only guard
// rejects an audit fail-closed. The classifier strips it from failure evidence
// so a guard-only rejection stays a round-level problem while any coexisting
// provider failure keeps its terminal classification.
export const GUARD_REJECTION_MESSAGE =
  "Auditor workspace read-only guard could not inspect every path; " +
  "the audit was rejected fail-closed.";

export type AgentRuntimeFailure = {
  kind: string;
  abort_reason: string;
  message: string;
  user_message: string;
};

const _CLASSIFIERS: readonly (readonly [string, RegExp, string])[] = [
  [
    "model_unavailable",
    new RegExp(
      "(?:model.{0,80}(?:not supported|unsupported|not found|does not exist|unavailable|invalid|not available|access denied|no access)|" +
        "(?:not supported|unsupported|not found|does not exist|unavailable|invalid).{0,80}model)",
      "is",
    ),
    "Model unavailable",
  ],
  [
    "authentication",
    new RegExp(
      "(?:\\b401\\b|unauthori[sz]ed|not logged in|login required|authentication (?:failed|required)|" +
        "invalid (?:api[ _-]?key|auth|token)|missing (?:api[ _-]?key|auth|token)|oauth.{0,40}(?:expired|invalid))",
      "is",
    ),
    "Provider login or credentials invalid",
  ],
  [
    "quota",
    new RegExp(
      "(?:insufficient[_ -]?quota|quota exceeded|credit balance|billing.{0,40}(?:required|disabled|limit)|" +
        "spend limit|usage limit)",
      "is",
    ),
    "Provider quota or billing limit",
  ],
  [
    "rate_limit",
    new RegExp("(?:\\b429\\b|rate[ _-]?limit|too many requests|overloaded)", "i"),
    "Provider rate-limited or overloaded",
  ],
  [
    "network",
    new RegExp(
      "(?:connection (?:error|failed|reset|closed)|stream disconnected|network (?:error|unreachable)|" +
        "timed? out|dns|name resolution|tls|certificate)",
      "i",
    ),
    "Provider network connection failed",
  ],
];

/**
 * Return a failure only when the agent runtime itself failed.
 *
 * Tool commands run by an otherwise healthy Executor may fail as part of the
 * task and must remain auditable task evidence. We therefore require a
 * non-success episode status or a normalized hard runtime signal. Local
 * episode timeouts are classified separately so the manager can recover;
 * genuine provider failures remain terminal at the caller.
 */
export function classifyAgentRuntimeFailure(result: EpisodeResult): AgentRuntimeFailure | null {
  const metadata = isObject(result.metadata) ? result.metadata : {};
  const hardSignals = hardSignalLabels(metadata.runtime_signals);
  if (result.status !== "error" && result.status !== "timeout" && !hardSignals.length) return null;
  let candidates = _failureMessages(result, metadata);
  const guardRejected = Boolean(truthy(metadata.verifier_workspace_snapshot_errors));
  if (guardRejected) {
    // The guard's fail-closed rejection sentence is local bookkeeping, not
    // provider evidence; classify only what remains so a coexisting
    // authentication/network/quota failure keeps its terminal kind.
    candidates = _stripGuardRejection(candidates);
  }
  const combined = candidates.join("\n");
  let kind = result.status === "timeout" ? "timeout" : "provider_error";
  let label = kind === "timeout" ? "Agent execution timed out" : "Agent provider failed to start or run";
  // A command episode that reaches its harness budget is a local timeout, not
  // evidence that the provider connection failed. In particular, the adapter's
  // own "Episode timed out after ..." message matches the generic network
  // classifier below. Keep the explicit status authoritative so the manager can
  // recover from the real workspace in a later round.
  let matchedProviderKind = false;
  if (result.status !== "timeout") {
    for (const [candidateKind, pattern, candidateLabel] of _CLASSIFIERS) {
      if (pattern.test(combined)) {
        kind = candidateKind;
        label = candidateLabel;
        matchedProviderKind = true;
        break;
      }
    }
  }
  // Downgrade to a round-level failure only when the failure is proven to be
  // caused solely by the snapshot guard: the guard rejected the audit, nothing
  // matched a provider classifier, no hard runtime signal fired, the episode did
  // not time out, and the episode's own failure channels (actions log, error
  // field) carry nothing beyond the guard rejection. The audit is already
  // rejected fail-closed by the adapter, so the round fails and is retried
  // instead of the whole run aborting over a transient filesystem race, e.g. a
  // build directory churning underneath the walk.
  if (
    guardRejected &&
    !matchedProviderKind &&
    !hardSignals.length &&
    result.status !== "timeout" &&
    !_nonGuardFailureEvidence(result)
  ) {
    return null;
  }
  let message = candidates.find((item) => _specificMessage(item));
  if (message === undefined) message = candidates.length ? candidates[0] : "agent runtime failed";
  message = _clean(message, 1200);
  return {
    kind,
    abort_reason: `provider_${kind}`,
    message,
    user_message: `${label}: ${message}`,
  };
}

/** Alias kept for callers that read the classifier as a provider-failure gate. */
export const classifyProviderFailure = classifyAgentRuntimeFailure;

/** Remove the guard's own rejection sentence, keeping any other evidence. */
function _stripGuardRejection(candidates: string[]): string[] {
  const stripped: string[] = [];
  for (const item of candidates) {
    let text = item.split(GUARD_REJECTION_MESSAGE).join(" ");
    text = collapse(text);
    if (text && !stripped.includes(text)) stripped.push(text);
  }
  return stripped;
}

/**
 * True when the episode's failure channels carry more than the guard.
 *
 * Looks only at channels that are silent on a successful episode (failure
 * records in the actions log and the episode error field), so stderr noise from
 * a healthy run cannot escalate a guard-only rejection back into a terminal
 * provider failure.
 */
function _nonGuardFailureEvidence(result: EpisodeResult): boolean {
  const values: unknown[] = [];
  for (const record of _jsonRecords(result.actions_log)) {
    const recordType = String(record.type ?? "");
    if (recordType === "turn.failed") {
      const error = record.error;
      _append(values, isObject(error) ? error.message : error);
    } else if (recordType === "error") {
      _append(values, record.message || record.error);
    } else if (recordType === "result" && record.is_error) {
      _append(values, record.result || record.error || record.subtype);
    }
  }
  _append(values, result.error);
  for (const value of values) {
    const text = _clean(value, 2000).split(GUARD_REJECTION_MESSAGE).join(" ").trim();
    if (text) return true;
  }
  return false;
}

function _failureMessages(result: EpisodeResult, metadata: Record<string, unknown>): string[] {
  const values: unknown[] = [];
  for (const record of _jsonRecords(result.actions_log)) {
    const recordType = String(record.type ?? "");
    if (recordType === "turn.failed") {
      const error = record.error;
      _append(values, isObject(error) ? error.message : error);
    } else if (recordType === "error") {
      _append(values, record.message || record.error);
    } else if (recordType === "result" && record.is_error) {
      _append(values, record.result || record.error || record.subtype);
    }
  }
  _append(values, result.error);
  _append(values, metadata.stderr_tail);
  const signals = metadata.runtime_signals;
  if (Array.isArray(signals)) {
    for (const item of signals) {
      if (isObject(item)) _append(values, item.evidence || item.signal);
      else _append(values, item);
    }
  }
  const deduped: string[] = [];
  for (const value of values) {
    const cleaned = _clean(value, 2000);
    if (cleaned && !deduped.includes(cleaned)) deduped.push(cleaned);
  }
  return deduped;
}

function* _jsonRecords(raw: unknown): Generator<Record<string, unknown>> {
  for (const line of splitLines(String(raw ?? ""))) {
    if (!line.replace(/^\s+/, "").startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(value)) yield value;
  }
}

function _append(target: unknown[], value: unknown): void {
  const message = _unwrapProviderMessage(value);
  if (message) target.push(message);
}

/** Extract the useful sentence from provider errors wrapped as JSON strings. */
function _unwrapProviderMessage(value: unknown, depth = 0): string {
  if (depth >= 5 || value === null || value === undefined) return "";
  if (isObject(value)) {
    // Providers wrap the readable sentence in different keys: OpenAI/Claude use
    // {"error": {"message": ...}}, OpenCode uses {"name": ..., "data":
    // {"message": ...}}, FastAPI uses {"detail": ...}.
    for (const key of ["message", "detail", "data", "error"]) {
      if (key in value) {
        const message = _unwrapProviderMessage(value[key], depth + 1);
        if (message) return message;
      }
    }
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = _unwrapProviderMessage(item, depth + 1);
      if (message) return message;
    }
    return "";
  }
  if (typeof value !== "string") return pyStr(value).trim();

  const text = value.trim();
  const head = text.slice(0, 1);
  if (head === "{" || head === "[") {
    let decoded: unknown;
    let ok = true;
    try {
      decoded = JSON.parse(text);
    } catch {
      ok = false;
    }
    if (ok) {
      const message = _unwrapProviderMessage(decoded, depth + 1);
      if (message) return message;
    }
  }
  return text;
}

function _specificMessage(value: string): boolean {
  const text = value.trim();
  return Boolean(text) && !["AGENT_TURN_FAILED", "response.failed", "Connection error."].includes(text);
}

const _SECRET_VALUE =
  /(\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)\s*[=:]\s*)\S+/gi;

function _clean(value: unknown, limit: number): string {
  let text = collapse(_unwrapProviderMessage(value));
  text = text.replace(_SECRET_VALUE, "$1***REDACTED***");
  return text.slice(0, limit);
}

/** Python's `" ".join(text.split())`. */
function collapse(text: string): string {
  const parts = text.split(/\s+/).filter((part) => part !== "");
  return parts.join(" ");
}

/** Python's `str.splitlines()` for the line kinds a JSONL log can carry. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function pyStr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
