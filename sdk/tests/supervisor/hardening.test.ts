// Ported from LongHorizon-Harness tests/supervisor/test_hardening.py.
//
// Where the Python test monkeypatches ``fcntl.flock`` or ``os.fdopen`` the Node
// port asserts the equivalent failure of its own mechanism (an aliased or
// symlinked lock file, a temp file that never leaks), because the process lock
// here is an exclusive lock file rather than flock.

import assert from "node:assert/strict";
import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ControlBus,
  RevisionConflict,
  atomicBytesWrite,
  iterRunControlDirs,
} from "../../src/supervisor/control_bus.js";
import { ApprovalOption, DashboardState } from "../../src/dashboard/state.js";
import {
  IdempotencyConflict,
  RunSupervisor,
  type SignalName,
  type WorkerProcess,
  openWorkerLog,
  savedTaskFromRounds,
  supervisorRuntime,
  terminalStatusForExit,
  workerLogLimits,
} from "../../src/supervisor/service.js";

const APPEND_FIXTURE = fileURLToPath(new URL("../fixtures/append_commands.mjs", import.meta.url));

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-hard-")));
}

class FakeProcess implements WorkerProcess {
  pid = 9191;
  returncode: number | null;

  constructor(returncode: number | null = null) {
    this.returncode = returncode;
  }

  poll(): number | null {
    return this.returncode;
  }
}

function withRuntime(overrides: Partial<typeof supervisorRuntime>): () => void {
  const saved = { ...supervisorRuntime };
  Object.assign(supervisorRuntime, overrides);
  return () => Object.assign(supervisorRuntime, saved);
}

function oserror(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function readJsonFileSync(target: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(target, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lifecycle derivation
// ---------------------------------------------------------------------------

test("a non-zero worker exit is failed and persists a crash report", () => {
  const worker = new FakeProcess(7);
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "crash me" });
    const runDir = path.join(root, "runs", String(created.id));
    fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "logs", "report.json"),
      JSON.stringify({ status: "complete", completion_satisfied: true }),
      "utf-8",
    );

    const status = supervisor.status(String(created.id));

    assert.equal(status.status, "failed");
    assert.equal(status.exit_code, 7);
    assert.equal(status.report_status, "completed");
    const crash = readJsonFileSync(path.join(runDir, "logs", "crash_report.json"));
    assert.equal(crash.status, "failed");
  } finally {
    restore();
  }
});

test("ending at an approval gate is cancelled, not failed", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    const created = supervisor.createRun({ task: "finish at the round limit" });
    const runDir = path.join(runsRoot, String(created.id));
    const logs = path.join(runDir, "logs");
    fs.mkdirSync(path.join(logs, "role_management", "rounds"), { recursive: true });
    const state = new DashboardState(logs, { runsRoot, controlEnabled: true });
    const approval = state.createApproval({
      title: "Round limit reached",
      options: [new ApprovalOption("continue", "Continue run"), new ApprovalOption("stop", "End run")],
      context: { phase: "end_of_round", trigger: "max_rounds" },
    });

    assert.equal(state.resolveApproval(approval.approval_id, { action: "stop" }), true);
    assert.equal(state.getApproval(approval.approval_id)?.action, "stop");
    const durable = new ControlBus(runDir).readStatus();
    assert.equal(durable.status, "stopping");
    assert.equal(durable.requested_action, "cancel");

    fs.writeFileSync(
      path.join(logs, "report.json"),
      JSON.stringify({
        status: "incomplete",
        completion_satisfied: false,
        abort_reason: "max_rounds_exhausted",
        rounds: [{ round_index: 1 }],
        final_response: "Useful final answer",
      }),
      "utf-8",
    );
    worker.returncode = 1;

    const status = supervisor.status(String(created.id));

    assert.equal(status.status, "cancelled");
    assert.equal(status.report_status, "incomplete");
    assert.equal(status.exit_code, 1);
    assert.ok(!("failure_reason" in status));
    assert.equal(fs.existsSync(path.join(logs, "crash_report.json")), false);
  } finally {
    restore();
  }
});

