// Ported from LongHorizon-Harness tests/test_cli_isolation.py (the CLI half),
// tests/test_guard_exclude_paths.py, and the CLI section of tests/test_resume.py.
//
// The Python suite calls `cli._reserve_run_dir`, `cli._read_task`, … directly;
// the same functions are exported here, so every case below is an in-process
// call rather than a subprocess. The argv-parser cases at the end do spawn the
// CLI, because exit codes and the argparse help layout are the thing under test.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  adoptSupervisedRunDir,
  applyRepeatableDefaults,
  buildParser,
  claimSupervisedOwner,
  cliHooks,
  main,
  outermostPaths,
  printProgress,
  printRunSummary,
  publicRoleConfigsFromArgs,
  readSupervisedTask,
  readTask,
  reserveRunDir,
  resolveGuardExcludePaths,
  runWithAttachedControl,
  shouldKeepEmbeddedDashboard,
  writeBootstrapFailure,
} from "../src/cli.js";
import { ControlBus } from "../src/supervisor/control_bus.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.dirname(HERE);
const CLI_ENTRY = path.join(SDK_ROOT, "src", "cli.ts");

const roots: string[] = [];

function tmpRoot(prefix = "lh-cli-"): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function captureStdout(body: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  try {
    body();
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  return chunks.join("");
}

// `--import tsx` resolves against the child's cwd, so the loader is addressed
// by absolute path: several cases below run the CLI from a scratch directory.
const TSX_LOADER = path.join(SDK_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

function runCli(args: string[], cwd = SDK_ROOT): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, COLUMNS: "80" },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// --- run directory reservation --------------------------------------------

test("an explicit run id cannot reuse an existing directory", () => {
  const root = path.join(tmpRoot(), "runs");
  fs.mkdirSync(path.join(root, "fixed"), { recursive: true });

  assert.throws(() => reserveRunDir(root, "fixed"), /already exists/);
});

test("a run id must be a single safe path component", () => {
  const root = path.join(tmpRoot(), "runs");
  for (const runId of ["", ".", "..", "nested/run", "..\\escape", "bad\u0000id"]) {
    assert.throws(() => reserveRunDir(root, runId), /run id/);
  }
});

test("a generated run id is reserved atomically", () => {
  const [runId, runDir] = reserveRunDir(path.join(tmpRoot(), "runs"), null);

  assert.equal(runId, path.basename(runDir));
  assert.ok(fs.statSync(runDir).isDirectory());
  assert.match(runId, /^\d{8}T\d{6}Z_[0-9a-f]{8}$/);
});

// --- task ingestion --------------------------------------------------------

test("literal task text is used verbatim", () => {
  assert.equal(readTask("  do the thing  "), "  do the thing  ");
});

test("an @file task is read and stripped", () => {
  const root = tmpRoot();
  const target = path.join(root, "task.md");
  fs.writeFileSync(target, "  inspect the result \n", "utf-8");

  assert.equal(readTask(`@${target}`), "inspect the result");
});

test("the task file reader does not follow a symlink", () => {
  const root = tmpRoot();
  const outside = path.join(root, "outside-task.md");
  fs.writeFileSync(outside, "do not consume", "utf-8");
  const link = path.join(root, "task.md");
  fs.symlinkSync(outside, link);

  assert.throws(() => readTask(`@${link}`));
});

test("the task file reader is bounded", () => {
  const root = tmpRoot();
  const target = path.join(root, "task.md");
  fs.writeFileSync(target, "x".repeat(100_001), "utf-8");

  assert.throws(() => readTask(`@${target}`), /too large/);
});

test("a supervised task reference is bound to the reserved run", () => {
  const root = tmpRoot();
  const runDir = path.join(root, "runs", "reserved");
  const taskPath = path.join(runDir, "tmp", "task.md");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(taskPath, "inside", "utf-8");
  const outside = path.join(root, "outside-task.md");
  fs.writeFileSync(outside, "secret", "utf-8");

  assert.equal(readSupervisedTask(`@${taskPath}`, runDir), "inside");
  assert.throws(
    () => readSupervisedTask(`@${outside}`, runDir),
    /reserved run\/tmp\/task\.md/,
  );

  const link = path.join(runDir, "tmp", "task-link.md");
  fs.symlinkSync(outside, link);
  assert.throws(() => readSupervisedTask(`@${link}`, runDir), /reserved run\/tmp\/task\.md/);

  fs.unlinkSync(taskPath);
  fs.linkSync(outside, taskPath);
  assert.throws(() => readSupervisedTask(`@${taskPath}`, runDir), /private regular file/);
});

test("a supervised worker requires a @task-file reference", () => {
  const runDir = path.join(tmpRoot(), "run");
  assert.throws(() => readSupervisedTask("inline text", runDir), /@task-file reference/);
});

// --- supervised reservation adoption ---------------------------------------

function writeReservation(
  root: string,
  runId: string,
  owner: Record<string, unknown>,
  status: Record<string, unknown> = { run_id: runId, status: "creating" },
): string {
  const runDir = path.join(root, runId);
  fs.mkdirSync(path.join(runDir, "control"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "control", "owner.json"), JSON.stringify(owner), "utf-8");
  fs.writeFileSync(path.join(runDir, "control", "status.json"), JSON.stringify(status), "utf-8");
  return runDir;
}

test("a supervised worker adopts only its own reservation", () => {
  const base = tmpRoot();
  const root = path.join(base, "runs");
  const workspace = path.join(base, "workspace");
  const owner: Record<string, unknown> = {
    run_id: "reserved",
    pid: process.pid,
    task: "inspect the result",
    agent: "claude_code",
    model: "claude-opus-5",
    max_rounds: 4,
    workspace,
    state: "creating",
  };
  const runDir = writeReservation(root, "reserved", owner);

  const adopted = adoptSupervisedRunDir(root, "reserved", {
    task: "inspect the result",
    agent: "claude_code",
    model: "claude-opus-5",
    workspace,
    maxRounds: 4,
  });
  assert.deepEqual(adopted, ["reserved", runDir]);

  owner["pid"] = process.pid + 1;
  fs.writeFileSync(path.join(runDir, "control", "owner.json"), JSON.stringify(owner), "utf-8");
  assert.throws(
    () =>
      adoptSupervisedRunDir(root, "reserved", {
        task: "inspect the result",
        agent: "claude_code",
        model: "claude-opus-5",
        workspace,
        maxRounds: 4,
      }),
    /another process/,
  );
});

test("a supervised worker claims a pre-spawn reservation", async () => {
  const base = tmpRoot();
  const root = path.join(base, "runs");
  const workspace = path.join(base, "workspace");
  const runDir = writeReservation(root, "reserved", {
    run_id: "reserved",
    pid: 0,
    supervisor_pid: 777,
    task: "race-free launch",
    agent: "claude_code",
    model: null,
    max_rounds: 2,
    workspace,
    state: "creating",
  });
  const originalGetppid = cliHooks.getppid;
  cliHooks.getppid = () => 777;
  try {
    assert.deepEqual(
      adoptSupervisedRunDir(root, "reserved", {
        task: "race-free launch",
        agent: "claude_code",
        model: null,
        workspace,
        maxRounds: 2,
      }),
      ["reserved", runDir],
    );
    await claimSupervisedOwner("reserved", runDir);
  } finally {
    cliHooks.getppid = originalGetppid;
  }
  const claimed = JSON.parse(
    fs.readFileSync(path.join(runDir, "control", "owner.json"), "utf-8"),
  ) as Record<string, unknown>;
  assert.equal(claimed["pid"], process.pid);
  assert.equal(claimed["state"], "running");
  assert.equal(claimed["signal_mode"], "pgid");
});

test("a supervised worker does not follow a metadata symlink", () => {
  for (const metadataName of ["owner.json", "status.json"]) {
    const base = tmpRoot();
    const root = path.join(base, "runs");
    const runDir = path.join(root, "reserved");
    const control = path.join(runDir, "control");
    fs.mkdirSync(control, { recursive: true });
    const records: Record<string, Record<string, unknown>> = {
      "owner.json": {
        run_id: "reserved",
        pid: process.pid,
        task: "inspect",
        agent: "claude_code",
        model: null,
        max_rounds: 1,
      },
      "status.json": { run_id: "reserved", status: "creating" },
    };
    for (const [name, payload] of Object.entries(records)) {
      const target = path.join(control, name);
      if (name === metadataName) {
        const outside = path.join(base, `outside-${name}`);
        fs.writeFileSync(outside, JSON.stringify(payload), "utf-8");
        fs.symlinkSync(outside, target);
      } else {
        fs.writeFileSync(target, JSON.stringify(payload), "utf-8");
      }
    }

    assert.throws(
      () =>
        adoptSupervisedRunDir(root, "reserved", {
          task: "inspect",
          agent: "claude_code",
          model: null,
          workspace: null,
          maxRounds: 1,
        }),
      /reservation is invalid/,
    );
  }
});

test("a terminal reservation is never adopted", () => {
  const base = tmpRoot();
  const root = path.join(base, "runs");
  writeReservation(
    root,
    "reserved",
    { run_id: "reserved", pid: process.pid, agent: "claude_code", model: null, max_rounds: 1 },
    { run_id: "reserved", status: "completed" },
  );

  assert.throws(
    () =>
      adoptSupervisedRunDir(root, "reserved", {
        task: null,
        agent: "claude_code",
        model: null,
        workspace: null,
        maxRounds: 1,
      }),
    /already terminal/,
  );
});

// --- bootstrap failure -----------------------------------------------------

test("a bootstrap failure does not follow a role directory symlink", () => {
  const base = tmpRoot();
  const logDir = path.join(base, "lh_harness");
  const outside = path.join(base, "outside-role");
  fs.mkdirSync(logDir);
  fs.mkdirSync(outside);
  const outsideReport = path.join(outside, "report.json");
  const outsideEvents = path.join(outside, "events.jsonl");
  fs.writeFileSync(outsideReport, "private report", "utf-8");
  fs.writeFileSync(outsideEvents, "private events", "utf-8");
  fs.symlinkSync(outside, path.join(logDir, "role_orchestration"), "dir");

  writeBootstrapFailure(logDir, "task", new Error("boom"), 3);

  assert.equal(fs.readFileSync(outsideReport, "utf-8"), "private report");
  assert.equal(fs.readFileSync(outsideEvents, "utf-8"), "private events");
  assert.ok(fs.statSync(path.join(logDir, "report.json")).isFile());
  const report = JSON.parse(fs.readFileSync(path.join(logDir, "report.json"), "utf-8")) as Record<
    string,
    unknown
  >;
  assert.equal(report["schema_version"], 2);
  assert.equal(report["status"], "failed");
  assert.equal(report["abort_reason"], "worker_bootstrap_failure");
  assert.equal(report["completion_satisfied"], false);
  assert.equal(report["max_rounds"], 3);
  assert.equal(report["error"], "boom");
});

// --- guard exclude paths ---------------------------------------------------

function workspaceIn(base: string): string {
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  return workspace;
}

test("relative guard exclusions resolve against the workspace", () => {
  const workspace = workspaceIn(tmpRoot());

  const resolved = resolveGuardExcludePaths(["target", "node_modules"], {
    workspace,
    protected: [],
  });

  assert.deepEqual(resolved, [
    path.join(workspace, "target"),
    path.join(workspace, "node_modules"),
  ]);
});

test("duplicate guard exclusions are collapsed", () => {
  const workspace = workspaceIn(tmpRoot());

  const resolved = resolveGuardExcludePaths(["target", path.join(workspace, "target")], {
    workspace,
    protected: [],
  });

  assert.deepEqual(resolved, [path.join(workspace, "target")]);
});

test("guard exclusions outside the workspace are rejected", () => {
  const workspace = workspaceIn(tmpRoot());

  for (const escape of ["..", "../sibling", "/etc", "a/../../.."]) {
    assert.throws(
      () => resolveGuardExcludePaths([escape], { workspace, protected: [] }),
      /escapes the workspace/,
    );
  }
});

test("excluding the workspace itself is rejected", () => {
  const workspace = workspaceIn(tmpRoot());

  assert.throws(
    () => resolveGuardExcludePaths(["."], { workspace, protected: [] }),
    /disable the read-only guard/,
  );
});

test("version-control state is protected from guard exclusions", () => {
  const workspace = workspaceIn(tmpRoot());

  for (const vcsPath of [".git", ".git/objects", "vendored/.git"]) {
    assert.throws(
      () => resolveGuardExcludePaths([vcsPath], { workspace, protected: [] }),
      /version-control state/,
    );
  }
});

test("harness state paths are protected from guard exclusions", () => {
  const workspace = workspaceIn(tmpRoot());
  const runDir = path.join(workspace, "runs", "run-1");

  // Excluding the harness path itself, or any parent that covers it, would hide
  // the run's own control/state files from the guard.
  for (const candidate of ["runs/run-1", "runs"]) {
    assert.throws(
      () => resolveGuardExcludePaths([candidate], { workspace, protected: [runDir] }),
      /harness state/,
    );
  }
});

test("a sibling of harness state is allowed", () => {
  const workspace = workspaceIn(tmpRoot());
  const runDir = path.join(workspace, "runs", "run-1");

  const resolved = resolveGuardExcludePaths(["target"], { workspace, protected: [runDir] });

  assert.deepEqual(resolved, [path.join(workspace, "target")]);
});

// --- repeatable option defaults --------------------------------------------

const REPEATABLE = ["mcp_add_dir", "guard_exclude_path"] as const;

function namespace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const name of REPEATABLE) values[name] = null;
  return { ...values, ...overrides };
}

