// Ported 1:1 from LongHorizon-Harness src/lh_harness/dashboard/state.py
//
// Shared Web state: reads harness logs and holds human-approval records.
//
// The harness imports this state and the optional approval hook. The Web server
// projects the same state into its public snapshot and control APIs.
//
// On-disk logs are always read fresh from ``log_dir`` so the UI reflects live
// progress. Approval records are kept in memory. (The Python original guards them
// with a threading lock; a Node process has a single JS thread, so those critical
// sections are simply synchronous here.)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { DEFAULT_LOG_DIR, MAX_ROUNDS } from "../types.js";
import {
  ControlBus,
  appendJsonl,
  ensureDirNofollow,
  expandUser,
  openNofollow as openNofollowAnchored,
} from "../supervisor/control_bus.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, canonicalLifecycleStatus } from "../supervisor/lifecycle.js";
import {
  resolveNonStrict,
  safeRunDir,
  safeRunLogs,
  safeRunRole,
  safeRunRounds,
} from "../utils/run_boundary.js";
import { parseTrajectory as parseAgentTrajectory } from "../agent_logs.js";
import { readLoopSnapshot, type LoopSnapshot } from "../loop/state.js";
import { pyStrip } from "../utils/pystr.js";

// Roles whose episodes live under <logDir>/<role>_episodes/epNNN.
const TRAJECTORY_ROLES = [
  "prompt_tailor",
  "planner",
  "rubric",
  "composer",
  "evaluator",
  "final_response",
] as const;
const MAX_EPISODE_SEQ = 100_000;

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TRAJECTORY_BYTES = 16 * 1024 * 1024;
const MAX_TRAJECTORY_STEPS = 5_000;
const MAX_ROUND_TEXT_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSONL_BYTES = 8 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 512 * 1024;
const MAX_JSONL_RECORDS = 20_000;
const MAX_ARTIFACT_COUNT = 512;
const MAX_ARTIFACT_SCAN = 2_048;
const MAX_ARTIFACT_NAME_CHARS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// ``resolveNonStrict`` is the shared ``Path.resolve(strict=False)`` helper.
export { resolveNonStrict };

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function pathExists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Open a path for reading without following any path component symlink.
 *
 * ``strictParent`` mirrors the Python keyword: with ``false`` the parent is
 * canonicalised once (macOS exposes system roots as links) and only the final
 * component is protected by ``O_NOFOLLOW``.
 */
function openNofollow(
  target: string,
  options: { directory?: boolean; strictParent?: boolean } = {},
): number {
  const absolute = path.resolve(target);
  const anchored = options.strictParent
    ? absolute
    : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  return openNofollowAnchored(anchored, { directory: options.directory });
}

/**
 * Read a regular file through a no-follow descriptor with a byte cap.
 *
 * Returns ``[data, tooLarge]``.  For JSONL callers, ``tail=true`` retains a
 * complete suffix when the file exceeds the cap.  Non-tail callers receive a
 * bounded prefix together with ``tooLarge=true``; authoritative JSON and
 * artifact callers reject that result, while human-readable round text can show
 * the prefix with an explicit truncation marker.
 */
function readFileBounded(
  target: string,
  maxBytes: number,
  options: { tail: boolean; strictParent?: boolean },
): [Buffer | null, boolean] {
  let fd: number;
  try {
    fd = openNofollow(target, { strictParent: options.strictParent });
  } catch {
    return [null, false];
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return [null, false];
    const size = Number(info.size);
    const start = options.tail ? Math.max(0, size - maxBytes) : 0;
    // Read one extra byte so a file that grows after fstat cannot evade the bound.
    const chunks: Buffer[] = [];
    let remaining = maxBytes + 1;
    let position = start;
    while (remaining > 0) {
      const length = Math.min(remaining, 1024 * 1024);
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, position);
      if (!read) break;
      chunks.push(buffer.subarray(0, read));
      remaining -= read;
      position += read;
    }
    const data = Buffer.concat(chunks);
    const tooLarge = data.length > maxBytes;
    let raw = data.subarray(0, maxBytes);
    if (options.tail && start) {
      const firstNewline = raw.indexOf(0x0a);
      if (firstNewline < 0) return [Buffer.alloc(0), true];
      raw = raw.subarray(firstNewline + 1);
    }
    if (options.tail && raw.length && raw[raw.length - 1] !== 0x0a && raw[raw.length - 1] !== 0x0d) {
      const lastNewline = raw.lastIndexOf(0x0a);
      raw = lastNewline >= 0 ? raw.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    }
    return [raw, tooLarge];
  } catch {
    return [null, false];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function readTextBounded(
  target: string,
  maxBytes: number,
  options: { tail?: boolean; strictParent?: boolean } = {},
): [string | null, boolean] {
  const [data, tooLarge] = readFileBounded(target, maxBytes, {
    tail: options.tail ?? false,
    strictParent: options.strictParent,
  });
  if (data === null) return [null, tooLarge];
  return [data.toString("utf-8"), tooLarge];
}

function readJson(target: string, options: { strictParent?: boolean } = {}): unknown {
  const [text, tooLarge] = readTextBounded(target, MAX_JSON_BYTES, {
    tail: false,
    strictParent: options.strictParent,
  });
  if (text === null || tooLarge) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readJsonl(target: string, options: { strictParent?: boolean } = {}): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const [raw] = readTextBounded(target, MAX_JSONL_BYTES, {
    tail: true,
    strictParent: options.strictParent,
  });
  if (raw === null) return records;
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    const line = pyStrip(rawLine);
    if (!line) continue;
    if (Buffer.byteLength(line, "utf-8") > MAX_JSONL_LINE_BYTES) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(record)) {
      records.push(record);
      if (records.length >= MAX_JSONL_RECORDS) break;
    }
  }
  return records;
}