for (const completionSatisfied of [false, null] as const) {
  test(`a success report requires explicit completion evidence (completion_satisfied=${completionSatisfied})`, () => {
    const report: Record<string, unknown> = { status: "complete" };
    if (completionSatisfied !== null) report.completion_satisfied = completionSatisfied;

    const [lifecycle, reportStatus] = terminalStatusForExit({ report, returncode: 0 });

    assert.equal(lifecycle, "failed");
    assert.equal(reportStatus, "completed");
  });
}

test("a historical completed report without evidence projects failed", () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(path.join(runsRoot, "run-1", "logs", "role_management"), { recursive: true });
  fs.writeFileSync(
    path.join(runsRoot, "run-1", "logs", "report.json"),
    JSON.stringify({ status: "complete", completion_satisfied: false }),
    "utf-8",
  );

  const status = new RunSupervisor(runsRoot, {
    workspaceRoot: path.join(root, "workspace"),
  }).status("run-1");

  assert.equal(status.status, "failed");
  assert.equal(status.report_status, "completed");
  assert.equal(
    status.failure_reason,
    "worker reported completion without explicit completion evidence",
  );
});

test("the failure report does not follow an existing report symlink", () => {
  const worker = new FakeProcess(7);
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "crash without redirect" });
    const logs = path.join(root, "runs", String(created.id), "logs");
    const outside = path.join(root, "outside-report.json");
    fs.writeFileSync(outside, "private", "utf-8");
    fs.mkdirSync(logs, { recursive: true });
    fs.symlinkSync(outside, path.join(logs, "report.json"));

    supervisor.status(String(created.id));

    assert.equal(fs.readFileSync(outside, "utf-8"), "private");
    assert.equal(fs.lstatSync(path.join(logs, "report.json")).isSymbolicLink(), false);
    assert.equal(readJsonFileSync(path.join(logs, "report.json")).status, "failed");
  } finally {
    restore();
  }
});

test("resume rejects an active run", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "still running" });
    assert.throws(() => supervisor.resume(String(created.id)), /active/);
  } finally {
    restore();
  }
});

