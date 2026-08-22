// Ported 1:1 from LongHorizon-Harness src/lh_harness/webapi/events.py
//
// Normalize LongHorizon JSONL events and provide replay-safe tailing.

import fs from "node:fs";
import { EventEnvelope } from "./models.js";
// Written by the supervisor agent; expected signature:
//   openNofollow(path: string, options?: { directory?: boolean }): number
import { openNofollow } from "../supervisor/control_bus.js";

/**
 * Raised when a JSONL record cannot be represented by the public schema.
 *
 * A single corrupt line must never take down the live dashboard.  The
 * tailer catches this exception, records a diagnostic, and continues with
 * the remaining records.
 */
export class EventNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventNormalizationError";
  }
}

export const EVENT_TYPE_MAP: Record<string, string> = {
  role_harness_start: "run.started",
  manager_round_start: "round.manager.started",
  manager_round_done: "round.manager.completed",
  executor_role_start: "round.executor.started",
  executor_role_done: "round.executor.completed",
  auditor_role_start: "round.auditor.started",
  auditor_role_done: "round.auditor.completed",
  auditor_format_repair_start: "round.audit_repair.started",
  auditor_format_repair_done: "round.audit_repair.completed",
  final_response_start: "round.final_response.started",
  final_response_done: "round.final_response.completed",
  final_response_discarded: "round.final_response.discarded",
  managed_round_recorded: "round.recorded",
  role_harness_done: "run.completed",
  role_harness_cancelled: "run.cancelled",
  role_harness_failed: "run.failed",
  approval_created: "operator.approval.pending",
  approval_resolved: "operator.approval.resolved",
  instruction_queued: "operator.instruction.queued",
  instruction_applied: "operator.instruction.applied",
};

const _ROUND_KEYS = ["round", "round_index", "round_no", "round_number"] as const;
const _ROLE_KEYS = ["role", "role_name", "agent_role"] as const;

// Event logs are worker-produced input.  A dashboard poll must remain bounded
// even if a worker (or a local process with access to its run directory) writes
// an unexpectedly large JSONL file.  Explicit event ids make retaining a byte
// tail safe: a cursor that fell outside the retained window is reported as a
// resync gap instead of causing an unbounded historical scan.
export const _MAX_EVENT_LOG_BYTES = 8 * 1024 * 1024;
export const _MAX_EVENT_LINE_BYTES = 512 * 1024;
export const _MAX_EVENT_RECORDS = 20_000;

// Mutable bounds so tests can shrink the retention window (the Python tests
// monkeypatch the module-level constants).
const BOUNDS = {
  maxLogBytes: _MAX_EVENT_LOG_BYTES,
  maxLineBytes: _MAX_EVENT_LINE_BYTES,
  maxRecords: _MAX_EVENT_RECORDS,
};

