import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parsePlan } from "../../src/loop/plan.js";
import { RunState, contractPasses, parseContract, parseEvaluation, readLoopSnapshot } from "../../src/loop/state.js";

function tmpRun(): { runDir: string; logDir: string } {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-state-"));
  return { runDir, logDir: path.join(runDir, "lh_harness") };
}

test("a contract parses with default-FAIL rows and the pass rule needs every mandatory row", () => {
  const contract = parseContract(
    {
      criteria: [
        { id: "C1", statement: "9:16", verify: "ffprobe", evidence: "json", mandatory: true, weight: 2, passes: true },
        { statement: "original", mandatory: false, weight: 1 },
      ],
      scoring: { pass_rule: "custom" },
    },
    "s1",
  );
  assert.deepEqual(contract.criteria.map((item) => item.id), ["c1", "c2"]);
  assert.equal(contract.criteria[0]!.passes, true);
  assert.equal(contract.criteria[1]!.weight, 1);
  assert.equal(contractPasses(contract).passes, false);
  contract.criteria[1]!.passes = true;
  contract.criteria[0]!.score = 5;
  contract.criteria[1]!.score = 2;
  // weighted mean (2*5 + 1*2)/3 = 4 ≥ 3.5
  assert.equal(contractPasses(contract).passes, true);
  contract.criteria[0]!.score = 3;
  assert.match(contractPasses(contract).reason, /below/);
  assert.throws(() => parseContract({ criteria: [] }, "s1"), /no criteria/);
});

test("the evaluator's verdict is checked against the contract rule", () => {
  const contract = parseContract({ criteria: [{ id: "c1", statement: "a", mandatory: true }, { id: "c2", statement: "b" }] }, "s1");
  const claimedPass = parseEvaluation(
    { verdict: "PASS", criteria: [{ id: "c1", passes: false, score: 1, finding: "missing" }, { id: "c2", passes: true, score: 4 }] },
    { subtaskId: "s1", round: 1, contract, narrative: "n", episodeDir: "/e" },
  );
  assert.equal(claimedPass.verdict, "NEEDS_WORK");
  assert.match(claimedPass.harness_note, /mandatory criteria failed: c1/);
  const honest = parseEvaluation(
    { verdict: "pass", summary: "fine", criteria: [{ id: "c1", passes: true, score: 5 }, { id: "c2", passes: true, score: 4 }], plan_changes: [{ op: "add" }] },
    { subtaskId: "s1", round: 2, contract, narrative: "n", episodeDir: "/e" },
  );
  assert.equal(honest.verdict, "PASS");
  assert.equal(honest.plan_changes.length, 1);
  const garbage = parseEvaluation(null, { subtaskId: "s1", round: 3, contract, narrative: "", episodeDir: "/e" });
  assert.equal(garbage.verdict, "NEEDS_WORK");
  assert.equal(garbage.claimed_verdict, "invalid");
});

test("the loop snapshot projects plan, contracts, progress, evidence, evaluations and episodes", () => {
  const { runDir, logDir } = tmpRun();
  const state = new RunState({ runDir, logDir });
  state.ensureLayout();
  state.writeTask("build it", ["inbox/a.zip"]);
  const plan = parsePlan({ title: "T", nodes: [{ id: "s1", title: "One", goal: "g", backing: ["r"] }, { id: "s2", title: "Two", goal: "g", backing: ["r"] }] });
  state.writePlan(plan, { revisionNote: "planner" });
  state.writeContract(parseContract({ criteria: [{ id: "c1", statement: "x", mandatory: true }] }, "s1"));
  fs.writeFileSync(state.rubricPath("s1"), "# rubric\n");
  fs.writeFileSync(state.progressPath("s1"), "Status: done\n## Evidence\n- c1 → a.png\n");
  fs.mkdirSync(state.evidenceDir("s1"), { recursive: true });
  fs.writeFileSync(path.join(state.evidenceDir("s1"), "a.png"), "png");
  fs.writeFileSync(state.ledgerPath("s1"), '{"kind":"write"}\n{"kind":"bash"}\n');
  state.writeContextPack("s1", 1, { sections: [{ title: "T", kind: "memory", path: "/m.md", reason: "why", chars: 3 }], selector: "python" }, "rendered");
  state.writeEvaluation(parseEvaluation({ verdict: "PASS", criteria: [{ id: "c1", passes: true, score: 5 }] }, { subtaskId: "s1", round: 1, contract: state.readContract("s1")!, narrative: "ok", episodeDir: "/e" }));
  state.appendEpisodeIndex({ seq: 1, ep: 1, role: "composer", subtask_id: "s1", round: 1, dir: "/x/composer_episodes/ep001", status: "running", started_at: 1, finished_at: null, duration_ms: null, cost_usd: null, error: null });
  state.appendEpisodeIndex({ seq: 1, ep: 1, role: "composer", subtask_id: "s1", round: 1, dir: "/x/composer_episodes/ep001", status: "done", started_at: 1, finished_at: 2, duration_ms: 1000, cost_usd: 0.5, error: null });
  state.setPhase({ phase: "executing", current_subtask: "s1", current_role: "evaluator", current_round: 1 });

  const snap = readLoopSnapshot(runDir, logDir);
  assert.equal(snap.task.split("\n")[0], "build it");
  assert.equal(snap.plan?.title, "T");
  assert.equal(snap.phase?.current_role, "evaluator");
  assert.equal(snap.subtasks.length, 2);
  const s1 = snap.subtasks[0]!;
  assert.equal(s1.contract?.criteria[0]?.id, "c1");
  assert.equal(s1.rubric, "# rubric\n");
  assert.deepEqual(s1.evidence_files, ["a.png"]);
  assert.equal(s1.ledger_count, 2);
  assert.equal(s1.evaluations[0]?.verdict, "PASS");
  assert.equal(s1.context[0]?.sections[0]?.reason, "why");
  assert.equal(s1.episodes.length, 1);
  assert.equal(s1.episodes[0]?.status, "done");
  assert.equal(snap.episodes[0]?.cost_usd, 0.5);
  assert.ok(fs.existsSync(path.join(state.dir("plan"), "revisions", "r000.json")));
  assert.match(fs.readFileSync(path.join(state.dir("plan"), "PLAN.md"), "utf-8"), /\*\*One\*\*/);
});

test("criteria the evaluator leaves out count as failed and become actionable findings", () => {
  const contract = parseContract({ criteria: [{ id: "c1", statement: "a", mandatory: true, verify: "ls a" }, { id: "c2", statement: "b", mandatory: true }] }, "s1");
  const record = parseEvaluation(
    { verdict: "PASS", criteria: [{ id: "c1", passes: true, score: 5 }] },
    { subtaskId: "s1", round: 1, contract, narrative: "", episodeDir: "/e" },
  );
  assert.equal(record.verdict, "NEEDS_WORK");
  assert.match(record.harness_note, /ungraded criteria: c2/);
  assert.equal(record.findings.length, 1);
  assert.match(record.findings[0]!, /Criterion c2 was not graded/);
  assert.match(record.criteria[1]!.finding, /not graded/);
});