test("the workspace must stay inside the configured root", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const workspaceRoot = path.join(root, "workspace");
    const supervisor = new RunSupervisor(path.join(root, "runs"), { workspaceRoot });

    assert.throws(
      () => supervisor.createRun({ task: "escape", workspace: path.join(root, "outside") }),
      /inside configured workspace root/,
    );

    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(workspaceRoot, "link"), "dir");
    assert.throws(
      () => supervisor.createRun({ task: "symlink escape", workspace: path.join(workspaceRoot, "link") }),
      /inside configured workspace root/,
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Control bus
// ---------------------------------------------------------------------------

test("control-bus revisions and expected_revision are atomic across processes", () => {
  const runDir = path.join(tmpDir(), "run");

  // Four separate OS processes, 5 appends each: the lock file is the only thing
  // that can keep the revisions unique.
  const workers = [0, 1, 2, 3].map((worker) =>
    child_process.spawnSync(
      process.execPath,
      ["--import", "tsx", APPEND_FIXTURE, runDir, String(worker), "5"],
      { encoding: "utf-8" },
    ),
  );
  const revisions: number[] = [];
  for (const worker of workers) {
    assert.equal(worker.status, 0, worker.stderr);
    revisions.push(...(JSON.parse(worker.stdout.trim()) as number[]));
  }
  assert.deepEqual(
    revisions.sort((left, right) => left - right),
    Array.from({ length: 20 }, (_value, index) => index + 1),
  );

  assert.throws(
    () => new ControlBus(runDir).append("stale", null, { expectedRevision: 0 }),
    RevisionConflict,
  );
  const bus = new ControlBus(runDir);
  const command = bus.append("idempotent", null, { commandId: "same" });
  assert.equal(bus.append("idempotent", null, { commandId: "same" }).revision, command.revision);

  for (let index = 0; index < 40; index += 1) {
    new ControlBus(runDir).writeStatus({ writer: index });
  }
  assert.notEqual(new ControlBus(runDir).readStatus().writer, undefined);
});

test("the control bus accepts the trusted macOS /var alias", (t) => {
  // The system /var alias must not be confused with a run-boundary link.
  let real: string;
  try {
    if (!fs.lstatSync("/var").isSymbolicLink()) return t.skip("host has no macOS /var alias");
    real = fs.realpathSync("/var");
  } catch {
    return t.skip("host has no /var");
  }
  const scratch = tmpDir();
  if (!scratch.startsWith(`${real}/`)) return t.skip("temporary root is outside /var");
  const relative = path.relative(real, scratch);
  const runDir = path.join("/var", relative, "alias-run");
  const command = new ControlBus(runDir).append("alias-safe");
  assert.equal(command.revision, 1);
});

test("the control bus fails closed when the process lock cannot be taken", () => {
  const root = tmpDir();
  const control = path.join(root, "run", "control");
  fs.mkdirSync(control, { recursive: true });
  const outside = path.join(root, "outside.lock");
  fs.writeFileSync(outside, "private", "utf-8");
  fs.symlinkSync(outside, path.join(control, ".control.lock"));

  assert.throws(() => new ControlBus(path.join(root, "run")).append("test"), /locking is unavailable/);
  assert.equal(fs.readFileSync(outside, "utf-8"), "private");
});

test("the control-bus lock rejects a hard-link alias", (t) => {
  // A lock alias would let two boundaries serialize independently.
  const root = tmpDir();
  const control = path.join(root, "run", "control");
  fs.mkdirSync(control, { recursive: true });
  const outside = path.join(root, "outside.lock");
  fs.writeFileSync(outside, "private", "utf-8");
  try {
    fs.linkSync(outside, path.join(control, ".control.lock"));
  } catch {
    return t.skip("filesystem does not support hard links");
  }

  assert.throws(() => new ControlBus(path.join(root, "run")).append("blocked"), /locking is unavailable/);
  assert.equal(fs.readFileSync(outside, "utf-8"), "private");
});

test("the supervisor idempotency lock rejects a symlink", () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  const outside = path.join(root, "outside.lock");
  fs.writeFileSync(outside, "private", "utf-8");
  fs.symlinkSync(outside, path.join(runsRoot, ".supervisor.lock"));
  const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });

  assert.throws(
    () => supervisor.createRun({ task: "locked out", idempotencyKey: "k" }),
    /secure supervisor locking/,
  );
  assert.equal(fs.readFileSync(outside, "utf-8"), "private");
});

test("control-bus append rejects a hard-linked control log", (t) => {
  const root = tmpDir();
  const control = path.join(root, "run", "control");
  fs.mkdirSync(control, { recursive: true });
  const outside = path.join(root, "outside.jsonl");
  fs.writeFileSync(outside, "", "utf-8");
  try {
    fs.linkSync(outside, path.join(control, "commands.jsonl"));
  } catch {
    return t.skip("filesystem does not support hard links");
  }

  assert.throws(() => new ControlBus(path.join(root, "run")).append("blocked"));
  assert.equal(fs.readFileSync(outside, "utf-8"), "");
});

