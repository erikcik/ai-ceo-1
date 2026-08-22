// Ported 1:1 from LongHorizon-Harness tests/test_manager_hardening.py.
//
// The Python fakes are `run_episode` coroutines returning scripted
// `EpisodeResult`s; they are ported as classes implementing `AgentAdapter`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentAdapter } from "../src/adapters/base.js";
import { DashboardState } from "../src/dashboard/state.js";
import { LocalEnvironment } from "../src/environment/local.js";
import {
  createGateContext,
  humanGate,
  mergeEpisodeLogs,
  run,
  saveRoleResult,
  writeTerminalFailure,
} from "../src/manager.js";
import { EpisodeBudget, episodeResult, harnessConfig, type EpisodeResult, type HarnessConfig } from "../src/types.js";
import { safeRunLogs, safeRunRole } from "../src/utils/run_boundary.js";

/** `RuntimeError` so `exception_type` reads the way the Python test expects. */
class RuntimeError_ extends Error {}
Object.defineProperty(RuntimeError_, "name", { value: "RuntimeError" });

function tmpPath(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-manager-")));
}

function readText(target: string): string {
  return fs.readFileSync(target, "utf-8");
}

function config(tmp: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return harnessConfig({
    workspace_path: path.join(tmp, "workspace"),
    harness_dir: path.join(tmp, "harness"),
    log_dir: path.join(tmp, "logs"),
    ...overrides,
  });
}

/** Replays a fixed reply sequence; the Python fakes are `iter(...)` generators. */
class SequencedAgent implements AgentAdapter {
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly outputs: EpisodeResult[]) {}

  async runEpisode(prompt: string): Promise<EpisodeResult> {
    this.prompts.push(String(prompt));
    const value = this.outputs[this.index];
    if (value === undefined) throw new Error("SequencedAgent ran out of scripted episodes");
    this.index += 1;
    return value;
  }
}

// --- crash boundary ---------------------------------------------------------

test("terminal failure does not follow a role directory symlink", () => {
  const tmp = tmpPath();
  const logDir = path.join(tmp, "lh_harness");
  const outside = path.join(tmp, "outside-role");
  fs.mkdirSync(logDir);
  fs.mkdirSync(outside);
  const outsideReport = path.join(outside, "report.json");
  const outsideEvents = path.join(outside, "events.jsonl");
  fs.writeFileSync(outsideReport, "private report");
  fs.writeFileSync(outsideEvents, "private events");
  fs.symlinkSync(outside, path.join(logDir, "role_orchestration"), "dir");

  const result = writeTerminalFailure({ log_dir: logDir, max_total_episodes: 5 }, "task", {
    status: "failed",
    reason: "worker crashed",
    exc: new RuntimeError_("boom"),
    abortReason: "worker_exception",
  });

  assert.equal(result["status"], "failed");
  assert.equal(JSON.parse(readText(path.join(logDir, "report.json")))["status"], "failed");
  assert.equal(readText(outsideReport), "private report");
  assert.equal(readText(outsideEvents), "private events");
});

test("terminal failure does not follow a log directory symlink", () => {
  const tmp = tmpPath();
  const outside = path.join(tmp, "outside-logs");
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, "sentinel.txt");
  fs.writeFileSync(sentinel, "private");
  const logLink = path.join(tmp, "lh_harness");
  fs.symlinkSync(outside, logLink, "dir");

  const result = writeTerminalFailure({ log_dir: logLink, max_total_episodes: 5 }, "task", {
    status: "failed",
    reason: "worker crashed",
    exc: new RuntimeError_("boom"),
    abortReason: "worker_exception",
  });

  assert.equal(result["status"], "failed");
  assert.equal(readText(sentinel), "private");
  assert.equal(fs.existsSync(path.join(outside, "report.json")), false);
  assert.equal(fs.existsSync(path.join(outside, "role_orchestration")), false);
});

// --- episode / artifact layout ---------------------------------------------