test("the command line replaces the configured list", () => {
  for (const name of REPEATABLE) {
    const args = namespace({ [name]: ["from-cli"] });

    applyRepeatableDefaults(args, { [name]: ["from-config-a", "from-config-b"] });

    assert.deepEqual(args[name], ["from-cli"]);
  }
});

test("the configured list is used when the command line is silent", () => {
  for (const name of REPEATABLE) {
    const args = namespace();

    applyRepeatableDefaults(args, { [name]: ["from-config"] });

    assert.deepEqual(args[name], ["from-config"]);
  }
});

test("an absent option and config becomes an empty list", () => {
  for (const name of REPEATABLE) {
    const args = namespace();

    applyRepeatableDefaults(args, {});

    assert.deepEqual(args[name], []);
  }
});

test("the cached defaults are never aliased", () => {
  for (const name of REPEATABLE) {
    const configured = ["from-config"];
    const args = namespace();

    applyRepeatableDefaults(args, { [name]: configured });
    (args[name] as string[]).push("mutated-later");

    assert.deepEqual(configured, ["from-config"]);
  }
});

test("a malformed configured value does not leak into argv", () => {
  for (const bad of ["not-a-list", 7, null, { a: 1 }]) {
    const args = namespace();

    applyRepeatableDefaults(args, { guard_exclude_path: bad });

    assert.deepEqual(args["guard_exclude_path"], []);
  }
});

