// Stand-in for the real ``lh-harness run --supervised`` worker.
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
fs.mkdirSync(path.join(roleDir, "rounds", "round_001"), { recursive: true });
fs.appendFileSync(
  path.join(roleDir, "events.jsonl"),
  `${JSON.stringify({ schema_version: 1, event: "role_harness_start", ts: Date.now() / 1000 })}\n`,
  "utf-8",
);
fs.writeFileSync(
  path.join(logDir, "report.json"),
  JSON.stringify({
    schema_version: 2,
    status,
    completion_satisfied: completionSatisfied,
    task: "fixture task",
    rounds: [{ round_index: 1 }],
    final_response: "fixture reply",
  }),
  "utf-8",
);
process.stdout.write("fake worker finished\n");
process.exit(status === "completed" ? 0 : 1);
