// Ported 1:1 from LongHorizon-Harness src/lh_harness/adapters/claude_permissions.py
/**
 * Role permission policy + the auditor's workspace read-only guard.
 *
 * Layers A/B live in `policyForRole` / `pathDenyRules`; layer C is the
 * pre/post `snapshotWorkspace` + `workspaceSnapshotDiff` pair. Note that
 * `verifier_workspace_restored` is hard-coded `false` upstream — no snapshot
 * restoration is implemented anywhere in the harness, and the port keeps it
 * that way.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeRole =
  | "prompt_tailor"
  | "planner"
  | "rubric"
  | "composer"
  | "evaluator"
  | "final_response";

const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;
/** Roles whose episodes run under the workspace snapshot guard (read-only by contract). */
const GUARDED_ROLES = new Set(["evaluator"]);

export type ClaudeRolePolicy = {
  role: ClaudeRole;
  permission_mode: string;
  disallowed_tools: readonly string[];
  load_computer_mcp: boolean;
  workspace_read_only: boolean;
  /** The role may spawn the harness-defined subagents (Agent tool). */
  subagents: boolean;
};

/**
 * Return the role deny-list used with Claude's unrestricted mode.
 *
 * Claude's interactive approval system and native sandbox are deliberately
 * bypassed. The deny-list expresses role separation; finer write scopes are
 * enforced by the loop's hooks (see loop/hooks.ts), not here.
 */
export function policyForRole(role: string): ClaudeRolePolicy {
  if (role === "prompt_tailor" || role === "final_response") {
    // Reads a few files, writes prose the harness stores. No side effects.
    return {
      role,
      permission_mode: "bypassPermissions",
      disallowed_tools: ["Bash", ...WRITE_TOOLS, "Agent", "mcp__*", "WebSearch", "WebFetch"],
      load_computer_mcp: false,
      workspace_read_only: true,
      subagents: false,
    };
  }
  if (role === "planner") {
    // Inspects the workspace and attachments, researches, writes plan/research
    // notes (write scope hook-limited to the state dir + memory).
    return {
      role,
      permission_mode: "bypassPermissions",
      disallowed_tools: [],
      load_computer_mcp: true,
      workspace_read_only: false,
      subagents: true,
    };
  }
  if (role === "rubric") {
    return {
      role,
      permission_mode: "bypassPermissions",
      disallowed_tools: ["Bash", "mcp__*"],
      load_computer_mcp: false,
      workspace_read_only: false,
      subagents: true,
    };
  }
  if (role === "composer") {
    return {
      role,
      permission_mode: "bypassPermissions",
      disallowed_tools: [],
      load_computer_mcp: true,
      workspace_read_only: false,
      subagents: true,
    };
  }
  if (role === "evaluator") {
    // Verifies with every tool a reviewer would use; writes only memory pages
    // (hook-limited) and is checked by the workspace snapshot guard.
    return {
      role,
      permission_mode: "bypassPermissions",
      disallowed_tools: [],
      load_computer_mcp: true,
      workspace_read_only: true,
      subagents: true,
    };
  }
  throw new Error(`Unknown Claude Code role: ${role}`);
}

export function isAuditorRole(role: string): boolean {
  return GUARDED_ROLES.has(role);
}

/**
 * Build `Read`/`Edit` deny rules that hide harness-owned paths from Claude.
 *
 * Deny rules still apply under `--dangerously-skip-permissions`, and a `Read`
 * deny also blocks the Edit tool. `//` anchors the pattern at the filesystem
 * root; anything else would resolve against the settings source.
 */
export function pathDenyRules(paths: readonly string[]): string[] {
  const rules: string[] = [];
  for (const raw of paths) {
    const resolved = lstripSlash(toPosix(resolvePath(raw)));
    if (!resolved) continue;
    for (const tool of ["Read", "Edit"]) {
      for (const pattern of [`//${resolved}`, `//${resolved}/**`]) {
        const rule = `${tool}(${pattern})`;
        if (!rules.includes(rule)) rules.push(rule);
      }
    }
  }
  return rules;
}

/** One `snapshot_workspace` record: `[kind, ...stat fields]`. */
export type SnapshotRecord = readonly (string | number | null)[];

export type WorkspaceSnapshot = {
  records: Record<string, SnapshotRecord>;
  errors: readonly string[];
};

/**
 * Take a bounded-content workspace manifest for auditor mutation checks.
 *
 * `hiddenPaths` skips harness-owned trees (logs, prompts, harness state)
 * that keep changing while the auditor runs.
 */
