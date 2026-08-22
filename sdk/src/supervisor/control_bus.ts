// Ported 1:1 from LongHorizon-Harness src/lh_harness/supervisor/control_bus.py
//
// Small append-only control bus used by the API and a run worker.
//
// The existing manager writes append-only JSONL logs. Control commands follow the
// same rule so a browser can be disconnected or the API restarted without losing
// an operator action. A receipt is the only terminal authority for a command.
//
// Node port notes (the two places where the mechanism, not the behaviour, differs):
//
//  * There is no ``openat``/``dir_fd``.  The anchored no-follow walk is emulated
//    by ``lstat``-ing every path component (rejecting symlinks and non-directories)
//    and then opening the final component with ``O_NOFOLLOW`` (plus ``O_NONBLOCK``
//    so a planted FIFO cannot hang a reader) and validating ``fstat``:
//    regular file with ``nlink === 1``.
//  * There is no ``flock``.  The process-wide serialisation point is an atomic
//    ``O_CREAT|O_EXCL`` lock file carrying the holder pid, acquired with bounded
//    retry/backoff and stale-holder detection.  An unavailable lock stays fatal:
//    degrading to an in-process mutex would permit duplicate revisions and double
//    side effects.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { pyStrip } from "../utils/pystr.js";

export const MAX_CONTROL_RECORD_BYTES = 512 * 1024;
export const MAX_CONTROL_LOG_BYTES = 16 * 1024 * 1024;
const TRUSTED_SYSTEM_ALIASES = new Set(["/var", "/tmp", "/etc"]);

// Bounded wait for the cross-process lock file.  The Python flock blocks
// indefinitely; a bounded wait plus stale detection keeps a crashed holder from
// wedging the whole control plane while still failing closed.
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 10;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const O_CLOEXEC = (fs.constants as unknown as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

/**
 * Test seams.  The Python tests monkeypatch ``control_bus._open_nofollow`` and
 * ``os.close``; ESM namespaces are read-only, so the two functions are routed
 * through this mutable object instead.
 */
export const controlBusHooks: {
  openNofollow: (target: string, options?: { directory?: boolean }) => number;
  closeSync: (fd: number) => void;
} = {
  openNofollow: (target, options) => openNofollow(target, options),
  closeSync: (fd) => fs.closeSync(fd),
};

function oserror(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "";
}

export function expandUser(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) return path.join(os.homedir(), target.slice(2));
  return target;
}

function pathParts(absolute: string): string[] {
  // ["/", "a", "b"] like pathlib's Path.parts on POSIX.
  const trimmed = absolute.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter((item) => item !== "");
  return [path.sep, ...parts];
}

/**
 * Normalize harmless macOS system aliases without resolving run links.
 *
 * macOS exposes ``/var``, ``/tmp`` and ``/etc`` as links into ``/private``.
 * Resolving the *whole* path would be unsafe because a worker can replace a
 * run child with a link.  Only these OS-owned top-level aliases are resolved;
 * every component below them remains subject to O_NOFOLLOW walking.
 */
export function absoluteAnchoredPath(target: string): string {
  const absolute = path.resolve(expandUser(target));
  const parts = pathParts(absolute);
  if (parts.length < 2 || parts[0] !== path.sep) return absolute;
  const first = path.sep + parts[1];
  if (!TRUSTED_SYSTEM_ALIASES.has(first)) return absolute;
  let resolved: string;
  try {
    resolved = fs.realpathSync(first);
  } catch {
    return absolute;
  }
  // Only accept the standard macOS private target.  On Linux these prefixes
  // are normally real directories, so ``target === first`` is unchanged.
  if (resolved !== first && path.dirname(resolved) !== "/private") return absolute;
  return path.join(resolved, ...parts.slice(2));
}

function walkNoFollowParents(absolute: string): void {
  const parts = pathParts(absolute);
  if (parts.length < 2 || parts[0] !== path.sep) {
    throw oserror("EINVAL", "control-bus path must be absolute");
  }
  let current: string = path.sep;
  for (const component of parts.slice(1, -1)) {
    if (component === "" || component === "." || component === "..") {
      throw oserror("EINVAL", "unsafe control-bus path component");
    }
    current = path.join(current, component);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw oserror("ELOOP", "unsafe control-bus path component");
    if (!info.isDirectory()) throw oserror("ENOTDIR", "unsafe control-bus path component");
  }
}