test("run parses repeatable options without inheriting the config", async () => {
  const captured: [string[], string[]][] = [];
  const originalLoad = cliHooks.loadRunDefaults;
  const originalRun = cliHooks.runCommand;
  cliHooks.loadRunDefaults = () => ({
    guard_exclude_path: ["cfg-guard"],
    mcp_add_dir: ["cfg-dir"],
  });
  cliHooks.runCommand = async (args) => {
    captured.push([
      [...(args["guard_exclude_path"] as string[])],
      [...(args["mcp_add_dir"] as string[])],
    ]);
    return 0;
  };
  try {
    assert.equal(await main(["run", "--task=t"]), 0);
    assert.deepEqual(captured[captured.length - 1], [["cfg-guard"], ["cfg-dir"]]);

    assert.equal(await main(["run", "--task=t", "--guard-exclude-path=cli-guard"]), 0);
    assert.deepEqual(
      captured[captured.length - 1],
      [["cli-guard"], ["cfg-dir"]],
      "only the given option is overridden",
    );

    // A second call in the same process must not accumulate.
    assert.equal(await main(["run", "--task=t", "--guard-exclude-path=cli-guard"]), 0);
    assert.deepEqual(captured[captured.length - 1], [["cli-guard"], ["cfg-dir"]]);

    assert.equal(
      await main([
        "run",
        "--task=t",
        "--guard-exclude-path=a",
        "--guard-exclude-path=b",
      ]),
      0,
    );
    assert.deepEqual(captured[captured.length - 1], [["a", "b"], ["cfg-dir"]]);
  } finally {
    cliHooks.loadRunDefaults = originalLoad;
    cliHooks.runCommand = originalRun;
  }
});