export function snapshotWorkspace(
  workspacePath: string,
  hiddenPaths: readonly string[] = [],
): WorkspaceSnapshot {
  const root = resolvePath(workspacePath);
  const excluded = new Set(hiddenPaths.map((item) => resolvePath(item)));
  const records: Record<string, SnapshotRecord> = {};
  const errors: string[] = [];
  if (!fs.existsSync(root)) {
    return { records: {}, errors: [`workspace does not exist: ${root}`] };
  }
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (exc) {
      errors.push(`${directory}: ${osErrorName(exc)}: ${errorText(exc)}`);
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (excluded.has(entryPath)) continue;
      try {
        const relative = toPosix(path.relative(root, entryPath));
        const stat = fs.lstatSync(entryPath, { bigint: true });
        const mode = Number(stat.mode);
        const mtimeNs = String(stat.mtimeNs);
        if (entry.isSymbolicLink()) {
          records[relative] = ["symlink", mode, mtimeNs, fs.readlinkSync(entryPath)];
        } else if (entry.isDirectory()) {
          records[relative] = ["dir", mode, mtimeNs];
          stack.push(entryPath);
        } else if (entry.isFile()) {
          const size = Number(stat.size);
          const digest = smallFileDigest(entryPath, size);
          records[relative] = ["file", mode, size, mtimeNs, digest];
        } else {
          records[relative] = ["other", mode, Number(stat.size), mtimeNs];
        }
      } catch (exc) {
        errors.push(`${entryPath}: ${osErrorName(exc)}: ${errorText(exc)}`);
      }
    }
  }
  return { records, errors: errors.slice(0, 100) };
}

export function workspaceSnapshotDiff(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): Record<string, unknown> {
  const beforePaths = Object.keys(before.records);
  const afterPaths = Object.keys(after.records);
  const beforeSet = new Set(beforePaths);
  const afterSet = new Set(afterPaths);
  const added = afterPaths.filter((p) => !beforeSet.has(p)).sort(pySort);
  const deleted = beforePaths.filter((p) => !afterSet.has(p)).sort(pySort);
  const changed: string[] = [];
  const typeChanged: string[] = [];
  for (const p of beforePaths.filter((item) => afterSet.has(item)).sort(pySort)) {
    const old = before.records[p];
    const now = after.records[p];
    if (recordsEqual(old, now)) continue;
    if (old.length > 0 && now.length > 0 && old[0] !== now[0]) {
      typeChanged.push(p);
    } else {
      changed.push(p);
    }
  }
  return {
    verifier_workspace_guard: true,
    verifier_workspace_restore_on_mutation: true,
    verifier_workspace_restored: false,
    verifier_workspace_mutation_detected: Boolean(
      added.length || deleted.length || changed.length || typeChanged.length,
    ),
    verifier_workspace_mutations: {
      added,
      changed,
      deleted,
      type_changed: typeChanged,
    },
    verifier_workspace_mutation_counts: {
      added: added.length,
      changed: changed.length,
      deleted: deleted.length,
      type_changed: typeChanged.length,
    },
    verifier_workspace_snapshot_errors: [...before.errors, ...after.errors].slice(0, 100),
  };
}

function smallFileDigest(filePath: string, size: number): string | null {
  if (size > 4 * 1024 * 1024) return null;
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest("hex");
}

function recordsEqual(a: SnapshotRecord, b: SnapshotRecord): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Python `sorted()` on strings compares code points, not locale. */
function pySort(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `Path(raw).expanduser().resolve()` — absolute, symlinks resolved where possible. */
export function resolvePath(raw: string): string {
  const expanded = expandUser(raw);
  const absolute = path.resolve(expanded);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    // A non-existent leaf still resolves in Python (strict=False): resolve the
    // deepest existing ancestor and re-attach the remainder.
    let head = absolute;
    const tail: string[] = [];
    for (;;) {
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      tail.unshift(path.basename(head));
      head = parent;
      try {
        return path.join(fs.realpathSync.native(head), ...tail);
      } catch {
        /* keep walking up */
      }
    }
  }
}

function expandUser(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function toPosix(value: string): string {
  return path.sep === "/" ? value : value.split(path.sep).join("/");
}

function lstripSlash(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === "/") start += 1;
  return value.slice(start);
}

/** Map an errno onto the Python exception class name the message would carry. */
function osErrorName(exc: unknown): string {
  const code = (exc as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "PermissionError";
    case "ENOENT":
      return "FileNotFoundError";
    case "ENOTDIR":
      return "NotADirectoryError";
    case "EISDIR":
      return "IsADirectoryError";
    case "ELOOP":
      return "OSError";
    default:
      return "OSError";
  }
}

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