/**
 * Open an absolute path without following any component symlink.
 *
 * Control metadata lives below directories writable by the worker.  A final
 * ``O_NOFOLLOW`` is insufficient when ``control`` or ``.idempotency`` itself
 * is swapped for a link, so validate every component with ``lstat`` and open
 * the final one with ``O_NOFOLLOW``.
 */
export function openNofollow(target: string, options: { directory?: boolean } = {}): number {
  if (!O_NOFOLLOW || !O_DIRECTORY) {
    throw oserror("ENOTSUP", "secure control-bus path opening is unavailable");
  }
  const absolute = absoluteAnchoredPath(target);
  const parts = pathParts(absolute);
  if (parts.length < 2 || parts[0] !== path.sep) {
    throw oserror("EINVAL", "control-bus path must be absolute");
  }
  walkNoFollowParents(absolute);
  const final = parts[parts.length - 1];
  if (final === "" || final === "." || final === "..") {
    throw oserror("EINVAL", "unsafe control-bus path component");
  }
  let flags = fs.constants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
  if (options.directory) {
    flags |= O_DIRECTORY;
  } else {
    // A final component can be replaced with a FIFO between higher level
    // validation and this open.  Non-blocking mode lets the subsequent
    // regular-file check reject it without hanging an API worker
    // indefinitely; it has no effect on ordinary files.
    flags |= O_NONBLOCK;
  }
  return fs.openSync(absolute, flags);
}

/** Spelling alias: consumers written against ``_open_nofollow`` use both cases. */
export const openNoFollow = openNofollow;

/**
 * Create/validate a directory chain without traversing symlinks and return the
 * anchored (alias-normalised) absolute path of the final directory.
 */
export function ensureDirNofollow(target: string, mode = 0o700): string {
  if (!O_NOFOLLOW || !O_DIRECTORY) {
    throw oserror("ENOTSUP", "secure control-bus directory creation is unavailable");
  }
  const absolute = absoluteAnchoredPath(target);
  const parts = pathParts(absolute);
  if (parts.length < 1 || parts[0] !== path.sep) {
    throw oserror("EINVAL", "control-bus directory path must be absolute");
  }
  let current: string = path.sep;
  for (const component of parts.slice(1)) {
    if (component === "" || component === "." || component === "..") {
      throw oserror("EINVAL", "unsafe control-bus directory component");
    }
    current = path.join(current, component);
    let missing: unknown = null;
    let created = false;
    // Concurrent API processes can both observe a missing component.  Retry
    // the anchored stat after either side wins mkdir.  A bounded loop still
    // fails closed if another actor repeatedly removes it.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      let info: fs.Stats;
      try {
        info = fs.lstatSync(current);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        missing = error;
        try {
          fs.mkdirSync(current, { mode });
        } catch (mkdirError) {
          // Another creator won.  The next anchored stat validates that the
          // winner made a real directory, not a link.
          if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
        }
        continue;
      }
      if (info.isSymbolicLink()) throw oserror("ELOOP", "unsafe control-bus directory component");
      if (!info.isDirectory()) throw oserror("ENOTDIR", "unsafe control-bus directory component");
      created = true;
      break;
    }
    if (!created) {
      throw missing ?? oserror("ENOENT", current);
    }
  }
  return absolute;
}

/**
 * Open or create one private regular file inside an already validated parent.
 *
 * macOS can transiently return ``ENOENT`` when several writers concurrently
 * use ``O_CREAT | O_NOFOLLOW`` on the same new pathname.  An exclusive-create
 * attempt followed by a no-create open avoids that platform race and also
 * gives deletion/replacement races a bounded retry path.
 */
