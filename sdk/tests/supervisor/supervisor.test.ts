// Ported from LongHorizon-Harness tests/supervisor/test_supervisor.py.
//
// The Web-API cases of the Python file belong to the webapi port; what remains
// here is the supervisor contract itself, plus one case that launches a real
// (fixture) worker so the genuine launch transaction is covered — the Python
// suite only ever monkeypatches ``subprocess.Popen``.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ControlBus } from "../../src/supervisor/control_bus.js";
import {
  RunSupervisor,
  type SignalName,
  type WorkerProcess,
  supervisorRuntime,
} from "../../src/supervisor/service.js";

const FAKE_WORKER = fileURLToPath(new URL("../fixtures/fake_worker.mjs", import.meta.url));

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-sup-")));
}

class FakeProcess implements WorkerProcess {
  pid = 4242;
  returncode: number | null = null;

  poll(): number | null {
    return this.returncode;
  }
}

/** Replace the injectable process primitives for one test. */
function withRuntime(overrides: Partial<typeof supervisorRuntime>): () => void {
  const saved = { ...supervisorRuntime };
  Object.assign(supervisorRuntime, overrides);
  return () => Object.assign(supervisorRuntime, saved);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("supervisor creates an owned run without touching the manager", () => {
  const worker = new FakeProcess();
  const restore = withRuntime({ spawn: () => worker });
  try {
    const root = path.join(tmpDir(), "runs");
    const supervisor = new RunSupervisor(root, { workspaceRoot: path.join(tmpDir(), "workspace") });
    const result = supervisor.createRun({ task: "inspect the project", maxRounds: 2 });

    assert.ok(result.id);
    const runDir = path.join(root, String(result.id));
    assert.ok(fs.statSync(path.join(runDir, "control", "owner.json")).isFile());
    assert.equal(supervisor.canControl(String(result.id)), true);
    assert.equal(supervisor.status(String(result.id)).alive, true);
    const owner = result.owner as Record<string, unknown>;
    assert.ok((owner.command as string[]).includes("--supervised"));
    assert.ok((owner.command as string[]).includes("--no-dashboard"));
  } finally {
    restore();
  }
});

test("worker command forwards the selected agent, models and task indirection", () => {
  const worker = new FakeProcess();
  const commands: string[][] = [];
  const launchEnv: Record<string, string | undefined> = {};
  const restore = withRuntime({
    spawn: (command, options) => {
      commands.push([...command]);
      Object.assign(launchEnv, options.env);
      return worker;
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({
      task: "use the selected backend",
      agent: "claude_code",
      model: "claude-custom-test",
      roleConfigs: {
        planner: { agent: "codex", model: "gpt-planner-test" },
        composer: { agent: "claude_code", model: "claude-composer-test" },
        evaluator: { agent: "codex", model: "gpt-evaluator-test" },
      },
    });

    const owner = created.owner as Record<string, unknown>;
    assert.equal(owner.agent, "claude_code");
    assert.equal(owner.model, "claude-custom-test");
    assert.deepEqual((owner.role_configs as Record<string, unknown>).evaluator, {
      agent: "codex",
      model: "gpt-evaluator-test",
    });
    assert.equal(commands.length, 1);
    const command = commands[0];
    assert.equal(command[0], process.execPath);
    assert.ok(command.some((item) => item.endsWith("cli.ts")));
    assert.equal(command[command.indexOf("--supervised") - 1], "--no-dashboard");
    for (const flag of [
      "--agent=claude_code",
      "--model=claude-custom-test",
      "--planner-agent=codex",
      "--planner-model=gpt-planner-test",
      "--composer-agent=claude_code",
      "--composer-model=claude-composer-test",
      "--evaluator-agent=codex",
      "--evaluator-model=gpt-evaluator-test",
    ]) {
      assert.ok(command.includes(flag), `missing ${flag}`);
    }
    const taskArgument = command.find((item) => item.startsWith("--task="))!.slice("--task=".length);
    assert.ok(taskArgument.startsWith("@"));
    assert.equal(fs.readFileSync(taskArgument.slice(1), "utf-8").trim(), "use the selected backend");
    const display = String(supervisor.owner(String(created.id)).command_display ?? "");
    assert.ok(!display.includes("use the selected backend"));
    assert.ok(!("LH_HARNESS_WEB_TOKEN" in launchEnv) || launchEnv.LH_HARNESS_WEB_TOKEN === undefined);
  } finally {
    restore();
  }
});

test("supervisor shutdown stops owned live workers", async () => {
  const worker = new FakeProcess();
  const signals: SignalName[] = [];
  const restore = withRuntime({
    spawn: () => worker,
    killpg: (_pgid: number, signal: SignalName) => {
      signals.push(signal);
      worker.returncode = -15;
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
    });
    const created = supervisor.createRun({ task: "stop with the Web API" });

    await supervisor.shutdown({ graceSeconds: 0.1 });

    const status = supervisor.status(String(created.id));
    assert.ok(signals.length);
    assert.equal(status.status, "cancelled");
    assert.equal(status.alive, false);
  } finally {
    restore();
  }
});

test("attached supervisor is scoped to its worker", () => {
  const root = path.join(tmpDir(), "runs");
  fs.mkdirSync(path.join(root, "attached", "logs", "role_management"), { recursive: true });
  fs.mkdirSync(path.join(root, "other", "logs", "role_management"), { recursive: true });
  const supervisor = new RunSupervisor(root, {
    workspaceRoot: path.join(tmpDir(), "workspace"),
    attachedOnly: true,
  });
  supervisor.attachRun({
    runId: "attached",
    pid: process.pid,
    task: "attached task",
    workspace: null,
  });

  // Embedded runs generate their id after this process starts, so it is not
  // present in argv.  The hosting PID is nevertheless unambiguously alive.
  assert.equal(supervisor.canControl("attached"), true);
  assert.throws(() => supervisor.status("other"), /cannot access another run/);
  assert.throws(() => supervisor.stop("other"), /cannot (?:access|control) (?:another|this) run/);
});

test("attached stop queues a cooperative cancellation without signalling self", () => {
  const signals: [number, SignalName][] = [];
  const restore = withRuntime({
    kill: (pid: number, signal: SignalName) => {
      signals.push([pid, signal]);
    },
    killpg: (pgid: number, signal: SignalName) => {
      signals.push([pgid, signal]);
    },
  });
  try {
    const root = tmpDir();
    const supervisor = new RunSupervisor(path.join(root, "runs"), {
      workspaceRoot: path.join(root, "workspace"),
      attachedOnly: true,
    });
    supervisor.attachRun({ runId: "run-1", pid: process.pid, task: "stop me" });

    const result = supervisor.stop("run-1");

    assert.equal(result.status, "accepted");
    assert.deepEqual(signals, []);
    const status = supervisor.status("run-1");
    assert.equal(status.status, "stopping");
    assert.equal(status.requested_action, "stop");
  } finally {
    restore();
  }
});

test("finalize_attached_run persists terminal state before --keep-dashboard", () => {
  const root = tmpDir();
  const supervisor = new RunSupervisor(path.join(root, "runs"), {
    workspaceRoot: path.join(root, "workspace"),
    attachedOnly: true,
  });
  supervisor.attachRun({
    runId: "run-1",
    pid: process.pid,
    task: "finish",
    command: ["lh-harness-eray", "run"],
  });

  const status = supervisor.finalizeAttachedRun("run-1", {
    report: { status: "complete", completion_satisfied: true },
    returncode: 0,
  });
  const owner = supervisor.owner("run-1");

  assert.equal(status.status, "completed");
  assert.equal(status.alive, false);
  assert.equal(owner.state, "completed");
  assert.equal(owner.managed, false);
  assert.equal(owner.pid, 0);
  assert.equal(owner.pgid, 0);
  // Terminal status remains monotonic even though this process is still alive
  // to serve a kept dashboard.
  assert.equal(supervisor.status("run-1").status, "completed");
});

test("a real detached worker is launched, logged and reconciled from its report", async () => {
  const root = tmpDir();
  const runsRoot = path.join(root, "runs");
  const realSpawn = supervisorRuntime.spawn;
  let observedDetached = false;
  const restore = withRuntime({
    // Keep the genuine spawn (detached process group + inherited log fd) but
    // point it at the fixture worker instead of the not-yet-written CLI.
    spawn: (command, options) => {
      observedDetached = command.includes("--supervised");
      const runId = command.find((item) => item.startsWith("--run-id="))!.slice("--run-id=".length);
      return realSpawn([process.execPath, FAKE_WORKER, path.join(runsRoot, runId)], options);
    },
  });
  try {
    const supervisor = new RunSupervisor(runsRoot, { workspaceRoot: path.join(root, "workspace") });
    const created = supervisor.createRun({ task: "run the fixture worker", maxRounds: 1 });
    const runId = String(created.id);

    let status: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = supervisor.status(runId);
      if (status.alive === false) break;
      await sleep(20);
    }

    assert.ok(observedDetached);
    assert.equal(status.status, "completed");
    assert.equal(status.report_status, "completed");
    assert.equal(status.exit_code, 0);
    const workerLog = fs.readFileSync(path.join(runsRoot, runId, "worker.log"), "utf-8");
    assert.ok(workerLog.includes("fake worker finished"));
    // The owner keeps the launch provenance and a real process group id.
    const owner = new ControlBus(path.join(runsRoot, runId)).readOwner();
    assert.equal(owner.pgid, owner.pid);
    assert.equal(owner.state, "running");
  } finally {
    restore();
  }
});
