// Ported from LongHorizon-Harness tests/test_resume.py — the manager-owned
// sections only (`--- manager ledger restore ---` and the manager half of
// `--- approval extra rounds ---`). The supervisor, lifecycle, dashboard and CLI
// sections of that module belong to the supervisor/CLI ports.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extraRounds, managedRoundFromDict, recordedRounds } from "../src/manager.js";
import { MAX_ROUNDS, managedRound } from "../src/types.js";

function tmpPath(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-resume-ledger-")));
}

function round(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...managedRound({
      round_index: index,
      next_step: "cli",
      plan_text: `plan ${index}`,
      executor_output: `output ${index}`,
      auditor_report: `report ${index}`,
      harness_feedback: "",
      task_state: `state ${index}`,
      task_contract: `contract ${index}`,
      related_report_refs: [],
      manager_status: { ok: true },
      executor_status: {},
      auditor_status: {},
    }),
    ...overrides,
  };
}

function writeLedger(roleDir: string, records: Record<string, unknown>[]): void {
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(
    path.join(roleDir, "rounds.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}

// --- manager ledger restore -------------------------------------------------

test("recorded rounds restores a contiguous history", () => {
  const role = path.join(tmpPath(), "role_orchestration");
  writeLedger(role, [round(1), round(2), round(3)]);

  const restored = recordedRounds(role);

  assert.deepEqual(
    restored.map((item) => item.round_index),
    [1, 2, 3],
  );
  assert.equal(restored[restored.length - 1]!.task_state, "state 3");
  assert.equal(restored[restored.length - 1]!.task_contract, "contract 3");
  assert.equal(restored[0]!.plan_text, "plan 1");
});

test("recorded rounds keeps the latest entry per index", () => {
  const role = path.join(tmpPath(), "role_orchestration");
  // The loop re-records a round after a late gate decision; the ledger is
  // append-only, so the newest entry for an index must win.
  writeLedger(role, [round(1), round(1, { plan_text: "revised plan" })]);

  const restored = recordedRounds(role);

  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.plan_text, "revised plan");
});

test("recorded rounds skips a truncated tail", () => {
  const role = path.join(tmpPath(), "role_orchestration");
  fs.mkdirSync(role, { recursive: true });
  const good = JSON.stringify(round(1));
  fs.writeFileSync(path.join(role, "rounds.jsonl"), good + "\n" + good.slice(0, Math.floor(good.length / 2)));

  const restored = recordedRounds(role);

  assert.deepEqual(
    restored.map((item) => item.round_index),
    [1],
  );
});

for (const payload of [
  { round_index: 0 },
  { round_index: -1 },
  { round_index: true },
  { round_index: "2" },
  { round_index: MAX_ROUNDS + 1 },
  { no_index: 1 },
  [1, 2, 3],
  "not an object",
] as unknown[]) {
  test(`recorded rounds rejects the unusable entry ${JSON.stringify(payload)}`, () => {
    const role = path.join(tmpPath(), "role_orchestration");
    fs.mkdirSync(role, { recursive: true });
    fs.writeFileSync(path.join(role, "rounds.jsonl"), JSON.stringify(payload) + "\n");

    assert.deepEqual(recordedRounds(role), []);
  });
}

test("recorded rounds is empty without a ledger", () => {
  assert.deepEqual(recordedRounds(path.join(tmpPath(), "missing")), []);
});

test("managed round from dict sanitises untrusted fields", () => {
  const record = managedRoundFromDict({
    round_index: 2,
    next_step: "not-a-route",
    plan_text: null,
    related_report_refs: ["a", 7, null],
    manager_status: "not-a-dict",
  });

  assert.equal(record.next_step, "invalid");
  assert.equal(record.plan_text, "");
  assert.deepEqual(record.related_report_refs, ["a"]);
  assert.deepEqual(record.manager_status, {});
});

// --- approval extra rounds (manager-side validation) ------------------------

for (const [value, expected] of [
  [null, 0],
  [0, 0],
  [-1, 0],
  [true, 0],
  ["5", 5],
  ["x", 0],
  [MAX_ROUNDS + 1, MAX_ROUNDS],
] as [unknown, number][]) {
  test(`manager extra-rounds validation maps ${JSON.stringify(value)} to ${expected}`, () => {
    assert.equal(extraRounds(value), expected);
  });
}
