// Ported 1:1 from LongHorizon-Harness src/lh_harness/utils/run_boundary.py.
//
// Filesystem boundary checks for run-scoped dashboard data.
//
// Run directories are writable by the worker (and, in some deployments, by an
// agent process). Treat `runs/<id>` and its `lh_harness`/`control` children as
// ownership boundaries: a symlink, a path that resolves to another run, or a
// non-directory must never be accepted as a run layout.
//
// The helpers intentionally return `null` instead of raising.  Callers use
// that result to hide a concurrently replaced/invalid run from a listing or to
// return a normal `404`/`ValueError` at their API boundary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const _MAX_RUN_ID_CHARS = 128;
export const CANONICAL_LOG_DIR = "lh_harness";
export const CANONICAL_ROLE_DIR = "role_orchestration";
export const OSWORLD_COMPAT_LOG_DIR = "cua_harness";
export const LEGACY_LOG_DIR = "logs";
export const LEGACY_ROLE_DIR = "role_management";

function roleDirName(logName: string): string {
  return logName === LEGACY_LOG_DIR ? LEGACY_ROLE_DIR : CANONICAL_ROLE_DIR;
}

/** Python `Path.expanduser()`. */
export function expanduser(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Python `Path.resolve(strict=False)`: resolve what exists, keep the rest. */
export function resolveNonStrict(value: string): string {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // fall through to the longest-existing-prefix walk
  }
  const parts = absolute.split(path.sep);
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const prefix = parts.slice(0, index).join(path.sep) || path.sep;
    try {
      const real = fs.realpathSync(prefix);
      return path.join(real, ...parts.slice(index));
    } catch {
      continue;
    }
  }
  return absolute;
}