test("the control bus rejects a symlinked control directory", () => {
  const root = tmpDir();
  const run = path.join(root, "run");
  const outside = path.join(root, "outside-control");
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(run, { recursive: true });
  fs.symlinkSync(outside, path.join(run, "control"), "dir");

  assert.throws(() => new ControlBus(run).append("blocked"));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("the control bus rejects a symlinked run directory", () => {
  const root = tmpDir();
  const outside = path.join(root, "outside-run");
  fs.mkdirSync(outside, { recursive: true });
  const runLink = path.join(root, "run-link");
  fs.symlinkSync(outside, runLink, "dir");

  assert.throws(() => new ControlBus(runLink).append("blocked"));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("an idempotency write rejects a symlinked directory and leaks no temp file", () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  const outside = path.join(root, "outside-idempotency");
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(runsRoot, ".idempotency"), "dir");
  const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });

  assert.throws(() =>
    RunSupervisor.writeIdempotency(supervisor.idempotencyPath("create", "key"), { state: "creating" }),
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("the task file write rejects a symlinked tmp directory", () => {
  const root = tmpDir();
  const run = path.join(root, "run");
  fs.mkdirSync(run, { recursive: true });
  const outside = path.join(root, "outside-tmp");
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(run, "tmp"), "dir");

  assert.throws(() => RunSupervisor.writeTaskFile(path.join(run, "tmp", "task.md"), "secret"));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("an atomic write leaves no temporary sibling when the parent is unsafe", () => {
  const root = tmpDir();
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(root, "link");
  fs.symlinkSync(outside, link, "dir");

  assert.throws(() => atomicBytesWrite(path.join(link, "status.json"), Buffer.from("{}")));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("create recovery rejects a tmp symlink before the worker launches", () => {
  // A recovered reservation must not let ``tmp`` redirect task.md writes.
  const launches: string[][] = [];
  const restore = withRuntime({
    spawn: (command) => {
      launches.push([...command]);
      return new FakeProcess();
    },
  });
  try {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    const run = path.join(runsRoot, "reserved");
    fs.mkdirSync(run, { recursive: true });
    const outside = path.join(root, "outside-tmp");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(run, "tmp"), "dir");
    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });

    assert.throws(() =>
      supervisor.createRun({
        task: "must stay inside the reservation",
        runId: "reserved",
        recoverReservation: true,
      }),
    );
    assert.deepEqual(launches, []);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    restore();
  }
});

test("iter_run_control_dirs skips symlinked run boundaries", () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(path.join(runsRoot, "real", "control"), { recursive: true });
  fs.mkdirSync(path.join(root, "outside", "control"), { recursive: true });
  fs.symlinkSync(path.join(root, "outside"), path.join(runsRoot, "evil"), "dir");

  assert.deepEqual(iterRunControlDirs(runsRoot), [path.join(runsRoot, "real")]);
});

// ---------------------------------------------------------------------------
// Stop / abort
// ---------------------------------------------------------------------------

test("a stop request keeps stopping while a stale approval is present", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker, killpg: () => undefined });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "stop me" });
    const roleDir = path.join(root, "runs", String(created.id), "logs", "role_management");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "approvals.jsonl"),
      `${JSON.stringify({ approval_id: "approval-1", status: "pending" })}\n`,
      "utf-8",
    );

    assert.equal(supervisor.status(String(created.id)).status, "waiting_approval");
    supervisor.stop(String(created.id));
    const status = supervisor.status(String(created.id));

    assert.equal(status.status, "stopping");
    assert.equal(status.requested_action, "stop");
    assert.equal(status.alive, true);
  } finally {
    restore();
  }
});

test("abort escalates stop and cross-action retries are idempotent", () => {
  const worker = new FakeProcess();
  const signals: SignalName[] = [];
  const restore = withRuntime({
    spawn: () => worker,
    killpg: (_pgid: number, signal: SignalName) => {
      signals.push(signal);
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "stop then abort" });

    const stopped = supervisor.stop(String(created.id));
    const aborted = supervisor.abort(String(created.id));
    const repeatedStop = supervisor.stop(String(created.id));

    assert.equal(stopped.signal, "SIGTERM");
    assert.equal(aborted.signal, "SIGKILL");
    assert.equal(repeatedStop.idempotent, true);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    const status = supervisor.status(String(created.id));
    assert.equal(status.status, "stopping");
    assert.equal(status.requested_action, "abort");
  } finally {
    restore();
  }
});

test("stop after abort returns the abort receipt without a conflict", () => {
  const worker = new FakeProcess();
  const signals: SignalName[] = [];
  const restore = withRuntime({
    spawn: () => worker,
    killpg: (_pgid: number, signal: SignalName) => {
      signals.push(signal);
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "abort then stop" });

    supervisor.abort(String(created.id));
    const repeated = supervisor.stop(String(created.id));

    assert.equal(repeated.command_id, "lifecycle-abort");
    assert.equal(repeated.signal, "SIGKILL");
    assert.equal(repeated.idempotent, true);
    assert.deepEqual(signals, ["SIGKILL"]);
  } finally {
    restore();
  }
});