test("a role result writes an OSWorld-style episode with the dashboard role names", () => {
  const tmp = tmpPath();
  const resultDir = path.join(tmp, "run-1");
  const logDir = path.join(resultDir, "lh_harness");
  const roundDir = path.join(logDir, "role_orchestration", "rounds", "round_001");
  fs.mkdirSync(roundDir, { recursive: true });
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: "finished" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  const result = episodeResult({
    status: "done",
    actions_log: raw,
    duration_ms: 123,
    metadata: { command: "codex exec --json", exit_code: 0 },
  });
  const screenshot = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("final")]);

  const artifacts = saveRoleResult(roundDir, "executor", result, {
    episodeRoot: path.join(logDir, "cli_executor_episodes"),
    finalScreenshot: screenshot,
  });
  mergeEpisodeLogs(logDir);

  const episode = path.join(logDir, "cli_executor_episodes", "ep001");
  assert.equal(readText(path.join(episode, "codex_stream.jsonl")), raw);
  assert.ok(readText(path.join(episode, "agent.log")).includes("assistant output:\nfinished"));
  const chat = readText(path.join(episode, "chat.jsonl"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.equal(chat[0]["type"], "session");
  assert.equal(chat[chat.length - 1]["message"]["content"][0]["text"], "finished");
  assert.ok(fs.readFileSync(path.join(episode, "final_screenshot.png")).equals(screenshot));
  assert.equal(readText(path.join(roundDir, "executor_raw_trajectory.jsonl")), raw);
  assert.ok(fs.statSync(path.join(roundDir, "executor_metadata.json")).isFile());
  assert.equal(fs.existsSync(path.join(roundDir, "task_raw_trajectory.txt")), false);
  assert.equal(fs.existsSync(path.join(roundDir, "task_metadata.json")), false);
  assert.equal(artifacts["screenshot_count"], 1);
  const manifest = JSON.parse(readText(path.join(roundDir, "executor_screenshots.json")));
  assert.equal(manifest["screenshots"][0]["kind"], "final_environment_screenshot");
  assert.ok(readText(path.join(resultDir, "agent.log")).includes("cli_executor_episodes/ep001"));
  assert.ok(readText(path.join(resultDir, "chat.jsonl")).includes("finished"));
  const listed = new DashboardState(logDir).listRoundArtifacts(1);
  assert.ok(listed.includes("executor_raw_trajectory.jsonl"));
  assert.ok(listed.includes("executor_metadata.json"));
});

test("a short-lived CUA result layout remains readable", () => {
  const tmp = tmpPath();
  const runsRoot = path.join(tmp, "runs");
  const runDir = path.join(runsRoot, "old-cua-run");
  const roleDir = path.join(runDir, "cua_harness", "role_orchestration");
  fs.mkdirSync(path.join(roleDir, "rounds"), { recursive: true });

  assert.equal(safeRunLogs(runsRoot, runDir, { allowMissing: false }), path.join(runDir, "cua_harness"));
  assert.equal(safeRunRole(runsRoot, runDir, { allowMissing: false }), roleDir);
});

// --- human gate -------------------------------------------------------------

test("dashboard instructions are kept for the manager and the final reply", async () => {
  const tmp = tmpPath();
  const humanHook = async () => ({
    action: "continue",
    instructions: "The final reply must contain OPERATOR_MARKER.",
  });

  const ctx = createGateContext({
    config: harnessConfig({ max_total_episodes: 2 }),
    task: "original task",
    rounds: [],
    humanHook,
    logDir: tmp,
    eventsPath: path.join(tmp, "events.jsonl"),
    roundBudget: 2,
  });

  const shouldStop = await humanGate(ctx, "progress", 1, "verified state");

  assert.equal(shouldStop, false);
  assert.equal(ctx.carryoverInstructions, "The final reply must contain OPERATOR_MARKER.");
  assert.deepEqual(ctx.operatorInstructions, ["The final reply must contain OPERATOR_MARKER."]);
});