export function openPrivateRegularAt(parentDir: string, name: string, flags: number, mode = 0o600): number {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw oserror("EINVAL", "unsafe private file name");
  }
  if (!O_NOFOLLOW) throw oserror("ENOTSUP", "secure private file opening is unavailable");
  const target = path.join(parentDir, name);
  const baseFlags = flags | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    let fd: number | null = null;
    try {
      try {
        fd = fs.openSync(target, baseFlags | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") {
          // APFS can report a short-lived ENOENT while a sibling is being
          // created/renamed.  The parent is validated, so a bounded retry
          // cannot escape the intended directory.
          continue;
        }
        if (code !== "EEXIST") throw error;
        try {
          fd = fs.openSync(target, baseFlags);
        } catch (openError) {
          if (errorCode(openError) === "ENOENT") continue;
          throw openError;
        }
      }
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) {
        throw oserror("ELOOP", "private file is not an unaliased regular file");
      }
      try {
        fs.fchmodSync(fd, mode);
      } catch {
        // Permission tightening is defense in depth.
      }
      const result = fd;
      fd = null;
      return result;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
  throw oserror("ENOENT", name);
}

function openUniqueTemp(parentDir: string, prefix: string, suffix: string): [number, string] {
  const flags =
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | O_CLOEXEC | O_NOFOLLOW;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const name = `${prefix}${crypto.randomUUID().replace(/-/g, "")}${suffix}`;
    try {
      return [fs.openSync(path.join(parentDir, name), flags, 0o600), name];
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw oserror("EEXIST", "could not allocate a unique control-bus temporary file");
}

/** Atomically write bytes below an anchored, no-follow parent directory. */
export function atomicBytesWrite(target: string, payload: Buffer, mode = 0o600): void {
  const absolute = absoluteAnchoredPath(target);
  const parentDir = ensureDirNofollow(path.dirname(absolute));
  const name = path.basename(absolute);
  let fd: number | null = null;
  let temporaryName: string | null = null;
  try {
    [fd, temporaryName] = openUniqueTemp(parentDir, `.${name}.`, ".tmp");
    try {
      fs.fchmodSync(fd, mode);
    } catch {
      /* best effort */
    }
    fs.writeSync(fd, payload, 0, payload.length, null);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best effort */
    }
    fs.closeSync(fd);
    fd = null;
    // ``rename`` never follows a final symlink, so a swapped destination is
    // replaced rather than written through.
    fs.renameSync(path.join(parentDir, temporaryName), path.join(parentDir, name));
    temporaryName = null;
    try {
      const dirFd = fs.openSync(parentDir, fs.constants.O_RDONLY | O_DIRECTORY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      /* best effort */
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (temporaryName !== null) {
      try {
        fs.unlinkSync(path.join(parentDir, temporaryName));
      } catch {
        /* ignore */
      }
    }
  }
}

/** UTF-8 convenience wrapper around {@link atomicBytesWrite} (mode 0o600). */
export function writeTextNofollowAtomic(target: string, text: string, mode = 0o600): void {
  atomicBytesWrite(target, Buffer.from(text, "utf-8"), mode);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = sortDeep(item);
    }
    return out;
  }
  return value;
}

function compactDumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compactDumps).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${compactDumps(item)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/**
 * ``json.dumps(value, ensure_ascii=False, sort_keys=True[, indent=n])``.
 *
 * Python's compact separators are ``", "``/``": "``; reproduce them so the
 * on-disk records stay byte-compatible with the original harness.
 */
export function jsonDumpsSorted(value: unknown, indent?: number): string {
  const sorted = sortDeep(value);
  if (indent === undefined) return compactDumps(sorted);
  const encoded = JSON.stringify(sorted, null, indent);
  return encoded === undefined ? "null" : encoded;
}

export class RevisionConflict extends Error {
  expected: number;
  actual: number;

  constructor(expected: number, actual: number) {
    super(`control revision conflict: expected ${expected}, current ${actual}`);
    this.name = "RevisionConflict";
    this.expected = Math.trunc(expected);
    this.actual = Math.trunc(actual);
  }
}

export class CommandConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandConflict";
  }
}

