// Ported 1:1 from LongHorizon-Harness src/lh_harness/supervisor/service.py
//
// Process supervisor used by the standalone Web API.
//
// This is intentionally a small supervisor around the existing CLI rather than
// a second implementation of the Manager loop. The worker remains the normal
// ``lh-harness run`` process, which keeps the execution kernel and old CLI
// compatible while giving the workbench a durable owner and command boundary.
//
// Node port notes: where Python spawns ``sys.executable -m lh_harness`` this
// spawns ``process.execPath --import tsx <package>/src/cli.ts`` (deliberately not
// a PATH lookup, so a stale global install cannot receive the private
// ``--supervised`` protocol), and ``start_new_session`` becomes ``detached: true``
// so the child's pgid equals its pid.

import child_process from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ControlBus,
  RevisionConflict,
  atomicBytesWrite,
  ensureDirNofollow,
  expandUser,
  jsonDumpsSorted,
  openNofollow,
  readJsonFile,
  readJsonl,
  withProcessLock,
} from "./control_bus.js";
import {
  ACTIVE_STATUSES,
  MAX_RESUME_EPOCH,
  RESUME_EPOCH_KEY,
  TERMINAL_STATUSES,
  canonicalLifecycleStatus,
  isTerminalStatus,
  mergeLifecycleStatus,
  resumeEpoch,
} from "./lifecycle.js";
import { normaliseReasoningEffort, supportsReasoningEffort } from "../agent_registry.js";
import { gateWorkerEnv, resolveCapabilities, writeRunMcpConfig } from "../capabilities.js";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_MAX_ROUNDS, MAX_ROUNDS } from "../types.js";
import {
  resolveNonStrict,
  safeRunControl,
  safeRunDir,
  safeRunLogs,
  safeRunRole,
  safeRunRounds,
} from "../utils/run_boundary.js";
import { pyStrip } from "../utils/pystr.js";

// types.py also carries the non-Claude backend defaults; ``types.ts`` only ports
// the Claude one because this package ships a single adapter.  The values stay
// verbatim so a role bound to another backend keeps the historical model id.
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_DEEPSEEK_HARNESS_MODEL = "deepseek-v4-flash";
const DEFAULT_OPENCODE_MODEL = "opencode/deepseek-v4-flash-free";

// ``worker.log`` is a diagnostic stream, not an unbounded data store.  Keep a
// generous tail for post-mortem inspection while preventing an old run from
// consuming all disk space when a supervisor is restarted.  Mutable so tests can
// shrink them exactly like the Python monkeypatch does.
export const workerLogLimits = {
  maxBytes: 8 * 1024 * 1024,
  keepBytes: 4 * 1024 * 1024,
};
const MAX_SAVED_TASK_BYTES = 100_000;
const MAX_ROUND_DIR_SCAN = 10_000;
export const MISSING_COMPLETION_EVIDENCE =
  "worker reported completion without explicit completion evidence";
const ROLE_KEYS = ["manager", "executor", "auditor"] as const;
const AGENT_CHOICES: ReadonlySet<string> = new Set([
  "codex",
  "claude_code",
  "deepseek_harness",
  "opencode",
]);

export type SignalName = "SIGTERM" | "SIGKILL";

/** One supervised worker: the Node stand-in for ``subprocess.Popen``. */
export interface WorkerProcess {
  pid: number;
  poll(): number | null;
  kill?(signal?: NodeJS.Signals): void;
}

export interface SpawnOptions {
  cwd: string;
  logFd: number;
  env: NodeJS.ProcessEnv;
}

function signalExitCode(signal: NodeJS.Signals | null): number | null {
  if (!signal) return null;
  const numbers: Record<string, number> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 };
  return -(numbers[signal] ?? 0);
}

function defaultSpawn(command: string[], options: SpawnOptions): WorkerProcess {
  const child = child_process.spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    // ``start_new_session=True``: a new process group whose pgid equals the pid,
    // so the supervisor can signal the whole worker tree.
    detached: true,
    stdio: ["ignore", options.logFd, options.logFd],
    env: options.env,
  });
  let returncode: number | null = null;
  child.on("exit", (code, signal) => {
    returncode = code === null ? signalExitCode(signal) : code;
  });
  child.on("error", () => {
    returncode = returncode ?? 1;
  });
  child.unref();
  return {
    pid: child.pid ?? 0,
    poll: () => returncode,
    kill: (signal) => child.kill(signal),
  };
}

/**
 * Injectable process primitives.
 *
 * The Python tests monkeypatch ``service.subprocess.Popen`` / ``service.os.killpg``;
 * ESM namespaces are read-only, so those seams live here.  ``psQuery`` keeps the
 * read-only identity probe separate from worker launches, exactly like the
 * captured ``_REAL_POPEN`` upstream.
 */
export const supervisorRuntime = {
  spawn: defaultSpawn,
  kill: (pid: number, signal: SignalName): void => {
    process.kill(pid, signal);
  },
  killpg: (pgid: number, signal: SignalName): void => {
    process.kill(-pgid, signal);
  },
  psQuery: (pid: number, field: string): string | null => {
    try {
      const probe = child_process.spawnSync("ps", ["-p", String(pid), "-o", field], {
        encoding: "utf-8",
        timeout: 2000,
      });
      if (probe.status !== 0) return null;
      return pyStrip(String(probe.stdout ?? ""));
    } catch {
      return null;
    }
  },
};

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "";
}

