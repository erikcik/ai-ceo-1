// Tests for src/dashboard/state.ts (dashboard/state.py).
//
// The Python suite exercises DashboardState through the Web API; this port folds
// a hand-written fixture ledger (the event vocabulary of spec 01 §2) straight
// into ``snapshot()`` and asserts the projection contract the UI depends on:
// every snapshot field, strict chronological round ordering, the live/recorded
// merge, active-role folding, trajectories and the operator-message projection.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DashboardState } from "../src/dashboard/state.js";

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-state-")));
}

function write(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf-8");
}

function jsonl(records: Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

interface Fixture {
  runsRoot: string;
  runDir: string;
  logDir: string;
  roleDir: string;
}

/** A finished round 1 plus an in-flight round 2, written like the manager does. */
function buildRun(options: { reportStatus?: string | null } = {}): Fixture {
  const runsRoot = path.join(tmpDir(), "runs");
  const runDir = path.join(runsRoot, "run-1");
  const logDir = path.join(runDir, "lh_harness");
  const roleDir = path.join(logDir, "role_orchestration");
  fs.mkdirSync(path.join(roleDir, "rounds"), { recursive: true });

  // Round directories are deliberately created newest-first: readdir order must
  // not leak into the transcript, the numeric round_index sort must.
  const round2 = path.join(roleDir, "rounds", "round_002");
  write(path.join(round2, "manager_plan.txt"), "Plan for round two\nNext: GUI\n");
  write(path.join(round2, "task_state.txt"), "state after round one");

  const round1 = path.join(roleDir, "rounds", "round_001");
  write(path.join(round1, "manager_plan.txt"), "Plan for round one\nNext: CLI\n");
  write(path.join(round1, "task_state.txt"), "initial state");
  write(path.join(round1, "task_contract.txt"), "the contract");
  write(path.join(round1, "executor_output.txt"), "executor said hello");
  write(path.join(round1, "auditor_report.txt"), "auditor report text");
  write(path.join(round1, "harness_feedback.txt"), "feedback");
  write(path.join(round1, "final_response.txt"), "round one reply");
  write(
    path.join(round1, "manager_metadata.json"),
    JSON.stringify({ status: "done", error: null, duration_ms: 12, extra: "dropped" }),
  );
  write(path.join(round1, "executor_metadata.json"), JSON.stringify({ status: "done", duration_ms: 34 }));
  write(path.join(round1, "auditor_metadata.json"), JSON.stringify({ status: "done", duration_ms: 56 }));
  write(
    path.join(round1, "auditor_format_repair_metadata.json"),
    JSON.stringify({ status: "error", duration_ms: 7 }),
  );
  write(path.join(round1, "final_response_metadata.json"), JSON.stringify({ status: "done" }));
  write(path.join(round1, "manager_raw_trajectory.jsonl"), jsonl([{ type: "assistant" }]));
  write(
    path.join(round1, "manager_trajectory.jsonl"),
    jsonl([
      { kind: "text", text: "thinking" },
      { kind: "text", text: "the answer" },
      { kind: "result", text: "the answer" },
    ]),
  );

  write(
    path.join(roleDir, "events.jsonl"),
    jsonl([
      { schema_version: 1, event_id: "run-1:000001", ts: 1, event: "role_harness_start", variant: "lh_harness_role_managed", max_rounds: 4 },
      { schema_version: 1, event_id: "run-1:000002", ts: 2, event: "manager_round_start", round: 1, prompt_chars: 10 },
      { schema_version: 1, event_id: "run-1:000003", ts: 3, event: "manager_round_done", round: 1, next_step: "cli", status: "completed" },
      { schema_version: 1, event_id: "run-1:000004", ts: 4, event: "executor_role_start", round: 1, role: "cli" },
      { schema_version: 1, event_id: "run-1:000005", ts: 5, event: "executor_role_done", round: 1, role: "cli", status: "completed" },
      { schema_version: 1, event_id: "run-1:000006", ts: 6, event: "auditor_role_start", round: 1, role: "cli" },
      { schema_version: 1, event_id: "run-1:000007", ts: 7, event: "auditor_role_done", round: 1, role: "cli", status: "completed" },
      { schema_version: 1, event_id: "run-1:000008", ts: 8, event: "managed_round_recorded", round: 1 },
      { schema_version: 1, event_id: "run-1:000009", ts: 9, event: "manager_round_start", round: 2, prompt_chars: 20 },
    ]),
  );
  write(
    path.join(roleDir, "rounds.jsonl"),
    jsonl([
      {
        round_index: 1,
        next_step: "cli",
        plan_text: "recorded plan",
        executor_output: "recorded executor output",
        auditor_report: "recorded auditor report",
        harness_feedback: "",
        task_state: "recorded state",
        task_contract: "recorded contract",
        related_report_refs: [],
        manager_status: { status: "done" },
        executor_status: { status: "done" },
        auditor_status: { status: "done" },
      },
    ]),
  );
  write(path.join(roleDir, "final_response.txt"), "the published reply");
  const reportStatus = options.reportStatus === undefined ? null : options.reportStatus;
  if (reportStatus !== null) {
    write(
      path.join(logDir, "report.json"),
      JSON.stringify({ schema_version: 2, status: reportStatus, task: "reported task", completion_satisfied: true }),
    );
  } else {
    write(path.join(logDir, "report.json"), JSON.stringify({ schema_version: 2, task: "reported task" }));
  }
  return { runsRoot, runDir, logDir, roleDir };
}

test("snapshot exposes every projected field", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const snapshot = state.snapshot();

  assert.deepEqual(
    Object.keys(snapshot).sort(),
    [
      "approvals",
      "control_enabled",
      "current_run",
      "events",
      "final_response",
      "log_dir",
      "operator_messages",
      "pending_injections",
      "report",
      "round_count",
      "rounds",
      "runs",
      "server_time",
      "task",
    ].sort(),
  );
  assert.equal(snapshot.task, "reported task");
  assert.equal(snapshot.log_dir, fixture.logDir);
  assert.equal(snapshot.current_run, "run-1");
  // The role-scoped reply wins: the manager writes it before report.json.
  assert.equal(snapshot.final_response, "the published reply");
  assert.equal(snapshot.round_count, 2);
  assert.equal(snapshot.control_enabled, false);
  assert.deepEqual(snapshot.approvals, []);
  assert.deepEqual(snapshot.operator_messages, []);
  assert.deepEqual(snapshot.pending_injections, []);
  assert.equal(typeof snapshot.server_time, "number");
  assert.equal((snapshot.runs as Record<string, unknown>[])[0].id, "run-1");
  assert.equal((snapshot.events as Record<string, unknown>[]).length, 9);
});