/** Test seam mirroring `monkeypatch.setattr(events_module, "_MAX_...", n)`. */
export function _setEventBoundsForTests(next: Partial<typeof BOUNDS>): typeof BOUNDS {
  const previous = { ...BOUNDS };
  Object.assign(BOUNDS, next);
  return previous;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python ``str(value)`` for the scalar shapes that reach these records. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** Python ``repr()`` of a string, used verbatim inside diagnostics. */
function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === "\\") out += "\\\\";
    else if (char === quote) out += `\\${quote}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return `${quote}${out}${quote}`;
}

function _asInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) return null;
    return Number.parseInt(text, 10);
  }
  return null;
}

export function _eventType(name: string): string {
  if (name in EVENT_TYPE_MAP) return EVENT_TYPE_MAP[name];
  if (name.endsWith("_start")) return `${name.slice(0, -"_start".length).replaceAll("_", ".")}.started`;
  if (name.endsWith("_done")) return `${name.slice(0, -"_done".length).replaceAll("_", ".")}.completed`;
  if (name.endsWith("_cancelled")) return `${name.slice(0, -"_cancelled".length).replaceAll("_", ".")}.cancelled`;
  return name.replaceAll("_", ".");
}

export function _statusFor(eventType: string, rawName: string): string | null {
  if (eventType.endsWith(".started")) return "running";
  if (eventType.endsWith(".completed") || rawName.endsWith("_done")) return "completed";
  if (eventType.endsWith(".cancelled")) return "cancelled";
  if (eventType.endsWith(".failed")) return "failed";
  if (eventType.endsWith(".pending")) return "pending";
  if (eventType.endsWith(".resolved") || eventType.endsWith(".applied")) return "completed";
  return null;
}

const RESERVED_KEYS = new Set([
  "schema_version",
  "event_id",
  "type",
  "event",
  "ts",
  "timestamp",
  "run_id",
  "round",
  "round_index",
  "round_no",
  "round_number",
  "role",
  "role_name",
  "agent_role",
  "status",
]);

/** Convert a legacy Manager event into the versioned public envelope. */
export function normalizeEvent(
  record: Record<string, unknown>,
  options: { run_id: string; sequence: number; offset?: number | null; fallback_event_id?: string | null },
): EventEnvelope {
  const runId = options.run_id;
  const sequence = options.sequence;
  const offset = options.offset ?? null;
  const fallbackEventId = options.fallback_event_id ?? null;

  if (!isRecord(record)) {
    throw new EventNormalizationError("event record is not an object");
  }
  const rawSchema = "schema_version" in record ? record.schema_version : 1;
  // Do not coerce arbitrary values (for example ``"bad"``) into a valid
  // protocol version.  It is safer to skip the record and ask the client to
  // resynchronise than to publish a fabricated event.
  if (typeof rawSchema === "boolean" || !(typeof rawSchema === "number" || typeof rawSchema === "string")) {
    throw new EventNormalizationError("schema_version is not numeric");
  }
  let schemaVersion: number;
  if (typeof rawSchema === "number") {
    if (!Number.isFinite(rawSchema)) {
      throw new EventNormalizationError("schema_version is not numeric");
    }
    schemaVersion = Math.trunc(rawSchema);
    if (rawSchema !== schemaVersion) {
      throw new EventNormalizationError("schema_version must be an integer");
    }
  } else {
    const text = rawSchema.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      throw new EventNormalizationError("schema_version is not numeric");
    }
    schemaVersion = Number.parseInt(text, 10);
    if (text !== String(schemaVersion)) {
      throw new EventNormalizationError("schema_version must be an integer");
    }
  }
  if (schemaVersion < 1 || schemaVersion > 2) {
    throw new EventNormalizationError(`unsupported schema_version: ${schemaVersion}`);
  }

  const rawName = pyStr(record.event || record.type || "unknown");
  const eventType = pyStr(record.type || _eventType(rawName));

  // ``events.jsonl`` is produced by a worker and is therefore an untrusted
  // input at the Web/API boundary.  Never let a record identify itself as a
  // different run: doing so would make a run's REST/WS stream a cross-run
  // event oracle, and a foreign terminal event could alter the projection
  // shown to an operator.  Missing run ids remain valid for legacy logs.
  const rawRunId = record.run_id;
  if (rawRunId !== null && rawRunId !== undefined) {
    if (typeof rawRunId !== "string" || rawRunId !== runId) {
      throw new EventNormalizationError("event run_id does not match the requested run");
    }
  }

  const rawEventId = record.event_id;
  let eventId: string;
  if (rawEventId === null || rawEventId === undefined || rawEventId === "") {
    eventId = fallbackEventId || `${runId}:${String(sequence).padStart(6, "0")}`;
  } else {
    if (typeof rawEventId !== "string") {
      throw new EventNormalizationError("event_id must be a string");
    }
    // Keep ids bounded before they are copied into snapshots/cursors.  A
    // valid id is still allowed to use a non-numeric suffix for backwards
    // compatibility, but it must be scoped to this run.
    if (rawEventId.length > 256) {
      throw new EventNormalizationError("event_id is too long");
    }
    if (!rawEventId.startsWith(`${runId}:`)) {
      throw new EventNormalizationError("event_id does not belong to the requested run");
    }
    eventId = rawEventId;
  }
  const tsRaw = "ts" in record ? record.ts : "timestamp" in record ? record.timestamp : 0.0;
  let ts = Number(tsRaw as never);
  if (typeof tsRaw === "object" || tsRaw === null || tsRaw === undefined || Number.isNaN(ts)) {
    ts = 0.0;
  }

  let roundNumber: number | null = null;
  for (const key of _ROUND_KEYS) {
    const value = record[key];
    if (value !== null && value !== undefined) {
      roundNumber = _asInt(value);
      break;
    }
  }
  let role: string | null = null;
  for (const key of _ROLE_KEYS) {
    const value = record[key];
    if (value !== null && value !== undefined) {
      role = pyStr(value);
      break;
    }
  }
  if (role === null) {
    for (const candidate of [
      "manager",
      "executor_gui",
      "executor_cli",
      "executor",
      "auditor_format_repair",
      "auditor",
      "final_response",
    ]) {
      if (`.${eventType}.`.includes(`.${candidate}.`) || eventType.startsWith(`${candidate}.`)) {
        role = candidate;
        break;
      }
    }
  }
  const rawStatus = record.status;
  const legacyEpisodeStatus = isRecord(rawStatus) ? rawStatus : null;
  let status: string | null;
  if (legacyEpisodeStatus !== null) {
    // Older Manager builds wrote the complete episode diagnostic object into
    // the event-level ``status`` field.  Keep that diagnostic available to
    // clients, but derive the public lifecycle status from the event type so
    // consumers never receive Python/JSON object repr strings as statuses.
    status = _statusFor(eventType, rawName);
    if (status === null) {
      const nestedStatus = legacyEpisodeStatus.status;
      status =
        nestedStatus !== null && nestedStatus !== undefined && !isRecord(nestedStatus) && !Array.isArray(nestedStatus)
          ? pyStr(nestedStatus)
          : null;
    }
  } else {
    status = rawStatus !== null && rawStatus !== undefined ? pyStr(rawStatus) : _statusFor(eventType, rawName);
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RESERVED_KEYS.has(key)) payload[key] = value;
  }
  if (legacyEpisodeStatus !== null && !("episode_status" in payload)) {
    payload.episode_status = legacyEpisodeStatus;
  }
  const legacy: Record<string, unknown> = { event: rawName };
  if ("event_id" in record) {
    legacy.event_id = record.event_id;
  }
  return new EventEnvelope({
    schema_version: schemaVersion,
    event_id: eventId,
    type: eventType,
    ts,
    run_id: runId,
    round: roundNumber,
    role,
    status,
    payload,
    legacy,
    offset,
  });
}

const WHITESPACE_BYTES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

/** ``bytes.strip()`` — ASCII whitespace only, exactly like CPython. */
function stripBytes(line: Buffer): Buffer {
  let start = 0;
  let end = line.length;
  while (start < end && WHITESPACE_BYTES.has(line[start])) start += 1;
  while (end > start && WHITESPACE_BYTES.has(line[end - 1])) end -= 1;
  return line.subarray(start, end);
}

/** ``bytes.splitlines(keepends=True)`` — splits on \n, \r and \r\n. */
function splitLinesKeepEnds(raw: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  let index = 0;
  while (index < raw.length) {
    const byte = raw[index];
    if (byte === 0x0a) {
      lines.push(raw.subarray(start, index + 1));
      index += 1;
      start = index;
    } else if (byte === 0x0d) {
      const end = index + 1 < raw.length && raw[index + 1] === 0x0a ? index + 2 : index + 1;
      lines.push(raw.subarray(start, end));
      index = end;
      start = index;
    } else {
      index += 1;
    }
  }
  if (start < raw.length) lines.push(raw.subarray(start));
  return lines;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Read complete JSONL records while safely ignoring an incomplete tail. */
export class EventTailer {
  path: string;
  run_id: string;
  last_cursor_gap = false;
  last_resync_required = false;
  last_warnings: string[] = [];
  last_first_event_id: string | null = null;
  last_last_event_id: string | null = null;

  constructor(path: string, options: { run_id?: string } = {}) {
    this.path = path;
    // Diagnostics describe the most recent read.  They are deliberately
    // kept out of the event stream so a bad line cannot poison consumers.
    this.run_id = options.run_id || "local";
  }

  read(options: { limit?: number; after?: string | null } = {}): EventEnvelope[] {
    const limit = options.limit ?? 500;
    const after = options.after ?? null;
    this.last_cursor_gap = false;
    this.last_resync_required = false;
    this.last_warnings = [];
    this.last_first_event_id = null;
    this.last_last_event_id = null;
    let raw: Buffer = Buffer.alloc(0);
    let baseOffset = 0;
    let headTruncated = false;
    try {
      [raw, baseOffset, headTruncated] = this._readBounded();
    } catch {
      if (after) {
        this.last_cursor_gap = true;
        this.last_resync_required = true;
        this.last_warnings.push("event log is unavailable; a full resync is required");
      }
      return [];
    }
    if (headTruncated) {
      this.last_warnings.push(
        `event log exceeds ${BOUNDS.maxLogBytes} bytes; replay is limited to the retained tail`,
      );
    }
    const records: EventEnvelope[] = [];
    let head = 0;
    const seenEventIds = new Set<string>();
    let recordsTruncated = false;
    let offset = baseOffset;
    let sequence = 0;
    for (const line of splitLinesKeepEnds(raw)) {
      const lineStart = offset;
      offset += line.length;
      const text = stripBytes(line);
      if (text.length === 0) continue;
      if (line.length > BOUNDS.maxLineBytes) {
        this.last_warnings.push(`ignored oversized event at byte offset ${lineStart}`);
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(STRICT_UTF8.decode(text));
      } catch {
        this.last_warnings.push(`ignored malformed event at byte offset ${lineStart}`);
        continue;
      }
      if (!isRecord(record)) {
        this.last_warnings.push(`ignored non-object event at byte offset ${lineStart}`);
        continue;
      }
      sequence += 1;
      try {
        // The sequence is based on the complete file, before any
        // tail/limit truncation.  Thus an event keeps the same id in a
        // snapshot, REST replay, and WebSocket reconnect.
        const fallbackEventId = headTruncated
          ? `${this.run_id}:offset-${lineStart.toString(16).padStart(16, "0")}`
          : null;
        const item = normalizeEvent(record, {
          run_id: this.run_id,
          sequence,
          offset: lineStart,
          fallback_event_id: fallbackEventId,
        });
        // A duplicate cursor is ambiguous for replay.  Keep the first
        // occurrence (the one with the smallest file offset) and make
        // the diagnostic visible to clients rather than silently
        // allowing a reconnect to skip or repeat deltas.
        if (seenEventIds.has(item.event_id)) {
          this.last_warnings.push(`ignored duplicate event_id ${pyRepr(item.event_id)}`);
          continue;
        }
        if (records.length - head >= BOUNDS.maxRecords) {
          const removed = records[head];
          head += 1;
          seenEventIds.delete(removed.event_id);
          recordsTruncated = true;
        }
        records.push(item);
        seenEventIds.add(item.event_id);
      } catch (exc) {
        if (!(exc instanceof EventNormalizationError)) throw exc;
        this.last_warnings.push(`ignored event ${sequence}: ${exc.message}`);
        continue;
      }
    }
    if (recordsTruncated) {
      this.last_warnings.push(
        `event log contains more than ${BOUNDS.maxRecords} records; replay is limited to the retained tail`,
      );
    }
    let retainedRecords = records.slice(head);
    let replayFromCursor = false;
    if (after) {
      const matching = retainedRecords.findIndex((item) => item.event_id === after);
      if (matching !== -1) {
        retainedRecords = retainedRecords.slice(matching + 1);
        replayFromCursor = true;
      } else {
        // A missing cursor is not equivalent to "start from the
        // beginning".  It means the client has fallen behind a
        // rotated/truncated log, used another run's cursor, or a
        // corrupt line was encountered.  Tell it to rebuild a
        // snapshot before consuming new deltas.
        this.last_cursor_gap = true;
        this.last_resync_required = true;
        this.last_warnings.push(`cursor ${pyRepr(after)} is not present in the retained event log`);
      }
    }
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
    // For a reconnect cursor, ``limit`` bounds the *next* contiguous
    // events.  Applying it to the tail of the whole file would silently
    // skip the first deltas when a run has many events (and makes replay
    // depend on log length).
    const bounded = replayFromCursor
      ? retainedRecords.slice(0, boundedLimit)
      : retainedRecords.slice(Math.max(0, retainedRecords.length - boundedLimit));
    this.last_first_event_id = bounded.length ? bounded[0].event_id : null;
    this.last_last_event_id = bounded.length ? bounded[bounded.length - 1].event_id : after;
    return bounded;
  }

  /**
   * Read at most ``_MAX_EVENT_LOG_BYTES`` from the event log.
   *
   * The file descriptor is opened with ``O_NOFOLLOW`` where available so a
   * final-path symlink cannot redirect the dashboard to an arbitrary file
   * between a path check and the read.  A byte tail starts at a complete
   * line; callers get a resync gap if their cursor was discarded.
   */
  private _readBounded(): [Buffer, number, boolean] {
    // Event logs are worker-produced and may be swapped while a dashboard
    // is polling.  Walk every parent component with anchored no-follow
    // opens and reject hardlink/special-file aliases before reading.
    const fd = openNofollow(this.path);
    let raw: Buffer = Buffer.alloc(0);
    let size = 0;
    let headTruncated = false;
    let start = 0;
    try {
      const metadata = fs.fstatSync(fd);
      if (!metadata.isFile() || metadata.nlink !== 1) {
        return [Buffer.alloc(0), 0, false];
      }
      size = metadata.size;
      if (size <= 0) {
        return [Buffer.alloc(0), 0, false];
      }
      headTruncated = size > BOUNDS.maxLogBytes;
      start = Math.max(0, size - BOUNDS.maxLogBytes);
      const buffer = Buffer.alloc(BOUNDS.maxLogBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, BOUNDS.maxLogBytes, start);
      raw = buffer.subarray(0, bytesRead);
    } finally {
      try {
        fs.closeSync(fd);
      } catch (exc) {
        if ((exc as NodeJS.ErrnoException).code !== "EBADF") throw exc;
      }
    }

    if (headTruncated) {
      // The first bytes may be the middle of a JSON record.  Drop that
      // partial record and report offsets relative to the real file.
      const firstNewline = raw.indexOf(0x0a);
      if (firstNewline < 0) {
        return [Buffer.alloc(0), size, true];
      }
      start += firstNewline + 1;
      raw = raw.subarray(firstNewline + 1);
    }

    // A worker can be writing the final line while we read.  Never parse
    // that incomplete tail; it will be picked up on the next poll.
    if (raw.length && raw[raw.length - 1] !== 0x0a && raw[raw.length - 1] !== 0x0d) {
      const lastNewline = raw.lastIndexOf(0x0a);
      raw = lastNewline >= 0 ? raw.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    }
    return [raw, start, headTruncated];
  }
}