/**
 * Clamp an operator-supplied extra-round count to a safe budget.
 *
 * ``0`` means "use the manager's configured budget".  The value crosses the
 * HTTP boundary and is replayed from an on-disk command, so anything that is
 * not a plain in-range integer is rejected as 0 rather than trusted.
 */
export function normaliseExtraRounds(value: unknown): number {
  if (value === null || value === undefined || typeof value === "boolean") return 0;
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    const text = pyStrip(candidate);
    if (!text) return 0;
    if (!/^[+-]?\d+$/.test(text)) return 0;
    candidate = Number.parseInt(text, 10);
  }
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) return 0;
  if (candidate <= 0) return 0;
  return Math.min(candidate, MAX_ROUNDS);
}

/** One selectable answer shown as a button in the approval dialog. */
export class ApprovalOption {
  value: string;
  label: string;
  style: string;

  constructor(value: string, label: string, style = "") {
    this.value = value;
    this.label = label;
    this.style = style;
  }

  toDict(): Record<string, unknown> {
    return { value: this.value, label: this.label, style: this.style };
  }
}

export interface ApprovalInit {
  approval_id: string;
  title: string;
  message?: string;
  options?: ApprovalOption[];
  answers?: string[];
  allow_input?: boolean;
  input_label?: string;
  allow_extra_rounds?: boolean;
  context?: Record<string, unknown>;
  status?: string;
  action?: string;
  reason?: string;
  user_input?: string;
  extra_rounds?: number;
  created_at?: number;
  resolved_at?: number | null;
}

/**
 * A single human-in-the-loop checkpoint (a question with options).
 *
 * Request fields (shown in the dialog): ``title``, ``message``, ``options``,
 * ``allow_input`` / ``input_label``. Response fields (filled on resolve):
 * ``action`` (the chosen option value), ``reason`` (optional why), and
 * ``user_input`` (free-form text). ``context`` carries extensible metadata
 * (e.g. ``phase``, ``kind``, ``round_index``) without widening the schema.
 */
export class Approval {
  approval_id: string;
  title: string;
  message: string;
  options: ApprovalOption[];
  answers: string[]; // quick-answer choices (e.g. Yes/No)
  allow_input: boolean;
  input_label: string;
  // Round-budget gates additionally offer a number: how many rounds to grant.
  allow_extra_rounds: boolean;
  context: Record<string, unknown>;
  status: string; // pending | resolved
  // --- response ---
  action: string;
  reason: string;
  user_input: string;
  extra_rounds: number; // 0 -> use the manager's configured budget
  created_at: number;
  resolved_at: number | null;

  constructor(init: ApprovalInit) {
    this.approval_id = init.approval_id;
    this.title = init.title;
    this.message = init.message ?? "";
    this.options = init.options ?? [];
    this.answers = init.answers ?? [];
    this.allow_input = init.allow_input ?? true;
    this.input_label = init.input_label ?? "";
    this.allow_extra_rounds = init.allow_extra_rounds ?? false;
    this.context = init.context ?? {};
    this.status = init.status ?? "pending";
    this.action = init.action ?? "";
    this.reason = init.reason ?? "";
    this.user_input = init.user_input ?? "";
    this.extra_rounds = init.extra_rounds ?? 0;
    this.created_at = init.created_at ?? Date.now() / 1000;
    this.resolved_at = init.resolved_at ?? null;
  }

  get round_index(): number {
    const value = this.context.round_index;
    const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? 0), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  toDict(): Record<string, unknown> {
    return {
      approval_id: this.approval_id,
      title: this.title,
      message: this.message,
      options: this.options.map((option) => option.toDict()),
      answers: [...this.answers],
      allow_input: this.allow_input,
      input_label: this.input_label,
      allow_extra_rounds: this.allow_extra_rounds,
      context: this.context,
      round_index: this.round_index,
      status: this.status,
      action: this.action,
      reason: this.reason,
      user_input: this.user_input,
      extra_rounds: this.extra_rounds,
      created_at: this.created_at,
      resolved_at: this.resolved_at,
    };
  }
}

/** Both spellings are accepted so HTTP and manager callers can use either. */
export interface ResolveApprovalOptions {
  action: string;
  reason?: string;
  user_input?: string;
  userInput?: string;
  extra_rounds?: number | null;
  extraRounds?: number | null;
  command_id?: string | null;
  commandId?: string | null;
  expected_revision?: number | null;
  expectedRevision?: number | null;
}

export interface AddInjectionOptions {
  command_id?: string | null;
  commandId?: string | null;
  expected_revision?: number | null;
  expectedRevision?: number | null;
}