// --- role resolution -------------------------------------------------------

test("role configs are only reported when a public role is overridden", () => {
  assert.equal(publicRoleConfigsFromArgs({ agent: "claude_code", model: null }), null);
});

test("an explicit role agent stops model inheritance at that boundary", () => {
  const configs = publicRoleConfigsFromArgs({
    agent: "claude_code",
    model: "custom-model",
    manager_agent: "claude_code",
    auditor_reasoning_effort: "high",
  });

  assert.deepEqual(configs, {
    manager: { agent: "claude_code", model: "claude-opus-5" },
    executor: { agent: "claude_code", model: "custom-model" },
    auditor: { agent: "claude_code", model: "custom-model", reasoning_effort: "high" },
  });
});

// --- outermost paths -------------------------------------------------------

test("nested paths collapse into their outermost parent", () => {
  const base = tmpRoot();
  const runs = path.join(base, "runs");
  const runDir = path.join(runs, "run-1");
  const logDir = path.join(runDir, "lh_harness");
  fs.mkdirSync(logDir, { recursive: true });
  const sibling = path.join(base, "other");
  fs.mkdirSync(sibling);

  assert.deepEqual([...outermostPaths(runs, runDir, logDir, sibling)].sort(), [runs, sibling].sort());
});

// --- embedded control plane ------------------------------------------------

