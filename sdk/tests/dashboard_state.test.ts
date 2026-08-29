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

/**
 * One planned run: a finished subtask with its rubric/contract/evaluation and a
 * composer episode on disk, written exactly the way `src/loop/state.ts` lays the
 * run out (`<run>/lh_harness` for the supervisor contract, `<run>/state` for
 * everything the loop reads back).
 */
function buildRun(options: { reportStatus?: string | null } = {}): Fixture {
  const runsRoot = path.join(tmpDir(), "runs");
  const runDir = path.join(runsRoot, "run-1");
  const logDir = path.join(runDir, "lh_harness");
  const roleDir = path.join(logDir, "role_orchestration");
  const stateDir = path.join(runDir, "state");
  fs.mkdirSync(roleDir, { recursive: true });

  write(path.join(stateDir, "task", "TASK.md"), "ship the api\n");
  write(
    path.join(stateDir, "phase.json"),
    JSON.stringify({
      phase: "executing",
      current_subtask: "build-api",
      current_role: "composer",
      current_round: 1,
      updated_at: 9,
      detail: "",
    }),
  );
  write(
    path.join(stateDir, "plan", "plan.json"),
    JSON.stringify({
      schema_version: 1,
      title: "Ship the API",
      summary: "two steps",
      assumptions: [],
      questions: [],
      revision: 1,
      created_at: 1,
      updated_at: 2,
      nodes: [
        {
          id: "build-api",
          title: "Build the API",
          goal: "expose /health",
          children: [],
          status: "done",
          rounds: 1,
          last_verdict: "PASS",
        },
        {
          id: "ship-it",
          title: "Ship it",
          goal: "deploy",
          children: [],
          status: "pending",
          rounds: 0,
          depends_on: ["build-api"],
        },
      ],
    }),
  );
  write(path.join(stateDir, "prompts", "planner.md"), "planner briefing\n");
  write(path.join(stateDir, "research", "web-frameworks.md"), "# notes\n");
  write(path.join(stateDir, "rubrics", "build-api.md"), "the rubric\n");
  write(
    path.join(stateDir, "contracts", "build-api.json"),
    JSON.stringify({
      subtask_id: "build-api",
      criteria: [{ id: "c1", statement: "/health returns 200", mandatory: true, weight: 1, passes: true, score: 5 }],
      scoring: { scale: "0-5", pass_rule: "all mandatory pass" },
      created_at: 1,
      updated_at: 2,
    }),
  );
  write(path.join(stateDir, "progress", "build-api.md"), "wrote the handler\n");
  write(path.join(stateDir, "evidence", "build-api", "ledger.jsonl"), jsonl([{ claim: "200 OK", proof: "curl.txt" }]));
  write(path.join(stateDir, "evidence", "build-api", "curl.txt"), "HTTP/1.1 200 OK\n");
  write(
    path.join(stateDir, "evaluations", "build-api", "r1.json"),
    JSON.stringify({
      subtask_id: "build-api",
      round: 1,
      verdict: "PASS",
      claimed_verdict: "PASS",
      summary: "looks right",
      criteria: [{ id: "c1", passes: true, score: 5, checked: ["curl"], finding: "" }],
      findings: [],
      plan_changes: [],
      memory_notes: [],
      narrative: "",
      harness_note: "",
      episode_dir: path.join(logDir, "evaluator_episodes", "ep002"),
      created_at: 8,
    }),
  );
  write(
    path.join(stateDir, "context", "build-api-r1.json"),
    JSON.stringify({ selector: "loop", sections: [{ title: "Task", kind: "task", path: "task/TASK.md", reason: "always", chars: 12 }] }),
  );
  write(
    path.join(stateDir, "episodes.jsonl"),
    jsonl([
      {
        seq: 1,
        role: "composer",
        subtask_id: "build-api",
        round: 1,
        dir: path.join(logDir, "composer_episodes", "ep001"),
        status: "done",
        started_at: 4,
        finished_at: 5,
        duration_ms: 1200,
        cost_usd: 0.5,
        error: null,
      },
      {
        seq: 2,
        role: "evaluator",
        subtask_id: "build-api",
        round: 1,
        dir: path.join(logDir, "evaluator_episodes", "ep002"),
        status: "done",
        started_at: 6,
        finished_at: 7,
        duration_ms: 900,
        cost_usd: 0.25,
        error: null,
      },
    ]),
  );
  write(path.join(stateDir, "FINAL.md"), "the state reply");

  // One composer episode on disk: normalized + provider-raw trajectory.
  const episode = path.join(logDir, "composer_episodes", "ep001");
  write(path.join(episode, "composer_raw_trajectory.jsonl"), jsonl([{ type: "assistant" }]));
  write(
    path.join(episode, "composer_trajectory.jsonl"),
    jsonl([
      { kind: "text", text: "thinking" },
      { kind: "text", text: "the answer" },
      { kind: "result", text: "the answer" },
    ]),
  );
  write(path.join(episode, "metadata.json"), JSON.stringify({ status: "done", duration_ms: 1200 }));
  write(path.join(episode, "prompt.md"), "compose it");

  write(
    path.join(roleDir, "events.jsonl"),
    jsonl([
      { schema_version: 1, event_id: "run-1:000001", ts: 1, event: "run_started", max_rounds: 25 },
      { schema_version: 1, event_id: "run-1:000002", ts: 2, event: "episode_started", role: "planner", seq: 0 },
      { schema_version: 1, event_id: "run-1:000003", ts: 3, event: "plan_written", leaves: 2, questions: 0 },
      { schema_version: 1, event_id: "run-1:000004", ts: 4, event: "subtask_started", subtask_id: "build-api" },
      { schema_version: 1, event_id: "run-1:000005", ts: 5, event: "episode_started", role: "composer", seq: 1 },
      { schema_version: 1, event_id: "run-1:000006", ts: 6, event: "episode_finished", role: "composer", seq: 1, status: "done" },
      { schema_version: 1, event_id: "run-1:000007", ts: 7, event: "evaluation", subtask_id: "build-api", round: 1, verdict: "PASS" },
      { schema_version: 1, event_id: "run-1:000008", ts: 8, event: "subtask_done", subtask_id: "build-api", rounds: 1 },
      { schema_version: 1, event_id: "run-1:000009", ts: 9, event: "subtask_started", subtask_id: "ship-it" },
    ]),
  );
  write(path.join(roleDir, "final_response.txt"), "the published reply");
  const reportStatus = options.reportStatus === undefined ? null : options.reportStatus;
  const report: Record<string, unknown> = {
    schema_version: 3,
    task: "reported task",
    completion_authority: "evaluator_contracts",
    rounds_run: 1,
    max_rounds: 25,
    cost_usd: 0.75,
    status_counts: { done: 1, pending: 1 },
    subtasks: [{ id: "build-api", status: "done" }],
  };
  if (reportStatus !== null) {
    report.status = reportStatus;
    report.completion_satisfied = true;
  }
  write(path.join(logDir, "report.json"), JSON.stringify(report));
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
      "loop",
      "operator_messages",
      "pending_injections",
      "report",
      "runs",
      "server_time",
      "task",
    ].sort(),
  );
  // The state tree owns the task; report.task is only a fallback.
  assert.equal(snapshot.task, "ship the api\n");
  assert.equal(snapshot.log_dir, fixture.logDir);
  assert.equal(snapshot.current_run, "run-1");
  // The role-scoped reply wins: the loop writes it before report.json.
  assert.equal(snapshot.final_response, "the published reply");
  assert.equal(snapshot.control_enabled, false);
  assert.deepEqual(snapshot.approvals, []);
  assert.deepEqual(snapshot.operator_messages, []);
  assert.deepEqual(snapshot.pending_injections, []);
  assert.equal(typeof snapshot.server_time, "number");
  assert.equal((snapshot.runs as Record<string, unknown>[])[0].id, "run-1");
  assert.equal((snapshot.events as Record<string, unknown>[]).length, 9);
});

