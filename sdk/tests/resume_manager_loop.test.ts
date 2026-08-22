// Ported 1:1 from LongHorizon-Harness tests/test_resume_manager_loop.py.
//
// The resumed manager loop continues numbering and sees its own history.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentAdapter } from "../src/adapters/base.js";
import { LocalEnvironment } from "../src/environment/local.js";
import { run } from "../src/manager.js";
import { episodeResult, harnessConfig, managedRound, type EpisodeResult } from "../src/types.js";

// The manager reply that routes one more CLI executor round, and the reply that
// claims completion. Completion is only accepted when the previous auditor
// report was clean, so a resumed ledger must supply that evidence.
const PLAN = "Next: cli\n\nCurrent Task State:\nstill working\n\nPlan:\nkeep going";
const DONE = "Next: done\n\nCurrent Task State:\nall finished";
const EXECUTED = "executor made the change";

function cleanAudit(summary: string): string {
  return `Status: complete\nIntegrity: clean\nContract audit: aligned\n\nSummary:\n${summary}`;
}

const CLEAN_AUDIT = cleanAudit("the change is verified");

function tmpPath(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-resume-")));
}

function ledgerRound(index: number): Record<string, unknown> {
  return {
    ...managedRound({
      round_index: index,
      next_step: "cli",
      plan_text: `plan ${index}`,
      executor_output: `output ${index}`,
      auditor_report: cleanAudit(`round ${index} verified`),
      harness_feedback: "",
      task_state: `state ${index}`,
      task_contract: `contract ${index}`,
      related_report_refs: [],
      manager_status: {},
      executor_status: {},
      auditor_status: {},
    }),
  };
}

function seedLedger(tmp: string, indices: number[]): string {
  const role = path.join(tmp, "logs", "role_orchestration");
  fs.mkdirSync(role, { recursive: true });
  fs.writeFileSync(
    path.join(role, "rounds.jsonl"),
    indices.map((index) => JSON.stringify(ledgerRound(index))).join("\n") + "\n",
  );
  return role;
}

/** Replays a fixed reply sequence and records the prompts it received. */
class SequencedAgent implements AgentAdapter {
  readonly prompts: string[] = [];
  private readonly replies: string[];

  constructor(replies: string[]) {
    this.replies = [...replies];
  }

  async runEpisode(prompt: string): Promise<EpisodeResult> {
    this.prompts.push(String(prompt));
    const reply = this.replies.length ? this.replies.shift()! : DONE;
    return episodeResult({ status: "done", actions_log: reply });
  }
}

async function runResume(
  tmp: string,
  options: {
    resume: boolean;
    replies: string[];
    maxRounds?: number;
    pendingInstructions?: (() => string[]) | null;
  },
): Promise<[Record<string, unknown>, SequencedAgent]> {
  const agent = new SequencedAgent(options.replies);
  const report = await run({
    task: "finish the refactor",
    env: new LocalEnvironment(path.join(tmp, "tmp")),
    config: harnessConfig({
      max_total_episodes: options.maxRounds ?? 2,
      workspace_path: path.join(tmp, "workspace"),
      harness_dir: path.join(tmp, "harness"),
      log_dir: path.join(tmp, "logs"),
    }),
    agent,
    resume: options.resume,
    pendingInstructions: options.pendingInstructions ?? null,
  });
  return [report, agent];
}

function roundIndices(report: Record<string, unknown>): number[] {
  return (report["rounds"] as Record<string, unknown>[]).map((item) => item["round_index"] as number);
}

test("a resumed loop continues the round numbering", async () => {
  const tmp = tmpPath();
  seedLedger(tmp, [1, 2, 3]);

  const [report] = await runResume(tmp, { resume: true, replies: [DONE] });

  assert.deepEqual(roundIndices(report), [1, 2, 3, 4], "the loop must continue at 4, not restart at 1");
  assert.equal(report["rounds_run"], 4);
  // max_total_episodes is the *additional* budget after a resume.
  assert.equal(report["max_rounds"], 5);
  const roundsDir = path.join(tmp, "logs", "role_orchestration", "rounds");
  assert.ok(fs.statSync(path.join(roundsDir, "round_004")).isDirectory());
  assert.equal(fs.existsSync(path.join(roundsDir, "round_001")), false, "restored rounds must not re-run");
});

