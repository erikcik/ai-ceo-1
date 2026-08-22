// Tests for src/dashboard/gate.ts + src/dashboard/rules.ts (gate.py, rules.py).
//
// One case per trigger (``completed``, ``max_rounds``, ``needs_input``,
// ``needs_human``, ``repeated_failure``), per answer (``continue`` / ``stop``),
// and for the ordering guarantee that a ``stop`` persists the operator's
// cancellation intent before the blocking hook is released.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApprovalRules } from "../src/dashboard/rules.js";
import { DashboardState } from "../src/dashboard/state.js";
import { makeHumanHook } from "../src/dashboard/gate.js";

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-gate-")));
}

function newState(): DashboardState {
  const runsRoot = path.join(tmpDir(), "runs");
  const logDir = path.join(runsRoot, "run-1", "lh_harness");
  fs.mkdirSync(path.join(logDir, "role_orchestration", "rounds"), { recursive: true });
  return new DashboardState(logDir, { runsRoot, controlEnabled: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the gate's approval, assert on it, then answer it. */
async function answerGate(
  state: DashboardState,
  answer: { action: string; reason?: string; user_input?: string; extra_rounds?: number | null },
  inspect?: (approval: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const pending = state.listApprovals().find((item) => item.status === "pending");
    if (pending !== undefined) {
      inspect?.(pending);
      assert.equal(state.resolveApproval(String(pending.approval_id), answer), true);
      return pending;
    }
    await sleep(2);
  }
  throw new Error("the gate never opened an approval");
}

const failingRound = {
  round_index: 1,
  auditor_status: { invalid_plan: true },
  executor_status: { status: "done" },
};

test("no trigger returns continue and forwards queued injections", async () => {
  const state = newState();
  state.addInjection("look at the logs");
  state.addInjection("and the config");
  const hook = makeHumanHook(state, { pollInterval: 0.01 });

  const decision = await hook({
    phase: "end_of_round",
    outcome: "progress",
    reached_max: false,
    round_index: 1,
    rounds: [],
  });

  assert.deepEqual(decision, { action: "continue", instructions: "look at the logs\nand the config" });
  assert.deepEqual(state.listApprovals(), []);
});

test("trigger completed: dialog payload, continue answer and extra rounds", async () => {
  const state = newState();
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const pending = hook({
    phase: "end_of_round",
    outcome: "completed",
    reached_max: false,
    round_index: 3,
    task: "the task",
    task_state: "the state",
    final_response: "the reply",
    rounds: [{ round_index: 1 }, { round_index: 2 }, { round_index: 3 }],
  });

  await answerGate(state, { action: "continue", extra_rounds: 5, user_input: "keep going" }, (approval) => {
    assert.equal(approval.title, "Task complete. Continue the run?");
    assert.equal(
      approval.message,
      "The manager confirmed task completion. Continue to add rounds and inject instructions, or end this run.",
    );
    assert.deepEqual(approval.options, [
      { value: "continue", label: "Continue run", style: "primary" },
      { value: "stop", label: "End run", style: "danger" },
    ]);
    assert.deepEqual(approval.answers, []);
    assert.equal(approval.allow_input, true);
    assert.equal(approval.input_label, "Optional: add instructions for the next manager round");
    assert.equal(approval.allow_extra_rounds, true);
    assert.equal(approval.round_index, 3);
    assert.deepEqual(approval.context, {
      phase: "end_of_round",
      trigger: "completed",
      outcome: "completed",
      round_index: 3,
      question: "",
      detail: "",
      task: "the task",
      task_state: "the state",
      final_response: "the reply",
      round_count: 3,
    });
  });

  assert.deepEqual(await pending, {
    action: "continue",
    instructions: "keep going",
    extra_rounds: 5,
    reason: "",
  });
});

test("trigger max_rounds outranks a blocked outcome on the same round", async () => {
  const state = newState();
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const pending = hook({
    outcome: "blocked",
    reached_max: true,
    round_index: 4,
    rounds: [],
  });

  await answerGate(state, { action: "continue" }, (approval) => {
    assert.equal(approval.title, "Round limit reached. Continue the run?");
    assert.equal(
      approval.message,
      "The configured round budget is exhausted before completion. Continue to add rounds, or end this run.",
    );
    assert.equal(approval.allow_extra_rounds, true);
    assert.equal((approval.context as Record<string, unknown>).trigger, "max_rounds");
  });

  const decision = await pending;
  assert.equal(decision.action, "continue");
  // ``0`` falls back to the caller's default, which falls back to the manager's
  // configured budget.
  assert.equal(decision.extra_rounds, 0);
});

test("trigger needs_input shows the manager question and quick answers", async () => {
  const state = newState();
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const pending = hook({
    outcome: "ask",
    reached_max: false,
    round_index: 2,
    question: "Should I delete the stale branch?",
    answers: ["Yes", "No"],
    rounds: [],
  });

  await answerGate(state, { action: "continue", user_input: "No" }, (approval) => {
    assert.equal(approval.title, "Manager needs your decision");
    assert.equal(
      approval.message,
      "The manager needs your decision or input before it can continue. Answer below and continue, or stop this run." +
        "\n\nManager question:\nShould I delete the stale branch?",
    );
    assert.deepEqual(approval.answers, ["Yes", "No"]);
    assert.equal(approval.input_label, "Your answer, injected into the next manager round");
    assert.equal(approval.allow_extra_rounds, false);
    assert.deepEqual(approval.options, [
      { value: "continue", label: "Continue run", style: "primary" },
      { value: "stop", label: "Stop run", style: "danger" },
    ]);
  });

  assert.equal((await pending).instructions, "No");
});

test("trigger needs_human opens on a blocked outcome", async () => {
  const state = newState();
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const pending = hook({ outcome: "blocked", reached_max: false, round_index: 1, rounds: [] });

  await answerGate(state, { action: "continue", reason: "I unblocked it" }, (approval) => {
    assert.equal(approval.title, "Task blocked; operator input required");
    assert.equal(
      approval.message,
      "The manager reported that it cannot proceed automatically. Add instructions and continue, or stop this run.",
    );
    assert.equal(approval.allow_extra_rounds, false);
  });

  assert.equal((await pending).reason, "I unblocked it");
});

test("trigger repeated_failure carries the rule reason as message and detail", async () => {
  const state = newState();
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const rounds = [
    { round_index: 1, auditor_status: { invalid_plan: true } },
    { round_index: 2, auditor_status: { invalid_completion: true } },
    { round_index: 3, executor_status: { status: "timeout" } },
  ];
  const pending = hook({ outcome: "progress", reached_max: false, round_index: 3, rounds });

  const expected =
    "3 consecutive rounds failed (invalid route / rejected completion / episode error; threshold 3). " +
    "The run may be looping; operator input is requested.";
  await answerGate(state, { action: "continue", extra_rounds: 2 }, (approval) => {
    assert.equal(approval.title, "Repeated failures require operator input");
    assert.equal(approval.message, expected);
    assert.equal((approval.context as Record<string, unknown>).detail, expected);
    assert.equal(approval.allow_extra_rounds, true);
  });

  assert.equal((await pending).extra_rounds, 2);
});

test("the repeated-failure streak breaks on a healthy round", async () => {
  const state = newState();
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const rounds = [
    { round_index: 1, auditor_status: { invalid_plan: true } },
    { round_index: 2, auditor_status: { invalid_plan: true } },
    { round_index: 3, auditor_status: { status: "done" } },
  ];

  const decision = await hook({ outcome: "progress", reached_max: false, round_index: 3, rounds });
  assert.deepEqual(decision, { action: "continue", instructions: "" });
});

test("LH_HARNESS_DASHBOARD_FAILURE_LIMIT overrides the default of 3", async () => {
  const saved = process.env.LH_HARNESS_DASHBOARD_FAILURE_LIMIT;
  process.env.LH_HARNESS_DASHBOARD_FAILURE_LIMIT = "1";
  try {
    const state = newState();
    const hook = makeHumanHook(state, { pollInterval: 0.01, rules: new ApprovalRules() });
    const pending = hook({ outcome: "progress", reached_max: false, round_index: 1, rounds: [failingRound] });
    await answerGate(state, { action: "continue" }, (approval) => {
      assert.equal((approval.context as Record<string, unknown>).trigger, "repeated_failure");
      assert.ok(String(approval.message).startsWith("1 consecutive rounds failed"));
    });
    await pending;
  } finally {
    if (saved === undefined) delete process.env.LH_HARNESS_DASHBOARD_FAILURE_LIMIT;
    else process.env.LH_HARNESS_DASHBOARD_FAILURE_LIMIT = saved;
  }
});

test("a stop answer persists requested_action=cancel + stopping before releasing the hook", async () => {
  const state = newState();
  state.controlBus.writeStatus({ run_id: "run-1", status: "running", alive: true });
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const pending = hook({ outcome: "completed", reached_max: false, round_index: 1, rounds: [] });

  await answerGate(state, { action: "stop", reason: "that is enough" });
  const decision = await pending;
  // Read the durable status in the same tick the hook returned: the intent must
  // already be persisted, otherwise a fast worker exit is misclassified.
  const durable = state.controlBus.readStatus();

  assert.equal(decision.action, "stop");
  assert.equal(decision.reason, "that is enough");
  assert.equal(durable.requested_action, "cancel");
  assert.equal(durable.status, "stopping");
  assert.ok(typeof durable.operator_stop_requested_at === "number");
});

test("a stop answer leaves an already terminal lifecycle alone", async () => {
  const state = newState();
  state.controlBus.writeStatus({ run_id: "run-1", status: "completed", alive: false });
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const pending = hook({ outcome: "completed", reached_max: false, round_index: 1, rounds: [] });

  await answerGate(state, { action: "stop" });
  await pending;

  const durable = state.controlBus.readStatus();
  assert.equal(durable.status, "completed");
  assert.ok(!("requested_action" in durable));
});

test("the hook joins drained injections with the operator's dialog input", async () => {
  const state = newState();
  state.addInjection("queued note");
  const hook = makeHumanHook(state, { pollInterval: 0.01, defaultExtraRounds: 4 });
  const pending = hook({ outcome: "completed", reached_max: false, round_index: 1, rounds: [] });

  await answerGate(state, { action: "continue", user_input: "  dialog note  " });
  const decision = await pending;

  assert.equal(decision.instructions, "queued note\ndialog note");
  // The operator left the round input empty, so the caller's default applies.
  assert.equal(decision.extra_rounds, 4);
  // The instruction was claimed exactly once.
  assert.deepEqual(state.listInjections(), []);
});

test("an answer outside the approval's own options is rejected", async () => {
  const state = newState();
  const hook = makeHumanHook(state, { pollInterval: 0.01 });
  const pending = hook({ outcome: "blocked", reached_max: false, round_index: 1, rounds: [] });

  const approval = await answerGate(state, { action: "continue" }, (item) => {
    // ``needs_human`` forbids extra rounds and an arbitrary action.
    assert.equal(state.resolveApproval(String(item.approval_id), { action: "pause" }), false);
    assert.equal(
      state.resolveApproval(String(item.approval_id), { action: "continue", extra_rounds: 3 }),
      false,
    );
  });
  await pending;

  assert.equal(state.getApproval(String(approval.approval_id))?.status, "resolved");
});

test("a worker waiting at a human gate stays alive with no other live handles", async () => {
  // Regression: the gate's poll sleep used an unref'd timer, so a supervised
  // worker with nothing else pending exited with code 0 mid-gate and the
  // supervisor reported "worker exited without a valid final report".
  const { spawn } = await import("node:child_process");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const gateModule = pathToFileURL(fileURLToPath(new URL("../src/dashboard/gate.ts", import.meta.url))).href;
  const script = `
    const { makeHumanHook } = await import(${JSON.stringify(gateModule)});
    const approvals = new Map();
    const state = {
      hasPendingApproval: () => false,
      createApproval: (init) => { const a = { approval_id: "x", status: "pending", toDict: () => ({ approval_id: "x", status: "pending", ...init }), ...init }; approvals.set("x", a); return a; },
      getApproval: (id) => approvals.get(id) ?? null,
      resolveApproval: () => true,
      updateApprovalContext: () => true,
      drainInjections: () => [],
      listInjections: () => [],
    };
    const hook = makeHumanHook(state, { pollInterval: 0.2 });
    hook({ outcome: "ask", round_index: 1, rounds: [], question: "q", answers: [] }).then(() => process.exit(9));
  `;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited: number | null = null;
  child.on("exit", (code) => { exited = code; });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill("SIGKILL");
  assert.equal(exited, null, "the gate poll must keep the process alive while waiting for the operator");
});