test("reopening a run withdraws the round reply the dashboard reads", async () => {
  const tmp = tmpPath();
  const humanHook = async () => ({ action: "continue" });

  const roleDir = path.join(tmp, "role_orchestration");
  const roundDir = path.join(roleDir, "rounds", "round_002");
  fs.mkdirSync(roundDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "final_response.txt"), "withdrawn answer");
  fs.writeFileSync(path.join(roundDir, "final_response.txt"), "withdrawn answer");
  fs.writeFileSync(path.join(roundDir, "manager_plan.txt"), "plan kept for auditing");

  const ctx = createGateContext({
    config: harnessConfig({ max_total_episodes: 4 }),
    task: "original task",
    rounds: [],
    humanHook,
    logDir: tmp,
    eventsPath: path.join(tmp, "events.jsonl"),
    roundBudget: 4,
    roleDir,
    finalResponse: "withdrawn answer",
    responseRound: 2,
  });

  assert.equal(await humanGate(ctx, "progress", 2, "verified state"), false);

  assert.equal(ctx.finalResponse, "");
  // Both published copies go, so the round stops advertising a reply it no
  // longer stands behind.
  assert.equal(fs.existsSync(path.join(roleDir, "final_response.txt")), false);
  assert.equal(fs.existsSync(path.join(roundDir, "final_response.txt")), false);
  assert.ok(fs.existsSync(path.join(roundDir, "manager_plan.txt")));
  assert.equal(new DashboardState(tmp).snapshot()["final_response"], "");
});

// --- provider failures ------------------------------------------------------