test("the embedded control watcher cancels the manager run", async () => {
  const runDir = path.join(tmpRoot(), "run");
  new ControlBus(runDir).writeStatus({
    run_id: "run",
    status: "stopping",
    requested_action: "abort",
  });

  const result = await runWithAttachedControl(
    (signal) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const timer = setTimeout(() => resolve({ status: "unexpected" }), 30_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({ status: "cancelled" });
        });
      }),
    { runDir, enabled: true, pollInterval: 0.01 },
  );

  assert.deepEqual(result, { status: "cancelled" });
});

test("the embedded control watcher survives an isolated EBADF", async () => {
  const runDir = path.join(tmpRoot(), "run");
  new ControlBus(runDir).writeStatus({
    run_id: "run",
    status: "stopping",
    requested_action: "abort",
  });

  const realReadStatus = ControlBus.prototype.readStatus;
  let calls = 0;
  ControlBus.prototype.readStatus = function readStatus(this: ControlBus) {
    calls += 1;
    if (calls === 1) {
      const error = new Error("Bad file descriptor") as NodeJS.ErrnoException;
      error.code = "EBADF";
      throw error;
    }
    return realReadStatus.call(this);
  };
  try {
    const result = await runWithAttachedControl(
      (signal) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const timer = setTimeout(() => resolve({ status: "unexpected" }), 30_000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve({ status: "cancelled" });
          });
        }),
      { runDir, enabled: true, pollInterval: 0.01 },
    );
    assert.deepEqual(result, { status: "cancelled" });
    assert.ok(calls >= 2);
  } finally {
    ControlBus.prototype.readStatus = realReadStatus;
  }
});

test("the embedded control watcher propagates non-EBADF errors", async () => {
  const runDir = path.join(tmpRoot(), "run");
  new ControlBus(runDir);

  const realReadStatus = ControlBus.prototype.readStatus;
  ControlBus.prototype.readStatus = function readStatus(): Record<string, unknown> {
    const error = new Error("Permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  };
  try {
    await assert.rejects(
      runWithAttachedControl(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            setTimeout(() => resolve({ status: "complete" }), 50);
          }),
        { runDir, enabled: true, pollInterval: 0.01 },
      ),
      (exc: NodeJS.ErrnoException) => exc.code === "EACCES",
    );
  } finally {
    ControlBus.prototype.readStatus = realReadStatus;
  }
});