function oserror(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

// ``resolveNonStrict`` is the shared ``Path.resolve(strict=False)`` helper.
export { resolveNonStrict };

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
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

/** ``shlex.join`` — POSIX quoting for the durable ``command_display``. */
export function shlexJoin(command: readonly string[]): string {
  return command
    .map((item) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(item) ? item : `'${item.split("'").join(`'"'"'`)}'`))
    .join(" ");
}

function defaultModelForAgent(agent: string): string {
  if (agent === "claude_code") return DEFAULT_CLAUDE_MODEL;
  if (agent === "deepseek_harness") return DEFAULT_DEEPSEEK_HARNESS_MODEL;
  if (agent === "opencode") return DEFAULT_OPENCODE_MODEL;
  return DEFAULT_CODEX_MODEL;
}

export type RoleConfigs = Record<string, Record<string, string>>;

/**
 * Validate and resolve the three public role bindings.
 *
 * An empty mapping means the legacy global ``agent``/``model`` path.  Once a
 * caller supplies any role configuration, every public role is resolved to an
 * explicit backend and model so switching one role to Claude can never inherit
 * a Codex model id (or vice versa).
 */
export function normaliseRoleConfigs(
  value: unknown,
  options: { agent: string; model: string | null; reasoningEffort?: string | null },
): RoleConfigs {
  const { agent, model } = options;
  const reasoningEffort = options.reasoningEffort ?? null;
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new Error("roles must be an object");
  const unknownKeys = Object.keys(value).filter((key) => !(ROLE_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length) {
    throw new Error(`unknown role configuration: ${unknownKeys.sort()[0]}`);
  }
  const result: RoleConfigs = {};
  for (const role of ROLE_KEYS) {
    let raw = value[role];
    if (raw === null || raw === undefined) raw = {};
    if (!isRecord(raw)) throw new Error(`roles.${role} must be an object`);
    const extra = Object.keys(raw).filter(
      (key) => !["agent", "model", "reasoning_effort"].includes(key),
    );
    if (extra.length) throw new Error(`unknown roles.${role} field: ${extra.sort()[0]}`);
    const roleAgent = pyStrip(String(raw.agent || agent));
    if (!AGENT_CHOICES.has(roleAgent)) {
      throw new Error(`roles.${role}.agent must be codex, claude_code, deepseek_harness, or opencode`);
    }
    const rawModel = raw.model;
    let roleModel: string;
    if (rawModel === null || rawModel === undefined || (typeof rawModel === "string" && !pyStrip(rawModel))) {
      roleModel =
        roleAgent === agent && typeof model === "string" && pyStrip(model)
          ? pyStrip(model)
          : defaultModelForAgent(roleAgent);
    } else if (typeof rawModel !== "string") {
      throw new Error(`roles.${role}.model must be a string`);
    } else {
      roleModel = pyStrip(rawModel);
    }
    if (!roleModel || roleModel.length > 256 || roleModel.includes("\u0000")) {
      throw new Error(`roles.${role}.model must be a non-empty string of at most 256 characters`);
    }
    result[role] = { agent: roleAgent, model: roleModel };
    // Effort tiers are backend-specific, so a global value only reaches a role
    // that kept the global backend.
    let rawEffort = raw.reasoning_effort;
    if ((rawEffort === null || rawEffort === undefined) && roleAgent === agent) rawEffort = reasoningEffort;
    let roleEffort: string;
    try {
      roleEffort = normaliseReasoningEffort(rawEffort as string | null | undefined) ?? "";
    } catch (error) {
      throw new Error(`roles.${role}.reasoning_effort ${(error as Error).message}`);
    }
    if (roleEffort) {
      if (!supportsReasoningEffort(roleAgent)) {
        throw new Error(`roles.${role}.agent ${roleAgent} does not accept a reasoning effort`);
      }
      result[role].reasoning_effort = roleEffort;
    }
  }
  return result;
}

/**
 * Open a run-local worker log without following the final symlink.
 *
 * The supervisor passes the returned descriptor to the child.  The parent chain
 * is validated with anchored no-follow semantics and the final component is
 * opened with ``O_NOFOLLOW``; this closes the check-then-open race where an
 * attacker swaps ``worker.log`` (or the run directory) for a link between
 * validation and launch.  Existing oversized logs are compacted to their newest
 * tail before the worker starts.
 */
export function openWorkerLog(target: string): number {
  const nofollow = fs.constants.O_NOFOLLOW ?? 0;
  if (!nofollow) throw oserror("ENOTSUP", "worker log requires O_NOFOLLOW");
  const nonblock = fs.constants.O_NONBLOCK ?? 0;
  const absolute = path.resolve(target);
  // Walk every parent component with anchored no-follow opens.  Opening
  // ``dirname`` as one pathname still follows an intermediate symlink and
  // leaves a run-directory swap window.
  const parentFd = openNofollow(path.dirname(absolute), { directory: true });
  let fd: number | null = null;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDWR | fs.constants.O_CREAT | nofollow | nonblock, 0o600);
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw oserror("EINVAL", "worker log is not a regular file");
    // A hard link is another way for a run-local pathname to alias data owned
    // by a different boundary.  There is no legitimate reason for a supervisor
    // log to have multiple directory entries, so reject it like a symlink.
    if (info.nlink !== 1) throw oserror("ELOOP", "worker log has multiple hard links");
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // Permission tightening is defense in depth; the no-follow and
      // regular-file checks remain mandatory.
    }
    const size = Number(info.size);
    if (size > workerLogLimits.maxBytes) {
      const keep = Math.max(1, Math.min(workerLogLimits.keepBytes, workerLogLimits.maxBytes));
      const start = Math.max(0, size - keep);
      const tail = Buffer.alloc(keep);
      let filled = 0;
      let position = start;
      while (filled < keep) {
        const read = fs.readSync(fd, tail, filled, keep - filled, position);
        if (!read) break;
        filled += read;
        position += read;
      }
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, tail, 0, filled, 0);
      try {
        fs.fsyncSync(fd);
      } catch {
        // The log is diagnostic; inability to flush it must not turn a
        // successfully opened regular file into a launch deadlock.
      }
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
    try {
      fs.closeSync(parentFd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read one saved task contract through a fully anchored no-follow walk.
 *
 * Round directories and their files are worker/agent writable, so a lexical
 * glob followed by a plain read can follow either ``round_001 -> outside`` or
 * ``task_contract.txt -> secret`` after the run boundary was checked.
 */
export function savedTaskFromRounds(
  runsRoot: string,
  runId: string,
  options: { firstLine: boolean },
): string {
  try {
    const runPath = safeRunDir(runsRoot, runId);
    const logsPath = runPath !== null ? safeRunLogs(runsRoot, runPath, { allowMissing: false }) : null;
    const rolePath = runPath !== null ? safeRunRole(runsRoot, runPath, { allowMissing: false }) : null;
    if (runPath === null || logsPath === null || rolePath === null) return "";
    let current = path.resolve(runsRoot);
    // The runs root is worker-adjacent state; walk it with no-follow semantics
    // just like the nested components below.
    for (const component of [runId, path.basename(logsPath), path.basename(rolePath), "rounds"]) {
      const next = path.join(current, component);
      const fd = openNofollow(next, { directory: true });
      fs.closeSync(fd);
      current = next;
    }
    const roundsDir = current;
    const candidates: [number, string][] = [];
    const entries = fs.readdirSync(roundsDir);
    for (let entryNumber = 0; entryNumber < entries.length; entryNumber += 1) {
      if (entryNumber >= MAX_ROUND_DIR_SCAN) break;
      const name = String(entries[entryNumber]);
      if (!name.startsWith("round_")) continue;
      const suffix = name.slice("round_".length);
      if (!suffix || !/^\d+$/.test(suffix)) continue;
      candidates.push([Number.parseInt(suffix, 10), name]);
    }
    candidates.sort((left, right) => left[0] - right[0] || left[1].localeCompare(right[1]));
    for (const [, name] of candidates) {
      let contractFd: number | null = null;
      try {
        const roundFd = openNofollow(path.join(roundsDir, name), { directory: true });
        fs.closeSync(roundFd);
        contractFd = openNofollow(path.join(roundsDir, name, "task_contract.txt"));
        const info = fs.fstatSync(contractFd);
        if (!info.isFile() || info.nlink !== 1 || Number(info.size) > MAX_SAVED_TASK_BYTES) continue;
        const chunks: Buffer[] = [];
        let remaining = MAX_SAVED_TASK_BYTES + 1;
        while (remaining > 0) {
          const length = Math.min(64 * 1024, remaining);
          const buffer = Buffer.allocUnsafe(length);
          const read = fs.readSync(contractFd, buffer, 0, length, null);
          if (!read) break;
          chunks.push(buffer.subarray(0, read));
          remaining -= read;
        }
        const raw = Buffer.concat(chunks);
        if (raw.length > MAX_SAVED_TASK_BYTES) continue;
        const text = pyStrip(raw.toString("utf-8"));
        if (!text) continue;
        if (options.firstLine) return pyStrip(text.split(/\r\n|\r|\n/)[0]);
        return text;
      } catch {
        continue;
      } finally {
        if (contractFd !== null) {
          try {
            fs.closeSync(contractFd);
          } catch {
            /* ignore */
          }
        }
      }
    }
    return "";
  } catch {
    return "";
  }
}

export class IdempotencyConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflict";
  }
}

function commandFingerprint(command: readonly string[] | null | undefined): string {
  if (!command || !command.length) return "";
  return sha256Hex(JSON.stringify(command.map((item) => String(item))));
}

/** Return a stable-enough process start marker on the host platform. */
function pidStartIdentity(pid: number): string | null {
  if (pid <= 0) return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    // The executable name may contain spaces/parentheses; the final ')' before
    // the state field is the reliable delimiter.
    const closing = raw.lastIndexOf(")");
    const fields = closing >= 0 ? raw.slice(closing + 2).split(/\s+/) : [];
    // /proc/<pid>/stat field 22 is starttime; after pid/comm it is index 19.
    if (fields.length > 19 && fields[19]) return `proc:${fields[19]}`;
  } catch {
    /* not Linux, or the process is gone */
  }
  let started: string | null;
  try {
    started = supervisorRuntime.psQuery(pid, "lstart=");
  } catch {
    return null;
  }
  return started ? `ps:${started}` : null;
}

function processIdentity(pid: number, command?: readonly string[] | null): Record<string, string> {
  const identity: Record<string, string> = {};
  const start = pidStartIdentity(pid);
  if (start) identity.pid_start_identity = start;
  const fingerprint = commandFingerprint(command);
  if (fingerprint) identity.command_fingerprint = fingerprint;
  return identity;
}

function readJson(target: string): Record<string, unknown> {
  return readJsonFile(target, 8 * 1024 * 1024);
}

function pendingApproval(target: string): boolean {
  const latest = new Map<string, Record<string, unknown>>();
  let records: Record<string, unknown>[];
  try {
    records = readJsonl(target);
  } catch {
    return false;
  }
  for (const value of records) {
    if (isRecord(value) && typeof value.approval_id === "string") latest.set(value.approval_id, value);
  }
  return [...latest.values()].some((item) => item.status === "pending");
}

/** Read a manager report status while tolerating legacy spellings. */
function reportStatusOf(report: Record<string, unknown>): string {
  return report && Object.keys(report).length ? canonicalLifecycleStatus(report.status, "") : "";
}

function missingCompletionEvidence(report: Record<string, unknown>, reportStatus?: string): boolean {
  const status = reportStatus !== undefined ? reportStatus : reportStatusOf(report);
  return status === "completed" && report.completion_satisfied !== true;
}

/**
 * Derive process lifecycle status and preserve the audit/report status.
 *
 * A zero exit code is not enough to claim success: the manager must have
 * written a successful report.  Conversely, every positive non-zero exit is a
 * worker failure even if a partial report happens to say ``complete``.  Only an
 * explicit operator stop/abort is a cancellation; an unsolicited signal is
 * treated as a failure/crash.
 */
export function terminalStatusForExit(options: {
  report: Record<string, unknown>;
  returncode: number | null;
  requestedAction?: string;
}): [string, string] {
  const action = pyStrip(String(options.requestedAction ?? "")).toLowerCase();
  const reportStatus = reportStatusOf(options.report);
  if (action === "stop" || action === "abort" || action === "cancel") {
    return ["cancelled", reportStatus];
  }
  if (options.returncode === null || options.returncode === undefined) {
    return ["running", reportStatus];
  }
  if (options.returncode !== 0) return ["failed", reportStatus];
  // ``complete``/``completed`` is a claim about the manager's audit result, not
  // proof by itself.  The worker protocol explicitly carries the boolean
  // completion authority; accepting a missing/false value would let a truncated
  // or hand-written report make a clean process look successful.
  if (missingCompletionEvidence(options.report, reportStatus)) return ["failed", reportStatus];
  if (TERMINAL_STATUSES.has(reportStatus)) return [reportStatus, reportStatus];
  // A clean process exit without a report is a protocol failure, never a
  // successful completion.  The caller persists a crash/protocol report.
  return ["failed", reportStatus];
}

// ``_merge_lifecycle_status`` lives in service.py upstream; it is defined in
// lifecycle.ts here and re-exported so the Python import path still resolves.
export { mergeLifecycleStatus } from "./lifecycle.js";

export const RESUME_MODES = ["continue", "retry"] as const;

// A reopened run keeps its identity and history but must not inherit the
// previous generation's outcome, live process identity, or one-shot idempotency
// marker.
const RESUME_CLEARED_OWNER_KEYS: ReadonlySet<string> = new Set([
  "pid",
  "pgid",
  "command",
  "command_display",
  "exit_code",
  "finished_at",
  "failure_reason",
  "requested_action",
  "stop_requested_at",
  "abort_requested_at",
  "idempotency_fingerprint",
  "process_start_time",
  "process_command",
  "signal_mode",
  "attached",
]);

/**
 * Choose the round budget for a resumed run.
 *
 * ``max_rounds`` is *additional* rounds for the resumed worker (the manager adds
 * it to the rounds it restored), so the saved value is a sensible default and an
 * explicit operator value simply replaces it.
 */
function resumeRoundBudget(owner: Record<string, unknown>, extraRounds: number | null | undefined): number {
  if (extraRounds !== null && extraRounds !== undefined) {
    if (typeof extraRounds !== "number" || !Number.isInteger(extraRounds)) {
      throw new Error("extra_rounds must be an integer");
    }
    if (!(extraRounds >= 1 && extraRounds <= MAX_ROUNDS)) {
      throw new Error(`extra_rounds must be an integer from 1 to ${MAX_ROUNDS}`);
    }
    return extraRounds;
  }
  const saved = Number(owner.max_rounds || DEFAULT_MAX_ROUNDS);
  if (!Number.isFinite(saved) || !Number.isInteger(saved)) return DEFAULT_MAX_ROUNDS;
  return saved >= 1 && saved <= MAX_ROUNDS ? saved : DEFAULT_MAX_ROUNDS;
}

/**
 * Scope a lifecycle command id to the run's resume generation.
 *
 * Command ids are the idempotency key, so a run reopened by ``resume`` must not
 * inherit the previous generation's ``lifecycle-stop`` receipt -- that would
 * make the new worker's stop look already-delivered and leave it running.  Epoch
 * 0 keeps the historical unsuffixed id so existing run directories stay
 * compatible.
 */
export function lifecycleCommandId(kind: string, epoch: number): string {
  return epoch <= 0 ? `lifecycle-${kind}` : `lifecycle-${kind}@${epoch}`;
}

/**
 * The interpreter prefix for a worker launch.
 *
 * Always launch through the interpreter that owns this supervisor.  A PATH
 * lookup can select an older globally installed console script when the Web
 * workbench is running from a source checkout; that old process may not
 * understand the private ``--supervised`` protocol.
 */
export function workerEntryCommand(): string[] {
  const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
  // Node resolves a bare `--import` specifier against the child's cwd (the
  // user's workspace), so the tsx loader is pinned to an absolute file URL.
  const loader = import.meta.resolve("tsx");
  return [process.execPath, "--import", loader, cliPath];
}

export interface WorkerCommandOptions {
  runsRoot: string;
  runId: string;
  task: string;
  agent: string;
  model?: string | null;
  roleConfigs?: RoleConfigs | null;
  workspace: string;
  maxRounds: number;
  promptLanguage: string;
  reasoningEffort?: string | null;
  resume?: boolean;
}

/** Build the worker argv (exported so the CLI can reuse the exact spelling). */
export function buildWorkerCommand(options: WorkerCommandOptions): string[] {
  const command = [...workerEntryCommand()];
  command.push(
    "run",
    // Values originate at the HTTP boundary.  The equals spelling keeps a value
    // beginning with '-' attached to its option instead of allowing the parser
    // to reinterpret it as another flag.
    `--task=${options.task}`,
    `--agent=${options.agent}`,
    `--runs-root=${options.runsRoot}`,
    `--run-id=${options.runId}`,
    `--workspace=${options.workspace}`,
    `--max-rounds=${options.maxRounds}`,
    `--prompt-language=${options.promptLanguage}`,
    "--no-dashboard",
    "--supervised",
  );
  if (options.resume) command.push("--resume");
  if (options.model) command.push(`--model=${options.model}`);
  if (options.reasoningEffort && !options.roleConfigs) {
    command.push(`--reasoning-effort=${options.reasoningEffort}`);
  }
  for (const role of ROLE_KEYS) {
    const spec = (options.roleConfigs ?? {})[role];
    if (!spec) continue;
    command.push(`--${role}-agent=${spec.agent}`, `--${role}-model=${spec.model}`);
    if (spec.reasoning_effort) command.push(`--${role}-reasoning-effort=${spec.reasoning_effort}`);
  }
  return command;
}

export interface RunSupervisorOptions {
  workspaceRoot?: string | null;
  workspace_root?: string | null;
  attachedOnly?: boolean;
  attached_only?: boolean;
  attachedRunId?: string | null;
  attached_run_id?: string | null;
}

// Every option below also accepts the Python keyword spelling, so an HTTP layer
// that forwards ``role_configs``/``max_rounds`` verbatim needs no translation.
export interface CreateRunOptions {
  task: string;
  agent?: string;
  model?: string | null;
  roleConfigs?: unknown;
  role_configs?: unknown;
  workspace?: string | null;
  maxRounds?: number;
  max_rounds?: number;
  promptLanguage?: string;
  prompt_language?: string;
  runId?: string | null;
  run_id?: string | null;
  reasoningEffort?: string | null;
  reasoning_effort?: string | null;
  idempotencyKey?: string | null;
  idempotency_key?: string | null;
  capabilities?: readonly string[] | null;
  recoverReservation?: boolean;
  idempotencyFingerprint?: string | null;
}

/** Collapse the camelCase/snake_case spellings of one create option. */
function createOption<T>(options: CreateRunOptions, camel: T | undefined, snake: T | undefined): T | undefined {
  void options;
  return camel !== undefined ? camel : snake;
}

function normaliseCreateOptions(options: CreateRunOptions): CreateRunOptions {
  return {
    ...options,
    roleConfigs: createOption(options, options.roleConfigs, options.role_configs),
    maxRounds: createOption(options, options.maxRounds, options.max_rounds),
    promptLanguage: createOption(options, options.promptLanguage, options.prompt_language),
    runId: createOption(options, options.runId, options.run_id),
    reasoningEffort: createOption(options, options.reasoningEffort, options.reasoning_effort),
    idempotencyKey: createOption(options, options.idempotencyKey, options.idempotency_key),
  };
}

/** Own worker processes and persist their lifecycle metadata. */
export class RunSupervisor {
  runsRoot: string;
  workspaceRoot: string;
  attachedOnly: boolean;
  attachedRunId: string | null;

  private processes = new Map<string, WorkerProcess>();
  private commandsByRun = new Map<string, string[]>();

  constructor(runsRoot: string, options: RunSupervisorOptions = {}) {
    this.runsRoot = resolveNonStrict(runsRoot);
    fs.mkdirSync(this.runsRoot, { recursive: true });
    this.runsRoot = resolveNonStrict(this.runsRoot);
    this.workspaceRoot = resolveNonStrict(options.workspaceRoot || options.workspace_root || process.cwd());
    this.attachedOnly = Boolean(options.attachedOnly ?? options.attached_only);
    const attachedRunId = options.attachedRunId ?? options.attached_run_id ?? null;
    if (attachedRunId !== null) RunSupervisor.validateRunId(attachedRunId);
    this.attachedRunId = attachedRunId;
  }

  /** Serialize launch/resume idempotency transactions across workers. */
  private supervisorLocked<T>(body: () => T): T {
    return withProcessLock(
      this.runsRoot,
      ".supervisor.lock",
      "secure supervisor locking is unavailable",
      body,
    );
  }

  static idempotencyKeyOf(value: string | null | undefined): string {
    const key = pyStrip(String(value ?? ""));
    if (key.length > 256 || key.includes("\u0000")) {
      throw new Error("Idempotency-Key must be at most 256 characters");
    }
    return key;
  }

  idempotencyPath(operation: string, key: string): string {
    const digest = sha256Hex(`${operation}\u0000${key}`);
    return path.join(this.runsRoot, ".idempotency", `${operation}-${digest}.json`);
  }

  static writeIdempotency(target: string, payload: Record<string, unknown>): void {
    atomicBytesWrite(target, Buffer.from(`${jsonDumpsSorted(payload)}\n`, "utf-8"));
  }

  static readIdempotency(target: string): Record<string, unknown> {
    return readJson(target);
  }

  /** Persist the worker prompt without putting it in ``ps`` arguments. */
  static writeTaskFile(target: string, task: string): void {
    atomicBytesWrite(target, Buffer.from(`${task}\n`, "utf-8"));
  }

  private existingRunResult(
    runId: string,
    options: { expectedFingerprint?: string | null } = {},
  ): Record<string, unknown> | null {
    const runDir = this.runDirOf(runId);
    const logs = this.runLogsDir(runId);
    const owner = readJson(path.join(runDir, "control", "owner.json"));
    if (!Object.keys(owner).length || String(owner.run_id || runId) !== runId) return null;
    const marker = String(owner.idempotency_fingerprint || "");
    if (options.expectedFingerprint && marker !== options.expectedFingerprint) {
      // A deterministic idempotency run id must never be used to adopt an
      // unrelated pre-existing worker.
      return null;
    }
    const status = readJson(path.join(runDir, "control", "status.json"));
    const ownerPid = Number(owner.pid || 0);
    const lifecycle = canonicalLifecycleStatus(status.status, "");
    // A reservation owner is written before spawn.  It is not a successful
    // create result until a pid is durable, or the run has reached a terminal
    // state after a launch attempt.
    if (ownerPid <= 0 && !TERMINAL_STATUSES.has(lifecycle)) return null;
    return {
      id: runId,
      task: String(owner.task || ""),
      status: String(status.status || owner.state || "starting"),
      log_dir: String(logs),
      owner,
    };
  }

  private runDirOf(runId: string): string {
    RunSupervisor.validateRunId(runId);
    const target = safeRunDir(this.runsRoot, runId);
    if (target === null) throw new Error("invalid run id");
    return target;
  }

  /** Return a run-local logs path after rejecting symlinked layouts. */
  private runLogsDir(
    runId: string,
    options: { requireRoleManagement?: boolean; allowMissing?: boolean } = {},
  ): string {
    const runDir = this.runDirOf(runId);
    const logs = safeRunLogs(this.runsRoot, runDir, {
      requireRoleManagement: options.requireRoleManagement ?? false,
      allowMissing: options.allowMissing ?? true,
    });
    if (logs === null) throw new Error("run logs path is outside its run boundary");
    return logs;
  }

  static validateRunId(runId: string): void {
    if (
      typeof runId !== "string" ||
      !runId ||
      runId.length > 128 ||
      runId === "." ||
      runId === ".." ||
      runId.includes("/") ||
      runId.includes("\\") ||
      [...runId].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)
    ) {
      throw new Error("invalid run id");
    }
  }

  /** Keep an embedded/attached supervisor bound to exactly one run. */
  private assertRunScope(runId: string, options: { forAttach?: boolean } = {}): void {
    if (!this.attachedOnly || options.forAttach) return;
    if (!this.attachedRunId) throw new Error("attached supervisor has no attached run");
    if (runId !== this.attachedRunId) throw new Error("attached supervisor cannot access another run");
  }

  private busFor(runId: string): ControlBus {
    this.assertRunScope(runId);
    const runDir = this.runDirOf(runId);
    if (safeRunControl(this.runsRoot, runDir, { allowMissing: true }) === null) {
      throw new Error("run control path is outside its run boundary");
    }
    return new ControlBus(runDir);
  }

  private isAlive(runId: string): boolean {
    const worker = this.processes.get(runId);
    if (worker !== undefined) return worker.poll() === null;
    const owner = this.busFor(runId).readOwner();
    const pid = Number(owner.pid || 0);
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    // An embedded supervisor controls its hosting process directly.  The PID
    // cannot be reused while that same process is executing this code; avoid
    // requiring a command-line match in test runners and wrappers.  In
    // particular, ``lh-harness run --dashboard`` generates its run id after the
    // process has started, so that id can never appear in the original argv
    // unless the caller supplied ``--run-id`` explicitly.
    if (Boolean(owner.attached) && pid === process.pid) return true;
    // After an API restart the in-memory child handle is gone. Confirm the PID
    // still belongs to the same worker instead of trusting a reused PID from an
    // unrelated process.
    const expectedStart = String(owner.pid_start_identity || "");
    const currentStart = pidStartIdentity(pid);
    if (expectedStart) {
      if (!currentStart || currentStart !== expectedStart) return false;
    } else if (worker === undefined) {
      // A restarted API has no child handle and no durable identity to
      // distinguish a reused PID. Fail closed rather than signalling it.
      return false;
    }
    let current: string;
    try {
      current = supervisorRuntime.psQuery(pid, "command=") || "";
    } catch {
      return false;
    }
    if (!current) return false;
    if (!current.includes("lh-harness") && !current.includes("lh_harness")) return false;
    // Require the durable run boundary to be visible in argv as well. A
    // same-named executable alone is not enough protection from PID reuse.
    if (!current.includes(runId)) return false;
    return true;
  }

  canControl(runId: string): boolean {
    if (this.attachedOnly && runId !== this.attachedRunId) return false;
    if (this.attachedOnly && !this.attachedRunId) return false;
    const status = this.busFor(runId).readStatus();
    if (status.managed === false) return false;
    if (TERMINAL_STATUSES.has(canonicalLifecycleStatus(status.status))) return false;
    if (status.stop_requested_at || status.abort_requested_at) return false;
    if (canonicalLifecycleStatus(status.status) === "stopping") return false;
    const owner = this.busFor(runId).readOwner();
    if (owner.managed === false || owner.attached === false) return false;
    return this.isAlive(runId);
  }

  /** Persist a durable explanation when a worker exits unexpectedly. */
  private persistFailureReport(
    runId: string,
    options: { returncode: number | null; reason: string; report: Record<string, unknown> },
  ): void {
    const logs = this.runLogsDir(runId);
    ensureDirNofollow(logs);
    const crash = {
      schema_version: 1,
      supervisor_generated: true,
      status: "failed",
      run_id: runId,
      exit_code: options.returncode,
      reason: options.reason,
      observed_at: Date.now() / 1000,
      report_status: reportStatusOf(options.report),
    };
    // Use a unique temporary path so an API restart cannot leave a partial
    // report.  This is intentionally local rather than going through the
    // manager's report writer, which may still be diagnosing its own error.
    try {
      RunSupervisor.writePrivateAtomicJson(path.join(logs, "crash_report.json"), crash);
      if (!Object.keys(options.report).length) {
        RunSupervisor.writePrivateAtomicJson(path.join(logs, "report.json"), {
          schema_version: 2,
          status: "failed",
          task: String(this.busFor(runId).readOwner().task || ""),
          completion_satisfied: false,
          error: options.reason,
          supervisor_generated: true,
          exit_code: options.returncode,
        });
      }
    } catch {
      // Lifecycle state remains useful even if a read-only filesystem prevents
      // the diagnostic artifact from being written.
    }
  }

  /** Atomically write a bounded supervisor diagnostic without following a link. */
  static writePrivateAtomicJson(target: string, value: Record<string, unknown>): void {
    atomicBytesWrite(target, Buffer.from(`${jsonDumpsSorted(value, 2)}\n`, "utf-8"));
  }

  /**
   * Recover a stop/abort whose sender crashed after appending it.
   *
   * A lifecycle command is durable before the signal is sent. If the API
   * process dies in that tiny interval, a later status poll must deliver the
   * command instead of leaving a worker in ``stopping`` forever. A repeated
   * SIGTERM/SIGKILL is harmless, so replay after an uncertain crash is safer
   * than treating the command as already delivered.
   */
  private replayPendingLifecycle(
    runId: string,
    bus: ControlBus,
    status: Record<string, unknown>,
  ): Record<string, unknown> {
    const action = pyStrip(String(status.requested_action ?? "")).toLowerCase();
    if (
      (action !== "stop" && action !== "abort") ||
      canonicalLifecycleStatus(status.status) !== "stopping"
    ) {
      return status;
    }
    const commandId = lifecycleCommandId(action, resumeEpoch(status));
    const allCommands = bus.commands();
    let command: Record<string, unknown> | null = null;
    for (let index = allCommands.length - 1; index >= 0; index -= 1) {
      if (allCommands[index].command_id === commandId) {
        command = allCommands[index];
        break;
      }
    }
    if (command === null || bus.receiptFor(commandId) !== null) return status;
    const owner = bus.readOwner();
    const pid = Number(owner.pid || 0);
    const pgid = Number(owner.pgid || pid);
    if (!Number.isFinite(pid) || !Number.isFinite(pgid)) return status;

    /**
     * Close a durable stopping intent when its target is gone.
     *
     * The command is written before signalling, so a supervisor restart can
     * discover an intent after the worker has already exited.  Do not leave that
     * run in ``stopping`` with an unreceipted command: a later poll would have no
     * safe side effect left to perform and the UI would show an indefinite
     * spinner.  A valid report remains the authority; without one this is a
     * failed/crashed worker.
     */
    const reconcileUnavailable = (reason: string): Record<string, unknown> => {
      const report = readJson(path.join(this.runLogsDir(runId), "report.json"));
      const hasReport = Object.keys(report).length > 0;
      const [lifecycle, reportStatus] = terminalStatusForExit({
        report,
        returncode: hasReport ? 0 : 1,
      });
      const failureReason = lifecycle === "failed" && !hasReport ? reason : "";
      bus.receipt(command!, "rejected", { message: reason, result: { status: lifecycle } });
      const result = bus.updateStatus((value) => {
        const updated: Record<string, unknown> = {
          ...value,
          status: lifecycle,
          alive: false,
          finished_at: value.finished_at || Date.now() / 1000,
          report_status: reportStatus || null,
        };
        if (failureReason) updated.failure_reason = value.failure_reason || failureReason;
        return updated;
      });
      if (lifecycle === "failed" && !hasReport) {
        this.persistFailureReport(runId, {
          returncode: null,
          reason: failureReason || reason,
          report,
        });
      }
      return result;
    };

    if (pid <= 0 || pgid <= 0) {
      return reconcileUnavailable("worker owner has no live process identity");
    }
    if (!this.isAlive(runId)) {
      // Identity mismatch is intentionally fail-closed: never signal a reused
      // PID merely because the old owner record said it was alive.
      return reconcileUnavailable("worker is no longer running or its identity changed");
    }
    const sig: SignalName = action === "abort" ? "SIGKILL" : "SIGTERM";
    // Record an attempt for diagnostics under the same lock used by status
    // merges. Do not use it as a once-only gate: a crash after the signal and
    // before the receipt needs one safe retry.
    try {
      bus.updateStatus((value) => ({ ...value, signal_replay_attempted_at: Date.now() / 1000 }));
      if (String(owner.signal_mode || "pgid") === "pid") {
        supervisorRuntime.kill(pid, sig);
      } else {
        supervisorRuntime.killpg(pgid, sig);
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") return reconcileUnavailable("worker is no longer running");
      if (code === "EPERM") {
        bus.receipt(command, "failed", { message: "permission denied" });
        return bus.updateStatus((value) => ({
          ...value,
          status: "running",
          alive: true,
          requested_action: null,
          signal_error: "permission denied",
        }));
      }
      // Other signal errors (for example an invalid process-group boundary) are
      // also terminal for this delivery attempt.  Keep the command receipt
      // explicit instead of allowing a durable ``stopping`` spinner with no
      // explanation.
      return reconcileUnavailable(`could not signal worker: ${(error as Error).message}`);
    }
    bus.receipt(command, "accepted", { message: `replayed ${sig}` });
    return bus.updateStatus((value) => ({ ...value, signal_replayed_at: Date.now() / 1000 }));
  }

  private refresh(runId: string): Record<string, unknown> {
    const bus = this.busFor(runId);
    let status = bus.readStatus();
    status = this.replayPendingLifecycle(runId, bus, status);
    // Historical or imported runs can be explicitly unmanaged. Their
    // log/report projection remains readable, but this supervisor must not
    // infer liveness or re-enable process control.
    if (status.managed === false) {
      const report = readJson(path.join(this.runLogsDir(runId), "report.json"));
      const reportStatus = reportStatusOf(report);
      const lifecycle = canonicalLifecycleStatus(status.status, "idle");
      if (!TERMINAL_STATUSES.has(lifecycle) && TERMINAL_STATUSES.has(reportStatus)) {
        const [projected] = terminalStatusForExit({ report, returncode: 0 });
        status = bus.updateStatus((value) => ({
          ...value,
          status: projected,
          report_status: reportStatus,
          alive: false,
          managed: false,
          finished_at: value.finished_at || Date.now() / 1000,
          ...(missingCompletionEvidence(report, reportStatus)
            ? { failure_reason: MISSING_COMPLETION_EVIDENCE }
            : {}),
        }));
      } else {
        status = { ...status, alive: false, managed: false };
      }
      return status;
    }
    const worker = this.processes.get(runId);
    const returncode = worker !== undefined ? worker.poll() : null;
    if (worker !== undefined && returncode !== null) {
      const report = readJson(path.join(this.runLogsDir(runId), "report.json"));
      const hasReport = Object.keys(report).length > 0;
      const requestedAction = String(status.requested_action ?? "");
      let [lifecycle, reportStatus] = terminalStatusForExit({ report, returncode, requestedAction });
      const existingLifecycle = canonicalLifecycleStatus(status.status, "");
      if (TERMINAL_STATUSES.has(existingLifecycle)) {
        // Durable terminal decisions are monotonic.  A late/stale process poll
        // must not reopen a completed/cancelled run.
        lifecycle = existingLifecycle;
      }
      const nextStatus: Record<string, unknown> = {
        ...status,
        status: lifecycle,
        report_status: reportStatus || null,
        exit_code: returncode,
        finished_at: status.finished_at || Date.now() / 1000,
        alive: false,
      };
      const protocolFailure = missingCompletionEvidence(report, reportStatus);
      let reason = "";
      if (lifecycle === "failed" && (returncode !== 0 || !hasReport || protocolFailure)) {
        const reportReason = pyStrip(String(report.failure_reason || report.error || ""));
        reason = reportReason
          ? reportReason
          : returncode !== 0
            ? `worker exited with status ${returncode}`
            : protocolFailure
              ? MISSING_COMPLETION_EVIDENCE
              : "worker exited without a valid final report";
        nextStatus.failure_reason = reason;
      }
      const merged = bus.updateStatus((current) => mergeLifecycleStatus(current, nextStatus));
      if (merged.status === "failed" && (returncode !== 0 || !hasReport || protocolFailure)) {
        this.persistFailureReport(runId, { returncode, reason, report });
      }
      return merged;
    }

    const alive = this.isAlive(runId);
    const oldStatus = canonicalLifecycleStatus(status.status, "idle");
    let nextStatusName = oldStatus;
    if (alive) {
      const roleDir = safeRunRole(this.runsRoot, this.runDirOf(runId), { allowMissing: true });
      if (roleDir === null) throw new Error("run role path is outside its run boundary");
      if (oldStatus === "stopping" || TERMINAL_STATUSES.has(oldStatus)) {
        nextStatusName = oldStatus;
      } else if (pendingApproval(path.join(roleDir, "approvals.jsonl"))) {
        nextStatusName = "waiting_approval";
      } else if (isRegularFile(path.join(roleDir, "events.jsonl"))) {
        // ``starting`` is only the pre-worker state.  The first durable role
        // event proves that the harness is doing real work, so promote it
        // instead of leaving the UI stuck on "starting" until an approval or
        // terminal report appears.
        nextStatusName = "running";
      } else if (oldStatus === "running" || oldStatus === "waiting_approval") {
        nextStatusName = "running";
      }
    } else if (ACTIVE_STATUSES.has(oldStatus)) {
      // The API may have restarted and therefore have no child handle.
      // Reconcile an exited worker from its durable report.  Without a process
      // handle we cannot obtain an exit code, so a missing report is still a
      // failure (never an implicit completion).
      const report = readJson(path.join(this.runLogsDir(runId), "report.json"));
      const hasReport = Object.keys(report).length > 0;
      const requestedAction = String(status.requested_action ?? "");
      const [lifecycle, reportStatus] = terminalStatusForExit({
        report,
        returncode: hasReport ? 0 : 1,
        requestedAction,
      });
      nextStatusName = lifecycle;
      status = {
        ...status,
        report_status: reportStatus || null,
        exit_code: status.exit_code ?? null,
        finished_at: status.finished_at || Date.now() / 1000,
      };
      const reportReason = pyStrip(String(report.failure_reason || report.error || ""));
      if (
        lifecycle === "failed" &&
        (reportReason || !hasReport || missingCompletionEvidence(report, reportStatus))
      ) {
        status.failure_reason = reportReason
          ? reportReason
          : hasReport
            ? MISSING_COMPLETION_EVIDENCE
            : "worker disappeared without a final report";
      }
    } else if (!TERMINAL_STATUSES.has(oldStatus)) {
      // Historical/non-supervised runs have no owner status file.  Their final
      // manager report is still authoritative for the audit outcome, but a
      // missing report remains ``idle`` rather than being guessed as successful.
      const report = readJson(path.join(this.runLogsDir(runId), "report.json"));
      const hasReport = Object.keys(report).length > 0;
      const [lifecycle, reportStatus] = terminalStatusForExit({
        report,
        returncode: hasReport ? 0 : 1,
      });
      if (TERMINAL_STATUSES.has(reportStatus)) {
        nextStatusName = lifecycle;
        status = {
          ...status,
          report_status: reportStatus,
          finished_at: status.finished_at || Date.now() / 1000,
        };
        if (missingCompletionEvidence(report, reportStatus)) {
          status.failure_reason = MISSING_COMPLETION_EVIDENCE;
        }
      }
    }
    const candidate = { ...status, status: nextStatusName, alive };
    const merged = bus.updateStatus((current) => mergeLifecycleStatus(current, candidate));
    if (
      merged.status === "failed" &&
      merged.failure_reason === "worker disappeared without a final report"
    ) {
      this.persistFailureReport(runId, {
        returncode: null,
        reason: String(merged.failure_reason),
        report: {},
      });
    }
    return merged;
  }

  listRunItems(): Record<string, unknown>[] {
    const items: Record<string, unknown>[] = [];
    if (!isDirectory(this.runsRoot)) return items;
    const safeEntry = (entry: string): boolean => {
      try {
        const resolved = safeRunDir(this.runsRoot, path.basename(entry));
        return resolved !== null && resolved === entry && isDirectory(resolved);
      } catch {
        return false;
      }
    };
    let entries: string[];
    try {
      entries = fs.readdirSync(this.runsRoot).map((name) => path.join(this.runsRoot, name));
    } catch {
      return items;
    }
    let runDirs = entries.filter(safeEntry);

    const mtimeOf = (entry: string): number => {
      // Directory deletion/replacement is normal while a run is being cleaned
      // up.  Sorting must be best-effort and never turn one disappearing entry
      // into a 500 for the whole /api/runs request.
      if (!safeEntry(entry)) return 0.0;
      try {
        return fs.statSync(entry).mtimeMs / 1000;
      } catch {
        return 0.0;
      }
    };

    runDirs = runDirs
      .map((entry) => [entry, mtimeOf(entry)] as const)
      .sort((left, right) => right[1] - left[1])
      .map(([entry]) => entry);
    if (this.attachedOnly) {
      if (!this.attachedRunId) return items;
      const attached = path.join(this.runsRoot, this.attachedRunId);
      runDirs = safeEntry(attached) ? [attached] : [];
    }
    for (const runDir of runDirs) {
      if (!safeEntry(runDir)) continue;
      const logs = safeRunLogs(this.runsRoot, runDir, { allowMissing: true });
      const control = safeRunControl(this.runsRoot, runDir, { allowMissing: true });
      const role = safeRunRole(this.runsRoot, runDir, { allowMissing: true });
      const rounds = safeRunRounds(this.runsRoot, runDir, { allowMissing: true });
      if (logs === null || control === null || role === null || rounds === null) continue;
      if (!(isDirectory(role) || isDirectory(control))) continue;
      let status: Record<string, unknown>;
      let report: Record<string, unknown>;
      let owner: Record<string, unknown>;
      let mtime: number;
      try {
        status = this.refresh(path.basename(runDir));
        report = readJson(path.join(logs, "report.json"));
        owner = readJson(path.join(runDir, "control", "owner.json"));
        mtime = fs.statSync(runDir).mtimeMs / 1000;
      } catch {
        // A concurrently removed/replaced run is simply absent from this poll;
        // it must not turn the entire /api/runs response into a 500.
        continue;
      }
      let task = String(owner.task || report.task || "");
      if (!task) {
        task = savedTaskFromRounds(this.runsRoot, path.basename(runDir), { firstLine: true });
      }
      const item: Record<string, unknown> = {
        id: path.basename(runDir),
        task,
        status: String(status.status || report.status || "idle"),
        mtime,
        log_dir: String(logs),
      };
      // Keep the actual launch provenance beside the run summary source so the
      // Web API can expose it even if the corresponding dashboard state is
      // evicted/rejected during a concurrent filesystem change.
      for (const field of ["agent", "model", "role_configs", "workspace", "max_rounds", "prompt_language"]) {
        if (field in owner) item[field] = owner[field];
      }
      items.push(item);
    }
    return items;
  }

  status(runId: string): Record<string, unknown> {
    this.assertRunScope(runId);
    return this.refresh(runId);
  }

  owner(runId: string): Record<string, unknown> {
    this.assertRunScope(runId);
    return this.busFor(runId).readOwner();
  }

  /** Create one worker, replaying a durable result for request retries. */
  createRun(rawOptions: CreateRunOptions): Record<string, unknown> {
    const options = normaliseCreateOptions(rawOptions);
    const key = RunSupervisor.idempotencyKeyOf(options.idempotencyKey ?? null);
    if (!key) return this.createRunOnce(options);
    const request = {
      task: options.task,
      agent: options.agent ?? "codex",
      model: options.model ?? null,
      role_configs: (options.roleConfigs ?? null) as unknown,
      workspace: options.workspace ?? null,
      max_rounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
      prompt_language: options.promptLanguage ?? "en",
      run_id: options.runId ?? null,
      reasoning_effort: options.reasoningEffort ?? null,
    };
    const fingerprint = sha256Hex(jsonDumpsSorted(request));
    const target = this.idempotencyPath("create", key);
    return this.supervisorLocked(() => {
      const existing = RunSupervisor.readIdempotency(target);
      let reservedRunId: string;
      if (Object.keys(existing).length) {
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflict(
            "Idempotency-Key was already used for a different create request",
          );
        }
        const result = existing.result;
        if (isRecord(result)) return { ...result, idempotent: true };
        reservedRunId = String(existing.run_id || "");
        if (reservedRunId) {
          const recovered = this.existingRunResult(reservedRunId, { expectedFingerprint: fingerprint });
          if (recovered !== null) {
            RunSupervisor.writeIdempotency(target, {
              ...existing,
              state: "completed",
              result: recovered,
              completed_at: Date.now() / 1000,
            });
            return { ...recovered, idempotent: true };
          }
          // A crashed caller may have persisted the reservation before it
          // created the run directory.  Reuse that stable id and complete the
          // launch transaction on retry.
          if (pathExists(this.runDirOf(reservedRunId))) {
            // A directory with a reservation but no durable pid is recoverable;
            // an active/owned directory was handled by existingRunResult above
            // and is not recoverable.
            const reservationDir = this.runDirOf(reservedRunId);
            const owner = readJson(path.join(reservationDir, "control", "owner.json"));
            const status = readJson(path.join(reservationDir, "control", "status.json"));
            if (
              Number(owner.pid || 0) > 0 ||
              ACTIVE_STATUSES.has(canonicalLifecycleStatus(status.status, ""))
            ) {
              throw new IdempotencyConflict("request is already being created");
            }
          }
        } else {
          reservedRunId = String(options.runId || "") || `idem-${fingerprint.slice(0, 24)}`;
        }
      } else {
        reservedRunId = String(options.runId || "") || `idem-${fingerprint.slice(0, 24)}`;
        // A fresh idempotency key is not allowed to "recover" an explicit run
        // directory that predates the request.  Recovery is only valid after
        // the reservation record itself exists.
        if (pathExists(this.runDirOf(reservedRunId))) {
          throw new Error(`run already exists: ${reservedRunId}`);
        }
      }
      // Record the reservation before spawning the worker.  A crash or client
      // disconnect after launch can therefore be reconciled by a retry instead
      // of starting a second process.
      RunSupervisor.writeIdempotency(target, {
        schema_version: 1,
        operation: "create",
        key,
        fingerprint,
        run_id: reservedRunId,
        state: "creating",
        created_at: Date.now() / 1000,
      });
      const created = this.createRunOnce({
        ...options,
        runId: reservedRunId,
        recoverReservation: Boolean(Object.keys(existing).length),
        idempotencyFingerprint: fingerprint,
      });
      RunSupervisor.writeIdempotency(target, {
        schema_version: 1,
        operation: "create",
        key,
        fingerprint,
        run_id: reservedRunId,
        state: "completed",
        result: created,
        created_at: Date.now() / 1000,
        completed_at: Date.now() / 1000,
      });
      return created;
    });
  }

  private createRunOnce(rawOptions: CreateRunOptions): Record<string, unknown> {
    const options = normaliseCreateOptions(rawOptions);
    if (this.attachedOnly) {
      throw new Error("this API is attached to an existing worker and cannot create runs");
    }
    if (typeof options.task !== "string") throw new Error("task must be a string");
    const task = pyStrip(options.task);
    if (!task) throw new Error("task is required");
    if (task.length > 100_000 || task.includes("\u0000")) {
      throw new Error("task is too large or contains a NUL byte");
    }
    const agent = options.agent ?? "codex";
    if (!AGENT_CHOICES.has(agent)) {
      throw new Error("agent must be codex, claude_code, deepseek_harness, or opencode");
    }
    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    if (
      typeof maxRounds !== "number" ||
      !Number.isInteger(maxRounds) ||
      !(maxRounds >= 1 && maxRounds <= MAX_ROUNDS)
    ) {
      throw new Error(`max_rounds must be an integer from 1 to ${MAX_ROUNDS}`);
    }
    const promptLanguage = options.promptLanguage ?? "en";
    if (promptLanguage !== "en" && promptLanguage !== "zh") {
      throw new Error("prompt_language must be en or zh");
    }
    let model = options.model ?? null;
    if (model !== null && model !== undefined) {
      if (
        typeof model !== "string" ||
        !pyStrip(model) ||
        pyStrip(model).length > 256 ||
        model.includes("\u0000")
      ) {
        throw new Error("model must be a non-empty string of at most 256 characters");
      }
      model = pyStrip(model);
    }
    const reasoningEffort = normaliseReasoningEffort(options.reasoningEffort ?? null) || null;
    if (reasoningEffort && !supportsReasoningEffort(agent)) {
      throw new Error(`agent ${agent} does not accept a reasoning effort`);
    }
    const resolvedRoleConfigs = normaliseRoleConfigs(options.roleConfigs ?? null, {
      agent,
      model,
      reasoningEffort,
    });
    const capabilities = resolveCapabilities(options.capabilities ?? null);
    const runId =
      options.runId ||
      `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}_${crypto
        .randomUUID()
        .replace(/-/g, "")
        .slice(0, 8)}`;
    const runDir = this.runDirOf(runId);
    let workspacePath = this.resolveWorkspace(options.workspace ?? null);
    fs.mkdirSync(workspacePath, { recursive: true });
    // Re-resolve after mkdir: a pre-existing symlink or a concurrently
    // introduced symlink must not redirect the worker outside the boundary.
    workspacePath = this.resolveWorkspace(workspacePath);
    // Atomic directory creation prevents two API processes from accepting the
    // same explicit run id and overwriting each other's owner/worker.  Node's
    // recursive mkdir never reports EEXIST for the leaf, so the parent chain is
    // created recursively and the run directory itself exclusively.
    let alreadyExisted = false;
    try {
      fs.mkdirSync(path.dirname(runDir), { recursive: true });
      fs.mkdirSync(runDir);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      alreadyExisted = true;
    }
    if (alreadyExisted) {
      if (!options.recoverReservation) throw new Error(`run already exists: ${runId}`);
      if (
        safeRunLogs(this.runsRoot, runDir, { allowMissing: true }) === null ||
        safeRunControl(this.runsRoot, runDir, { allowMissing: true }) === null
      ) {
        throw new Error("run reservation path is outside its run boundary");
      }
      const existingOwner = readJson(path.join(runDir, "control", "owner.json"));
      const existingStatus = readJson(path.join(runDir, "control", "status.json"));
      if (options.idempotencyFingerprint && Object.keys(existingOwner).length) {
        const marker = String(existingOwner.idempotency_fingerprint || "");
        if (marker !== options.idempotencyFingerprint) {
          throw new IdempotencyConflict(
            "idempotency reservation belongs to a different run request",
          );
        }
      }
      if (
        Number(existingOwner.pid || 0) > 0 ||
        ACTIVE_STATUSES.has(canonicalLifecycleStatus(existingStatus.status, ""))
      ) {
        throw new Error(`run already exists: ${runId}`);
      }
    }
    // A recovered reservation is still untrusted filesystem state.  Do not
    // launch a worker when its logs path was replaced with a sibling/outside
    // symlink while the original API process was unavailable.
    this.runLogsDir(runId);
    if (safeRunControl(this.runsRoot, runDir, { allowMissing: true }) === null) {
      throw new Error("run control path is outside its run boundary");
    }
    const taskPath = path.join(runDir, "tmp", "task.md");
    RunSupervisor.writeTaskFile(taskPath, task);
    const bus = new ControlBus(runDir);
    const command = buildWorkerCommand({
      runsRoot: this.runsRoot,
      runId,
      // Keep the full task out of the process table and durable
      // ``command_display``; the owner record remains the resumable source of
      // truth.
      task: `@${taskPath}`,
      agent,
      model,
      roleConfigs: resolvedRoleConfigs,
      workspace: workspacePath,
      maxRounds,
      promptLanguage,
      reasoningEffort,
    });
    const startedAt = Date.now() / 1000;
    // Reserve the run before launching a process.  This closes the orphan
    // window where a fast-crashing worker existed without durable owner or
    // lifecycle metadata.
    const reservation: Record<string, unknown> = {
      run_id: runId,
      state: "creating",
      supervisor_pid: process.pid,
      started_at: startedAt,
      task,
      agent,
      model,
      role_configs: resolvedRoleConfigs,
      max_rounds: maxRounds,
      prompt_language: promptLanguage,
      workspace: workspacePath,
      capabilities,
    };
    if (reasoningEffort) reservation.reasoning_effort = reasoningEffort;
    if (options.idempotencyFingerprint) {
      reservation.idempotency_fingerprint = options.idempotencyFingerprint;
    }
    return this.launchWorker({ runId, runDir, bus, command, reservation, workspacePath, task });
  }

  /**
   * Persist the reservation, spawn the worker, and promote the owner.
   *
   * Shared by run creation and in-place resume so both paths get the same
   * launch transaction: no worker is ever left running without a durable owner,
   * and a failed launch always leaves a terminal status.
   */
  private launchWorker(options: {
    runId: string;
    runDir: string;
    bus: ControlBus;
    command: string[];
    reservation: Record<string, unknown>;
    workspacePath: string;
    task: string;
  }): Record<string, unknown> {
    const { runId, runDir, bus, command, reservation, workspacePath, task } = options;
    const startedAt = Number(reservation.started_at || Date.now() / 1000);
    const epoch = resumeEpoch(reservation);
    bus.writeOwner(reservation);
    const creatingStatus: Record<string, unknown> = {
      run_id: runId,
      status: "creating",
      started_at: startedAt,
      workspace: String(workspacePath),
      alive: false,
    };
    if (epoch) creatingStatus[RESUME_EPOCH_KEY] = epoch;
    bus.writeStatus(creatingStatus);
    const outputPath = path.join(runDir, "worker.log");
    // Open the final log component with no-follow semantics and compact an old
    // retained tail before handing the descriptor to the child.  A symlink or
    // special file is a failed launch, never a reason to write worker output
    // outside this run.
    let logFd: number;
    try {
      logFd = openWorkerLog(outputPath);
    } catch (error) {
      try {
        bus.writeStatus({
          ...bus.readStatus(),
          status: "failed",
          alive: false,
          finished_at: Date.now() / 1000,
          failure_reason: "worker log is not a safe regular file",
        });
      } catch {
        /* ignore */
      }
      throw error;
    }
    // The Web API bearer token is a control-plane credential.  It is often
    // supplied through ``LH_HARNESS_WEB_TOKEN`` and must not be inherited by the
    // worker/agent, whose prompt/tool environment is deliberately less trusted.
    // The worker is launched with ``--no-dashboard`` and has no legitimate need
    // for this variable; retaining the rest of the environment preserves
    // provider/API-key compatibility.
    // Capability gating (addition over upstream): strip credential env for any
    // integration the operator did not grant this run, and hand the worker a
    // per-run MCP config with only the granted servers (browser + selected).
    const grantedCapabilities = resolveCapabilities(
      (reservation.capabilities as string[] | undefined) ?? null,
    );
    const workerEnv: NodeJS.ProcessEnv = gateWorkerEnv(process.env, grantedCapabilities);
    delete workerEnv.LH_HARNESS_WEB_TOKEN;
    const runMcpConfig = writeRunMcpConfig(
      runDir,
      grantedCapabilities,
      workerEnv,
      process.env.LH_HARNESS_CLAUDECODE_MCP_CONFIG ?? null,
    );
    if (runMcpConfig) workerEnv.LH_HARNESS_CLAUDECODE_MCP_CONFIG = runMcpConfig;
    else delete workerEnv.LH_HARNESS_CLAUDECODE_MCP_CONFIG;
    let worker: WorkerProcess;
    try {
      worker = supervisorRuntime.spawn(command, {
        cwd: String(workspacePath),
        logFd,
        env: workerEnv,
      });
    } catch (error) {
      bus.writeStatus({
        ...bus.readStatus(),
        status: "failed",
        alive: false,
        finished_at: Date.now() / 1000,
        failure_reason: "worker could not be launched",
      });
      throw error;
    } finally {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    const owner: Record<string, unknown> = {
      ...reservation,
      state: "running",
      run_id: runId,
      pid: worker.pid,
      pgid: worker.pid,
      command,
      command_display: shlexJoin(command),
      ...processIdentity(worker.pid, command),
    };
    const startingStatus: Record<string, unknown> = {
      run_id: runId,
      status: "starting",
      pid: worker.pid,
      started_at: owner.started_at,
      workspace: String(workspacePath),
      alive: true,
    };
    if (epoch) startingStatus[RESUME_EPOCH_KEY] = epoch;
    try {
      bus.writeOwner(owner);
      bus.writeStatus(startingStatus);
    } catch (error) {
      // Metadata is part of the launch transaction.  Do not leave an unowned
      // worker running if the durable reservation cannot be promoted to a live
      // owner.
      try {
        supervisorRuntime.killpg(worker.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      throw error;
    }
    this.processes.set(runId, worker);
    this.commandsByRun.set(runId, command);
    return {
      id: runId,
      task,
      status: "starting",
      log_dir: String(this.runLogsDir(runId)),
      owner,
    };
  }

  /**
   * Register a worker that was launched outside this supervisor.
   *
   * ``lh-harness run --dashboard`` owns its own process, so there is no child
   * handle for the embedded API to use.  Persisting an attached owner gives the
   * same API a safe PID control path while retaining the supervisor as the
   * single lifecycle projection authority.
   */
  attachRun(rawOptions: {
    runId?: string;
    run_id?: string;
    pid: number;
    task?: string;
    agent?: string;
    model?: string | null;
    roleConfigs?: unknown;
    role_configs?: unknown;
    workspace?: string | null;
    maxRounds?: number;
    max_rounds?: number;
    promptLanguage?: string;
    prompt_language?: string;
    command?: string[] | null;
  }): Record<string, unknown> {
    const options = {
      ...rawOptions,
      runId: rawOptions.runId ?? rawOptions.run_id ?? "",
      roleConfigs: rawOptions.roleConfigs !== undefined ? rawOptions.roleConfigs : rawOptions.role_configs,
      maxRounds: rawOptions.maxRounds ?? rawOptions.max_rounds,
      promptLanguage: rawOptions.promptLanguage ?? rawOptions.prompt_language,
    };
    const { runId, pid } = options;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new Error("attached worker pid must be a positive integer");
    }
    if (this.attachedOnly && pid !== process.pid) {
      throw new Error("attached-only supervisor may attach only its current worker process");
    }
    RunSupervisor.validateRunId(runId);
    if (this.attachedOnly && this.attachedRunId && this.attachedRunId !== runId) {
      throw new Error("attached supervisor cannot attach another run");
    }
    const runDir = this.runDirOf(runId);
    fs.mkdirSync(runDir, { recursive: true });
    if (
      safeRunLogs(this.runsRoot, runDir, { allowMissing: true }) === null ||
      safeRunControl(this.runsRoot, runDir, { allowMissing: true }) === null
    ) {
      throw new Error("attached run path is outside its run boundary");
    }
    const workspacePath = this.resolveWorkspace(options.workspace ?? null);
    // Bypass the scope guard only for the initial attach transaction; the guard
    // becomes active immediately after the owner is durable.
    const bus = new ControlBus(runDir);
    const existing = bus.readOwner();
    const existingPid = Number(existing.pid || 0);
    if (existingPid > 0 && existingPid !== pid) {
      throw new Error("run is already owned by another worker");
    }
    const agent = options.agent ?? "";
    const model = options.model;
    const command = options.command || (existing.command as string[] | undefined) || [
      process.execPath,
      ...process.argv.slice(1),
    ];
    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const promptLanguage = options.promptLanguage ?? "en";
    const owner: Record<string, unknown> = {
      ...existing,
      run_id: runId,
      pid,
      pgid: pid,
      signal_mode: "pid",
      attached: true,
      managed: true,
      started_at: existing.started_at || Date.now() / 1000,
      task: options.task || existing.task || "",
      agent: agent || existing.agent || "",
      model: model !== undefined && model !== null ? model : (existing.model ?? null),
      role_configs:
        options.roleConfigs !== undefined && options.roleConfigs !== null
          ? normaliseRoleConfigs(options.roleConfigs, {
              agent: agent || String(existing.agent || "codex"),
              model:
                model !== undefined && model !== null
                  ? model
                  : existing.model
                    ? String(existing.model)
                    : null,
            })
          : (existing.role_configs ?? {}),
      max_rounds: maxRounds,
      prompt_language: promptLanguage === "en" || promptLanguage === "zh" ? promptLanguage : "en",
      workspace: String(workspacePath),
      command,
      command_display: shlexJoin(command),
      ...processIdentity(pid, command),
    };
    bus.writeOwner(owner);
    // Set the in-memory scope only after the durable owner write succeeds; a
    // failed attach must not leave the API pointing at a half-registered run.
    if (this.attachedOnly) this.attachedRunId = runId;
    const current = bus.readStatus();
    if (!TERMINAL_STATUSES.has(canonicalLifecycleStatus(current.status, ""))) {
      bus.writeStatus({
        ...current,
        run_id: runId,
        status: "running",
        pid,
        started_at: owner.started_at,
        workspace: String(workspacePath),
        alive: true,
        managed: true,
        attached: true,
      });
    }
    return owner;
  }

  /**
   * Persist the terminal result before an embedded process exits.
   *
   * ``attachRun`` records the hosting CLI PID, not a child handle.  Therefore
   * normal ``status()`` polling cannot observe the worker's completion while
   * ``--keep-dashboard`` keeps that PID alive.  This method derives the
   * lifecycle from the final report, preserves a concurrently persisted
   * stop/abort intent, and then clears the PID so future API processes cannot
   * signal a reused process.
   */
  finalizeAttachedRun(
    runId: string,
    options: { report?: Record<string, unknown> | null; returncode?: number | null; reason?: string } = {},
  ): Record<string, unknown> {
    this.assertRunScope(runId);
    const bus = this.busFor(runId);
    const returncode = options.returncode === undefined ? 0 : options.returncode;
    const runReport = isRecord(options.report)
      ? options.report
      : readJson(path.join(this.runLogsDir(runId), "report.json"));
    const current = bus.readStatus();
    const requestedAction = String(current.requested_action ?? "");
    const [candidate, reportStatus] = terminalStatusForExit({
      report: runReport,
      returncode,
      requestedAction,
    });
    let failureReason: string;
    if (options.reason && candidate === "failed") {
      failureReason = options.reason;
    } else if (candidate === "failed" && missingCompletionEvidence(runReport, reportStatus)) {
      failureReason = MISSING_COMPLETION_EVIDENCE;
    } else {
      failureReason = String(current.failure_reason || "");
    }

    const status = bus.updateStatus((value) => {
      const existing = canonicalLifecycleStatus(value.status, "");
      const lifecycle = TERMINAL_STATUSES.has(existing) ? existing : candidate;
      const updated: Record<string, unknown> = {
        ...value,
        status: lifecycle,
        report_status: reportStatus || value.report_status || null,
        exit_code: returncode,
        finished_at: value.finished_at || Date.now() / 1000,
        alive: false,
        managed: true,
      };
      if (failureReason && lifecycle === "failed") updated.failure_reason = failureReason;
      return updated;
    });
    let owner = bus.readOwner();
    if (Object.keys(owner).length) {
      owner = {
        ...owner,
        state: status.status || candidate,
        managed: false,
        attached: false,
        pid: 0,
        pgid: 0,
        signal_mode: "none",
        finished_at: status.finished_at || Date.now() / 1000,
      };
      bus.writeOwner(owner);
    }
    return status;
  }

  /** Resolve and enforce the supervisor workspace boundary. */
  private resolveWorkspace(workspace: string | null | undefined): string {
    const root = this.workspaceRoot;
    fs.mkdirSync(root, { recursive: true });
    let candidate = expandUser(String(workspace || root));
    if (!path.isAbsolute(candidate)) {
      // Relative workspace values are interpreted relative to the configured
      // root, making the boundary explicit and predictable.
      candidate = path.join(root, candidate);
    }
    let resolved: string;
    try {
      resolved = resolveNonStrict(candidate);
    } catch {
      throw new Error(`invalid workspace path: ${candidate}`);
    }
    if (!isInside(resolved, root)) {
      throw new Error(`workspace must be inside configured workspace root: ${root}`);
    }
    return resolved;
  }

  private signalRun(runId: string, sig: SignalName, kind: "stop" | "abort"): Record<string, unknown> {
    if (this.attachedOnly && runId !== this.attachedRunId) {
      throw new Error("attached supervisor cannot control this run");
    }
    this.assertRunScope(runId);
    const bus = this.busFor(runId);
    const current = this.refresh(runId);
    // A stable command id gives stop/abort true idempotency even when two API
    // processes race.  Replaying the request returns the first durable receipt
    // and never sends a second signal.  The id is scoped by resume generation so
    // reopening a run does not inherit the previous generation's delivered stop.
    const epoch = resumeEpoch(current);
    const commandId = lifecycleCommandId(kind, epoch);
    const findCommand = (id: string): Record<string, unknown> | null => {
      const all = bus.commands();
      for (let index = all.length - 1; index >= 0; index -= 1) {
        if (all[index].command_id === id) return all[index];
      }
      return null;
    };
    const existing = findCommand(commandId);
    if (existing !== null) {
      const receipt = bus.receiptFor(commandId);
      return {
        command_id: commandId,
        status: String(receipt?.status || "accepted"),
        signal: String(asRecord(existing.payload).signal || sig),
        idempotent: true,
      };
    }
    const currentStatus = canonicalLifecycleStatus(current.status);
    const requestedAction = pyStrip(String(current.requested_action ?? "")).toLowerCase();
    if (currentStatus === "stopping" || requestedAction === "stop" || requestedAction === "abort") {
      // Repeated lifecycle clicks are normal while the UI waits for process
      // reconciliation. Treat them as idempotent instead of surfacing a
      // conflict. The one meaningful transition is an explicit Abort after Stop,
      // which escalates SIGTERM to SIGKILL and updates the durable requested
      // action below.
      if (!(kind === "abort" && requestedAction === "stop")) {
        const activeKind =
          requestedAction === "stop" || requestedAction === "abort" ? requestedAction : kind;
        const activeCommandId = lifecycleCommandId(activeKind, epoch);
        const activeCommand = findCommand(activeCommandId);
        const receipt = bus.receiptFor(activeCommandId);
        const activeSignal = activeKind === "abort" ? "SIGKILL" : "SIGTERM";
        return {
          command_id: activeCommandId,
          status: String(receipt?.status || "accepted"),
          signal: String(asRecord(activeCommand?.payload).signal || activeSignal),
          idempotent: true,
        };
      }
    }
    if (!current.alive) throw new Error("worker is no longer running");
    const owner = bus.readOwner();
    if (!Object.keys(owner).length) throw new Error("run has no owner");
    const pgid = Number(owner.pgid || owner.pid || 0);
    if (!(pgid > 0)) throw new Error("run owner has no process group");
    let command: Record<string, unknown>;
    try {
      command = bus.append(
        kind,
        { signal: sig },
        {
          createdBy: "web",
          expectedRevision: bus.revision(),
          commandId,
          returnReplay: true,
        },
      );
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error;
      // Another supervisor won the race; return its command rather than issuing
      // a duplicate signal.
      const raced = findCommand(commandId);
      if (raced === null) throw new Error("could not persist lifecycle command");
      const receipt = bus.receiptFor(commandId);
      return {
        command_id: commandId,
        status: String(receipt?.status || "accepted"),
        signal: String(asRecord(raced.payload).signal || sig),
        idempotent: true,
      };
    }
    if (command._idempotent_replay) {
      const receipt = bus.receiptFor(commandId);
      return {
        command_id: commandId,
        status: String(receipt?.status || "accepted"),
        signal: String(asRecord(command.payload).signal || sig),
        idempotent: true,
      };
    }
    const now = Date.now() / 1000;
    const previousStatus = { ...current };

    const intentStatus = bus.updateStatus((value) => {
      // A concurrent poll may have already observed the worker's exit.  Preserve
      // that terminal decision; otherwise persist the operator intent together
      // with ``stopping`` atomically.
      const previousLifecycle = canonicalLifecycleStatus(value.status);
      if (TERMINAL_STATUSES.has(previousLifecycle)) return value;
      return {
        ...value,
        status: "stopping",
        requested_action: kind,
        stop_requested_at: kind === "stop" ? now : value.stop_requested_at,
        abort_requested_at: kind === "abort" ? now : value.abort_requested_at,
      };
    });
    const intentLifecycle = canonicalLifecycleStatus(intentStatus.status);
    const intentAction = pyStrip(String(intentStatus.requested_action ?? "")).toLowerCase();
    if (TERMINAL_STATUSES.has(intentLifecycle) || (intentLifecycle === "stopping" && intentAction !== kind)) {
      bus.receipt(command, "cancelled", { message: "run was already stopping or terminal" });
      return {
        command_id: command.command_id,
        status: "cancelled",
        signal: sig,
        idempotent: true,
      };
    }

    const ownerPid = Number(owner.pid || pgid);
    if (Boolean(owner.attached) && ownerPid === process.pid) {
      // The embedded dashboard and Manager share this process.  An OS signal
      // here would kill the API thread and Manager before either can flush a
      // terminal report.  The hosting CLI watches this durable intent and
      // cancels its Manager task inside the event loop, which also lets
      // LocalEnvironment reap the active agent process group.
      bus.receipt(command, "accepted", { message: "queued cooperative embedded cancellation" });
      return { command_id: command.command_id, status: "accepted", signal: sig };
    }
    try {
      if (String(owner.signal_mode || "pgid") === "pid") {
        supervisorRuntime.kill(ownerPid, sig);
      } else {
        supervisorRuntime.killpg(pgid, sig);
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") {
        // The signal raced with process exit.  Do not leave a durable
        // ``stopping`` state behind: reconcile from the final report, or record
        // a crash when the worker vanished without one.
        const report = readJson(path.join(this.runLogsDir(runId), "report.json"));
        const hasReport = Object.keys(report).length > 0;
        const [lifecycle, reportStatus] = terminalStatusForExit({
          report,
          returncode: hasReport ? 0 : 1,
        });
        const reason = "worker is no longer running";
        bus.updateStatus((value) => ({
          ...value,
          status: lifecycle,
          alive: false,
          finished_at: value.finished_at || Date.now() / 1000,
          report_status: reportStatus || null,
          ...(lifecycle === "failed" ? { failure_reason: reason } : {}),
        }));
        if (lifecycle === "failed" && !hasReport) {
          this.persistFailureReport(runId, { returncode: null, reason, report });
        }
        bus.receipt(command, "rejected", { message: reason, result: { status: lifecycle } });
        throw new Error("worker is no longer running");
      }
      if (code === "EPERM") {
        // Permission failures mean the worker may still be active.  A failed
        // control request must therefore roll back only the operator intent,
        // preserving the pre-request active state.
        bus.updateStatus((value) => {
          const restored = { ...value };
          let previousLifecycle = canonicalLifecycleStatus(previousStatus.status, "running");
          if (!ACTIVE_STATUSES.has(previousLifecycle)) previousLifecycle = "running";
          restored.status = previousLifecycle;
          restored.alive = previousStatus.alive === undefined ? true : Boolean(previousStatus.alive);
          delete restored.requested_action;
          delete restored.stop_requested_at;
          delete restored.abort_requested_at;
          restored.signal_error = "permission denied";
          return restored;
        });
        bus.receipt(command, "failed", {
          message: "permission denied",
          result: { status: previousStatus.status ?? "running" },
        });
        throw new Error("permission denied while signalling worker");
      }
      throw error;
    }
    bus.receipt(command, "accepted", { message: `sent ${sig}` });
    return { command_id: command.command_id, status: "accepted", signal: sig };
  }

  stop(runId: string): Record<string, unknown> {
    return this.signalRun(runId, "SIGTERM", "stop");
  }

  abort(runId: string): Record<string, unknown> {
    return this.signalRun(runId, "SIGKILL", "abort");
  }

  /**
   * Stop workers launched by this supervisor before its API exits.
   *
   * Only entries with an in-memory handle are owned by this process.
   * Historical/adopted workers are deliberately excluded so one Web instance can
   * never kill a task started by another instance merely because both can read
   * the same runs directory.
   *
   * (Async in the Node port: a synchronous grace period would starve the event
   * loop that observes child exits.)
   */
  async shutdown(options: { graceSeconds?: number } = {}): Promise<void> {
    const graceSeconds = options.graceSeconds ?? 5.0;
    const owned = new Map<string, WorkerProcess>();
    for (const [runId, worker] of this.processes) {
      if (worker.poll() === null) owned.set(runId, worker);
    }
    if (!owned.size) return;
    for (const runId of owned.keys()) {
      try {
        this.stop(runId);
      } catch {
        // The worker may have exited between the ownership snapshot and signal
        // delivery. The poll/reconciliation below remains the lifecycle
        // authority.
      }
    }
    const deadline = Date.now() + Math.max(0, graceSeconds) * 1000;
    while ([...owned.values()].some((worker) => worker.poll() === null) && Date.now() < deadline) {
      await sleep(0.05);
    }
    for (const worker of owned.values()) {
      if (worker.poll() !== null) continue;
      try {
        supervisorRuntime.killpg(worker.pid, "SIGKILL");
      } catch (error) {
        const code = errorCode(error);
        if (code === "ESRCH") continue;
        if (code === "EPERM") {
          // These are still verified in-memory children; fall back to a direct
          // signal when a platform denies killpg.
          try {
            worker.kill?.("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
    }
    const settleDeadline = Date.now() + 1000;
    while ([...owned.values()].some((worker) => worker.poll() === null) && Date.now() < settleDeadline) {
      await sleep(0.02);
    }
    for (const runId of owned.keys()) {
      try {
        this.status(runId);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Restart an interrupted run.
   *
   * ``continue`` (the default) reopens the same run directory so the worker
   * picks up its recorded rounds.  ``retry`` keeps the historical behaviour of
   * starting a fresh run from the saved task and configuration.
   */
  resume(
    runId: string,
    options: {
      mode?: string;
      extraRounds?: number | null;
      extra_rounds?: number | null;
      idempotencyKey?: string | null;
      idempotency_key?: string | null;
    } = {},
  ): Record<string, unknown> {
    const mode = options.mode ?? "continue";
    const extraRounds = options.extraRounds ?? options.extra_rounds ?? null;
    if (!(RESUME_MODES as readonly string[]).includes(mode)) {
      throw new Error("mode must be continue or retry");
    }
    if (
      extraRounds !== null &&
      extraRounds !== undefined &&
      (typeof extraRounds !== "number" ||
        !Number.isInteger(extraRounds) ||
        !(extraRounds >= 1 && extraRounds <= MAX_ROUNDS))
    ) {
      throw new Error(`extra_rounds must be an integer from 1 to ${MAX_ROUNDS}`);
    }
    const key = RunSupervisor.idempotencyKeyOf(options.idempotencyKey ?? options.idempotency_key ?? null);
    if (!key) return this.resumeOnce(runId, { mode, extraRounds });
    if (mode === "continue") {
      // An in-place resume reuses the run id, so there is no new reservation to
      // recover.  The epoch in the owner record already makes a replayed request
      // observable; guard it with the durable idempotency file only to return
      // the first result.
      const target = this.idempotencyPath("resume", key);
      const fingerprint = sha256Hex(
        jsonDumpsSorted({ run_id: runId, mode, extra_rounds: extraRounds }),
      );
      return this.supervisorLocked(() => {
        const existing = RunSupervisor.readIdempotency(target);
        if (Object.keys(existing).length) {
          if (existing.fingerprint !== fingerprint) {
            throw new IdempotencyConflict(
              "Idempotency-Key was already used for a different resume request",
            );
          }
          const result = existing.result;
          if (isRecord(result)) return { ...result, idempotent: true };
        }
        const created = this.resumeOnce(runId, { mode, extraRounds });
        RunSupervisor.writeIdempotency(target, {
          schema_version: 1,
          operation: "resume",
          key,
          fingerprint,
          run_id: runId,
          state: "completed",
          result: created,
          created_at: Date.now() / 1000,
          completed_at: Date.now() / 1000,
        });
        return created;
      });
    }
    // Keep the historical fingerprint for a plain retry so an Idempotency-Key
    // issued before this option existed still replays instead of conflicting.
    const request: Record<string, unknown> = { run_id: runId };
    if (extraRounds !== null && extraRounds !== undefined) request.extra_rounds = extraRounds;
    const fingerprint = sha256Hex(jsonDumpsSorted(request));
    const target = this.idempotencyPath("resume", key);
    return this.supervisorLocked(() => {
      const existing = RunSupervisor.readIdempotency(target);
      if (Object.keys(existing).length) {
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflict(
            "Idempotency-Key was already used for a different resume request",
          );
        }
        const result = existing.result;
        if (isRecord(result)) return { ...result, idempotent: true };
      }
      const targetRunId = `${runId}-resume-${sha256Hex(key).slice(0, 6)}`;
      if (!Object.keys(existing).length && pathExists(this.runDirOf(targetRunId))) {
        throw new Error(`run already exists: ${targetRunId}`);
      }
      RunSupervisor.writeIdempotency(target, {
        schema_version: 1,
        operation: "resume",
        key,
        fingerprint,
        run_id: targetRunId,
        state: "creating",
        created_at: Date.now() / 1000,
      });
      const recovered = this.existingRunResult(targetRunId, { expectedFingerprint: fingerprint });
      if (recovered !== null) {
        RunSupervisor.writeIdempotency(target, {
          schema_version: 1,
          operation: "resume",
          key,
          fingerprint,
          run_id: targetRunId,
          state: "completed",
          result: recovered,
          created_at: existing.created_at || Date.now() / 1000,
          completed_at: Date.now() / 1000,
        });
        return { ...recovered, idempotent: true };
      }
      const created = this.resumeOnce(runId, {
        mode,
        extraRounds,
        targetRunId,
        recoverReservation: Boolean(Object.keys(existing).length),
        idempotencyFingerprint: fingerprint,
      });
      RunSupervisor.writeIdempotency(target, {
        schema_version: 1,
        operation: "resume",
        key,
        fingerprint,
        run_id: targetRunId,
        state: "completed",
        result: created,
        created_at: Date.now() / 1000,
        completed_at: Date.now() / 1000,
      });
      return created;
    });
  }

  private resumeOnce(
    runId: string,
    options: {
      mode?: string;
      extraRounds?: number | null;
      targetRunId?: string | null;
      recoverReservation?: boolean;
      idempotencyFingerprint?: string | null;
    } = {},
  ): Record<string, unknown> {
    const mode = options.mode ?? "continue";
    const logs = this.runLogsDir(runId);
    const runDir = this.runDirOf(runId);
    const rounds = safeRunRounds(this.runsRoot, runDir, { allowMissing: true });
    if (rounds === null) throw new Error("run rounds path is outside its run boundary");
    const current = this.refresh(runId);
    if (Boolean(current.alive) || ACTIVE_STATUSES.has(canonicalLifecycleStatus(current.status))) {
      throw new Error("cannot resume an active run");
    }
    if (!isTerminalStatus(current.status)) {
      throw new Error(`run is not resumable from status ${current.status || "unknown"}`);
    }
    const owner = this.owner(runId);
    const report = readJson(path.join(logs, "report.json"));
    // The owner record is written before the worker starts and is therefore the
    // most reliable source even when a run is stopped mid-round.
    let task = String(owner.task || report.task || "");
    if (!task) task = savedTaskFromRounds(this.runsRoot, runId, { firstLine: false });
    if (!pyStrip(task)) throw new Error("cannot resume a run without a saved task");
    const workspace = String(owner.workspace || this.workspaceRoot);
    if (mode === "continue") {
      return this.continueRunInPlace(runId, {
        runDir,
        owner,
        status: current,
        task,
        workspace,
        extraRounds: options.extraRounds ?? null,
      });
    }
    const created = this.createRunOnce({
      task,
      agent: String(owner.agent || "codex"),
      model: owner.model ? String(owner.model) : null,
      roleConfigs: isRecord(owner.role_configs) ? owner.role_configs : null,
      workspace,
      maxRounds: resumeRoundBudget(owner, options.extraRounds ?? null),
      promptLanguage:
        owner.prompt_language === "en" || owner.prompt_language === "zh"
          ? String(owner.prompt_language)
          : "en",
      runId:
        options.targetRunId ||
        `${runId}-resume-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`,
      reasoningEffort: typeof owner.reasoning_effort === "string" ? owner.reasoning_effort : null,
      recoverReservation: options.recoverReservation ?? false,
      idempotencyFingerprint: options.idempotencyFingerprint ?? null,
    });
    // ``retry`` deliberately starts a fresh run directory from the saved
    // task/config; it does not carry over round state.
    const createdOwner = {
      ...asRecord(created.owner),
      resumed_from: runId,
      resume_kind: "retry",
    };
    this.busFor(String(created.id)).writeOwner(createdOwner);
    created.owner = createdOwner;
    return created;
  }

  /**
   * Reopen a terminal run and continue its own round ledger.
   *
   * The worker rebuilds the Manager prompt from ``rounds.jsonl``, so the new
   * process picks up the finished rounds instead of replanning from scratch.
   * The run directory, logs, and control bus are reused; only the resume
   * generation is incremented so lifecycle idempotency keys stay distinct.
   */
  private continueRunInPlace(
    runId: string,
    options: {
      runDir: string;
      owner: Record<string, unknown>;
      status: Record<string, unknown>;
      task: string;
      workspace: string;
      extraRounds: number | null;
    },
  ): Record<string, unknown> {
    if (this.attachedOnly) {
      throw new Error("this API is attached to an existing worker and cannot resume runs");
    }
    const { runDir, owner, status, task, workspace } = options;
    let epoch = resumeEpoch(owner) || resumeEpoch(status);
    if (epoch >= MAX_RESUME_EPOCH) throw new Error("run has been resumed too many times");
    epoch += 1;
    const agent = String(owner.agent || "codex");
    if (!AGENT_CHOICES.has(agent)) {
      throw new Error(`run cannot be continued: unknown agent '${agent}'`);
    }
    const model = owner.model ? String(owner.model) : null;
    const roleConfigs = isRecord(owner.role_configs) ? owner.role_configs : null;
    const reasoningEffort =
      normaliseReasoningEffort(
        typeof owner.reasoning_effort === "string" ? owner.reasoning_effort : null,
      ) || null;
    const resolvedRoleConfigs = normaliseRoleConfigs(roleConfigs, { agent, model, reasoningEffort });
    const maxRounds = resumeRoundBudget(owner, options.extraRounds);
    let workspacePath = this.resolveWorkspace(workspace);
    fs.mkdirSync(workspacePath, { recursive: true });
    workspacePath = this.resolveWorkspace(workspacePath);
    if (
      safeRunLogs(this.runsRoot, runDir, { allowMissing: true }) === null ||
      safeRunControl(this.runsRoot, runDir, { allowMissing: true }) === null
    ) {
      throw new Error("run reservation path is outside its run boundary");
    }
    this.runLogsDir(runId);
    const taskPath = path.join(runDir, "tmp", "task.md");
    RunSupervisor.writeTaskFile(taskPath, task);
    const bus = new ControlBus(runDir);
    const command = buildWorkerCommand({
      runsRoot: this.runsRoot,
      runId,
      task: `@${taskPath}`,
      agent,
      model,
      roleConfigs: resolvedRoleConfigs,
      workspace: workspacePath,
      maxRounds,
      promptLanguage:
        owner.prompt_language === "en" || owner.prompt_language === "zh"
          ? String(owner.prompt_language)
          : "en",
      reasoningEffort,
      resume: true,
    });
    const reservation: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(owner)) {
      if (!RESUME_CLEARED_OWNER_KEYS.has(key)) reservation[key] = value;
    }
    Object.assign(reservation, {
      run_id: runId,
      state: "creating",
      supervisor_pid: process.pid,
      started_at: Date.now() / 1000,
      task,
      agent,
      model,
      role_configs: resolvedRoleConfigs,
      max_rounds: maxRounds,
      workspace: String(workspacePath),
      resumed_from: runId,
      resume_kind: "continue",
      [RESUME_EPOCH_KEY]: epoch,
    });
    if (reasoningEffort) {
      reservation.reasoning_effort = reasoningEffort;
    } else {
      delete reservation.reasoning_effort;
    }
    bus.append(
      "resume",
      { mode: "continue", epoch, max_rounds: maxRounds },
      { createdBy: "web", commandId: `resume@${epoch}` },
    );
    return this.launchWorker({
      runId,
      runDir,
      bus,
      command,
      reservation,
      workspacePath,
      task,
    });
  }

  commandReceipt(runId: string, commandId: string): Record<string, unknown> | null {
    return this.busFor(runId).receiptFor(commandId);
  }
}

function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    if (typeof timer.unref === "function") timer.unref();
  });
}
