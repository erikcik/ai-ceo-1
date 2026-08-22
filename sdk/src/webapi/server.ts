// Ported 1:1 from LongHorizon-Harness src/lh_harness/webapi/server.py
//
// The FastAPI REST/WebSocket server of the original is re-implemented on
// node:http + ws.  Route paths, status codes, JSON bodies (`{"detail": ...}`),
// header names, middleware order and WebSocket close codes are verbatim.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { DashboardState } from "../dashboard/state.js";
import { discoverModelCatalog } from "../model_catalog.js";
import { RunSupervisor } from "../supervisor/service.js";
import { TERMINAL_STATUSES, canonicalLifecycleStatus, resumeEpoch } from "../supervisor/lifecycle.js";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_MAX_ROUNDS, MAX_ROUNDS } from "../types.js";
import { pyStrip } from "../utils/pystr.js";
import {
  safeRunControl,
  safeRunDir,
  safeRunLogs,
  safeRunRole,
  safeRunRounds,
} from "../utils/run_boundary.js";
import { EventTailer } from "./events.js";
import { buildMeta } from "./protocol.js";
import { _provenance, buildRunSummary, buildSnapshot } from "./snapshot.js";

type Dict = Record<string, unknown>;

const NUL = "\u0000";

// Vite builds directly into this directory, so a source checkout and an
// installed package resolve the same path.  It is absent until the frontend is
// built; the API then serves JSON only.
export const _STATIC_DIR = fileURLToPath(new URL("../../frontend/web/dist/", import.meta.url)).replace(/\/$/, "");
export const _DASHBOARD_MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
};

export const _MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const _MAX_CONTROL_BODY_BYTES = 1 * 1024 * 1024;
/**
 * Addition over upstream: files attached from the workbench. Upstream has no
 * upload path (the workspace is "the directory you launched from"); here a
 * browser can put input files into `<workspace>/inbox/` before starting a
 * task. Raw bodies, streamed to disk, bounded separately from control JSON.
 */
export const _MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const UPLOAD_INBOX_DIR = "inbox";

/** A safe, single-component file name for an upload; "" when unusable. */
export function sanitizeUploadName(raw: string): string {
  let name = String(raw || "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw header value */
  }
  name = name.split(/[\\/]/u).pop() || "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/gu, "").replace(/[^\w.\- ()+@,\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF]/gu, "-");
  name = name.replace(/\s+/gu, " ").replace(/^[\s.]+|[\s.]+$/gu, "");
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 24);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  if (!name || name === "." || name === "..") return "";
  return name;
}

// Agent-produced artifacts are untrusted.  Only a small, explicit raster
// allow-list is rendered in the dashboard origin; everything else is a
// download (including SVG, PDF and browser document formats).
export const _INLINE_RASTER_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
export const _TEXT_ARTIFACT_SUFFIXES = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".log", ".csv", ".tsv",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss",
  ".html", ".htm", ".xhtml", ".xht", ".xml", ".svg", ".svgz", ".yaml", ".yml",
  ".toml", ".ini", ".sh", ".zsh", ".bash", ".diff", ".patch", ".rst",
]);

// Static assets other than the three forced types still need a sane
// Content-Type; browsers refuse module scripts under nosniff otherwise.
const _STATIC_MIME_TYPES: Record<string, string> = {
  ...(_DASHBOARD_MIME_TYPES),
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
};

/** HTTPException equivalent: an error carrying an HTTP status + detail. */
export class HttpError extends Error {
  status: number;
  detail: string;
  headers: Record<string, string>;