test("a control stop request keeps the embedded server alive", async () => {
  for (const requestedAction of ["stop", "abort"]) {
    const runDir = path.join(tmpRoot(), "run");
    new ControlBus(runDir).writeStatus({ status: "stopping", requested_action: requestedAction });

    assert.equal(
      await shouldKeepEmbeddedDashboard(runDir, {
        explicitlyRequested: false,
        report: { status: "cancelled" },
      }),
      true,
    );
  }
});

test("the dashboard exits normally without a stop or keep request", async () => {
  const runDir = path.join(tmpRoot(), "run");

  assert.equal(
    await shouldKeepEmbeddedDashboard(runDir, {
      explicitlyRequested: false,
      report: { status: "complete" },
    }),
    false,
  );
  assert.equal(
    await shouldKeepEmbeddedDashboard(runDir, {
      explicitlyRequested: true,
      report: { status: "complete" },
    }),
    true,
  );
});

// --- console output --------------------------------------------------------

test("progress lines match the console contract", () => {
  const out = captureStdout(() => {
    printProgress("round_start", { round: 3, round_budget: 25 });
    printProgress("role_start", { round: 3, role: "manager" });
    printProgress("role_done", { round: 3, role: "manager", status: "done", duration_ms: 12_400, next_step: "cli" });
    printProgress("role_done", {
      round: 3,
      role: "cli_auditor",
      status: "done",
      duration_ms: 41_200,
      audit_status: "incomplete",
      integrity_status: "clean",
      contract_audit_status: "aligned",
    });
    printProgress("role_start", { round: 3, role: "final_response" });
  });

  assert.equal(
    out,
    "\n── Round 3/25 ──\n" +
      "  [manager] running...\n" +
      "  [manager] done · 12.4s · next=cli\n" +
      "  [cli_auditor] done · 41.2s · audit=incomplete/clean/aligned\n" +
      "\n── Writing reply ──\n" +
      "  [final_response] running...\n",
  );
});

test("the run summary uses 72-character rules and the documented labels", () => {
  const logDir = tmpRoot();
  const out = captureStdout(() => {
    printRunSummary(
      {
        status: "complete",
        rounds_run: 2,
        max_rounds: 25,
        elapsed_seconds: 90,
        abort_reason: "",
        final_response: "all done",
        current_task_state: "state",
        latest_auditor_report: "audit",
      },
      { logDir, workspace: "/tmp/ws" },
    );
  });

  const lines = out.split("\n");
  assert.equal(lines[1], "=".repeat(72));
  assert.equal(lines[2], "Result:    complete");
  assert.equal(lines[3], "Rounds:    2/25");
  assert.equal(lines[4], "Elapsed:   1.5 min");
  assert.equal(lines[5], "Workspace: /tmp/ws");
  assert.equal(lines[6], `Report:    ${path.join(logDir, "report.json")}`);
  assert.ok(out.includes(`\n${"-".repeat(72)}\n  all done\n${"-".repeat(72)}\n`));
  assert.ok(out.includes("\nTask state:\n  state\n"));
  assert.ok(out.includes("\nFinal audit:\n  audit\n"));
  assert.ok(out.endsWith(`${"=".repeat(72)}\n`));
  assert.ok(!out.includes("Stopped:"));
});

// --- argv parser -----------------------------------------------------------

test("the help formatter suppresses defaults that argparse would hide", () => {
  const { parser } = buildParser({});
  const runHelp = (parser as unknown as { subparsers: Map<string, { formatHelp(): string }> }).subparsers
    .get("run")!
    .formatHelp();

  // A real default is printed…
  assert.ok(runHelp.includes("Agent implementation for every role. (default:"));
  assert.ok(runHelp.includes("(default: 300)"));
  // …while `None`, `[]` and nargs==0 flags are not.
  assert.ok(!runHelp.includes("(default: None)"));
  assert.ok(!runHelp.includes("(default: True)"));
  assert.ok(runHelp.includes("--dashboard, --no-dashboard"));
  // Hidden flags stay hidden.
  assert.ok(!runHelp.includes("--supervised"));
  assert.ok(!runHelp.includes("--resume"));
  assert.ok(runHelp.endsWith(`Found a bug? Please open an issue: ${"https://github.com/AMAP-ML/LongHorizon-Harness/issues"}\n`));
});