/** Append one JSONL control record through an anchored, locked descriptor. */
export function appendJsonl(target: string, record: Record<string, unknown>): void {
  const line = `${jsonDumpsSorted(record)}\n`;
  if (Buffer.byteLength(line, "utf-8") > MAX_CONTROL_RECORD_BYTES) {
    throw new Error("control record is too large");
  }
  // A path-following append would follow a final symlink.  Commands and
  // receipts are control-plane data, so fail closed unless the whole parent
  // chain and final file pass the anchored no-follow checks.
  const absolute = absoluteAnchoredPath(target);
  const parentDir = ensureDirNofollow(path.dirname(absolute));
  const fd = openPrivateRegularAt(
    parentDir,
    path.basename(absolute),
    fs.constants.O_WRONLY | fs.constants.O_APPEND,
  );
  try {
    const payload = Buffer.from(line, "utf-8");
    fs.writeSync(fd, payload, 0, payload.length, null);
    fs.fsyncSync(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** Alias mirroring ``from .control_bus import _append_jsonl as _append_jsonl_nofollow``. */
export const appendJsonlNofollow = appendJsonl;

function readAllBounded(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let remaining = limit;
  while (remaining > 0) {
    const size = Math.min(1024 * 1024, remaining);
    const buffer = Buffer.allocUnsafe(size);
    const read = fs.readSync(fd, buffer, 0, size, null);
    if (!read) break;
    chunks.push(buffer.subarray(0, read));
    remaining -= read;
  }
  return Buffer.concat(chunks);
}

function closeTolerateEbadf(fd: number): void {
  // Tolerate EBADF only: a stray double-close elsewhere in the process can
  // recycle this descriptor number between our open and close, and crashing
  // the reader over that stolen close would take down an otherwise healthy
  // run.  Any other close failure is a real I/O problem and must propagate.
  try {
    controlBusHooks.closeSync(fd);
  } catch (error) {
    if (errorCode(error) !== "EBADF") throw error;
  }
}

export function readJsonl(target: string): Record<string, unknown>[] {
  let fd: number;
  try {
    fd = controlBusHooks.openNofollow(target);
  } catch {
    return [];
  }
  let raw: Buffer;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) return [];
    if (info.size > MAX_CONTROL_LOG_BYTES) {
      throw new Error("control log is too large to read safely");
    }
    raw = readAllBounded(fd, MAX_CONTROL_LOG_BYTES + 1);
    if (raw.length > MAX_CONTROL_LOG_BYTES) {
      throw new Error("control log grew beyond the safe read limit");
    }
  } finally {
    closeTolerateEbadf(fd);
  }
  const records: Record<string, unknown>[] = [];
  for (const line of raw.toString("binary").split(/\r\n|\r|\n/)) {
    if (Buffer.byteLength(line, "binary") > MAX_CONTROL_RECORD_BYTES) continue;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(line, "binary").toString("utf-8"));
    } catch {
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      records.push(value as Record<string, unknown>);
    }
  }
  return records;
}