  constructor(status: number, detail: string, headers: Record<string, string> = {}) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Error-class identity by name keeps this module decoupled from its writers. */
function isNamedError(value: unknown, ...names: string[]): boolean {
  if (!(value instanceof Error)) return false;
  const seen = new Set<string>([value.name]);
  let current: unknown = value.constructor;
  while (typeof current === "function" && (current as { name?: string }).name) {
    seen.add((current as { name: string }).name);
    current = Object.getPrototypeOf(current);
  }
  return names.some((name) => seen.has(name));
}

/** Python ``urllib.parse.quote(value, safe='')``. */
function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a header-safe, Unicode-preserving Content-Disposition value.
 *
 * ``name`` comes from an agent-controlled directory entry.  A quoted raw
 * filename is not sufficient: quotes/newlines can corrupt the header and
 * non-Latin names cannot be encoded by the Latin-1 header transport.
 */
export function _artifactContentDisposition(disposition: string, name: string): string {
  const original = String(name || "artifact").replaceAll("\r", "_").replaceAll("\n", "_");
  const suffix = path.extname(original);
  const safeSuffix = /^\.[A-Za-z0-9]{1,16}$/.test(suffix) ? suffix : "";
  const stemSource = suffix ? original.slice(0, original.length - suffix.length) : original;
  const safeStem =
    stemSource.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").replace(/[._-]+$/, "") || "artifact";
  const fallback = `${safeStem.slice(0, Math.max(1, 120 - safeSuffix.length))}${safeSuffix}`;
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${pyQuote(original)}`;
}

// Native browser WebSocket clients cannot set an ``Authorization`` header.
// Passing the long-lived bearer in ``?token=`` leaks it into access logs,
// reverse-proxy traces, browser history, and copied URLs.  Built-in clients use
// two URL-safe subprotocols instead: a public marker plus a base64url-encoded
// token.  The server echoes only the marker during the handshake.
export const _WS_AUTH_MARKER = "lh-harness-auth.v1";
export const _WS_AUTH_TOKEN_PREFIX = "lh-harness-token.";

export function _isLoopbackHost(host: string): boolean {
  const value = pyStrip(String(host || "")).toLowerCase().replace(/^\[+|\]+$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(value)) return true;
  if (net.isIPv4(value)) return value.startsWith("127.");
  if (net.isIPv6(value)) {
    if (value === "::1") return true;
    if (value.startsWith("::ffff:")) {
      const mapped = value.slice("::ffff:".length);
      return net.isIPv4(mapped) && mapped.startsWith("127.");
    }
    return false;
  }
  return false;
}

/** Return the hostname from a Host header, ignoring an optional port. */
export function _requestHostname(hostHeader: string): string {
  const value = pyStrip(String(hostHeader || ""));
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return "";
    return value.slice(1, end);
  }
  if ((value.match(/:/g) || []).length === 1) {
    return value.slice(0, value.lastIndexOf(":"));
  }
  return value;
}

export function _hostHeaderAllowed(hostHeader: string, bindHost: string): boolean {
  const hostname = _requestHostname(hostHeader);
  if (!hostname) return false;
  if (_isLoopbackHost(hostname)) return true;
  const configured = pyStrip(String(bindHost || "")).toLowerCase().replace(/^\[+|\]+$/g, "");
  return Boolean(configured) && hostname.toLowerCase() === configured;
}

export function _isJsonContentType(value: string | null | undefined): boolean {
  const media = pyStrip(String(value || "").split(";", 1)[0]).toLowerCase();
  return media === "application/json";
}

export function _configuredToken(explicit: string | null | undefined): string | null {
  const value = explicit !== null && explicit !== undefined ? explicit : process.env.LH_HARNESS_WEB_TOKEN;
  const text = pyStrip(String(value || ""));
  return text || null;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf-8");
  const b = Buffer.from(right, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function _bearerMatches(value: string | null | undefined, token: string | null): boolean {
  if (token === null) return true;
  if (!value || !value.startsWith("Bearer ")) return false;
  const supplied = pyStrip(value.slice("Bearer ".length));
  return Boolean(supplied) && constantTimeEquals(supplied, token);
}

/** Decode one bounded, URL-safe WebSocket auth protocol value. */
export function _decodeWsTokenProtocol(value: string): string | null {
  if (!value.startsWith(_WS_AUTH_TOKEN_PREFIX)) return null;
  const encoded = value.slice(_WS_AUTH_TOKEN_PREFIX.length);
  if (!encoded || encoded.length > 2048) return null;
  // Base64url without padding is the only representation emitted by the
  // frontends.  Restrict the alphabet before decoding so malformed protocol
  // headers cannot be interpreted ambiguously.
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const raw = Buffer.from(encoded, "base64url");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return decoded || null;
  } catch {
    return null;
  }
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Authenticate a WebSocket and return the subprotocol to echo. */
export function _websocketAuth(
  headers: http.IncomingHttpHeaders,
  token: string | null,
): [boolean, string | null] {
  if (token === null) return [true, null];
  if (_bearerMatches(headerValue(headers, "authorization"), token)) return [true, null];
  const protocols = new Set(
    String(headerValue(headers, "sec-websocket-protocol") || "")
      .split(",")
      .map((item) => pyStrip(item))
      .filter((item) => item),
  );
  if (!protocols.has(_WS_AUTH_MARKER)) {
    // Deliberately do not accept query-string credentials.  A query token
    // is a bearer credential with a much wider leak surface than a header.
    return [false, null];
  }
  for (const protocol of protocols) {
    const supplied = _decodeWsTokenProtocol(protocol);
    if (supplied !== null && constantTimeEquals(supplied, token)) {
      return [true, _WS_AUTH_MARKER];
    }
  }
  return [false, null];
}

export function _originAllowed(
  origin: string | null | undefined,
  host: string,
  allowedOrigins: Set<string>,
): boolean {
  // Non-browser clients generally omit Origin.  An explicit Origin must be
  // checked because browsers allow cross-site WebSocket upgrades without
  // applying CORS rules.
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  // Compare the complete authority, not only the hostname: accepting an
  // arbitrary port on the same machine still permits a cross-site browser
  // to read the stream.
  return parsed.host.toLowerCase().replace(/\/+$/, "") === host.toLowerCase().replace(/\/+$/, "");
}

export function _safeRunId(runId: unknown): boolean {
  return (
    typeof runId === "string" &&
    Boolean(runId) &&
    runId.length <= 128 &&
    runId !== "." &&
    runId !== ".." &&
    !runId.includes("/") &&
    !runId.includes("\\") &&
    ![...runId].some((char) => (char.codePointAt(0) as number) < 0x20 || char.codePointAt(0) === 0x7f)
  );
}

export function _boundedCommandId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = pyStrip(value);
  if (normalized.length > 256 || normalized.includes(NUL)) {
    throw new HttpError(422, "Idempotency-Key must be at most 256 characters");
  }
  return normalized || null;
}

export function _boundedCursor(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (
    value.length > 256 ||
    [...value].some((char) => (char.codePointAt(0) as number) < 0x20 || char.codePointAt(0) === 0x7f)
  ) {
    throw new HttpError(422, "after cursor is invalid or too long");
  }
  return value;
}

export function _bodyPositiveInt(value: unknown, options: { field: string; default?: number | null }): number {
  const field = options.field;
  const fallback = options.default ?? null;
  if ((value === null || value === undefined) && fallback !== null) return fallback;
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(422, `${field} must be an integer of at least 1`);
  }
  if (field === "max_rounds" && value > MAX_ROUNDS) {
    throw new HttpError(422, `${field} must be at most ${MAX_ROUNDS}`);
  }
  return value;
}

/**
 * Parse a JSON revision without lossy ``int()`` coercion.
 *
 * In particular, ``1.5`` must not silently become revision ``1`` and bools
 * must not pass as an integer subtype.
 */
export function _strictOptionalRevision(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") throw new HttpError(422, "expected_revision must be an integer");
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value;
    throw new HttpError(422, "expected_revision must be an integer");
  }
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (!text || text.length > 32 || !/^[+-]?\d+$/.test(text)) {
      throw new HttpError(422, "expected_revision must be an integer");
    }
    return Number.parseInt(text, 10);
  }
  throw new HttpError(422, "expected_revision must be an integer");
}

/**
 * Parse an optional extra-round grant from a request body.
 *
 * Rejecting an out-of-range value at the boundary (rather than clamping it)
 * keeps an obvious operator mistake visible instead of silently granting a
 * different budget than the one that was typed.
 */
export function _optionalExtraRounds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const detail = `extra_rounds must be an integer from 1 to ${MAX_ROUNDS}`;
  if (typeof value === "boolean") throw new HttpError(422, detail);
  let parsed: unknown = value;
  if (typeof value === "number" && !Number.isInteger(value)) throw new HttpError(422, detail);
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (!text || text.length > 16 || !/^\d+$/.test(text)) throw new HttpError(422, detail);
    parsed = Number.parseInt(text, 10);
  }
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || !(parsed >= 1 && parsed <= MAX_ROUNDS)) {
    throw new HttpError(422, detail);
  }
  return parsed;
}

export function _bodyText(
  value: unknown,
  options: { field: string; required?: boolean; max_chars?: number },
): string {
  const field = options.field;
  const required = options.required ?? false;
  const maxChars = options.max_chars ?? 100_000;
  let text: string;
  if (value === null || value === undefined) {
    text = "";
  } else if (typeof value === "string") {
    text = pyStrip(value);
  } else {
    throw new HttpError(422, `${field} must be a string`);
  }
  if (required && !text) throw new HttpError(422, `${field} is required`);
  if (text.length > maxChars) throw new HttpError(413, `${field} is too large`);
  if (text.includes(NUL)) throw new HttpError(422, `${field} contains a NUL byte`);
  return text;
}

/** Expose lifecycle metadata without echoing prompts/argv/credentials. */
export function _publicOwner(owner: Dict): Dict {
  const allowed = [
    "run_id",
    "pid",
    "pgid",
    "started_at",
    "agent",
    "model",
    "reasoning_effort",
    "role_configs",
    "max_rounds",
    "prompt_language",
    "workspace",
    "resumed_from",
    "resume_kind",
    "resume_epoch",
  ];
  const result: Dict = {};
  if (!isRecord(owner)) return result;
  for (const key of allowed) {
    if (key in owner) result[key] = owner[key];
  }
  if (typeof owner.task === "string") {
    result.task_summary = String(owner.task).slice(0, 500);
  }
  return result;
}

/** Track snapshot-only state that must wake connected Web clients. */
export function _streamProjectionSignature(snapshot: Dict): string {
  const operatorMessages = (Array.isArray(snapshot.operator_messages) ? snapshot.operator_messages : [])
    .filter(isRecord)
    .map((item) => [item.id ?? null, item.status ?? null]);
  const approvals = (Array.isArray(snapshot.approvals) ? snapshot.approvals : [])
    .filter(isRecord)
    .map((item) => [
      item.approval_id ?? null,
      item.status ?? null,
      item.action ?? null,
      item.user_input ?? null,
      item.resolved_at ?? null,
    ]);
  const run = isRecord(snapshot.run) ? snapshot.run : {};
  const controls = isRecord(snapshot.controls) ? snapshot.controls : {};
  return JSON.stringify([
    run.status ?? null,
    run.finished_at ?? null,
    run.exit_code ?? null,
    run.resume_epoch ?? null,
    snapshot.active_round ?? null,
    snapshot.active_role ?? null,
    controls.can_inject ?? null,
    controls.can_abort ?? null,
    controls.can_resume ?? null,
    operatorMessages,
    approvals,
  ]);
}

function expandUser(target: string): string {
  if (target === "~" || target.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, target.slice(1));
  }
  return target;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** Resolve run ids without letting API paths escape the configured root. */
export class StateRegistry {
  baseState: DashboardState;
  runsRoot: string | null;
  baseRunId: string;
  supervisor: RunSupervisor | null;
  states: Map<string, DashboardState>;

  constructor(options: {
    state: DashboardState;
    runsRoot?: string | null;
    runId?: string | null;
    supervisor?: RunSupervisor | null;
  }) {
    this.baseState = options.state;
    this.runsRoot = options.runsRoot ? path.resolve(expandUser(String(options.runsRoot))) : null;
    // A multi-run registry must not invent a ``local`` run merely because
    // its base state has not been selected yet.  The old sentinel caused a
    // read of /api/runs/local/snapshot to create durable control metadata
    // for a run that never existed.
    const derivedRunId =
      options.runId === null || options.runId === undefined ? this.baseState.currentRunId : "";
    this.baseRunId = options.runId || derivedRunId || (this.runsRoot === null ? "local" : "");
    this.supervisor = options.supervisor ?? null;
    this.states = new Map<string, DashboardState>();
    if (this.baseRunId) this.states.set(this.baseRunId, options.state);
  }

  /**
   * Keep a cached DashboardState aligned with the live supervisor.
   *
   * A state can be cached while a newly-created worker is still in its
   * reservation window.  Persisting that initial ``false`` forever makes
   * later instructions and approvals fail even after the worker is live.
   */
  private async _refreshControlCapability(runId: string, state: DashboardState): Promise<DashboardState> {
    if (this.supervisor !== null) {
      try {
        state.control_enabled = Boolean(this.supervisor.canControl(runId));
      } catch {
        state.control_enabled = false;
      }
    }
    return state;
  }

  /** Validate one run boundary before a state can read from it. */
  private _runPaths(runId: string): [string, string] | null {
    const root = this.runsRoot;
    if (root === null) return null;
    const runDir = safeRunDir(root, runId);
    if (runDir === null || !isDirectory(runDir)) return null;
    const logDir = safeRunLogs(root, runDir, { allowMissing: true });
    const controlDir = safeRunControl(root, runDir, { allowMissing: true });
    const roundsDir = safeRunRounds(root, runDir, { allowMissing: true });
    const roleDir = safeRunRole(root, runDir, { allowMissing: true });
    if (logDir === null || controlDir === null || roundsDir === null || roleDir === null) return null;
    if (!isDirectory(roleDir) && !isDirectory(controlDir)) return null;
    return [runDir, logDir];
  }

  async stateFor(runId: string): Promise<DashboardState | null> {
    if (!_safeRunId(runId)) return null;
    // An embedded dashboard is intentionally single-run.  Reject foreign
    // ids before touching the filesystem so direct API paths cannot inspect
    // or control another worker through the attached supervisor.
    if (this.supervisor !== null && Boolean(this.supervisor.attachedOnly)) {
      const attachedRunId = this.supervisor.attachedRunId;
      if (!attachedRunId || runId !== attachedRunId) return null;
    }
    const cached = this.states.get(runId);
    if (cached !== undefined) {
      if (this.runsRoot !== null) {
        // The base DashboardState may have auto-selected a run during
        // construction. Revalidate the cached path on every request;
        // otherwise a symlinked ``runs/<id>`` could bypass the normal
        // stateFor boundary check simply because it was already in the
        // registry cache.
        const paths = this._runPaths(runId);
        if (paths === null) return null;
        const [, logDir] = paths;
        try {
          if (realpathOrSelf(String(cached.log_dir)) !== logDir) return null;
        } catch {
          return null;
        }
      }
      return this._refreshControlCapability(runId, cached);
    }
    if (this.runsRoot === null || !_safeRunId(runId)) return null;
    const paths = this._runPaths(runId);
    if (paths === null) return null;
    const [, logDir] = paths;
    const state = new DashboardState(logDir, {
      runsRoot: this.runsRoot,
      controlEnabled: false,
    });
    this.states.set(runId, state);
    return this._refreshControlCapability(runId, state);
  }

  async defaultState(): Promise<[string, DashboardState]> {
    if (this.baseState.currentRunId) {
      return [this.baseState.currentRunId, this.baseState];
    }
    if (this.baseRunId) {
      return [this.baseRunId, this.baseState];
    }
    if (this.runsRoot !== null) {
      const items =
        this.supervisor !== null ? this.supervisor.listRunItems() : this.baseState.listRuns();
      if (items.length) {
        const selected = String((items[0] as Dict).id || "");
        const selectedState = await this.stateFor(selected);
        if (selectedState !== null) return [selected, selectedState];
      }
    }
    return [this.baseRunId, this.baseState];
  }

  async runItems(): Promise<Dict[]> {
    if (this.supervisor !== null) {
      return (this.supervisor.listRunItems()) as Dict[];
    }
    const items = this.baseState.listRuns() as Dict[];
    if (items.length) return items;
    if (this.runsRoot !== null) return [];
    const [runId, state] = await this.defaultState();
    return [
      {
        id: runId,
        log_dir: String(state.log_dir),
        mtime: 0.0,
        status: "",
      },
    ];
  }
}

async function _stateOr404(registry: StateRegistry, runId: string): Promise<DashboardState> {
  const state = await registry.stateFor(runId);
  if (state === null) throw new HttpError(404, "run not found");
  return state;
}

function _eventTailer(state: DashboardState, runId: string): EventTailer {
  return new EventTailer(path.join(String(state.role_dir), "events.jsonl"), { run_id: runId });
}

/**
 * Overlay durable Supervisor lifecycle state on the log projection.
 *
 * A stopped Worker can have a perfectly valid ``events.jsonl`` tail but no
 * final report. The log-only projection would call that run ``running``;
 * standalone Web clients must trust the persisted process owner/status
 * when one exists.
 */
export async function _snapshotFor(
  registry: StateRegistry,
  state: DashboardState,
  runId: string,
): Promise<Dict> {
  const result = buildSnapshot(state, { run_id: runId });
  const supervisor = registry.supervisor;
  if (supervisor === null) return result;
  let owner: unknown = {};
  try {
    owner = supervisor.owner(runId);
  } catch {
    owner = {};
  }
  const run = result.run as Dict;
  const mission = result.mission as Dict;
  if (isRecord(owner)) {
    Object.assign(run, _provenance(owner));
    // Single-run DashboardState instances may not have ``runsRoot`` and
    // therefore cannot read owner.json inside buildSnapshot().  The
    // Supervisor is authoritative here, including for the task shown while
    // the first Manager round is running.
    if (!pyStrip(String(mission.task || ""))) {
      const ownerTask = owner.task;
      if (typeof ownerTask === "string" && pyStrip(ownerTask)) {
        mission.task = ownerTask;
      }
    }
  }
  const managed = supervisor.status(runId) as Dict;
  if (managed.managed === false) {
    // Keep unmanaged runs' log/report projection visible, but do not let
    // stale lifecycle metadata overwrite it or re-enable operator controls.
    run.managed = false;
    result.controls = {
      ...(isRecord(result.controls) ? result.controls : {}),
      can_inject: false,
      can_abort: false,
      can_resume: false,
    };
    return result;
  }
  const status = canonicalLifecycleStatus(managed.status || run.status || "idle");
  run.status = status;
  // Keep the auditor/report vocabulary available as evidence without making
  // it the process-lifecycle authority.
  if (managed.report_status) {
    run.report_status = managed.report_status;
  }
  for (const field of [
    "completion_satisfied",
    "completion_authority",
    "exit_code",
    "failure_reason",
    "finished_at",
    "started_at",
  ]) {
    if (field in managed && managed[field] !== null && managed[field] !== undefined) {
      run[field] = managed[field];
    }
  }
  // Lets a client tell "stopping normally" from "SIGTERM was ignored" and only
  // then offer the force-kill escalation.
  for (const field of ["requested_action", "stop_requested_at"]) {
    if (managed[field] !== null && managed[field] !== undefined) {
      run[field] = managed[field];
    }
  }
  // Clients keep lifecycle monotonic to survive REST/WS races, so a resumed
  // run needs an explicit generation counter: without it a reopened run looks
  // like a stale "running" frame arriving after a terminal one and is dropped.
  const epoch = resumeEpoch(managed) || resumeEpoch(owner);
  if (epoch) {
    run.resume_epoch = epoch;
  }
  if (TERMINAL_STATUSES.has(status)) {
    // Supervisor lifecycle is authoritative even when the worker died
    // before its final round directory was marked closed.
    result.active_round = null;
    result.active_role = null;
  }
  const alive = Boolean(managed.alive);
  result.controls = {
    ...(isRecord(result.controls) ? result.controls : {}),
    can_inject: alive,
    can_abort: alive && ["running", "waiting_approval", "starting"].includes(status),
    can_resume: !Boolean(supervisor.attachedOnly) && !alive && TERMINAL_STATUSES.has(status),
  };
  return result;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: [string, string][] = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "SAMEORIGIN"],
  ["Referrer-Policy", "same-origin"],
  ["Cache-Control", "no-store"],
];

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of SECURITY_HEADERS) {
    if (!res.hasHeader(name)) res.setHeader(name, value);
  }
}

function sendResponse(
  res: ServerResponse,
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  applySecurityHeaders(res);
  const payload = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  res.setHeader("Content-Length", String(payload.length));
  res.statusCode = status;
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendResponse(res, status, JSON.stringify(body), { "Content-Type": "application/json", ...headers });
}

function sendDetail(res: ServerResponse, status: number, detail: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { detail }, headers);
}

/**
 * Buffer at most ``limit`` bytes and hand them to the route handler.
 *
 * Reading the stream incrementally lets the control plane reject an
 * undeclared/chunked oversized body as soon as it crosses the limit.
 */
function _cacheBoundedRequestBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function parseJsonObjectBody(body: Buffer | null): Dict {
  if (body === null || body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    throw new HttpError(422, "request body must be a JSON object");
  }
  if (!isRecord(parsed)) throw new HttpError(422, "request body must be a JSON object");
  return parsed;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parsePathInt(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new HttpError(422, "path parameter must be an integer");
  return Number.parseInt(value, 10);
}

function queryInt(
  params: URLSearchParams,
  name: string,
  fallback: number,
  bounds: { ge: number; le: number },
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^[+-]?\d+$/.test(pyStrip(raw))) {
    throw new HttpError(422, `${name} must be an integer`);
  }
  const value = Number.parseInt(pyStrip(raw), 10);
  if (value < bounds.ge || value > bounds.le) {
    throw new HttpError(422, `${name} must be between ${bounds.ge} and ${bounds.le}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

export type CreateAppOptions = {
  state?: DashboardState | null;
  logDir?: string | null;
  runsRoot?: string | null;
  runId?: string | null;
  controlEnabled?: boolean;
  workspaceRoot?: string | null;
  supervisor?: RunSupervisor | null;
  authToken?: string | null;
  allowedOrigins?: Iterable<string> | null;
  bindHost?: string;
  staticDir?: string | null;
  task?: string;
  /**
   * Addition over upstream: when set, the deployment supports an operator-
   * triggered restart. `POST /api/service/reload` acknowledges, then invokes
   * this callback; the process wrapper (or the container restart policy)
   * brings the service back up on the current harness source.
   */
  onReload?: (() => void) | null;
};

export type WebApp = {
  registry: StateRegistry;
  authToken: string | null;
  allowedOrigins: Set<string>;
  bindHost: string;
  staticDir: string | null;
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): void;
  shutdown(): Promise<void>;
};

/** Create an API app over a live shared state or a historical runs root. */
export function createApp(options: CreateAppOptions = {}): WebApp {
  const supervisor = options.supervisor ?? null;
  const bindHost = options.bindHost ?? "127.0.0.1";
  const dashboardState =
    options.state ??
    new DashboardState(options.logDir ?? null, {
      task: options.task ?? "",
      runsRoot: options.runsRoot ?? null,
      controlEnabled: options.controlEnabled ?? false,
    });
  const registry = new StateRegistry({
    state: dashboardState,
    runsRoot: options.runsRoot ?? null,
    runId: options.runId ?? null,
    supervisor,
  });
  const token = _configuredToken(options.authToken ?? null);
  const origins = new Set<string>();
  for (const item of options.allowedOrigins ?? []) {
    if (pyStrip(String(item))) origins.add(String(item).replace(/\/+$/, ""));
  }
  const configuredStaticDir = options.staticDir === undefined ? _STATIC_DIR : options.staticDir;
  const staticDir = configuredStaticDir && isDirectory(configuredStaticDir) ? configuredStaticDir : null;

  const pendingSubprotocols = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>, request: IncomingMessage) => {
      const selected = pendingSubprotocols.get(request);
      pendingSubprotocols.delete(request);
      return selected ?? false;
    },
  });

  function baseUrl(req: IncomingMessage): string {
    const host = headerValue(req.headers, "host") || bindHost;
    return `http://${host}/`;
  }

  async function metaResponse(req: IncomingMessage, forceModels: boolean): Promise<Dict> {
    const endpoint = baseUrl(req).replace(/\/+$/, "");
    let liveControl = false;
    for (const item of registry.states.values()) {
      if (item.control_enabled) liveControl = true;
    }
    liveControl = liveControl || supervisor !== null;
    const catalogue = (await discoverModelCatalog({ force: forceModels })) as Dict;
    return buildMeta({
      endpoint,
      capabilities: {
        approvals: liveControl,
        injections: liveControl,
        run_control: supervisor !== null,
        reload: Boolean(options.onReload),
        create_run: supervisor !== null && !Boolean(supervisor.attachedOnly),
        resume: supervisor !== null && !Boolean(supervisor.attachedOnly),
        stop: supervisor !== null,
        abort: supervisor !== null,
      },
      agents: catalogue.agents as Dict[],
      models: catalogue.models as Record<string, Dict[]>,
      defaults: {
        // Only the claude_code backend is ported; the Python default of
        // ``codex`` has no adapter here.
        agent: "claude_code",
        model: DEFAULT_CLAUDE_MODEL,
        roles: Object.fromEntries(
          ["manager", "executor", "auditor"].map((role) => [
            role,
            { agent: "claude_code", model: DEFAULT_CLAUDE_MODEL },
          ]),
        ),
      },
      model_discovery: catalogue.model_discovery as Record<string, Dict>,
    });
  }

  function resolveInboxDir(workspaceParam: string | null): { workspace: string; inbox: string } {
    if (supervisor === null || Boolean(supervisor.attachedOnly)) {
      throw new HttpError(501, "uploads require the standalone Web supervisor");
    }
    const raw = pyStrip(String(workspaceParam || ""));
    const workspace = raw ? path.resolve(expandUser(raw)) : String(supervisor.workspaceRoot);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(workspace);
    } catch {
      throw new HttpError(404, "workspace does not exist");
    }
    if (!stat.isDirectory()) throw new HttpError(422, "workspace is not a directory");
    return { workspace, inbox: path.join(workspace, UPLOAD_INBOX_DIR) };
  }

  function uniqueUploadPath(inbox: string, name: string): string {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = path.join(inbox, name);
    for (let index = 2; fs.existsSync(candidate); index += 1) {
      candidate = path.join(inbox, `${stem}-${index}${ext}`);
    }
    return candidate;
  }

  function uploadRecord(workspace: string, absolute: string, bytes: number, mtimeMs: number): Dict {
    return {
      name: path.basename(absolute),
      path: `${UPLOAD_INBOX_DIR}/${path.basename(absolute)}`,
      absolute,
      workspace,
      bytes,
      modified_at: new Date(mtimeMs).toISOString(),
    };
  }

  /** GET /api/uploads?workspace= — what is already in the inbox. */
  function listUploads(res: ServerResponse, params: URLSearchParams): void {
    const { workspace, inbox } = resolveInboxDir(params.get("workspace"));
    const files: Dict[] = [];
    if (fs.existsSync(inbox)) {
      for (const entry of fs.readdirSync(inbox, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const absolute = path.join(inbox, entry.name);
        const stat = fs.statSync(absolute);
        files.push(uploadRecord(workspace, absolute, stat.size, stat.mtimeMs));
      }
    }
    files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sendJson(res, 200, { workspace, inbox: UPLOAD_INBOX_DIR, files });
  }

  /** POST /api/uploads?workspace= with a raw body and `X-File-Name`. */
  async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { workspace, inbox } = resolveInboxDir(url.searchParams.get("workspace"));
    const name = sanitizeUploadName(headerValue(req.headers, "x-file-name") ?? url.searchParams.get("name") ?? "");
    if (!name) throw new HttpError(422, "X-File-Name header (or ?name=) with a usable file name is required");
    const contentLength = headerValue(req.headers, "content-length");
    if (contentLength !== undefined) {
      if (!/^\d+$/u.test(contentLength.trim())) throw new HttpError(400, "invalid content-length");
      if (Number.parseInt(contentLength.trim(), 10) > _MAX_UPLOAD_BYTES) throw new HttpError(413, "upload is too large");
    }
    fs.mkdirSync(inbox, { recursive: true });
    const target = uniqueUploadPath(inbox, name);
    const partial = path.join(inbox, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.part`);
    const bytes = await new Promise<number>((resolve, reject) => {
      let received = 0;
      let failed = false;
      const out = fs.createWriteStream(partial, { flags: "wx", mode: 0o644 });
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(partial, { force: true }, () => reject(error));
      };
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > _MAX_UPLOAD_BYTES) {
          req.destroy();
          fail(new HttpError(413, "upload is too large"));
        }
      });
      req.on("error", fail);
      out.on("error", fail);
      out.on("finish", () => {
        if (!failed) resolve(received);
      });
      req.pipe(out);
    });
    fs.renameSync(partial, target);
    const stat = fs.statSync(target);
    sendJson(res, 201, { ok: true, file: uploadRecord(workspace, target, bytes, stat.mtimeMs) });
  }

  async function createRun(req: IncomingMessage, res: ServerResponse, body: Buffer | null): Promise<void> {
    if (supervisor === null || Boolean(supervisor.attachedOnly)) {
      throw new HttpError(501, "run creation requires the standalone Web supervisor");
    }
    const payload = parseJsonObjectBody(body);
    let created: Dict;
    try {
      const task = _bodyText(payload.task ?? payload.instructions ?? "", { field: "task", required: true });
      const agent = _bodyText(payload.agent ?? "claude_code", { field: "agent", required: true, max_chars: 64 });
      const model = _bodyText(payload.model, { field: "model", max_chars: 256 }) || null;
      const reasoningEffort =
        _bodyText(payload.reasoning_effort, { field: "reasoning_effort", max_chars: 64 }) || null;
      const roleConfigs = payload.roles;
      const workspace = _bodyText(payload.workspace, { field: "workspace", max_chars: 4096 }) || null;
      const runIdValue = _bodyText(payload.run_id, { field: "run_id", max_chars: 128 }) || null;
      const maxRounds = _bodyPositiveInt(payload.max_rounds, { field: "max_rounds", default: DEFAULT_MAX_ROUNDS });
      const promptLanguage = _bodyText(payload.prompt_language ?? "en", {
        field: "prompt_language",
        required: true,
        max_chars: 2,
      });
      if (!["en", "zh"].includes(promptLanguage)) {
        throw new Error("prompt_language must be en or zh");
      }
      created = supervisor.createRun({
        task,
        agent,
        model,
        roleConfigs,
        workspace,
        maxRounds,
        promptLanguage,
        runId: runIdValue,
        reasoningEffort,
        idempotencyKey: _boundedCommandId(headerValue(req.headers, "idempotency-key")),
      }) as Dict;
    } catch (exc) {
      if (exc instanceof HttpError) throw exc;
      if (isNamedError(exc, "IdempotencyConflict")) {
        throw new HttpError(409, (exc as Error).message);
      }
      throw new HttpError(400, exc instanceof Error ? exc.message : String(exc));
    }
    if (isRecord(created.owner)) {
      created = { ...created, owner: _publicOwner(created.owner) };
    }
    sendJson(res, 200, { ok: true, run: created });
  }

  function artifactText(res: ServerResponse, state: DashboardState, roundIndex: number, name: string): void {
    const target = state.resolveRoundArtifact(roundIndex, name);
    if (target === null) throw new HttpError(404, "artifact not found");
    const size = state.roundArtifactSize(roundIndex, name);
    if (size === null) throw new HttpError(404, "artifact not found");
    if (size > _MAX_ARTIFACT_BYTES) throw new HttpError(413, "artifact is too large");
    const content = state.readRoundArtifact(roundIndex, name);
    if (content === null) {
      throw new HttpError(size >= _MAX_ARTIFACT_BYTES ? 413 : 404, "artifact changed during read");
    }
    sendResponse(res, 200, content, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  }

  function rawArtifact(res: ServerResponse, state: DashboardState, roundIndex: number, name: string): void {
    const target = state.resolveRoundArtifact(roundIndex, name);
    if (target === null) throw new HttpError(404, "artifact not found");
    const size = state.roundArtifactSize(roundIndex, name);
    if (size === null) throw new HttpError(404, "artifact not found");
    if (size > _MAX_ARTIFACT_BYTES) throw new HttpError(413, "artifact is too large");
    const content = state.readRoundArtifactBytes(roundIndex, name);
    if (content === null) {
      // Never hand a path to a file response after a separate stat: the
      // worker can replace/grow the file during that window.
      throw new HttpError(size >= _MAX_ARTIFACT_BYTES ? 413 : 404, "artifact changed during read");
    }
    const suffix = path.extname(String(target)).toLowerCase();
    // Never let an agent-produced document execute in the dashboard origin.
    let mediaType: string | undefined = _INLINE_RASTER_TYPES[suffix];
    let disposition: string;
    let contentSecurityPolicy: string;
    if (mediaType !== undefined) {
      disposition = "inline";
      contentSecurityPolicy = "default-src 'none'";
    } else {
      disposition = "attachment";
      mediaType = _TEXT_ARTIFACT_SUFFIXES.has(suffix) ? "text/plain" : "application/octet-stream";
      contentSecurityPolicy = "default-src 'none'; sandbox";
    }
    const contentType = mediaType.startsWith("text/") ? `${mediaType}; charset=utf-8` : mediaType;
    sendResponse(res, 200, content, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": contentSecurityPolicy,
      "Content-Disposition": _artifactContentDisposition(disposition, name),
    });
  }

  function trajectory(
    res: ServerResponse,
    state: DashboardState,
    runId: string,
    roundIndex: number,
    role: string,
  ): void {
    const result = state.readTrajectory(roundIndex, role) as Dict | null;
    if (result === null || result === undefined) throw new HttpError(404, "trajectory not found");
    // Normalized trajectories use OSWorld-style screenshot_file references
    // rather than multi-megabyte data URLs. Resolve only artifacts that pass
    // the same no-follow boundary checks as the raw artifact endpoint.
    const steps = Array.isArray(result.steps) ? result.steps : [];
    for (const step of steps) {
      if (!isRecord(step)) continue;
      let names: unknown[] = [];
      if (Array.isArray(step.screenshot_files)) {
        names = step.screenshot_files;
      } else if (typeof step.screenshot_file === "string") {
        names = [step.screenshot_file];
      }
      const safeNames = names.filter(
        (name): name is string =>
          typeof name === "string" && state.resolveRoundArtifact(roundIndex, name) !== null,
      );
      if (safeNames.length) {
        step.images = safeNames.map(
          (name) => `/api/runs/${pyQuote(runId)}/rounds/${roundIndex}/artifacts/${pyQuote(name)}/raw`,
        );
        step.has_image = true;
      }
    }
    sendJson(res, 200, result);
  }

  async function instructions(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    body: Buffer | null,
  ): Promise<void> {
    const stateForRun = await _stateOr404(registry, runId);
    const payload = parseJsonObjectBody(body);
    if (supervisor !== null && !supervisor.canControl(runId)) {
      throw new HttpError(409, "run is not accepting instructions");
    }
    const text = _bodyText(payload.instructions ?? payload.text ?? "", {
      field: "instructions",
      required: true,
      max_chars: 50_000,
    });
    const expectedRevision = _strictOptionalRevision(payload.expected_revision);
    let accepted: unknown;
    try {
      accepted = stateForRun.addInjection(text, {
        command_id: _boundedCommandId(headerValue(req.headers, "idempotency-key")),
        expected_revision: expectedRevision,
      });
    } catch (exc) {
      if (exc instanceof HttpError) throw exc;
      if (isNamedError(exc, "RevisionConflict", "CommandConflict")) {
        throw new HttpError(409, (exc as Error).message);
      }
      throw exc;
    }
    if (!accepted) throw new HttpError(409, "run is not accepting instructions");
    sendJson(res, 200, {
      ok: true,
      status: "accepted",
      idempotency_key: _boundedCommandId(headerValue(req.headers, "idempotency-key")),
      revision: stateForRun.control_bus.revision(),
    });
  }

  async function resolveApproval(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    approvalId: string,
    body: Buffer | null,
  ): Promise<void> {
    const stateForRun = await _stateOr404(registry, runId);
    const payload = parseJsonObjectBody(body);
    if (supervisor !== null && !supervisor.canControl(runId)) {
      throw new HttpError(409, "run is not accepting approvals");
    }
    const expectedRevision = _strictOptionalRevision(payload.expected_revision);
    let ok: unknown;
    try {
      ok = stateForRun.resolveApproval(approvalId, {
        action: _bodyText(payload.action ?? payload.decision ?? "continue", {
          field: "action",
          required: true,
          max_chars: 128,
        }),
        reason: _bodyText(payload.reason ?? payload.note ?? "", { field: "reason", max_chars: 10_000 }),
        user_input: _bodyText(payload.user_input ?? payload.instructions ?? "", {
          field: "user_input",
          max_chars: 50_000,
        }),
        extra_rounds: _optionalExtraRounds(payload.extra_rounds),
        command_id: _boundedCommandId(headerValue(req.headers, "idempotency-key")),
        expected_revision: expectedRevision,
      });
    } catch (exc) {
      if (exc instanceof HttpError) throw exc;
      if (isNamedError(exc, "RevisionConflict", "CommandConflict")) {
        throw new HttpError(409, (exc as Error).message);
      }
      throw exc;
    }
    if (!ok) throw new HttpError(409, "approval is missing, resolved, or read-only");
    sendJson(res, 200, {
      ok: true,
      approval_id: approvalId,
      status: "accepted",
      idempotency_key: _boundedCommandId(headerValue(req.headers, "idempotency-key")),
      revision: stateForRun.control_bus.revision(),
    });
  }

  async function resume(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    body: Buffer | null,
  ): Promise<void> {
    await _stateOr404(registry, runId);
    if (supervisor === null || Boolean(supervisor.attachedOnly)) {
      throw new HttpError(501, "resume requires the standalone Web supervisor");
    }
    const payload = parseJsonObjectBody(body);
    const mode = _bodyText(payload.mode ?? "continue", { field: "mode", max_chars: 16 }) || "continue";
    if (!["continue", "retry"].includes(mode)) {
      throw new HttpError(422, "mode must be continue or retry");
    }
    try {
      let created = supervisor.resume(runId, {
        mode,
        extraRounds: _optionalExtraRounds(payload.extra_rounds),
        idempotencyKey: _boundedCommandId(headerValue(req.headers, "idempotency-key")),
      }) as Dict;
      if (isRecord(created.owner)) {
        created = { ...created, owner: _publicOwner(created.owner) };
      }
      sendJson(res, 200, { ok: true, run: created });
    } catch (exc) {
      if (exc instanceof HttpError) throw exc;
      throw new HttpError(409, exc instanceof Error ? exc.message : String(exc));
    }
  }

  async function runRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    tail: string[],
    method: string,
    params: URLSearchParams,
    body: Buffer | null,
  ): Promise<void> {
    // GET /api/runs/{run_id}/snapshot
    if (method === "GET" && tail.length === 1 && tail[0] === "snapshot") {
      const state = await _stateOr404(registry, runId);
      sendJson(res, 200, await _snapshotFor(registry, state, runId));
      return;
    }
    // GET /api/runs/{run_id}/events
    if (method === "GET" && tail.length === 1 && tail[0] === "events") {
      const after = _boundedCursor(params.get("after"));
      const limit = queryInt(params, "limit", 500, { ge: 1, le: 5000 });
      const stateForRun = await _stateOr404(registry, runId);
      const tailer = _eventTailer(stateForRun, runId);
      const items = tailer.read({ limit, after });
      sendJson(res, 200, {
        run_id: runId,
        events: items.map((item) => item.toDict()),
        last_event_id: items.length ? items[items.length - 1].event_id : after,
        cursor_gap: tailer.last_cursor_gap,
        resync_required: tailer.last_resync_required,
        diagnostics: { warnings: tailer.last_warnings },
      });
      return;
    }
    // GET /api/runs/{run_id}/rounds/{round_index}/...
    if (method === "GET" && tail.length >= 3 && tail[0] === "rounds") {
      const roundIndex = parsePathInt(tail[1]);
      const kind = tail[2];
      const stateForRun = await _stateOr404(registry, runId);
      if (kind === "artifacts" && tail.length === 3) {
        sendJson(res, 200, {
          run_id: runId,
          round_index: roundIndex,
          artifacts: stateForRun.listRoundArtifacts(roundIndex),
        });
        return;
      }
      if (kind === "artifacts" && tail.length === 4) {
        artifactText(res, stateForRun, roundIndex, tail[3]);
        return;
      }
      if (kind === "artifacts" && tail.length === 5 && tail[4] === "raw") {
        rawArtifact(res, stateForRun, roundIndex, tail[3]);
        return;
      }
      if (kind === "trajectory" && tail.length === 4) {
        trajectory(res, stateForRun, runId, roundIndex, tail[3]);
        return;
      }
      throw new HttpError(404, "Not Found");
    }
    // POST /api/runs/{run_id}/instructions
    if (method === "POST" && tail.length === 1 && tail[0] === "instructions") {
      await instructions(req, res, runId, body);
      return;
    }
    // POST /api/runs/{run_id}/approvals/{approval_id}/resolve
    if (method === "POST" && tail.length === 3 && tail[0] === "approvals" && tail[2] === "resolve") {
      await resolveApproval(req, res, runId, tail[1], body);
      return;
    }
    // POST /api/runs/{run_id}/abort | stop
    if (method === "POST" && tail.length === 1 && (tail[0] === "abort" || tail[0] === "stop")) {
      const kind = tail[0];
      await _stateOr404(registry, runId);
      if (supervisor === null) {
        throw new HttpError(501, `${kind} requires the standalone Web supervisor`);
      }
      try {
        const result = (kind === "abort" ? supervisor.abort(runId) : supervisor.stop(runId)) as Dict;
        sendJson(res, 200, { ok: true, ...result });
      } catch (exc) {
        if (exc instanceof HttpError) throw exc;
        throw new HttpError(409, exc instanceof Error ? exc.message : String(exc));
      }
      return;
    }
    // POST /api/runs/{run_id}/resume
    if (method === "POST" && tail.length === 1 && tail[0] === "resume") {
      await resume(req, res, runId, body);
      return;
    }
    // GET /api/runs/{run_id}/status
    if (method === "GET" && tail.length === 1 && tail[0] === "status") {
      await _stateOr404(registry, runId);
      if (supervisor === null) {
        sendJson(res, 200, { run_id: runId, status: "attached", managed: false });
        return;
      }
      const managedStatus = supervisor.status(runId) as Dict;
      sendJson(res, 200, {
        run_id: runId,
        managed: managedStatus.managed !== false,
        ...managedStatus,
        owner: _publicOwner((supervisor.owner(runId)) as Dict),
      });
      return;
    }
    // GET /api/runs/{run_id}/commands/{command_id}
    if (method === "GET" && tail.length === 2 && tail[0] === "commands") {
      await _stateOr404(registry, runId);
      if (supervisor === null) {
        throw new HttpError(404, "command receipts are available for supervised runs");
      }
      const receipt = await supervisor.commandReceipt(runId, tail[1]);
      if (receipt === null || receipt === undefined) {
        throw new HttpError(404, "command receipt not found");
      }
      sendJson(res, 200, receipt);
      return;
    }
    throw new HttpError(404, "Not Found");
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    if (staticDir === null) throw new HttpError(404, "Not Found");
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method Not Allowed");
    const relative = decodeSegment(url.pathname).replace(/^\/+/, "");
    const candidate = relative === "" ? "index.html" : relative;
    const root = path.resolve(staticDir);
    const resolved = path.resolve(root, candidate);
    let target: string | null = null;
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      if (isDirectory(resolved)) {
        const index = path.join(resolved, "index.html");
        if (fs.existsSync(index)) target = index;
      } else if (fs.existsSync(resolved)) {
        target = resolved;
      }
    }
    if (target === null) {
      // Single-page app: unknown paths fall back to the shell.
      const index = path.join(root, "index.html");
      if (!fs.existsSync(index)) throw new HttpError(404, "Not Found");
      target = index;
    }
    const suffix = path.extname(target).toLowerCase();
    const mediaType = _STATIC_MIME_TYPES[suffix] || "application/octet-stream";
    const content = fs.readFileSync(target);
    const contentType =
      mediaType.startsWith("text/") || mediaType === "application/javascript"
        ? `${mediaType}; charset=utf-8`
        : mediaType;
    if (method === "HEAD") {
      applySecurityHeaders(res);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(content.length));
      res.statusCode = 200;
      res.end();
      return;
    }
    sendResponse(res, 200, content, { "Content-Type": contentType });
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer | null): Promise<void> {
    const method = req.method || "GET";
    const segments = url.pathname.split("/").filter((item) => item !== "").map(decodeSegment);
    const params = url.searchParams;

    if (segments[0] === "api") {
      // GET /api/meta
      if (method === "GET" && segments.length === 2 && segments[1] === "meta") {
        sendJson(res, 200, await metaResponse(req, false));
        return;
      }
      // POST /api/models/refresh
      if (method === "POST" && segments.length === 3 && segments[1] === "models" && segments[2] === "refresh") {
        sendJson(res, 200, await metaResponse(req, true));
        return;
      }
      // POST /api/service/reload — restart the service on current source.
      if (method === "POST" && segments.length === 3 && segments[1] === "service" && segments[2] === "reload") {
        if (!options.onReload) throw new HttpError(501, "reload is not enabled for this deployment");
        sendJson(res, 200, { ok: true, detail: "restarting" });
        // Let the response flush before the listener goes away.
        setTimeout(() => options.onReload?.(), 250);
        return;
      }
      // GET /api/uploads (POST is handled before the JSON middleware)
      if (method === "GET" && segments.length === 2 && segments[1] === "uploads") {
        listUploads(res, params);
        return;
      }
      // GET|POST /api/runs
      if (segments.length === 2 && segments[1] === "runs") {
        if (method === "GET") {
          const result: Dict[] = [];
          for (const item of await registry.runItems()) {
            const itemRunId = String(item.id || "");
            result.push(buildRunSummary(item, { state: await registry.stateFor(itemRunId) }));
          }
          sendJson(res, 200, { runs: result });
          return;
        }
        if (method === "POST") {
          await createRun(req, res, body);
          return;
        }
        throw new HttpError(405, "Method Not Allowed");
      }
      if (segments.length >= 3 && segments[1] === "runs") {
        await runRoutes(req, res, segments[2], segments.slice(3), method, params, body);
        return;
      }
      throw new HttpError(404, "Not Found");
    }

    // Static SPA bundle (mounted last so /api/* wins).
    await serveStatic(req, res, url, method);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://placeholder");
    } catch {
      sendDetail(res, 400, "invalid request target");
      return;
    }
    // Static assets remain public so a browser can render the login-free
    // shell, but every API route shares one authentication boundary when a
    // token is configured.
    if (_isLoopbackHost(bindHost) && !_hostHeaderAllowed(headerValue(req.headers, "host") || "", bindHost)) {
      sendDetail(res, 403, "host is not allowed");
      return;
    }
    const authenticated = _bearerMatches(headerValue(req.headers, "authorization"), token);
    if (token && url.pathname.startsWith("/api/") && !authenticated) {
      sendDetail(res, 401, "invalid or missing bearer token", { "WWW-Authenticate": "Bearer" });
      return;
    }
    let body: Buffer | null = null;
    const method = req.method || "GET";
    if (method === "POST" && url.pathname === "/api/uploads") {
      try {
        await handleUpload(req, res, url);
      } catch (exc) {
        if (exc instanceof HttpError) sendDetail(res, exc.status, exc.detail, exc.headers);
        else sendDetail(res, 500, exc instanceof Error ? exc.message : String(exc));
      }
      return;
    }
    if (["POST", "PUT", "PATCH"].includes(method) && url.pathname.startsWith("/api/")) {
      const contentType = headerValue(req.headers, "content-type");
      if (!_isJsonContentType(contentType)) {
        sendDetail(res, 415, "request must be application/json");
        return;
      }
      const contentLength = headerValue(req.headers, "content-length");
      if (contentLength !== undefined) {
        if (!/^[+-]?\d+$/.test(contentLength.trim())) {
          sendDetail(res, 400, "invalid content-length");
          return;
        }
        const declared = Number.parseInt(contentLength.trim(), 10);
        if (declared < 0) {
          sendDetail(res, 400, "invalid content-length");
          return;
        }
        if (declared > _MAX_CONTROL_BODY_BYTES) {
          sendDetail(res, 413, "request body is too large");
          return;
        }
      }
      body = await _cacheBoundedRequestBody(req, _MAX_CONTROL_BODY_BYTES);
      if (body === null) {
        sendDetail(res, 413, "request body is too large");
        return;
      }
    }
    try {
      await route(req, res, url, body);
    } catch (exc) {
      if (exc instanceof HttpError) {
        sendDetail(res, exc.status, exc.detail, exc.headers);
        return;
      }
      sendDetail(res, 500, exc instanceof Error ? exc.message : String(exc));
    }
  }

  function acceptThenClose(
    req: IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    code: number,
    reason: string,
  ): void {
    // Starlette rejects the handshake; a WebSocket close code is the only way
    // to give a browser client the same signal, so complete the upgrade and
    // close immediately with the documented code.  The public auth marker is
    // echoed when it was offered: a client that requested subprotocols and gets
    // none back tears the socket down as 1006 and never sees the real code.
    const offered = String(headerValue(req.headers, "sec-websocket-protocol") || "")
      .split(",")
      .map((item) => pyStrip(item));
    if (offered.includes(_WS_AUTH_MARKER)) pendingSubprotocols.set(req, _WS_AUTH_MARKER);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(code, reason);
    });
  }

  async function streamLoop(
    ws: WebSocket,
    stateForRun: DashboardState,
    runId: string,
    replay: number,
    after: string | null,
  ): Promise<void> {
    let closed = false;
    let notifyClosed: () => void = () => undefined;
    const closedPromise = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    // Clients close with their own codes (4008 heartbeat timeout, 4400 resync
    // required); any close simply ends this loop.
    ws.on("close", () => {
      closed = true;
      notifyClosed();
    });
    ws.on("error", () => {
      closed = true;
      notifyClosed();
    });
    ws.on("message", () => undefined);

    const send = (frame: Dict): boolean => {
      if (closed || ws.readyState !== ws.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    };

    try {
      const initialSnapshot = await _snapshotFor(registry, stateForRun, runId);
      if (!send({ kind: "snapshot", data: initialSnapshot })) return;
      let lastProjectionSignature = _streamProjectionSignature(initialSnapshot);
      const tailer = _eventTailer(stateForRun, runId);
      let cursor = after;
      let initial = replay ? tailer.read({ limit: Math.max(1, replay), after }) : [];
      if (tailer.last_resync_required) {
        send({
          kind: "resync_required",
          cursor: after,
          diagnostics: { warnings: tailer.last_warnings },
        });
        // A gap invalidates deltas.  Start the live cursor at the current
        // tail so subsequent frames are contiguous after the snapshot.
        const currentTail = tailer.read({ limit: 1 });
        cursor = currentTail.length ? currentTail[currentTail.length - 1].event_id : null;
        initial = [];
      }
      if (!replay && after === null) {
        const existing = tailer.read({ limit: 5000 });
        cursor = existing.length ? existing[existing.length - 1].event_id : null;
      }
      for (const item of initial) {
        if (!send({ kind: "event", data: item.toDict() })) return;
        cursor = item.event_id;
      }
      let idleTicks = 0;
      while (!closed) {
        let fresh = tailer.read({ limit: 5000, after: cursor });
        if (tailer.last_resync_required) {
          send({
            kind: "resync_required",
            cursor,
            diagnostics: { warnings: tailer.last_warnings },
          });
          // The requested cursor is absent, so last_last_event_id is that
          // same missing value.  Move to the retained tail after sending a
          // fresh snapshot; otherwise every poll repeats the same gap.
          const currentTail = tailer.read({ limit: 1 });
          cursor = currentTail.length ? currentTail[currentTail.length - 1].event_id : null;
          send({ kind: "snapshot", data: await _snapshotFor(registry, stateForRun, runId) });
          fresh = [];
        }
        if (fresh.length) {
          idleTicks = 0;
          for (const item of fresh) {
            if (!send({ kind: "event", data: item.toDict() })) return;
            cursor = item.event_id;
          }
          // Round files, approvals, and active-role state change beside the
          // event log. Refresh the projection after each batch so clients do
          // not need to independently poll every file.
          const updatedSnapshot = await _snapshotFor(registry, stateForRun, runId);
          send({ kind: "snapshot", data: updatedSnapshot });
          lastProjectionSignature = _streamProjectionSignature(updatedSnapshot);
        } else {
          idleTicks += 1;
          // Lifecycle and operator commands live outside the role event log.
          // Poll their projection once per second in both supervised and
          // attached modes.
          if (idleTicks % 4 === 0) {
            const updatedSnapshot = await _snapshotFor(registry, stateForRun, runId);
            const projectionSignature = _streamProjectionSignature(updatedSnapshot);
            if (projectionSignature !== lastProjectionSignature) {
              send({ kind: "snapshot", data: updatedSnapshot });
              lastProjectionSignature = projectionSignature;
            }
          }
          if (idleTicks >= 40) {
            send({ kind: "heartbeat" });
            idleTicks = 0;
          }
        }
        // Observe client/server close frames instead of only finding out on
        // the next heartbeat send.
        await Promise.race([sleep(250), closedPromise]);
      }
    } catch {
      try {
        ws.close();
      } catch {
        // The socket is already gone.
      }
    }
  }

  async function streamUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://placeholder");
    } catch {
      socket.destroy();
      return;
    }
    const segments = url.pathname.split("/").filter((item) => item !== "").map(decodeSegment);
    if (!(segments.length === 4 && segments[0] === "api" && segments[1] === "runs" && segments[3] === "stream")) {
      socket.destroy();
      return;
    }
    const runId = segments[2];
    let replay: number;
    let after: string | null;
    try {
      replay = queryInt(url.searchParams, "replay", 100, { ge: 0, le: 5000 });
      after = _boundedCursor(url.searchParams.get("after"));
    } catch {
      acceptThenClose(req, socket, head, 4400, "invalid stream parameters");
      return;
    }
    const stateForRun = await registry.stateFor(runId);
    if (stateForRun === null) {
      acceptThenClose(req, socket, head, 4404, "run not found");
      return;
    }
    const origin = headerValue(req.headers, "origin") || null;
    const host = headerValue(req.headers, "host") || "";
    if (_isLoopbackHost(bindHost) && !_hostHeaderAllowed(host, bindHost)) {
      acceptThenClose(req, socket, head, 4403, "host is not allowed");
      return;
    }
    const [authenticated, selectedSubprotocol] = _websocketAuth(req.headers, token);
    if (!authenticated) {
      acceptThenClose(req, socket, head, 4401, "invalid or missing bearer token");
      return;
    }
    if (!_originAllowed(origin, host, origins)) {
      acceptThenClose(req, socket, head, 4403, "origin is not allowed");
      return;
    }
    if (selectedSubprotocol !== null) pendingSubprotocols.set(req, selectedSubprotocol);
    wss.handleUpgrade(req, socket, head, (ws) => {
      void streamLoop(ws, stateForRun, runId, replay, after);
    });
  }

  function handleUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): void {
    void streamUpgrade(req, socket, head);
  }

  async function shutdown(): Promise<void> {
    for (const client of wss.clients) {
      try {
        client.close();
      } catch {
        // Ignore sockets that already went away.
      }
    }
    wss.close();
    if (supervisor !== null) {
      await supervisor.shutdown();
    }
  }

  return {
    registry,
    authToken: token,
    allowedOrigins: origins,
    bindHost,
    staticDir,
    handleRequest,
    handleUpgrade,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Server entry points
// ---------------------------------------------------------------------------

export type WebServerHandle = {
  url: string;
  host: string;
  port: number;
  state: DashboardState;
  app: WebApp;
  server: http.Server;
  close(): Promise<void>;
};

export type StartWebServerOptions = CreateAppOptions & {
  host?: string;
  port?: number;
  openBrowser?: boolean;
};

function displayUrl(host: string, port: number): string {
  let displayHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
  if (displayHost.includes(":") && !displayHost.startsWith("[")) displayHost = `[${displayHost}]`;
  return `http://${displayHost}:${port}/`;
}

/** Start the API server and return its handle (the Python daemon-thread port). */
export async function startWebServer(options: StartWebServerOptions = {}): Promise<WebServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8799;
  const token = _configuredToken(options.authToken ?? null);
  if (!_isLoopbackHost(host) && !token) {
    throw new Error(
      "refusing to expose the Web control API beyond localhost without LH_HARNESS_WEB_TOKEN (or --auth-token)",
    );
  }
  // ``bind_host`` is a separate create_app parameter upstream: it declares the
  // interface the API believes it is exposed on (Host allow-listing), which a
  // caller may set independently of the socket it actually binds.
  const app = createApp({ ...options, authToken: token, bindHost: options.bindHost ?? host });
  const server = http.createServer((req, res) => {
    void app.handleRequest(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    app.handleUpgrade(req, socket as net.Socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = displayUrl(host, boundPort);
  const handle: WebServerHandle = {
    url,
    host,
    port: boundPort,
    state: app.registry.baseState,
    app,
    server,
    async close(): Promise<void> {
      await app.shutdown();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
  if (options.openBrowser) {
    void openBrowserWhenReady(url);
  }
  return handle;
}

/** Run the optional control API in the foreground (``lh-harness web``). */
export async function runWebServer(options: {
  runsRoot?: string | null;
  logDir?: string | null;
  host?: string;
  port?: number;
  workspaceRoot?: string | null;
  authToken?: string | null;
  allowedOrigins?: Iterable<string> | null;
  supervisor?: RunSupervisor | null;
  /** See `CreateAppOptions.onReload`; when reload fires, resolve with exit code 87. */
  reloadable?: boolean;
}): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8799;
  const token = _configuredToken(options.authToken ?? null);
  if (!_isLoopbackHost(host) && !token) {
    throw new Error(
      "refusing to expose the Web control API beyond localhost without LH_HARNESS_WEB_TOKEN (or --auth-token)",
    );
  }
  const runId = options.logDir ? path.basename(path.dirname(path.resolve(expandUser(options.logDir)))) : null;
  const effectiveRoot = options.logDir ? null : options.runsRoot ?? null;
  // Standalone workbench (`lh-harness web` / `dashboard`): own the run
  // supervisor so the UI can create, stop, abort and resume runs. Pinning one
  // run's log dir (`--log-dir`) stays read-only, exactly as upstream.
  const supervisor =
    options.supervisor ??
    (effectiveRoot ? new RunSupervisor(effectiveRoot, { workspaceRoot: options.workspaceRoot ?? process.cwd() }) : null);
  let exitCode = 0;
  let requestReload: (() => void) | null = null;
  const handle = await startWebServer({
    logDir: options.logDir ?? null,
    runsRoot: effectiveRoot,
    runId,
    workspaceRoot: options.workspaceRoot ?? null,
    supervisor,
    authToken: token,
    allowedOrigins: options.allowedOrigins ?? null,
    host,
    port,
    onReload: options.reloadable ? () => requestReload?.() : null,
  });
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle
        .close()
        .then(() => (supervisor && !options.supervisor ? supervisor.shutdown() : undefined))
        .then(resolve);
    };
    requestReload = (): void => {
      // 87 tells the `start` wrapper (or the container restart policy, which
      // restarts on any exit) to bring the service back on current source.
      exitCode = 87;
      stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return exitCode;
}

// ---------------------------------------------------------------------------
// Browser opening (cli.py `_open_browser_when_ready`)
// ---------------------------------------------------------------------------

/** Poll ``url`` until it answers 200..499 (an auth page still proves it is up). */
export async function waitForDashboardReady(
  url: string,
  options: { timeout?: number; pollInterval?: number } = {},
): Promise<boolean> {
  const timeout = options.timeout ?? 10.0;
  const pollInterval = options.pollInterval ?? 0.05;
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now()) / 1000;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(0.5, remaining) * 1000)),
        redirect: "manual",
      });
      if (response.status >= 200 && response.status < 500) {
        try {
          await response.arrayBuffer();
        } catch {
          // The body is irrelevant; readiness is the status code.
        }
        return true;
      }
    } catch {
      // Not up yet.
    }
    await sleep(pollInterval * 1000);
  }
  return false;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {
      process.stdout.write(`Open this URL in a browser: ${url}\n`);
    });
    child.unref();
  } catch (exc) {
    process.stderr.write(`Could not open browser automatically: ${exc}; open ${url}\n`);
  }
}

/** Wait for readiness, then open a browser — used by `lh-harness run --dashboard`. */
export async function openBrowserWhenReady(url: string): Promise<void> {
  const ready = await waitForDashboardReady(url, { timeout: 10.0, pollInterval: 0.05 });
  if (!ready) {
    process.stderr.write(`Dashboard did not become ready in time; open ${url} manually.\n`);
    return;
  }
  openBrowser(url);
}