test("config defaults win over the hardcoded fallbacks", () => {
  const { parser } = buildParser({ agent: "claude_code", max_rounds: 7, runs_root: "./elsewhere" });
  const args = parser.parseArgs(["run", "--task=t"]);

  assert.equal(args["max_rounds"], 7);
  assert.equal(args["runs_root"], "./elsewhere");
  // an explicit flag still beats the config
  const explicit = buildParser({ max_rounds: 7 }).parser.parseArgs(["run", "--task=t", "--max-rounds=9"]);
  assert.equal(explicit["max_rounds"], 9);
});

test("--version prints the package version and exits 0", () => {
  const result = runCli(["-V"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "lh-harness 0.1.7\n");
});

test("no command prints help and exits 2", () => {
  const result = runCli([]);
  assert.equal(result.code, 2);
  assert.ok(result.stdout.startsWith("usage: lh-harness [-h] [-V]\n"));
  assert.ok(result.stdout.includes("LongHorizon-Harness 0.1.7"));
  assert.ok(result.stdout.includes("Homepage: https://github.com/AMAP-ML/LongHorizon-Harness"));
});

test("the retired tui command is not registered", () => {
  const result = runCli(["tui"]);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes("invalid choice: 'tui'"));
});

test("--help exits 0 and lists every subcommand", () => {
  const result = runCli(["--help"]);
  assert.equal(result.code, 0);
  for (const command of ["run", "dashboard", "web", "doctor", "plugin", "init", "check-update"]) {
    assert.ok(result.stdout.includes(`    ${command}`), `missing ${command}`);
  }
});

test("an invalid choice on run reports the flag and exits 2", () => {
  const result = runCli(["run", "--task=x", "--agent=bogus"]);
  assert.equal(result.code, 2);
  assert.ok(
    result.stderr.includes("argument --agent: invalid choice: 'bogus' (choose from claude_code)"),
    result.stderr,
  );
});

test("a missing required argument exits 2", () => {
  const result = runCli(["run"]);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes("the following arguments are required: --task"), result.stderr);
});

test("an unrecognized argument surfaces at the top-level parser", () => {
  const result = runCli(["run", "--task=x", "--bogus"]);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes("unrecognized arguments: --bogus"), result.stderr);
});

test("a bad reasoning effort is rejected by the argument type", () => {
  const result = runCli(["run", "--task=x", "--reasoning-effort=bad!"]);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes("argument --reasoning-effort: reasoning effort may only contain"), result.stderr);
});

test("--max-rounds enforces its 1..1000 range", () => {
  assert.equal(runCli(["run", "--task=x", "--max-rounds=0"]).code, 2);
  const tooMany = runCli(["run", "--task=x", "--max-rounds=1001"]);
  assert.equal(tooMany.code, 2);
  assert.ok(tooMany.stderr.includes("must be at most 1000"), tooMany.stderr);
});

test("--resume is refused outside a supervised worker", () => {
  const base = tmpRoot();
  const result = runCli(
    [
      "run",
      "--task=anything",
      `--runs-root=${path.join(base, "runs")}`,
      `--workspace=${base}`,
      "--resume",
    ],
    base,
  );

  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes("only available to supervised workers"), result.stderr);
  assert.equal(
    fs.existsSync(path.join(base, "runs")),
    false,
    "the guard must reject before reserving a run",
  );
});

test("plugin without a sub-action prints its help and exits 2", () => {
  const result = runCli(["plugin"]);
  assert.equal(result.code, 2);
  assert.ok(result.stdout.startsWith("usage: lh-harness plugin [-h] {list,install,uninstall} ..."));
});