test("a resumed loop feeds the history to the manager", async () => {
  const tmp = tmpPath();
  seedLedger(tmp, [1, 2]);

  const [, agent] = await runResume(tmp, { resume: true, replies: [DONE] });

  assert.ok(agent.prompts.length, "the manager must be asked for the next plan");
  const prompt = agent.prompts[0]!;
  assert.ok(prompt.includes("state 2"), "the restored task state must reach the prompt");
  assert.ok(prompt.includes("contract 2"), "the restored contract must reach the prompt");
  assert.ok(prompt.includes("round 2 verified"), "the restored auditor report must reach the prompt");
});

test("a resumed loop accepts completion grounded in restored history", async () => {
  // The restored ledger's clean auditor report is the evidence that makes an
  // immediate `Next: done` acceptable; without it the manager is sent back for
  // repair. This proves the restored rounds are semantically live.
  const tmp = tmpPath();
  seedLedger(tmp, [1, 2]);

  const [report] = await runResume(tmp, { resume: true, replies: [DONE] });

  assert.equal(report["completion_satisfied"], true);
  assert.equal(report["status"], "complete");
});

test("a message sent before a stop reaches the very next round", async () => {
  // The operator typed this while round 2 was running, then stopped the run. It
  // was never handed to a gate, so only a round-start claim can deliver it to
  // round 3 instead of the round after that.
  const tmp = tmpPath();
  seedLedger(tmp, [1, 2]);
  const queued: string[][] = [["check the config file first"]];

  const [, agent] = await runResume(tmp, {
    resume: true,
    replies: [DONE],
    pendingInstructions: () => (queued.length ? queued.shift()! : []),
  });

  assert.ok(agent.prompts[0]!.includes("check the config file first"));
  assert.equal(
    fs.readFileSync(
      path.join(tmp, "logs", "role_orchestration", "rounds", "round_003", "human_instructions.txt"),
      "utf-8",
    ),
    "check the config file first",
  );
});

test("a resumed loop records the resume in its events", async () => {
  const tmp = tmpPath();
  seedLedger(tmp, [1, 2, 3]);

  await runResume(tmp, { resume: true, replies: [DONE] });

  const events = fs
    .readFileSync(path.join(tmp, "logs", "role_orchestration", "events.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const start = events.find((item) => item["event"] === "role_harness_start");
  const resumed = events.find((item) => item["event"] === "role_harness_resumed");
  assert.equal(start["resumed"], true);
  assert.equal(start["resumed_rounds"], 3);
  assert.equal(start["max_rounds"], 5);
  assert.equal(resumed["restored_rounds"], 3);
  assert.equal(resumed["resume_from_round"], 3);
  assert.equal(resumed["round_budget"], 5);
});

test("a resumed loop appends to the existing ledger", async () => {
  const tmp = tmpPath();
  const role = seedLedger(tmp, [1, 2]);

  await runResume(tmp, { resume: true, replies: [DONE] });

  const recorded = fs
    .readFileSync(path.join(role, "rounds.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    recorded.map((item) => item["round_index"]),
    [1, 2, 3],
  );
});

test("without resume an existing ledger is ignored", async () => {
  const tmp = tmpPath();
  seedLedger(tmp, [1, 2, 3]);

  const [report, agent] = await runResume(tmp, { resume: false, replies: [DONE] });

  assert.equal((report["rounds"] as Record<string, unknown>[])[0]!["round_index"], 1);
  assert.equal(report["max_rounds"], 2);
  assert.ok(!agent.prompts[0]!.includes("state 3"), "a plain start must not inherit history");
  // Without the restored clean audit there is no evidence for completion, so
  // the immediate `Next: done` is rejected and repaired instead.
  assert.equal(report["completion_satisfied"], false);
});

test("a resume with no ledger starts from round one", async () => {
  const tmp = tmpPath();

  const [report] = await runResume(tmp, { resume: true, replies: [DONE] });

  assert.equal((report["rounds"] as Record<string, unknown>[])[0]!["round_index"], 1);
  assert.equal(report["max_rounds"], 2);
});

test("a resumed loop still stops at its budget", async () => {
  const tmp = tmpPath();
  seedLedger(tmp, [1, 2, 3]);

  const [report] = await runResume(tmp, {
    resume: true,
    replies: [PLAN, EXECUTED, CLEAN_AUDIT, PLAN, EXECUTED, CLEAN_AUDIT, PLAN],
  });

  // 3 restored + 2 additional rounds, then the budget is exhausted.
  assert.deepEqual(roundIndices(report), [1, 2, 3, 4, 5]);
  assert.equal(report["max_rounds"], 5);
  assert.equal(report["completion_satisfied"], false);
});