test("stop persists the intent before the signal", () => {
  const worker = new FakeProcess();
  const observed: string[] = [];
  let runDir = "";
  const restore = withRuntime({
    spawn: () => worker,
    killpg: () => {
      observed.push(String(new ControlBus(runDir).readStatus().status ?? ""));
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "ordering" });
    runDir = path.join(root, "runs", String(created.id));
    supervisor.stop(String(created.id));
    assert.deepEqual(observed, ["stopping"]);
  } finally {
    restore();
  }
});

test("a vanished worker reconciles stopping to failed", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({
    spawn: () => worker,
    killpg: () => {
      throw oserror("ESRCH");
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "vanish" });

    assert.throws(() => supervisor.stop(String(created.id)), /no longer running/);
    const status = supervisor.status(String(created.id));
    assert.equal(status.status, "failed");
    assert.equal(status.alive, false);
    assert.equal(status.requested_action, "stop");
    assert.equal(supervisor.commandReceipt(String(created.id), "lifecycle-stop")?.status, "rejected");
  } finally {
    restore();
  }
});

test("a permission failure restores the active state", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({
    spawn: () => worker,
    killpg: () => {
      throw oserror("EPERM");
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "permission" });

    assert.throws(() => supervisor.stop(String(created.id)), /permission denied/);
    const status = supervisor.status(String(created.id));
    assert.ok(["starting", "running"].includes(String(status.status)));
    assert.equal(status.alive, true);
    assert.ok(!("requested_action" in status));
    assert.equal(supervisor.commandReceipt(String(created.id), "lifecycle-stop")?.status, "failed");
  } finally {
    restore();
  }
});

test("a pending lifecycle command is replayed after a supervisor restart", () => {
  const worker = new FakeProcess();
  const sent: [number, SignalName][] = [];
  const restore = withRuntime({
    spawn: () => worker,
    killpg: (pgid: number, signal: SignalName) => {
      sent.push([pgid, signal]);
    },
  });
  try {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    const created = supervisor.createRun({ task: "replay stop" });
    const bus = new ControlBus(path.join(runsRoot, String(created.id)));
    const current = bus.readStatus();
    bus.append("stop", { signal: "SIGTERM" }, { commandId: "lifecycle-stop" });
    bus.writeStatus({ ...current, status: "stopping", requested_action: "stop", alive: true });

    // A fresh supervisor has no child handle, but the durable command must be
    // delivered once the PID identity can still be checked.
    const restarted = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    (restarted as unknown as { isAlive: (runId: string) => boolean }).isAlive = () => true;
    const status = restarted.status(String(created.id));
    assert.ok(sent.length);
    assert.equal(bus.receiptFor("lifecycle-stop")?.status, "accepted");
    assert.equal(status.status, "stopping");
  } finally {
    restore();
  }
});

test("a durable stop intent survives a later status poll", () => {
  // The Python test races a thread against the poll; the invariant it protects
  // is the monotonic merge, which is asserted directly here.
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    const created = supervisor.createRun({ task: "race status" });
    const bus = new ControlBus(path.join(runsRoot, String(created.id)));
    bus.writeStatus({
      ...bus.readStatus(),
      status: "stopping",
      requested_action: "stop",
      stop_requested_at: 1.0,
    });

    assert.equal(supervisor.status(String(created.id)).status, "stopping");
    assert.equal(bus.readStatus().status, "stopping");
  } finally {
    restore();
  }
});

test("the first role event promotes a starting worker to running", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "promote after first event" });
    const runDir = path.join(root, "runs", String(created.id));

    assert.equal(new ControlBus(runDir).readStatus().status, "starting");
    const roleDir = path.join(runDir, "logs", "role_management");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "events.jsonl"),
      `${JSON.stringify({ event: "role_harness_start" })}\n`,
      "utf-8",
    );

    assert.equal(supervisor.status(String(created.id)).status, "running");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Idempotency, listings and saved tasks
// ---------------------------------------------------------------------------