test("init writes the config template and refuses to clobber it", () => {
  const base = tmpRoot();
  const first = runCli(["init"], base);
  assert.equal(first.code, 0);
  const configPath = path.join(base, ".lh-harness", "config.toml");
  assert.equal(first.stdout, `Created config: ${configPath}\n`);
  assert.ok(fs.readFileSync(configPath, "utf-8").startsWith("# LongHorizon-Harness project defaults."));

  const second = runCli(["init"], base);
  assert.equal(second.code, 1);
  assert.ok(second.stderr.includes(`Config already exists: ${configPath}`));
  assert.ok(second.stderr.includes("Use `lh-harness init --force` to replace it."));

  const forced = runCli(["init", "--force"], base);
  assert.equal(forced.code, 0);

  // `run` announces the config it picked up.
  const run = runCli(["run", "--task=t", "--resume"], base);
  assert.ok(run.stdout.includes(`Using config: ${configPath}`), run.stdout);
});

test("doctor reports every check and exits on failures only", () => {
  const result = runCli(["doctor"], tmpRoot());
  assert.ok([0, 1].includes(result.code));
  assert.ok(result.stdout.startsWith("LongHorizon-Harness doctor (0.1.7)\n"));
  assert.ok(result.stdout.includes("\nPlatform: "));
  assert.ok(result.stdout.includes("Homepage: https://github.com/AMAP-ML/LongHorizon-Harness\n"));
  assert.ok(result.stdout.includes("Issues:   https://github.com/AMAP-ML/LongHorizon-Harness/issues\n"));
  assert.match(result.stdout, /\[OK {2}\] Node\.js runtime: v\d+\.\d+\.\d+ \(/);
  assert.ok(result.stdout.includes("[SKIP] Project config: .lh-harness/config.toml does not exist"));
  assert.match(result.stdout, /Doctor result: (ready|ready with \d+ warning\(s\)|\d+ required check\(s\) failed)\n/);
  // no registry drift
  assert.ok(!result.stdout.includes("Agent registry"));
});

test("the packaged bin entry point runs the CLI", () => {
  const out = execFileSync(process.execPath, [path.join(SDK_ROOT, "bin", "lh-harness.mjs"), "-V"], {
    cwd: SDK_ROOT,
    encoding: "utf-8",
  });
  assert.equal(out, "lh-harness 0.1.7\n");
});

test("a supervised worker's role configuration matches the reservation regardless of key order", () => {
  // The supervisor writes owner.json with sorted keys; the worker rebuilds the
  // map in manager/executor/auditor order. Python compares dicts by value, so
  // insertion order must never make the adoption fail.
  const base = tmpRoot();
  const root = path.join(base, "runs");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const roleConfigsSorted = {
    auditor: { agent: "claude_code", model: "claude-opus-5" },
    executor: { agent: "claude_code", model: "claude-opus-5" },
    manager: { agent: "claude_code", model: "claude-opus-5" },
  };
  const runDir = writeReservation(root, "reserved-roles", {
    run_id: "reserved-roles",
    pid: process.pid,
    task: "build the site",
    agent: "claude_code",
    model: "claude-opus-5",
    role_configs: roleConfigsSorted,
    max_rounds: 25,
    workspace,
    state: "creating",
  });
  const adopted = adoptSupervisedRunDir(root, "reserved-roles", {
    task: "build the site",
    agent: "claude_code",
    model: "claude-opus-5",
    roleConfigs: {
      manager: { agent: "claude_code", model: "claude-opus-5" },
      executor: { agent: "claude_code", model: "claude-opus-5" },
      auditor: { agent: "claude_code", model: "claude-opus-5" },
    },
    workspace,
    maxRounds: 25,
  });
  assert.deepEqual(adopted, ["reserved-roles", runDir]);
  assert.throws(
    () =>
      adoptSupervisedRunDir(root, "reserved-roles", {
        task: "build the site",
        agent: "claude_code",
        model: "claude-opus-5",
        roleConfigs: { ...roleConfigsSorted, executor: { agent: "claude_code", model: "claude-sonnet-5" } },
        workspace,
        maxRounds: 25,
      }),
    /role configuration does not match/u,
  );
});