test("a provider failure stops without a round-limit approval", async () => {
  const tmp = tmpPath();
  const message = "The 'bad-model' model is not supported when using Codex with a ChatGPT account.";

  class FailingAgent implements AgentAdapter {
    async runEpisode(): Promise<EpisodeResult> {
      return episodeResult({
        status: "error",
        actions_log: JSON.stringify({ type: "turn.failed", error: { message } }),
        metadata: {
          runtime_signals: [{ signal: "AGENT_TURN_FAILED", evidence: `AGENT_TURN_FAILED: ${message}` }],
        },
      });
    }
  }

  const approvals: Record<string, unknown>[] = [];
  const humanHook = async (context: Record<string, unknown>) => {
    approvals.push(context);
    return { action: "continue" };
  };

  const result = await run({
    task: "test invalid provider model",
    env: new LocalEnvironment(path.join(tmp, "tmp")),
    config: config(tmp, { max_total_episodes: 30, manager_budget: new EpisodeBudget(10) }),
    agent: new FailingAgent(),
    humanHook,
  });

  assert.deepEqual(approvals, []);
  assert.equal(result["status"], "failed");
  assert.equal(result["rounds_run"], 1);
  assert.equal(result["abort_reason"], "provider_model_unavailable");
  assert.ok(String(result["failure_reason"]).includes(message));
  const rounds = result["rounds"] as Record<string, any>[];
  assert.equal(rounds[0]!["manager_status"]["error"], `Model unavailable: ${message}`);
  const events = readText(path.join(tmp, "logs", "role_orchestration", "events.jsonl"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const failure = events.find((event) => event["event"] === "agent_runtime_failed");
  assert.ok(failure);
  assert.equal(failure["status"], "failed");
  assert.equal(failure["episode_status"]["status"], "error");
  assert.equal(failure["episode_status"]["error"], `Model unavailable: ${message}`);
});

// --- timeouts ---------------------------------------------------------------

test("an episode timeout is preserved and recovers in the next round", async () => {
  const tmp = tmpPath();
  const agent = new SequencedAgent([
    episodeResult({ status: "timeout", error: "Episode timed out after 10s." }),
    episodeResult({
      status: "done",
      actions_log: "Next: blocked\n\nReason:\nNeed operator input after recovery check.",
    }),
    episodeResult({ status: "done", actions_log: "The run stopped after preserving its state." }),
  ]);

  const result = await run({
    task: "recover after a local episode timeout",
    env: new LocalEnvironment(path.join(tmp, "tmp")),
    config: config(tmp, { max_total_episodes: 2, manager_budget: new EpisodeBudget(10) }),
    agent,
  });

  assert.equal(result["status"], "blocked");
  assert.equal(result["rounds_run"], 2);
  assert.equal(result["failure_reason"], "");
  const rounds = result["rounds"] as Record<string, any>[];
  assert.equal(rounds[0]!["manager_status"]["status"], "timeout");
  assert.equal(rounds[0]!["harness_feedback"], "Agent execution timed out: Episode timed out after 10s.");
});

test("an executor timeout preserves the partial output for recovery", async () => {
  const tmp = tmpPath();
  const agent = new SequencedAgent([
    episodeResult({ status: "done", actions_log: "Next: cli\n\nCurrent Task State:\nwork pending" }),
    episodeResult({
      status: "timeout",
      actions_log: "executor changed part of the workspace",
      error: "Episode timed out after 10s.",
    }),
    episodeResult({ status: "done", actions_log: "Next: blocked\n\nReason:\nrecovery checked" }),
    episodeResult({ status: "done", actions_log: "Partial work was preserved." }),
  ]);

  const result = await run({
    task: "recover an executor timeout",
    env: new LocalEnvironment(path.join(tmp, "tmp")),
    config: config(tmp, { max_total_episodes: 2 }),
    agent,
  });

  const rounds = result["rounds"] as Record<string, any>[];
  assert.equal(result["rounds_run"], 2);
  assert.equal(rounds[0]!["executor_status"]["status"], "timeout");
  assert.equal(rounds[0]!["executor_output"], "executor changed part of the workspace");
});

test("an auditor timeout keeps the executor result and recovers", async () => {
  const tmp = tmpPath();
  const agent = new SequencedAgent([
    episodeResult({ status: "done", actions_log: "Next: cli\n\nCurrent Task State:\nwork pending" }),
    episodeResult({ status: "done", actions_log: "executor completed the requested change" }),
    episodeResult({ status: "timeout", error: "Episode timed out after 10s." }),
    episodeResult({ status: "done", actions_log: "Next: blocked\n\nReason:\nrecovery checked" }),
    episodeResult({ status: "done", actions_log: "The executor result was preserved." }),
  ]);

  const result = await run({
    task: "recover an auditor timeout",
    env: new LocalEnvironment(path.join(tmp, "tmp")),
    config: config(tmp, { max_total_episodes: 2 }),
    agent,
  });

  const rounds = result["rounds"] as Record<string, any>[];
  assert.equal(result["rounds_run"], 2);
  assert.equal(rounds[0]!["auditor_status"]["status"], "timeout");
  assert.equal(rounds[0]!["executor_output"], "executor completed the requested change");
});

// --- late crash -------------------------------------------------------------

test("a late crash report preserves the completed rounds", async () => {
  const tmp = tmpPath();
  const outputs = [
    "Next: cli\n\nCurrent Task State:\nwork pending",
    "executor finished the requested work",
    "Status: complete\nIntegrity: clean\nContract audit: aligned",
    "Next: done\n\nCurrent Task State:\nwork finished",
    "The requested work is complete.",
  ];
  let index = 0;

  class OutputAgent implements AgentAdapter {
    async runEpisode(): Promise<EpisodeResult> {
      const value = outputs[index];
      if (value === undefined) throw new Error("out of scripted episodes");
      index += 1;
      return episodeResult({ status: "done", actions_log: value });
    }
  }

  const crashingHumanHook = async (context: Record<string, unknown>) => {
    if (context["outcome"] === "completed") throw new RuntimeError_("dashboard gate crashed after completion");
    return { action: "continue" };
  };

  const logDir = path.join(tmp, "logs");
  const result = await run({
    task: "finish two managed rounds",
    env: new LocalEnvironment(path.join(tmp, "tmp")),
    config: config(tmp, { max_total_episodes: 2, manager_budget: new EpisodeBudget(10) }),
    agent: new OutputAgent(),
    humanHook: crashingHumanHook,
  });

  assert.equal(result["status"], "failed");
  assert.equal(result["abort_reason"], "worker_exception");
  assert.equal(result["exception_type"], "RuntimeError");
  assert.equal(result["rounds_run"], 2);
  assert.deepEqual((result["rounds"] as Record<string, any>[]).map((item) => item["round_index"]), [1, 2]);
  assert.equal(result["completion_satisfied"], true);
  assert.ok(String(result["current_task_state"]).endsWith("work finished"));
  assert.ok(String(result["latest_auditor_report"]).startsWith("Status: complete"));
  assert.equal(result["final_response"], "The requested work is complete.");
  assert.ok((result["elapsed_seconds"] as number) >= 0);

  const persisted = JSON.parse(readText(path.join(logDir, "report.json")));
  assert.deepEqual(persisted, result);
});