test("the loop projection carries the plan, the phase and every subtask view", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const loop = state.readLoop();

  assert.equal(loop.phase?.phase, "executing");
  assert.equal(loop.phase?.current_subtask, "build-api");
  assert.equal(loop.plan?.title, "Ship the API");
  assert.deepEqual(loop.status_counts, {
    pending: 1,
    rubric: 0,
    composing: 0,
    evaluating: 0,
    done: 1,
    blocked: 0,
    skipped: 0,
  });
  assert.ok(loop.plan_markdown.includes("Build the API"));
  assert.deepEqual(Object.keys(loop.briefings), ["planner"]);
  assert.deepEqual(loop.research, ["web-frameworks.md"]);
  assert.deepEqual(loop.episodes.map((episode) => episode.seq), [1, 2]);
  assert.equal(loop.final_response, "the state reply");

  assert.deepEqual(loop.subtasks.map((subtask) => subtask.id), ["build-api", "ship-it"]);
  const [done, pending] = loop.subtasks;
  assert.equal(done.status, "done");
  assert.equal(done.last_verdict, "PASS");
  assert.equal(done.rubric, "the rubric\n");
  assert.equal(done.progress, "wrote the handler\n");
  assert.equal(done.contract?.criteria[0].id, "c1");
  assert.deepEqual(done.evidence_files, ["curl.txt"]);
  assert.equal(done.ledger_count, 1);
  assert.equal(done.evaluations.length, 1);
  assert.equal(done.evaluations[0].verdict, "PASS");
  assert.deepEqual(done.context.map((entry) => entry.round), [1]);
  assert.deepEqual(done.episodes.map((episode) => episode.role), ["composer", "evaluator"]);
  assert.equal(pending.status, "pending");
  assert.equal(pending.contract, null);
});

