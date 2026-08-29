// Stand-in for the real ``lh-harness-eray run --supervised`` worker.
//
// The Python supervisor tests monkeypatch ``subprocess.Popen``; this fixture
// exists so at least one Node test exercises the genuine launch transaction
// (detached process group, inherited worker.log descriptor, exit reconciliation).
//
// usage: node tests/fixtures/fake_worker.mjs <runDir> [status] [completionSatisfied]
import fs from "node:fs";
import path from "node:path";

const runDir = process.argv[2];
const status = process.argv[3] ?? "completed";
const completionSatisfied = (process.argv[4] ?? "true") === "true";

const logDir = path.join(runDir, "lh_harness");
const roleDir = path.join(logDir, "role_orchestration");
const stateDir = path.join(runDir, "state");
fs.mkdirSync(roleDir, { recursive: true });
fs.mkdirSync(path.join(logDir, "composer_episodes", "ep001"), { recursive: true });
fs.mkdirSync(path.join(stateDir, "plan"), { recursive: true });
const now = Date.now() / 1000;
fs.appendFileSync(
  path.join(roleDir, "events.jsonl"),
  [
    JSON.stringify({ schema_version: 1, event: "run_started", ts: now }),
    JSON.stringify({ schema_version: 1, event: "plan_written", leaves: 1, questions: 0, ts: now }),
    JSON.stringify({ schema_version: 1, event: "subtask_started", subtask_id: "fixture-subtask", ts: now }),
    JSON.stringify({ schema_version: 1, event: "episode_started", role: "composer", seq: 1, ts: now }),
    JSON.stringify({ schema_version: 1, event: "episode_finished", role: "composer", seq: 1, status: "done", ts: now }),
    JSON.stringify({ schema_version: 1, event: "subtask_done", subtask_id: "fixture-subtask", rounds: 1, ts: now }),
    JSON.stringify({
      schema_version: 1,
      event: status === "cancelled" ? "run_cancelled" : status === "failed" ? "run_failed" : "run_finished",
      status,
      ts: now,
    }),
  ].join("\n") + "\n",
  "utf-8",
);
fs.writeFileSync(
  path.join(stateDir, "plan", "plan.json"),
  JSON.stringify({
    schema_version: 1,
    title: "Fixture plan",
    revision: 1,
    nodes: [
      { id: "fixture-subtask", title: "Fixture subtask", goal: "do it", children: [], status: "done", rounds: 1, last_verdict: "PASS" },
    ],
  }),
  "utf-8",
);
const report = JSON.stringify({
  schema_version: 3,
  status,
  completion_satisfied: completionSatisfied,
  completion_authority: "evaluator_contracts",
  task: "fixture task",
  rounds_run: 1,
  max_rounds: 25,
  status_counts: { done: 1 },
  subtasks: [{ id: "fixture-subtask", title: "Fixture subtask", status: "done", rounds: 1, last_verdict: "PASS" }],
  cost_usd: 0.0,
  final_response: "fixture reply",
});
fs.writeFileSync(path.join(logDir, "report.json"), report, "utf-8");
fs.writeFileSync(path.join(roleDir, "report.json"), report, "utf-8");
fs.writeFileSync(path.join(roleDir, "final_response.txt"), "fixture reply", "utf-8");
process.stdout.write("fake worker finished\n");
process.exit(status === "completed" ? 0 : 1);