test("rounds are ordered by numeric index and merge recorded over live", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const rounds = state.readRounds();

  assert.deepEqual(
    rounds.map((round) => round.round_index),
    [1, 2],
  );
  const [first, second] = rounds;
  // Recorded values win on conflicts; ``in_progress`` is re-asserted from live.
  assert.equal(first.plan_text, "recorded plan");
  assert.equal(first.executor_output, "recorded executor output");
  assert.equal(first.in_progress, false);
  assert.equal(first.active_role, null);
  // The live-only round keeps the incremental artifacts and stays in progress.
  assert.equal(second.plan_text, "Plan for round two\nNext: GUI\n");
  assert.equal(second.next_step, "gui");
  assert.equal(second.in_progress, true);
  assert.equal(second.active_role, "manager");
});

test("a live round directory carries every per-round field", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  // Drop the recorded ledger so the raw ``_round_from_dir`` projection shows.
  fs.unlinkSync(path.join(fixture.roleDir, "rounds.jsonl"));
  fs.unlinkSync(path.join(fixture.logDir, "report.json"));
  const round = state.readRounds().find((item) => item.round_index === 1)!;

  assert.equal(round.next_step, "cli");
  assert.equal(round.plan_text, "Plan for round one\nNext: CLI\n");
  assert.equal(round.task_state, "initial state");
  assert.equal(round.task_contract, "the contract");
  assert.equal(round.executor_output, "executor said hello");
  assert.equal(round.auditor_report, "auditor report text");
  assert.equal(round.harness_feedback, "feedback");
  assert.equal(round.final_response, "round one reply");
  assert.deepEqual(round.related_report_refs, []);
  // ``_status`` keeps only status/error/duration_ms with non-null values.
  assert.deepEqual(round.manager_status, { status: "done", duration_ms: 12 });
  assert.deepEqual(round.executor_status, { status: "done", duration_ms: 34 });
  assert.deepEqual(round.auditor_status, {
    status: "done",
    duration_ms: 56,
    format_repair_attempted: true,
    format_repair_status: { status: "error", duration_ms: 7 },
  });
  assert.deepEqual(round.final_response_status, { status: "done" });
  assert.equal(round.in_progress, true);
});