export interface DashboardStateOptions {
  task?: string;
  runsRoot?: string | null;
  controlEnabled?: boolean;
}

/** Store bridging the management loop and the web server. */
export class DashboardState {
  runsRoot: string | null;
  // Python attribute names are kept available as aliases (``log_dir``,
  // ``control_enabled``, ``control_bus``, ``role_dir``) so either spelling works
  // from the API layer and the manager loop.
  logDir: string;
  task: string;
  controlEnabled: boolean;
  controlBus: ControlBus;

  private approvals = new Map<string, Approval>();
  private approvalOrder: string[] = [];
  // Free-form operator notes to inject into upcoming manager prompts,
  // independent of a blocking approval checkpoint.  Vestigial: the control bus
  // is the real queue.
  private pendingInjections: string[] = [];

  constructor(logDir: string | null = null, options: DashboardStateOptions = {}) {
    // When only a runsRoot is given (manual dashboard browsing), the newest run
    // is auto-selected so the UI shows something immediately; the user can
    // switch to any other run from the UI.
    this.runsRoot = options.runsRoot ? resolveNonStrict(options.runsRoot) : null;
    let resolved: string | null = logDir ? String(logDir) : null;
    if (resolved === null && this.runsRoot !== null) {
      const runs = this.scanRuns();
      if (runs.length) resolved = String(runs[0].log_dir);
    }
    this.logDir = resolveNonStrict(resolved ?? DEFAULT_LOG_DIR);
    this.task = options.task ?? "";
    this.controlEnabled = options.controlEnabled ?? false;
    this.controlBus = new ControlBus(path.dirname(this.logDir));
  }

  /** ``state.log_dir`` — the Python attribute name. */
  get log_dir(): string {
    return this.logDir;
  }

  set log_dir(value: string) {
    this.logDir = value;
  }

  /** ``state.control_enabled`` — the Python attribute name. */
  get control_enabled(): boolean {
    return this.controlEnabled;
  }

  set control_enabled(value: boolean) {
    this.controlEnabled = value;
  }

  /** ``state.control_bus`` — the Python attribute name. */
  get control_bus(): ControlBus {
    return this.controlBus;
  }

  // ------------------------------------------------------------------
  // Run selection (manual dashboard browsing across per-run result folders)
  // ------------------------------------------------------------------
  private scanRuns(): Record<string, unknown>[] {
    const root = this.runsRoot;
    if (root === null) return [];
    if (!isDirectory(root)) return [];
    const runs: Record<string, unknown>[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(root).sort();
    } catch {
      return runs;
    }
    for (const name of entries) {
      const runDir = safeRunDir(root, name);
      if (runDir === null || !isDirectory(runDir)) continue;
      // New runs use lh_harness/role_orchestration; the boundary helper
      // safeRunRole also accepts the legacy Dashboard layout.
      const logDir = safeRunLogs(root, runDir, { requireRoleManagement: true, allowMissing: false });
      if (logDir === null) continue;
      if (safeRunRounds(root, runDir, { allowMissing: true }) === null) continue;
      const roleDir = safeRunRole(root, runDir, { allowMissing: false });
      if (roleDir === null) continue;
      let mtime = 0.0;
      try {
        mtime = fs.statSync(roleDir).mtimeMs / 1000;
      } catch {
        mtime = 0.0;
      }
      const report = readJson(path.join(logDir, "report.json"), { strictParent: true });
      const status = isRecord(report) ? report.status : null;
      runs.push({
        id: name,
        log_dir: String(logDir),
        mtime,
        status: status || "",
      });
    }
    runs.sort((left, right) => Number(right.mtime) - Number(left.mtime));
    return runs;
  }

  listRuns(): Record<string, unknown>[] {
    return this.scanRuns();
  }