/** Python `path.relative_to(root)` succeeding (equality counts as inside). */
function inside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function componentName(value: string): string | null {
  const text = String(value);
  if (
    !text ||
    text.length > _MAX_RUN_ID_CHARS ||
    text === "." ||
    text === ".." ||
    text.includes("/") ||
    text.includes("\\") ||
    Array.from(text).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  ) {
    return null;
  }
  return text;
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function exists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return a canonical, real run directory path, or `null`.
 *
 * A non-existent path is accepted so callers can create a fresh run.  An
 * existing symlink (including one pointing to a sibling run *inside* the
 * configured root) is always rejected.
 */
export function safeRunDir(runsRoot: string, runId: string): string | null {
  const name = componentName(String(runId));
  if (name === null) return null;
  const root = resolveNonStrict(expanduser(runsRoot));
  const candidate = path.join(root, name);
  let resolved: string;
  try {
    if (isSymlink(candidate)) return null;
    if (exists(candidate) && !isDir(candidate)) return null;
    resolved = resolveNonStrict(candidate);
  } catch {
    return null;
  }
  // `resolve` can follow a symlink in any component.  Equality is the
  // important check even when the resolved target remains under `root`.
  if (resolved !== candidate || !inside(resolved, root)) return null;
  return resolved;
}

/**
 * Validate one direct child directory of a real run.
 *
 * `name` is deliberately a single component.  Existing children must be
 * real directories whose canonical path is exactly the lexical path; this
 * rejects `logs -> ../other-run/logs` as well as links outside the root.
 */
export function safeRunSubdir(
  runsRoot: string,
  runDir: string,
  name: string,
  options: { allowMissing?: boolean } = {},
): string | null {
  const allowMissing = options.allowMissing ?? true;
  const component = componentName(name);
  if (component === null) return null;
  const root = resolveNonStrict(expanduser(runsRoot));
  // Python compares the *literal* expanded path with its resolution, so a
  // relative path (or one containing "..") can never match and is rejected.
  const candidateRun = stripTrailingSep(expanduser(runDir));
  // Validate the run path itself before inspecting any child.  Passing an
  // absolute path is supported for callers that already resolved it, while
  // still requiring it to be exactly one direct child of `root`.
  try {
    const resolvedRun = resolveNonStrict(candidateRun);
    if (isSymlink(candidateRun) || resolvedRun !== candidateRun) return null;
    if (!inside(resolvedRun, root)) return null;
    if (path.dirname(resolvedRun) !== root || !isDir(resolvedRun)) return null;
  } catch {
    return null;
  }
  return safeChild(root, candidateRun, component, allowMissing);
}

function stripTrailingSep(value: string): string {
  if (value.length > 1 && value.endsWith(path.sep)) return value.replace(/[\\/]+$/, "") || path.sep;
  return value;
}

/** Validate one child below an already validated canonical directory. */
function safeChild(root: string, parent: string, component: string, allowMissing: boolean): string | null {
  const candidate = path.join(parent, component);
  let resolved: string;
  try {
    if (isSymlink(candidate)) return null;
    if (!exists(candidate)) return allowMissing ? candidate : null;
    if (!isDir(candidate)) return null;
    resolved = resolveNonStrict(candidate);
  } catch {
    return null;
  }
  if (resolved !== candidate || !inside(resolved, root) || path.dirname(resolved) !== parent) return null;
  return resolved;
}

/**
 * Validate the canonical OSWorld-style result-log directory.
 *
 * New runs use `lh_harness/role_orchestration`. Runs briefly written under
 * `cua_harness/role_orchestration` and historical `logs/role_management`
 * runs remain readable during migration.
 */
export function safeRunLogs(
  runsRoot: string,
  runDir: string,
  options: { requireRoleManagement?: boolean; allowMissing?: boolean } = {},
): string | null {
  const requireRoleManagement = options.requireRoleManagement ?? false;
  const allowMissing = options.allowMissing ?? true;
  const root = resolveNonStrict(expanduser(runsRoot));
  const run = safeRunDir(root, path.basename(runDir));
  if (run === null || resolveNonStrict(runDir) !== run) return null;
  let selectedLogName = CANONICAL_LOG_DIR;
  let canonicalExists: boolean;
  let compatExists: boolean;
  let legacyExists: boolean;
  try {
    canonicalExists = exists(path.join(run, CANONICAL_LOG_DIR)) || isSymlink(path.join(run, CANONICAL_LOG_DIR));
    compatExists =
      exists(path.join(run, OSWORLD_COMPAT_LOG_DIR)) || isSymlink(path.join(run, OSWORLD_COMPAT_LOG_DIR));
    legacyExists = exists(path.join(run, LEGACY_LOG_DIR)) || isSymlink(path.join(run, LEGACY_LOG_DIR));
  } catch {
    return null;
  }
  if (canonicalExists) selectedLogName = CANONICAL_LOG_DIR;
  else if (compatExists) selectedLogName = OSWORLD_COMPAT_LOG_DIR;
  else if (legacyExists) selectedLogName = LEGACY_LOG_DIR;
  const logs = safeChild(root, run, selectedLogName, allowMissing);
  if (logs === null) return null;
  let role: string | null = null;
  if (isDir(logs)) {
    const roleName = roleDirName(path.basename(logs));
    const rolePath = path.join(logs, roleName);
    let roleExists: boolean;
    try {
      roleExists = exists(rolePath) || isSymlink(rolePath);
    } catch {
      return null;
    }
    if (roleExists) {
      // An existing role child must be a real directory.  Missing role
      // data is allowed for a freshly reserved/partially written run.
      role = safeChild(root, logs, roleName, false);
      if (role === null) return null;
    }
  }
  if (requireRoleManagement && role === null) return null;
  return logs;
}

/** Return the current role ledger or one of its readable legacy layouts. */
export function safeRunRole(
  runsRoot: string,
  runDir: string,
  options: { allowMissing?: boolean } = {},
): string | null {
  const allowMissing = options.allowMissing ?? true;
  const root = resolveNonStrict(expanduser(runsRoot));
  const run = safeRunDir(root, path.basename(runDir));
  if (run === null || resolveNonStrict(runDir) !== run) return null;
  const logs = safeRunLogs(root, run, { allowMissing });
  if (logs === null) return null;
  const roleName = roleDirName(path.basename(logs));
  return safeChild(root, logs, roleName, allowMissing);
}

/** Return a validated role-orchestration `rounds` directory. */
export function safeRunRounds(
  runsRoot: string,
  runDir: string,
  options: { allowMissing?: boolean } = {},
): string | null {
  const allowMissing = options.allowMissing ?? true;
  const root = resolveNonStrict(expanduser(runsRoot));
  const role = safeRunRole(root, runDir, { allowMissing });
  if (role === null) return null;
  return safeChild(root, role, "rounds", allowMissing);
}

/** Validate a run's `control` directory using the same boundary rule. */
export function safeRunControl(
  runsRoot: string,
  runDir: string,
  options: { allowMissing?: boolean } = {},
): string | null {
  const allowMissing = options.allowMissing ?? true;
  const root = resolveNonStrict(expanduser(runsRoot));
  const run = safeRunDir(root, path.basename(runDir));
  if (run === null || resolveNonStrict(runDir) !== run) return null;
  return safeChild(root, run, "control", allowMissing);
}