test("create idempotency reuses the worker and rejects a conflicting payload", () => {
  const worker = new FakeProcess();
  const launches: number[] = [];
  const restore = withRuntime({
    spawn: () => {
      launches.push(1);
      return worker;
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const first = supervisor.createRun({ task: "same", idempotencyKey: "create-1" });
    const second = supervisor.createRun({ task: "same", idempotencyKey: "create-1" });
    assert.equal(first.id, second.id);
    assert.equal(second.idempotent, true);
    assert.equal(launches.length, 1);
    assert.throws(
      () => supervisor.createRun({ task: "different", idempotencyKey: "create-1" }),
      IdempotencyConflict,
    );
  } finally {
    restore();
  }
});

test("a fresh idempotency key cannot adopt a pre-existing run", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    fs.mkdirSync(path.join(runsRoot, "taken"), { recursive: true });
    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });

    assert.throws(
      () => supervisor.createRun({ task: "must not adopt", runId: "taken", idempotencyKey: "fresh-key" }),
      /already exists/,
    );
    assert.equal(fs.existsSync(supervisor.idempotencyPath("create", "fresh-key")), false);
  } finally {
    restore();
  }
});

test("the worker does not inherit the Web control token", () => {
  const worker = new FakeProcess();
  const captured: { env?: NodeJS.ProcessEnv } = {};
  const restore = withRuntime({
    spawn: (_command, options) => {
      captured.env = options.env;
      return worker;
    },
  });
  process.env.LH_HARNESS_WEB_TOKEN = "control-secret";
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    supervisor.createRun({ task: "do not leak the control token" });

    assert.ok(captured.env);
    assert.equal(captured.env?.LH_HARNESS_WEB_TOKEN, undefined);
  } finally {
    delete process.env.LH_HARNESS_WEB_TOKEN;
    restore();
  }
});

test("the run listing skips symlinked run directories", () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(path.join(root, "outside", "logs", "role_management"), { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.symlinkSync(path.join(root, "outside"), path.join(runsRoot, "evil"), "dir");
  const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
  assert.ok(supervisor.listRunItems().every((item) => item.id !== "evil"));
});

for (const child of ["role_management", "rounds"] as const) {
  test(`the run listing rejects a nested ${child} boundary symlink`, () => {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    const role = path.join(runsRoot, "run-1", "logs", "role_management");
    fs.mkdirSync(role, { recursive: true });
    if (child === "role_management") {
      const real = path.join(root, "real-role");
      fs.mkdirSync(real);
      fs.rmdirSync(role);
      fs.symlinkSync(real, role, "dir");
    } else {
      const rounds = path.join(role, "rounds");
      fs.mkdirSync(rounds);
      const real = path.join(root, "real-rounds");
      fs.mkdirSync(real);
      fs.rmdirSync(rounds);
      fs.symlinkSync(real, rounds, "dir");
    }
    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    assert.ok(supervisor.listRunItems().every((item) => item.id !== "run-1"));
  });
}

for (const targetInsideRoot of [true, false]) {
  test(`the run listing rejects ${targetInsideRoot ? "cross-run" : "external"} logs symlinks`, () => {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    const siblingLogs = path.join(runsRoot, "run-2", "logs", "role_management");
    fs.mkdirSync(siblingLogs, { recursive: true });
    const outsideLogs = path.join(root, "outside", "logs", "role_management");
    fs.mkdirSync(outsideLogs, { recursive: true });
    const target = targetInsideRoot ? path.dirname(siblingLogs) : path.dirname(outsideLogs);
    const run = path.join(runsRoot, "run-1");
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(path.join(run, "control"));
    fs.symlinkSync(target, path.join(run, "logs"), "dir");

    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    assert.ok(supervisor.listRunItems().every((item) => item.id !== "run-1"));
  });
}

test("the run listing does not follow a final task_contract symlink", () => {
  // A worker-writable contract pathname must not disclose an outside file.
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  const rounds = path.join(runsRoot, "run-1", "logs", "role_management", "rounds");
  fs.mkdirSync(rounds, { recursive: true });
  fs.mkdirSync(path.join(runsRoot, "run-1", "control"));
  const outside = path.join(root, "secret-task.txt");
  fs.writeFileSync(outside, "do not disclose this secret", "utf-8");
  fs.mkdirSync(path.join(rounds, "round_001"));
  fs.symlinkSync(outside, path.join(rounds, "round_001", "task_contract.txt"));

  const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
  const item = supervisor.listRunItems().find((entry) => entry.id === "run-1")!;

  assert.equal(item.task, "");
  assert.ok(!JSON.stringify(item).includes("secret"));
});

test("resume does not follow a final task_contract symlink", () => {
  // Resume must fail closed instead of using a secret linked contract.
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  const run = path.join(runsRoot, "run-1");
  const rounds = path.join(run, "logs", "role_management", "rounds");
  fs.mkdirSync(rounds, { recursive: true });
  fs.mkdirSync(path.join(run, "control"));
  const outside = path.join(root, "secret-task.txt");
  fs.writeFileSync(outside, "secret resume task", "utf-8");
  fs.mkdirSync(path.join(rounds, "round_001"));
  fs.symlinkSync(outside, path.join(rounds, "round_001", "task_contract.txt"));
  const bus = new ControlBus(run);
  bus.writeOwner({
    run_id: "run-1",
    task: "",
    agent: "codex",
    model: null,
    max_rounds: 30,
    workspace: path.join(root, "workspace"),
    pid: 0,
  });
  bus.writeStatus({ run_id: "run-1", status: "completed", alive: false });

  const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
  assert.throws(() => supervisor.resume("run-1"), /without a saved task/);
});

test("the saved task contract accepts a bounded regular file", () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  const contract = path.join(
    runsRoot,
    "run-1",
    "logs",
    "role_management",
    "rounds",
    "round_002",
    "task_contract.txt",
  );
  fs.mkdirSync(path.dirname(contract), { recursive: true });
  fs.writeFileSync(contract, "first line\nsecond line\n", "utf-8");

  assert.equal(savedTaskFromRounds(runsRoot, "run-1", { firstLine: true }), "first line");
  assert.equal(
    savedTaskFromRounds(runsRoot, "run-1", { firstLine: false }),
    "first line\nsecond line",
  );
});