  selectRun(runId: string): boolean {
    const root = this.runsRoot;
    if (
      root === null ||
      typeof runId !== "string" ||
      !runId ||
      runId.length > 128 ||
      runId.includes("/") ||
      runId.includes("\\") ||
      runId === "." ||
      runId === ".." ||
      [...runId].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)
    ) {
      return false;
    }
    const runDir = safeRunDir(root, runId);
    if (runDir === null || !isDirectory(runDir)) return false;
    const logDir = safeRunLogs(root, runDir, { requireRoleManagement: true, allowMissing: false });
    if (logDir === null) return false;
    if (safeRunRounds(root, runDir, { allowMissing: true }) === null) return false;
    this.logDir = logDir;
    this.task = ""; // will be re-read from the selected run's report
    return true;
  }

  get currentRunId(): string {
    if (this.runsRoot === null) return "";
    const parent = path.dirname(this.logDir);
    const root = resolveNonStrict(this.runsRoot);
    if (isInside(parent, root) && parent !== root) {
      const relative = path.relative(root, parent);
      const first = relative.split(path.sep)[0];
      if (first) return first;
    }
    return path.basename(parent);
  }

  // ------------------------------------------------------------------
  // On-disk log reading (always fresh so the UI tracks live progress)
  // ------------------------------------------------------------------
  private get roleDirPath(): string {
    const canonical = path.join(this.logDir, "role_orchestration");
    const legacy = path.join(this.logDir, "role_management");
    try {
      if (pathExists(canonical) || isSymlink(canonical)) return canonical;
      if (pathExists(legacy) || isSymlink(legacy)) return legacy;
    } catch {
      /* fall through */
    }
    // New/custom log directories always use the canonical layout. The legacy
    // path is selected only when it actually exists.
    return canonical;
  }

  /** Canonical role ledger path used by REST/WebSocket projections. */
  get roleDir(): string {
    return this.roleDirPath;
  }

  /** ``state.role_dir`` — the Python attribute name. */
  get role_dir(): string {
    return this.roleDirPath;
  }

  readReport(): Record<string, unknown> {
    for (const candidate of [
      path.join(this.logDir, "report.json"),
      path.join(this.roleDirPath, "report.json"),
    ]) {
      const data = readJson(candidate, { strictParent: true });
      if (isRecord(data)) return data;
    }
    return {};
  }

  // ------------------------------------------------------------------
  // Loop state projection (plan tree, subtasks, episodes)
  // ------------------------------------------------------------------
  /** The run directory that owns this log dir (``<run>/lh_harness`` → ``<run>``). */
  get runDir(): string {
    return path.dirname(this.logDir);
  }

  readLoop(): LoopSnapshot {
    try {
      return readLoopSnapshot(this.runDir, this.logDir);
    } catch {
      return {
        phase: null,
        task: "",
        config: null,
        plan: null,
        plan_markdown: "",
        plan_revisions: [],
        status_counts: null,
        briefings: {},
        research: [],
        research_notes: [],
        subtasks: [],
        episodes: [],
        cost_usd: 0,
        composer_episodes: 0,
        decisions: "",
        final_response: "",
      };
    }
  }

  readEvents(options: { limit?: number } = {}): Record<string, unknown>[] {
    const events = readJsonl(path.join(this.roleDirPath, "events.jsonl"), { strictParent: true });
    const boundedLimit = Math.max(1, Math.min(Math.trunc(options.limit ?? 500), 5_000));
    return events.slice(-boundedLimit);
  }

  // ------------------------------------------------------------------
  // State files (<run>/state/...): plan, rubrics, progress, evidence, context
  // ------------------------------------------------------------------
  private get stateRoot(): string | null {
    const candidate = path.join(this.runDir, "state");
    try {
      if (isSymlink(candidate) || !isDirectory(candidate)) return null;
      const resolved = fs.realpathSync(candidate);
      if (this.runsRoot !== null && !isInside(resolved, this.runsRoot)) return null;
      return resolved;
    } catch {
      return null;
    }
  }

  /** Resolve a relative state path (no traversal, no symlinks) to an absolute regular file or directory. */
  resolveStateFile(relative: string): string | null {
    if (typeof relative !== "string" || !relative || relative.length > 1024) return null;
    if ([...relative].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) return null;
    const parts = relative.split("/").filter((part) => part);
    if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\\") || part.length > MAX_ARTIFACT_NAME_CHARS)) return null;
    const root = this.stateRoot;
    if (root === null) return null;
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        if (isSymlink(current)) return null;
        const resolved = fs.realpathSync(current);
        if (!isInside(resolved, root)) return null;
        current = resolved;
      } catch {
        return null;
      }
    }
    return current;
  }

  listStateDir(relative: string): string[] {
    const target = relative ? this.resolveStateFile(relative) : this.stateRoot;
    if (target === null || !isDirectory(target)) return [];
    try {
      return fs
        .readdirSync(target)
        .filter((name) => !isSymlink(path.join(target, name)))
        .slice(0, MAX_ARTIFACT_COUNT)
        .sort();
    } catch {
      return [];
    }
  }

  stateFileSize(relative: string): number | null {
    const target = this.resolveStateFile(relative);
    if (target === null) return null;
    try {
      const fd = openNofollow(target, { strictParent: true });
      try {
        const info = fs.fstatSync(fd);
        return info.isFile() ? Number(info.size) : null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  readStateFile(relative: string): string | null {
    const bytes = this.readStateFileBytes(relative);
    return bytes === null ? null : bytes.toString("utf-8");
  }

  readStateFileBytes(relative: string): Buffer | null {
    const target = this.resolveStateFile(relative);
    if (target === null) return null;
    const [data, tooLarge] = readFileBounded(target, MAX_ARTIFACT_BYTES, { tail: false, strictParent: true });
    if (tooLarge || data === null) return null;
    return data;
  }

  // ------------------------------------------------------------------
  // Episode trajectories: <logDir>/<role>_episodes/epNNN
  // ------------------------------------------------------------------
  private safeEpisodeDir(role: string, seq: number): string | null {
    if (!(TRAJECTORY_ROLES as readonly string[]).includes(role)) return null;
    if (!Number.isInteger(seq) || seq < 1 || seq > MAX_EPISODE_SEQ) return null;
    const root = path.join(this.logDir, `${role}_episodes`);
    const candidate = path.join(root, `ep${String(seq).padStart(3, "0")}`);
    try {
      if (isSymlink(root) || isSymlink(candidate)) return null;
      const resolvedRoot = fs.realpathSync(root);
      const resolved = fs.realpathSync(candidate);
      if (this.runsRoot !== null && !isInside(resolvedRoot, this.runsRoot)) return null;
      if (!isInside(resolved, resolvedRoot)) return null;
      return isDirectory(resolved) ? resolved : null;
    } catch {
      return null;
    }
  }

  /** Episode number from an index entry's absolute dir (``.../composer_episodes/ep004`` → 4). */
  static episodeSeqFromDir(dir: string): { role: string; ep: number } | null {
    const match = /([a-z_]+)_episodes[\/\\]ep(\d{3,})$/.exec(dir);
    if (!match) return null;
    return { role: match[1]!, ep: Number.parseInt(match[2]!, 10) };
  }

  listEpisodeArtifacts(role: string, seq: number): string[] {
    const dir = this.safeEpisodeDir(role, seq);
    if (dir === null) return [];
    try {
      return fs.readdirSync(dir).filter((name) => !isSymlink(path.join(dir, name)) && fs.statSync(path.join(dir, name)).isFile()).slice(0, MAX_ARTIFACT_COUNT).sort();
    } catch {
      return [];
    }
  }

  resolveEpisodeArtifact(role: string, seq: number, name: string): string | null {
    if (typeof name !== "string" || name.length > MAX_ARTIFACT_NAME_CHARS) return null;
    if ([...name].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) return null;
    if (name.includes("/") || name.includes("\\") || name === "" || name === "." || name === "..") return null;
    const dir = this.safeEpisodeDir(role, seq);
    if (dir === null) return null;
    try {
      const candidate = path.join(dir, name);
      if (isSymlink(candidate)) return null;
      const target = fs.realpathSync(candidate);
      if (!isInside(target, dir) || isSymlink(target) || !fs.statSync(target).isFile()) return null;
      return target;
    } catch {
      return null;
    }
  }

  readEpisodeArtifactBytes(role: string, seq: number, name: string): Buffer | null {
    const target = this.resolveEpisodeArtifact(role, seq, name);
    if (target === null) return null;
    const [data, tooLarge] = readFileBounded(target, MAX_ARTIFACT_BYTES, { tail: false, strictParent: true });
    if (tooLarge || data === null) return null;
    return data;
  }

  episodeArtifactSize(role: string, seq: number, name: string): number | null {
    const target = this.resolveEpisodeArtifact(role, seq, name);
    if (target === null) return null;
    try {
      const fd = openNofollow(target, { strictParent: true });
      try {
        const info = fs.fstatSync(fd);
        return info.isFile() ? Number(info.size) : null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /** Parse one episode's trajectory (normalised when present, else the provider stream). */
  readTrajectory(role: string, seq: number): Record<string, unknown> | null {
    const dir = this.safeEpisodeDir(role, seq);
    if (dir === null) return null;
    const normalizedPath = this.resolveEpisodeArtifact(role, seq, `${role}_trajectory.jsonl`);
    const trajectoryPath = normalizedPath ?? this.resolveEpisodeArtifact(role, seq, `${role}_raw_trajectory.jsonl`);
    if (trajectoryPath === null) return null;
    const [data, tooLarge] = readFileBounded(trajectoryPath, MAX_TRAJECTORY_BYTES, { tail: false, strictParent: true });
    if (tooLarge) {
      return { role, episode: seq, steps: [], step_count: 0, raw_chars: 0, warning: "trajectory is too large to render" };
    }
    if (data === null) return null;
    const raw = data.toString("utf-8");
    let steps: Record<string, unknown>[];
    if (normalizedPath !== null) {
      const recent: Record<string, unknown>[] = [];
      for (const line of raw.split(/\r\n|\r|\n/)) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (isRecord(record)) {
          recent.push(record);
          if (recent.length > MAX_TRAJECTORY_STEPS + 1) recent.shift();
        }
      }
      steps = recent;
    } else {
      steps = parseAgentTrajectory(raw, MAX_TRAJECTORY_STEPS + 1) as Record<string, unknown>[];
    }
    const stepsTruncated = steps.length > MAX_TRAJECTORY_STEPS;
    steps = deduplicateFinalText(steps);
    if (stepsTruncated) steps = steps.slice(-MAX_TRAJECTORY_STEPS);
    const result: Record<string, unknown> = {
      role,
      episode: seq,
      steps,
      step_count: steps.length,
      raw_chars: raw.length,
      trajectory_source: normalizedPath !== null ? "normalized" : "provider_raw",
    };
    if (stepsTruncated) {
      result.steps_truncated = true;
      result.warning = `trajectory has more than ${MAX_TRAJECTORY_STEPS} steps; showing the latest ${MAX_TRAJECTORY_STEPS}`;
    }
    return result;
  }

  snapshot(): Record<string, unknown> {
    const report = this.readReport();
    let [finalResponse] = readTextBounded(
      path.join(this.roleDirPath, "final_response.txt"),
      MAX_ROUND_TEXT_BYTES,
      { tail: false, strictParent: true },
    );
    if (!finalResponse && typeof report.final_response === "string") {
      finalResponse = report.final_response;
    }
    const loop = this.readLoop();
    return {
      task: this.task || loop.task || report.task || "",
      log_dir: String(this.logDir),
      runs: this.listRuns(),
      current_run: this.currentRunId,
      report,
      final_response: finalResponse || loop.final_response || "",
      loop,
      events: this.readEvents({ limit: 200 }),
      approvals: this.listApprovals(),
      operator_messages: this.listOperatorMessages(),
      pending_injections: this.listInjections(),
      control_enabled: this.controlEnabled,
      server_time: Date.now() / 1000,
    };
  }

  // ------------------------------------------------------------------
  // Human approval records
  // ------------------------------------------------------------------
  createApproval(options: {
    title: string;
    message?: string;
    options?: ApprovalOption[] | null;
    answers?: string[] | null;
    allow_input?: boolean;
    input_label?: string;
    allow_extra_rounds?: boolean;
    context?: Record<string, unknown> | null;
  }): Approval {
    const approval = new Approval({
      approval_id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      title: options.title,
      message: options.message ?? "",
      options: [...(options.options ?? [])],
      answers: [...(options.answers ?? [])],
      allow_input: options.allow_input ?? true,
      input_label: options.input_label ?? "",
      allow_extra_rounds: options.allow_extra_rounds ?? false,
      context: options.context ?? {},
    });
    this.approvals.set(approval.approval_id, approval);
    this.approvalOrder.push(approval.approval_id);
    // Persist to the run's log dir so every human interaction is saved and
    // visible on the web even after the run ends or from a browsing session.
    this.persistApproval(approval.toDict());
    return approval;
  }

  resolveApproval(approvalId: string, options: ResolveApprovalOptions): boolean {
    if (!this.controlEnabled) return false;
    const commandIdOption = options.command_id ?? options.commandId ?? null;
    const expectedRevision = options.expected_revision ?? options.expectedRevision ?? null;
    this.refreshApprovalFromDisk(approvalId);
    const normalizedAction = pyStrip(String(options.action ?? ""));
    const normalizedReason = pyStrip(options.reason ?? "");
    const normalizedInput = pyStrip(options.user_input ?? options.userInput ?? "");
    const normalizedExtra = normaliseExtraRounds(options.extra_rounds ?? options.extraRounds ?? null);
    // The worker only understands the option values it issued.  Accept a small
    // backwards-compatible default vocabulary when an old approval record
    // omitted options, but never silently turn an arbitrary action into
    // "continue".
    const approval = this.approvals.get(approvalId);
    if (approval === undefined || approval.status === "resolved") return false;
    let allowed = new Set(
      approval.options.map((option) => pyStrip(String(option.value))).filter((value) => value),
    );
    if (allowed.size === 0) allowed = new Set(["continue", "stop"]);
    if (!allowed.has(normalizedAction)) return false;
    if (!approval.allow_input && normalizedInput) return false;
    if (!approval.allow_extra_rounds && normalizedExtra) return false;

    const payload: Record<string, unknown> = {
      approval_id: approvalId,
      action: normalizedAction,
      reason: normalizedReason,
      user_input: normalizedInput,
    };
    if (normalizedExtra) {
      // Only present when the operator chose a value: the payload doubles as
      // the idempotency fingerprint, so an unconditional new key would make a
      // retry of a pre-upgrade command look like a different one.
      payload.extra_rounds = normalizedExtra;
    }
    // The approval id is the durable uniqueness key.  Browser retries may carry
    // different Idempotency-Key values (or none at all), but one checkpoint
    // must never enqueue two decisions.  ControlBus serialises the append
    // across processes, closing the pending-check/append TOCTOU window that the
    // old in-memory check left open.
    const canonicalCommandId = `approval:${approvalId}:resolve`;
    const commands = this.controlBus.commands();
    let existing: Record<string, unknown> | null = null;
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      const item = commands[index];
      if (item.kind === "resolve_approval" && String(asRecord(item.payload).approval_id) === approvalId) {
        existing = item;
        break;
      }
    }
    if (existing !== null) {
      const existingPayload = asRecord(existing.payload);
      // An exact retry is idempotently accepted; a conflicting decision is
      // rejected and remains visible to the caller as HTTP 409.
      const existingKey = String(existingPayload.idempotency_key ?? "");
      const requestedKey = String(commandIdOption ?? "");
      if (requestedKey && existingKey && requestedKey !== existingKey) return false;
      return Object.entries(payload).every(
        ([key, value]) => String(existingPayload[key] ?? "") === String(value),
      );
    }
    const command = this.controlBus.append(
      "resolve_approval",
      { ...payload, idempotency_key: String(commandIdOption ?? "") },
      {
        createdBy: "operator",
        expectedRevision,
        commandId: canonicalCommandId,
      },
    );
    const persistedPayload = asRecord(command.payload);
    const persistedKey = String(persistedPayload.idempotency_key ?? "");
    const requestedKey = String(commandIdOption ?? "");
    if (requestedKey && persistedKey && requestedKey !== persistedKey) return false;
    return Object.entries(payload).every(
      ([key, value]) => String(persistedPayload[key] ?? "") === String(value),
    );
  }

  /** Append an approval record (pending or resolved) to the run log dir. */
  private persistApproval(record: Record<string, unknown>): void {
    const target = path.join(this.roleDirPath, "approvals.jsonl");
    try {
      // Keep the anchored walk in front of the append; a path-based mkdir
      // followed by an open would permit a swapped ``role_management``
      // directory to redirect this append.
      ensureDirNofollow(path.dirname(target));
      appendJsonl(target, record);
    } catch {
      // Approval persistence is diagnostic/control state. A read-only or
      // unavailable log must not crash the manager's execution loop.
    }
  }

  getApproval(approvalId: string): Approval | null {
    this.refreshApprovalFromDisk(approvalId);
    // Only the worker's blocking wait consumes operator commands.  Read APIs
    // must remain observational; otherwise two dashboard processes can race
    // while a GET silently resolves an approval.
    this.applyPendingResolutions();
    return this.approvals.get(approvalId) ?? null;
  }

  private approvalFromRecord(record: Record<string, unknown>): Approval | null {
    const approvalId = record.approval_id;
    if (typeof approvalId !== "string" || !approvalId) return null;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = rawOptions
      .filter(isRecord)
      .map(
        (item) =>
          new ApprovalOption(String(item.value ?? ""), String(item.label ?? ""), String(item.style ?? "")),
      );
    const resolvedAt = record.resolved_at;
    return new Approval({
      approval_id: approvalId,
      title: String(record.title ?? ""),
      message: String(record.message ?? ""),
      options,
      answers: (Array.isArray(record.answers) ? record.answers : []).map((item) => String(item)),
      allow_input: record.allow_input === undefined ? true : Boolean(record.allow_input),
      input_label: String(record.input_label ?? ""),
      allow_extra_rounds: Boolean(record.allow_extra_rounds ?? false),
      context: isRecord(record.context) ? { ...record.context } : {},
      status: String(record.status ?? "pending"),
      action: String(record.action ?? ""),
      reason: String(record.reason ?? ""),
      user_input: String(record.user_input ?? ""),
      extra_rounds: normaliseExtraRounds(record.extra_rounds),
      created_at: record.created_at === undefined ? Date.now() / 1000 : Number(record.created_at),
      resolved_at: resolvedAt ? Number(resolvedAt) : null,
    });
  }

  private refreshApprovalFromDisk(approvalId: string): void {
    const records = readJsonl(path.join(this.roleDirPath, "approvals.jsonl"), { strictParent: true });
    let latest: Record<string, unknown> | null = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].approval_id === approvalId) {
        latest = records[index];
        break;
      }
    }
    if (latest === null) return;
    const approval = this.approvalFromRecord(latest);
    if (approval === null) return;
    this.approvals.set(approvalId, approval);
    if (!this.approvalOrder.includes(approvalId)) this.approvalOrder.push(approvalId);
  }

  private applyPendingResolutions(): void {
    for (const command of this.controlBus.pending()) {
      if (command.kind !== "resolve_approval") continue;
      const payload = asRecord(command.payload);
      const approvalId = String(payload.approval_id ?? "");
      this.refreshApprovalFromDisk(approvalId);
      const approval = this.approvals.get(approvalId);
      if (approval === undefined || approval.status === "resolved") continue;
      const action = pyStrip(String(payload.action ?? ""));
      let allowed = new Set(
        approval.options.map((option) => pyStrip(String(option.value))).filter((value) => value),
      );
      if (allowed.size === 0) allowed = new Set(["continue", "stop"]);
      const userInput = pyStrip(String(payload.user_input ?? ""));
      const extraRounds = normaliseExtraRounds(payload.extra_rounds);
      if (
        !allowed.has(action) ||
        (!approval.allow_input && userInput) ||
        (!approval.allow_extra_rounds && extraRounds)
      ) {
        this.controlBus.receipt(command, "rejected", { message: "invalid approval response" });
        continue;
      }
      approval.action = action;
      approval.reason = pyStrip(String(payload.reason ?? ""));
      approval.user_input = userInput;
      approval.extra_rounds = extraRounds;
      approval.status = "resolved";
      approval.resolved_at = Date.now() / 1000;
      const snapshot = approval.toDict();
      this.persistApproval(snapshot);
      if (action === "stop") {
        // Resolving an end-of-round gate with "stop" is an explicit operator
        // cancellation, not a worker crash.  Persist that intent before the
        // blocking Manager hook is released so a fast worker exit cannot race
        // Supervisor reconciliation and be misclassified as ``failed`` solely
        // because incomplete runs deliberately return a non-zero process status.
        const now = Date.now() / 1000;
        this.controlBus.updateStatus((current) => {
          const lifecycle = canonicalLifecycleStatus(current.status, "");
          if (TERMINAL_STATUSES.has(lifecycle)) return current;
          const updated: Record<string, unknown> = {
            ...current,
            requested_action: "cancel",
            operator_stop_requested_at: current.operator_stop_requested_at || now,
          };
          if (ACTIVE_STATUSES.has(lifecycle)) updated.status = "stopping";
          return updated;
        });
      }
      this.controlBus.receipt(command, "applied", { result: { approval_id: approvalId } });
    }
  }

  /** Update live setup/progress metadata and append a durable snapshot. */
  updateApprovalContext(approvalId: string, updates: Record<string, unknown>): boolean {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined) return false;
    Object.assign(approval.context, updates);
    this.persistApproval(approval.toDict());
    return true;
  }

  listApprovals(): Record<string, unknown>[] {
    // Merge on-disk records (so past/other-process interactions still show)
    // with in-memory records only when the latter is newer.  Reading a snapshot
    // must not consume control commands or let a stale API cache overwrite a
    // resolved durable record.
    const merged = new Map<string, Record<string, unknown>>();
    for (const record of readJsonl(path.join(this.roleDirPath, "approvals.jsonl"), { strictParent: true })) {
      const approvalId = record.approval_id;
      if (typeof approvalId === "string") merged.set(approvalId, record);
    }
    for (const approvalId of this.approvalOrder) {
      const candidate = this.approvals.get(approvalId)?.toDict();
      if (candidate === undefined) continue;
      const existing = merged.get(approvalId);
      if (existing === undefined || approvalRecordNewer(candidate, existing)) {
        merged.set(approvalId, candidate);
      }
    }
    return [...merged.values()].sort(
      (left, right) => Number(left.created_at ?? 0) - Number(right.created_at ?? 0),
    );
  }

  hasPendingApproval(): boolean {
    return this.listApprovals().some((item) => item.status === "pending");
  }

  // ------------------------------------------------------------------
  // Free-form operator instruction injections
  // ------------------------------------------------------------------
  addInjection(text: string, options: AddInjectionOptions = {}): boolean {
    if (!this.controlEnabled) return false;
    const value = pyStrip(text ?? "");
    if (!value) return false;
    this.controlBus.append(
      "inject_instruction",
      { instructions: value },
      {
        createdBy: "operator",
        expectedRevision: options.expected_revision ?? options.expectedRevision ?? null,
        commandId: options.command_id ?? options.commandId ?? null,
      },
    );
    return true;
  }

  listInjections(): string[] {
    return this.controlBus
      .pending()
      .filter((item) => item.kind === "inject_instruction")
      .map((item) => String(asRecord(item.payload).instructions ?? ""));
  }

  /**
   * Return durable user-authored instruction messages for the timeline.
   *
   * Pending injections alone are insufficient: once the worker applies an
   * instruction it disappears from ``pending()``, even though the message must
   * remain visible after refresh. Commands are the append-only source of truth
   * and receipts only enrich their delivery state.
   */
  listOperatorMessages(options: { limit?: number } = {}): Record<string, unknown>[] {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(options.limit ?? 100), 500));
    const receipts = new Map<string, Record<string, unknown>>();
    for (const item of this.controlBus.receipts()) {
      if (item.command_id) receipts.set(String(item.command_id), item);
    }
    const messages: Record<string, unknown>[] = [];
    for (const command of this.controlBus.commands()) {
      if (command.kind !== "inject_instruction") continue;
      const payload = asRecord(command.payload);
      const text = pyStrip(String(payload.instructions ?? ""));
      const commandId = pyStrip(String(command.command_id ?? ""));
      if (!text || !commandId) continue;
      const receipt = receipts.get(commandId) ?? {};
      let createdAt = Number(command.created_at ?? 0);
      if (!Number.isFinite(createdAt)) createdAt = 0.0;
      messages.push({
        id: commandId,
        text: text.slice(0, 50_000),
        created_at: createdAt,
        status: String(receipt.status ?? "queued"),
      });
    }
    return messages.slice(-boundedLimit);
  }

  drainInjections(): string[] {
    const drained: string[] = [];
    for (const command of this.controlBus.pending()) {
      if (command.kind !== "inject_instruction") continue;
      const payload = asRecord(command.payload);
      const text = pyStrip(String(payload.instructions ?? ""));
      if (text) drained.push(text);
      this.controlBus.receipt(command, "applied", { result: { instructions: text } });
    }
    return drained;
  }
}

function deduplicateFinalText(steps: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!steps.length || steps[steps.length - 1].kind !== "result") return steps;
  const finalText = pyStrip(String(steps[steps.length - 1].text ?? ""));
  if (!finalText) return steps;
  for (let index = steps.length - 2; index >= 0; index -= 1) {
    if (steps[index].kind !== "text") continue;
    if (pyStrip(String(steps[index].text ?? "")) === finalText) {
      return [...steps.slice(0, index), ...steps.slice(index + 1)];
    }
    break;
  }
  return steps;
}

/** Compare append-only approval snapshots without trusting process order. */
function approvalRecordNewer(
  candidate: Record<string, unknown>,
  existing: Record<string, unknown>,
): boolean {
  const candidateTime = Number(candidate.resolved_at || candidate.created_at || 0.0);
  const existingTime = Number(existing.resolved_at || existing.created_at || 0.0);
  if (candidateTime !== existingTime) return candidateTime > existingTime;
  // At equal timestamps a resolved record is strictly more informative than a
  // pending one.  This also handles clocks with coarse resolution.
  return String(candidate.status) === "resolved" && String(existing.status) !== "resolved";
}

export { readJson as readStateJson, readJsonl as readStateJsonl, readTextBounded as readStateTextBounded };