test("a terminal report closes every in-progress round", () => {
  const fixture = buildRun({ reportStatus: "completed" });
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  assert.ok(state.readRounds().every((round) => round.in_progress === false));
});

test("a cancellation event closes every in-progress round", () => {
  const fixture = buildRun();
  fs.appendFileSync(
    path.join(fixture.roleDir, "events.jsonl"),
    jsonl([{ schema_version: 1, ts: 10, event: "role_harness_cancelled", round: 2, status: "cancelled" }]),
    "utf-8",
  );
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const rounds = state.readRounds();
  assert.ok(rounds.every((round) => round.in_progress === false));
  // A run-level lifecycle event clears the active role regardless of round.
  assert.ok(rounds.every((round) => round.active_role === null));
});

test("snapshot adds roles and role_sizes per round", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const rounds = state.snapshot().rounds as Record<string, unknown>[];
  assert.deepEqual(rounds[0].roles, ["manager"]);
  const sizes = rounds[0].role_sizes as Record<string, number>;
  assert.ok(sizes.manager > 0);
  assert.deepEqual(rounds[1].roles, []);
});

test("trajectories prefer the normalized file and de-duplicate the final text", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const trajectory = state.readTrajectory(1, "manager")!;

  assert.equal(trajectory.trajectory_source, "normalized");
  assert.equal(trajectory.round_index, 1);
  assert.equal(trajectory.role, "manager");
  // The trailing ``result`` duplicates the preceding ``text`` step, which is
  // removed so the UI does not render the reply twice.
  assert.equal(trajectory.step_count, 2);
  assert.equal(state.readTrajectory(1, "not_a_role"), null);
  assert.equal(state.readTrajectory(2, "manager"), null);
});

test("artifacts are listed, bounded and traversal-safe", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const artifacts = state.listRoundArtifacts(1);

  assert.deepEqual(artifacts, [...artifacts].sort());
  assert.ok(artifacts.includes("manager_plan.txt"));
  assert.equal(state.readRoundArtifact(1, "task_state.txt"), "initial state");
  assert.equal(state.roundArtifactSize(1, "task_state.txt"), "initial state".length);
  for (const name of ["../report.json", "..", ".", "", "nested/name"]) {
    assert.equal(state.resolveRoundArtifact(1, name), null);
  }
  assert.equal(state.readRoundArtifact(1, "missing.txt"), null);
});

test("events are tail-limited and the limit is clamped", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  assert.equal(state.readEvents({ limit: 2 }).length, 2);
  assert.equal(state.readEvents({ limit: 2 })[1].event, "manager_round_start");
  assert.equal(state.readEvents({ limit: 0 }).length, 1);
  assert.equal(state.readEvents({ limit: 10_000 }).length, 9);
});

test("operator messages survive being applied while injections drain once", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot, controlEnabled: true });

  assert.equal(state.addInjection("  focus on the failing test  "), true);
  assert.equal(state.addInjection("   "), false);
  assert.deepEqual(state.listInjections(), ["focus on the failing test"]);
  const queued = state.listOperatorMessages();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, "focus on the failing test");
  assert.equal(queued[0].status, "queued");

  assert.deepEqual(state.drainInjections(), ["focus on the failing test"]);
  // Claimed once: the receipt removes it from the pending queue but the durable
  // message stays visible in the timeline.
  assert.deepEqual(state.drainInjections(), []);
  assert.deepEqual(state.listInjections(), []);
  const applied = state.listOperatorMessages();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].status, "applied");
  assert.deepEqual(state.snapshot().pending_injections, []);
});

test("control_enabled=false makes the state read-only", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  assert.equal(state.addInjection("ignored"), false);
  assert.equal(state.resolveApproval("nope", { action: "continue" }), false);
});

test("run selection is bounded to safe ids inside the runs root", () => {
  const fixture = buildRun();
  const state = new DashboardState(null, { runsRoot: fixture.runsRoot });
  // Auto-selected newest run.
  assert.equal(state.currentRunId, "run-1");
  assert.equal(state.selectRun("run-1"), true);
  assert.equal(state.logDir, fixture.logDir);
  for (const bad of ["..", ".", "", "a/b", "a\\b", "x".repeat(129)]) {
    assert.equal(state.selectRun(bad), false);
  }
  assert.equal(state.selectRun("missing-run"), false);
  assert.deepEqual(
    state.listRuns().map((run) => run.id),
    ["run-1"],
  );
});