test("approval persistence rejects a final symlink", () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  const role = path.join(runsRoot, "run-1", "logs", "role_management");
  fs.mkdirSync(role, { recursive: true });
  const outside = path.join(root, "outside-approvals.jsonl");
  fs.writeFileSync(outside, "private\n", "utf-8");
  fs.symlinkSync(outside, path.join(role, "approvals.jsonl"));

  const state = new DashboardState(path.join(runsRoot, "run-1", "logs"), {
    runsRoot,
    controlEnabled: true,
  });
  state.createApproval({
    title: "should not escape",
    options: [new ApprovalOption("continue", "Continue")],
  });
  assert.equal(fs.readFileSync(outside, "utf-8"), "private\n");
});

for (const targetInsideRoot of [true, false]) {
  test(`resume rejects ${targetInsideRoot ? "cross-run" : "external"} logs symlinks`, () => {
    const root = tmpDir();
    const runsRoot = path.join(root, "runs");
    const siblingLogs = path.join(runsRoot, "run-2", "logs", "role_management");
    fs.mkdirSync(siblingLogs, { recursive: true });
    fs.writeFileSync(path.join(siblingLogs, "task_contract.txt"), "secret sibling task", "utf-8");
    const outsideLogs = path.join(root, "outside", "logs", "role_management");
    fs.mkdirSync(outsideLogs, { recursive: true });
    fs.writeFileSync(path.join(outsideLogs, "task_contract.txt"), "secret external task", "utf-8");
    const target = targetInsideRoot ? path.dirname(siblingLogs) : path.dirname(outsideLogs);
    const run = path.join(runsRoot, "run-1");
    fs.mkdirSync(run, { recursive: true });
    fs.symlinkSync(target, path.join(run, "logs"), "dir");
    const bus = new ControlBus(run);
    bus.writeOwner({
      run_id: "run-1",
      task: "original task",
      agent: "codex",
      max_rounds: 30,
      workspace: path.join(root, "workspace"),
      pid: 0,
    });
    bus.writeStatus({ run_id: "run-1", status: "completed", alive: false });

    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    assert.throws(() => supervisor.resume("run-1"), /logs path/);
  });
}

// ---------------------------------------------------------------------------
// worker.log
// ---------------------------------------------------------------------------