/** Read one control metadata file through a bounded no-follow descriptor. */
export function readJsonFile(target: string, maxBytes = MAX_CONTROL_RECORD_BYTES): Record<string, unknown> {
  let fd: number;
  try {
    fd = controlBusHooks.openNofollow(target);
  } catch {
    return {};
  }
  let raw: Buffer;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) return {};
    raw = readAllBounded(fd, maxBytes + 1);
    if (raw.length > maxBytes) return {};
  } catch {
    return {};
  } finally {
    // Same tolerance as above: this poller runs for the whole run, so a
    // single stolen-descriptor EBADF must degrade to one empty poll, not a
    // crash that surfaces at shutdown as the process exit status.
    closeTolerateEbadf(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf-8"));
  } catch {
    return {};
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sleepSync(milliseconds: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

const heldLocks = new Map<string, { depth: number }>();

/**
 * Acquire the cross-process lock file for one control directory.
 *
 * ``O_CREAT|O_EXCL`` is the portable stand-in for ``flock(LOCK_EX)``.  A
 * pre-existing lock is inspected: a symlink or hard-link alias is fatal (the
 * two boundaries would serialise independently), a live holder is waited for,
 * and a dead holder's lock is stolen.
 */
function acquireLockFile(parentDir: string, name: string): number {
  const target = path.join(parentDir, name);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        0o600,
      );
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) {
        fs.closeSync(fd);
        throw oserror("ELOOP", "lock file is not an unaliased regular file");
      }
      const payload = Buffer.from(`${jsonDumpsSorted({ pid: process.pid, created_at: Date.now() / 1000 })}\n`, "utf-8");
      fs.writeSync(fd, payload, 0, payload.length, null);
      return fd;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    // Someone holds (or leaked) the lock.  ``O_NOFOLLOW`` rejects a symlinked
    // lock path outright; a hard-link alias is rejected by the nlink check.
    let holderPid = 0;
    let probe: number;
    try {
      probe = fs.openSync(target, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    } catch (error) {
      // The holder released between EEXIST and this probe; retry the create.
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    try {
      const info = fs.fstatSync(probe);
      if (!info.isFile() || info.nlink !== 1) {
        throw oserror("ELOOP", "lock file is not an unaliased regular file");
      }
      const raw = readAllBounded(probe, MAX_CONTROL_RECORD_BYTES + 1).toString("utf-8");
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown };
        holderPid = typeof parsed.pid === "number" ? parsed.pid : 0;
      } catch {
        holderPid = 0;
      }
    } finally {
      try {
        fs.closeSync(probe);
      } catch {
        /* ignore */
      }
    }
    if (holderPid > 0 && holderPid !== process.pid && processAlive(holderPid)) {
      if (Date.now() >= deadline) {
        throw oserror("EWOULDBLOCK", "control lock is held by another process");
      }
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    // Stale (or unreadable) holder: reclaim the lock file and retry.
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

function releaseLockFile(fd: number, parentDir: string, name: string): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(path.join(parentDir, name));
  } catch {
    /* ignore */
  }
}

/**
 * Run ``body`` while holding the run's cross-process control lock.
 *
 * Directory-boundary failures surface as OSError-shaped errors so callers can
 * distinguish an invalid/symlinked run layout from a platform that cannot
 * provide a process lock.  Once the anchored parent exists, lock-setup failures
 * are normalised to ``secure control-bus locking is unavailable``.  There is no
 * thread-lock-only fallback.
 */
export function withProcessLock<T>(directory: string, lockName: string, unavailableMessage: string, body: () => T): T {
  const parentDir = ensureDirNofollow(directory);
  const lockKey = path.join(parentDir, lockName);
  const held = heldLocks.get(lockKey);
  if (held) {
    held.depth += 1;
    try {
      return body();
    } finally {
      held.depth -= 1;
      if (held.depth <= 0) heldLocks.delete(lockKey);
    }
  }
  let fd: number;
  try {
    fd = acquireLockFile(parentDir, lockName);
  } catch (error) {
    const failure = new Error(unavailableMessage);
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
  heldLocks.set(lockKey, { depth: 1 });
  try {
    return body();
  } finally {
    heldLocks.delete(lockKey);
    releaseLockFile(fd, parentDir, lockName);
  }
}

export type CommandRecord = Record<string, unknown>;
export type ReceiptRecord = Record<string, unknown>;

export interface AppendOptions {
  createdBy?: string;
  expectedRevision?: number | null;
  commandId?: string | null;
  returnReplay?: boolean;
}

/** Persist commands and receipts below one run directory. */
export class ControlBus {
  static terminalReceiptStatuses: ReadonlySet<string> = new Set([
    "applied",
    "rejected",
    "failed",
    "cancelled",
  ]);

  readonly runDir: string;
  readonly root: string;
  readonly commandsPath: string;
  readonly receiptsPath: string;
  readonly statusPath: string;
  readonly ownerPath: string;
  readonly lockPath: string;

  constructor(runDir: string) {
    // Keep the lexical boundary intact.  Resolving here would silently accept
    // ``runs/id`` when it has been replaced with a symlink to an external
    // directory; every subsequent anchored open would then be operating on the
    // wrong run.  The no-follow helpers reject any symlink component at use
    // time, while ``path.resolve`` only normalizes ``.``/``..``.
    this.runDir = path.resolve(expandUser(runDir));
    this.root = path.join(this.runDir, "control");
    this.commandsPath = path.join(this.root, "commands.jsonl");
    this.receiptsPath = path.join(this.root, "command_receipts.jsonl");
    this.statusPath = path.join(this.root, "status.json");
    this.ownerPath = path.join(this.root, "owner.json");
    // The lock file, rather than the commands file, is the process-wide
    // serialisation point.  Locking the data file itself is insufficient: two
    // writers can both read the same length and assign a duplicate revision
    // before either append obtains the file lock.
    this.lockPath = path.join(this.root, ".control.lock");
  }

  private locked<T>(body: () => T): T {
    return withProcessLock(this.root, ".control.lock", "secure control-bus locking is unavailable", body);
  }

  append(kind: string, payload: Record<string, unknown> | null = null, options: AppendOptions = {}): CommandRecord {
    const { createdBy = "web", expectedRevision = null, commandId = null, returnReplay = false } = options;
    const requestedId = pyStrip(String(commandId ?? ""));
    if (requestedId.length > 256 || requestedId.includes("\u0000")) {
      throw new Error("command_id must be at most 256 characters and contain no NUL");
    }
    if (String(kind).length > 128 || String(kind).includes("\u0000")) {
      throw new Error("command kind is invalid");
    }
    if (
      expectedRevision !== null &&
      expectedRevision !== undefined &&
      (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision))
    ) {
      throw new Error("expected_revision must be an integer");
    }
    const command: CommandRecord = {
      command_id: requestedId || `cmd-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      run_id: path.basename(this.runDir),
      kind,
      payload: payload ?? {},
      created_at: Date.now() / 1000,
      created_by: createdBy,
      expected_revision: expectedRevision ?? null,
    };
    return this.locked(() => {
      if (requestedId) {
        for (const existing of this.commandsUnlocked()) {
          if (existing.command_id === requestedId) {
            if (
              existing.run_id !== command.run_id ||
              existing.kind !== command.kind ||
              jsonDumpsSorted(existing.payload ?? {}) !== jsonDumpsSorted(command.payload ?? {})
            ) {
              throw new CommandConflict(
                `command id '${requestedId}' was already used for a different command`,
              );
            }
            // Keep the on-disk command schema stable while telling callers that
            // they must not perform a side effect a second time (e.g. sending
            // SIGTERM again).
            return returnReplay ? { ...existing, _idempotent_replay: true } : existing;
          }
        }
      }
      const currentRevision = this.currentRevisionUnlocked();
      if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new RevisionConflict(expectedRevision, currentRevision);
      }
      command.revision = currentRevision + 1;
      appendJsonl(this.commandsPath, command);
      return command;
    });
  }

  commands(): CommandRecord[] {
    return readJsonl(this.commandsPath);
  }

  private commandsUnlocked(): CommandRecord[] {
    return readJsonl(this.commandsPath);
  }

  private currentRevisionUnlocked(): number {
    // Use the maximum persisted revision, not line count: a manually
    // repaired/partially-corrupt JSONL should never cause revision reuse.
    let maximum = 0;
    for (const item of this.commandsUnlocked()) {
      const value = item.revision;
      const revision = typeof value === "number" ? Math.trunc(value) : Number.NaN;
      if (Number.isFinite(revision) && revision > maximum) maximum = revision;
    }
    return maximum;
  }

  /** Return the current command revision. */
  revision(): number {
    return this.locked(() => this.currentRevisionUnlocked());
  }

  receipts(): ReceiptRecord[] {
    return readJsonl(this.receiptsPath);
  }

  receiptFor(commandId: string): ReceiptRecord | null {
    let result: ReceiptRecord | null = null;
    for (const receipt of this.receipts()) {
      if (receipt.command_id === commandId) result = receipt;
    }
    return result;
  }

  pending(): CommandRecord[] {
    const receipts = new Set(this.receipts().map((item) => String(item.command_id)));
    return this.commands().filter((command) => !receipts.has(String(command.command_id)));
  }

  receipt(
    command: CommandRecord,
    status: string,
    options: { message?: string; result?: Record<string, unknown> | null } = {},
  ): ReceiptRecord {
    const record: ReceiptRecord = {
      command_id: command.command_id,
      run_id: command.run_id ?? path.basename(this.runDir),
      kind: command.kind,
      status,
      message: options.message ?? "",
      result: options.result ?? {},
      updated_at: Date.now() / 1000,
    };
    return this.locked(() => {
      const existing = this.receiptForUnlocked(String(record.command_id));
      if (existing !== null) {
        // A command receipt is idempotent.  Returning the durable record
        // (rather than a newly-created timestamp) lets a retry safely render
        // the same operator-visible result.
        return existing;
      }
      if (record.command_id) {
        appendJsonl(this.receiptsPath, record);
      }
      return record;
    });
  }

  private receiptForUnlocked(commandId: string): ReceiptRecord | null {
    let result: ReceiptRecord | null = null;
    for (const receipt of readJsonl(this.receiptsPath)) {
      if (receipt.command_id === commandId) result = receipt;
    }
    return result;
  }

  /** Atomically replace a JSON file with a unique temporary sibling. */
  static atomicJsonWrite(target: string, value: Record<string, unknown>): void {
    atomicBytesWrite(target, Buffer.from(`${jsonDumpsSorted(value, 2)}\n`, "utf-8"));
  }

  writeStatus(status: Record<string, unknown>): void {
    this.locked(() => {
      ControlBus.atomicJsonWrite(this.statusPath, status);
    });
  }

  /**
   * Atomically read, transform, and replace the lifecycle status.
   *
   * Atomic file replacement protects readers from partial JSON, but it does not
   * by itself prevent a stale read/modify/write from overwriting a newer
   * lifecycle decision made by another API process.  Callers that derive status
   * from process state use this transaction so the merge is performed while
   * holding the run's cross-process control lock.
   */
  updateStatus(
    update: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Record<string, unknown> {
    return this.locked(() => {
      const current = this.readStatusUnlocked();
      const updated = update(current);
      if (updated === null || typeof updated !== "object" || Array.isArray(updated)) {
        throw new TypeError("status update must return a dictionary");
      }
      if (jsonDumpsSorted(updated) !== jsonDumpsSorted(current)) {
        ControlBus.atomicJsonWrite(this.statusPath, updated);
      }
      return updated;
    });
  }

  private readStatusUnlocked(): Record<string, unknown> {
    return readJsonFile(this.statusPath);
  }

  readStatus(): Record<string, unknown> {
    return this.readStatusUnlocked();
  }

  writeOwner(owner: Record<string, unknown>): void {
    this.locked(() => {
      ControlBus.atomicJsonWrite(this.ownerPath, owner);
    });
  }

  readOwner(): Record<string, unknown> {
    return readJsonFile(this.ownerPath);
  }
}

/** Yield ``<runs_root>/<name>`` for entries whose run/control chain is unaliased. */
export function iterRunControlDirs(runsRoot: string): string[] {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(expandUser(runsRoot)));
  } catch {
    root = path.resolve(expandUser(runsRoot));
  }
  let rootFd: number;
  try {
    rootFd = openNofollow(root, { directory: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  try {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      // A directory entry that is a symlink must never make this iterator
      // expose another run's control boundary.
      if (entry.isSymbolicLink()) continue;
      let runFd: number | null = null;
      let controlFd: number | null = null;
      try {
        runFd = openNofollow(path.join(root, entry.name), { directory: true });
        controlFd = openNofollow(path.join(root, entry.name, "control"), { directory: true });
      } catch {
        continue;
      } finally {
        if (controlFd !== null) {
          try {
            fs.closeSync(controlFd);
          } catch {
            /* ignore */
          }
        }
        if (runFd !== null) {
          try {
            fs.closeSync(runFd);
          } catch {
            /* ignore */
          }
        }
      }
      found.push(path.join(root, entry.name));
    }
  } finally {
    try {
      fs.closeSync(rootFd);
    } catch {
      /* ignore */
    }
  }
  return found;
}