test("state files are readable, listable and traversal-safe", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });

  assert.equal(state.readStateFile("task/TASK.md"), "ship the api\n");
  assert.equal(state.stateFileSize("task/TASK.md"), "ship the api\n".length);
  assert.deepEqual(state.listStateDir("evidence/build-api"), ["curl.txt", "ledger.jsonl"]);
  assert.ok(state.listStateDir("").includes("plan"));
  for (const bad of ["../lh_harness/report.json", "..", ".", "", "task/../../etc"]) {
    assert.equal(state.resolveStateFile(bad), null);
  }
  assert.equal(state.readStateFile("task/missing.md"), null);
});

test("trajectories prefer the normalized file and de-duplicate the final text", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const trajectory = state.readTrajectory("composer", 1)!;

  assert.equal(trajectory.trajectory_source, "normalized");
  assert.equal(trajectory.episode, 1);
  assert.equal(trajectory.role, "composer");
  // The trailing ``result`` duplicates the preceding ``text`` step, which is
  // removed so the UI does not render the reply twice.
  assert.equal(trajectory.step_count, 2);
  assert.equal(state.readTrajectory("not_a_role", 1), null);
  assert.equal(state.readTrajectory("composer", 2), null);
});

test("episode artifacts are listed, bounded and traversal-safe", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  const artifacts = state.listEpisodeArtifacts("composer", 1);

  assert.deepEqual(artifacts, [...artifacts].sort());
  assert.ok(artifacts.includes("composer_trajectory.jsonl"));
  assert.ok(artifacts.includes("metadata.json"));
  assert.equal(state.readEpisodeArtifactBytes("composer", 1, "prompt.md")?.toString("utf-8"), "compose it");
  assert.equal(state.episodeArtifactSize("composer", 1, "prompt.md"), "compose it".length);
  for (const name of ["../report.json", "..", ".", "", "nested/name"]) {
    assert.equal(state.resolveEpisodeArtifact("composer", 1, name), null);
  }
  assert.equal(state.readEpisodeArtifactBytes("composer", 1, "missing.txt"), null);
  // The episode number is recovered from the index entry's absolute directory.
  assert.deepEqual(
    DashboardState.episodeSeqFromDir(path.join(fixture.logDir, "composer_episodes", "ep001")),
    { role: "composer", ep: 1 },
  );
});

test("events are tail-limited and the limit is clamped", () => {
  const fixture = buildRun();
  const state = new DashboardState(fixture.logDir, { runsRoot: fixture.runsRoot });
  assert.equal(state.readEvents({ limit: 2 }).length, 2);
  assert.equal(state.readEvents({ limit: 2 })[1].event, "subtask_started");
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