test("the worker log open rejects a final symlink", () => {
  const root = tmpDir();
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir);
  const outside = path.join(root, "outside.log");
  fs.writeFileSync(outside, "private", "utf-8");
  fs.symlinkSync(outside, path.join(runDir, "worker.log"));

  assert.throws(() => openWorkerLog(path.join(runDir, "worker.log")));
  assert.equal(fs.readFileSync(outside, "utf-8"), "private");
});

test("the worker log open rejects a hard-link alias", (t) => {
  const root = tmpDir();
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir);
  const outside = path.join(root, "outside.log");
  fs.writeFileSync(outside, "private", "utf-8");
  try {
    fs.linkSync(outside, path.join(runDir, "worker.log"));
  } catch {
    return t.skip("filesystem does not support hard links");
  }

  assert.throws(() => openWorkerLog(path.join(runDir, "worker.log")));
  assert.equal(fs.readFileSync(outside, "utf-8"), "private");
});

test("the worker log open compacts an old tail and tightens permissions", () => {
  const savedMax = workerLogLimits.maxBytes;
  const savedKeep = workerLogLimits.keepBytes;
  workerLogLimits.maxBytes = 64;
  workerLogLimits.keepBytes = 32;
  try {
    const runDir = path.join(tmpDir(), "run");
    fs.mkdirSync(runDir);
    const target = path.join(runDir, "worker.log");
    fs.writeFileSync(target, Buffer.from(Array.from({ length: 100 }, (_value, index) => index)));
    fs.chmodSync(target, 0o644);

    const fd = openWorkerLog(target);
    try {
      const expected = Buffer.from(Array.from({ length: 32 }, (_value, index) => index + 68));
      assert.deepEqual(fs.readFileSync(target), expected);
      assert.equal(fs.statSync(target).size, 32);
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    workerLogLimits.maxBytes = savedMax;
    workerLogLimits.keepBytes = savedKeep;
  }
});

// ---------------------------------------------------------------------------
// Capability grants: worker env + resume carryover (addition over upstream)
// ---------------------------------------------------------------------------

test("worker env is gated to the granted capabilities and told what was granted", () => {
  const spawnedEnvs: NodeJS.ProcessEnv[] = [];
  const restore = withRuntime({
    spawn: (_command, options) => {
      spawnedEnvs.push({ ...(options as { env: NodeJS.ProcessEnv }).env });
      return new FakeProcess();
    },
  });
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "gh-secret",
    VERCEL_TOKEN: "vc-secret",
    RESEND_API_KEY: "re-secret",
    HIGGSFIELD_API_KEY: "hf-secret",
  })) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    supervisor.createRun({ task: "deploy it", capabilities: ["github", "vercel"] });
    assert.equal(spawnedEnvs.length, 1);
    const env = spawnedEnvs[0]!;
    assert.equal(env.GH_TOKEN, "gh-secret");
    assert.equal(env.VERCEL_TOKEN, "vc-secret");
    assert.equal(env.RESEND_API_KEY, undefined, "unselected email secret must be stripped");
    assert.equal(env.HIGGSFIELD_API_KEY, undefined, "unselected media secret must be stripped");
    assert.equal(env.LH_HARNESS_GRANTED_CAPABILITIES, "browser,github,vercel");
  } finally {
    restore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a retry resume carries the original run's capability grants", () => {
  const spawnedEnvs: NodeJS.ProcessEnv[] = [];
  const restore = withRuntime({
    spawn: (_command, options) => {
      spawnedEnvs.push({ ...(options as { env: NodeJS.ProcessEnv }).env });
      return new FakeProcess(7);
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "deploy it", capabilities: ["vercel"] });
    const runId = String(created.id);
    assert.equal(supervisor.status(runId).status, "failed", "exit 7 makes the run terminal");

    const retried = supervisor.resume(runId, { mode: "retry" });
    const owner = retried.owner as Record<string, unknown>;
    assert.deepEqual(owner.capabilities, ["browser", "vercel"], "grants must survive a retry");
    assert.equal(spawnedEnvs.length, 2);
    assert.equal(spawnedEnvs[1]!.LH_HARNESS_GRANTED_CAPABILITIES, "browser,vercel");
  } finally {
    restore();
  }
});
