// Ported 1:1 from LongHorizon-Harness tests/test_trajectory_artifacts.py.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StreamingTrajectoryArtifactWriter,
  persistTrajectoryArtifacts,
} from "../src/trajectory_artifacts.js";

function tmpPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lh-trajectory-"));
}

function codexImageTrajectory(payloads: Buffer[]): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      id: "shot-1",
      type: "mcp_tool_call",
      result: {
        content: payloads.map((payload) => ({
          type: "image",
          data: payload.toString("base64"),
          mimeType: "image/png",
        })),
      },
    },
  });
}

test("embedded screenshots become files and file references", () => {
  const root = tmpPath();
  const roundDir = path.join(root, "run", "round_001");
  const payloads = [Buffer.from("\x89PNG\r\nfirst", "binary"), Buffer.from("\x89PNG\r\nsecond", "binary")];

  const summary = persistTrajectoryArtifacts(codexImageTrajectory(payloads), {
    roundDir,
    roleName: "executor",
  });

  assert.equal(summary.screenshot_count, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(roundDir, "executor_screenshots.json"), "utf-8"));
  const names = manifest.screenshots.map((item: Record<string, unknown>) => item["screenshot_file"]);
  assert.deepEqual(names, ["executor_step_0002_01.png", "executor_step_0002_02.png"]);
  names.forEach((name: string, index: number) => {
    assert.deepEqual(fs.readFileSync(path.join(roundDir, name)), payloads[index]);
  });

  assert.equal(fs.existsSync(path.join(root, "workspace")), false);

  const normalized = fs.readFileSync(path.join(roundDir, "executor_trajectory.jsonl"), "utf-8");
  const records = normalized
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  assert.equal(records[records.length - 1]["screenshot_file"], names[0]);
  assert.deepEqual(records[records.length - 1]["screenshot_files"], names);
  assert.ok(!normalized.includes("data:image"));
  assert.ok(!normalized.includes(payloads[0].toString("base64")));
});

test("invalid inline image is not written", () => {
  const root = tmpPath();
  const raw = JSON.stringify({
    type: "item.completed",
    item: {
      id: "shot-1",
      type: "mcp_tool_call",
      result: { content: [{ type: "image", data: "not-base64", mimeType: "image/png" }] },
    },
  });

  const summary = persistTrajectoryArtifacts(raw, { roundDir: root, roleName: "executor" });

  assert.equal(summary.screenshot_count, 0);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.endsWith(".png")),
    [],
  );
});

test("streaming writer persists screenshot before role finishes", () => {
  const root = tmpPath();
  const roundDir = path.join(root, "round_001");
  const livePath = path.join(roundDir, "executor_raw_trajectory.jsonl");

  const writer = StreamingTrajectoryArtifactWriter.fromLivePath(livePath);
  assert.notEqual(writer, null);
  writer!.consumeLine(codexImageTrajectory([Buffer.from("\x89PNG\r\nlive", "binary")]));

  const screenshot = path.join(roundDir, "executor_step_0002_01.png");
  assert.deepEqual(fs.readFileSync(screenshot), Buffer.from("\x89PNG\r\nlive", "binary"));
  const manifest = JSON.parse(fs.readFileSync(path.join(roundDir, "executor_screenshots.json"), "utf-8"));
  assert.equal(manifest.live, true);
  assert.equal(manifest.screenshot_count, 1);
  const normalized = fs.readFileSync(path.join(roundDir, "executor_trajectory.jsonl"), "utf-8");
  assert.ok(normalized.includes("executor_step_0002_01.png"));
  assert.ok(!normalized.includes("data:image"));
});

test("streaming writer pairs codex tool start and completion once", () => {
  const root = tmpPath();
  const roundDir = path.join(root, "round_001");
  const livePath = path.join(roundDir, "executor_raw_trajectory.jsonl");
  const writer = StreamingTrajectoryArtifactWriter.fromLivePath(livePath);
  assert.notEqual(writer, null);
  const started = {
    type: "item.started",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "/bin/zsh -lc pwd",
      status: "in_progress",
    },
  };
  const completed = {
    type: "item.completed",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "/bin/zsh -lc pwd",
      status: "completed",
      exit_code: 0,
      aggregated_output: "/tmp/workspace\n",
    },
  };

  writer!.consumeLine(JSON.stringify(started));
  writer!.consumeLine(JSON.stringify(completed));

  const records = fs
    .readFileSync(path.join(roundDir, "executor_trajectory.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record["kind"]),
    ["tool_use", "tool_result"],
  );
  assert.equal(records[0]["id"], "command-1");
  assert.equal(records[1]["tool_use_id"], "command-1");
  assert.equal(records[1]["status"], "completed");
});

// --- extra coverage: the Claude stream-json shape the SDK adapter writes ---

test("claude tool_result screenshots are materialised the same way", () => {
  const root = tmpPath();
  const roundDir = path.join(root, "round_002");
  const payload = Buffer.from("\x89PNG\r\nclaude", "binary");
  const raw =
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: payload.toString("base64") } },
            ],
          },
        ],
      },
    }) + "\n";

  const summary = persistTrajectoryArtifacts(raw, { roundDir, roleName: "gui_executor" });

  assert.equal(summary.screenshot_count, 1);
  assert.equal(summary.total_screenshot_bytes, payload.length);
  assert.equal(summary.screenshots[0]["screenshot_file"], "gui_executor_step_0001_01.png");
  assert.deepEqual(fs.readFileSync(path.join(roundDir, "gui_executor_step_0001_01.png")), payload);
});

test("an invalid role name is rejected", () => {
  const root = tmpPath();
  assert.throws(() => persistTrajectoryArtifacts("", { roundDir: root, roleName: "Executor" }), /invalid trajectory role/);
  assert.equal(StreamingTrajectoryArtifactWriter.fromLivePath(path.join(root, "round_001", "X_raw_trajectory.jsonl")), null);
});

test("fromLivePath rejects a non-round parent and a wrong suffix", () => {
  const root = tmpPath();
  assert.equal(StreamingTrajectoryArtifactWriter.fromLivePath(path.join(root, "notaround", "executor_raw_trajectory.jsonl")), null);
  assert.equal(StreamingTrajectoryArtifactWriter.fromLivePath(path.join(root, "round_001", "executor_trajectory.jsonl")), null);
  assert.equal(StreamingTrajectoryArtifactWriter.fromLivePath(path.join(root, "round_001", "executor_raw_trajectory.txt")), null);
});

test("a re-run removes the previous role step images", () => {
  const root = tmpPath();
  const roundDir = path.join(root, "round_001");
  fs.mkdirSync(roundDir, { recursive: true });
  fs.writeFileSync(path.join(roundDir, "executor_step_0001_01.png"), "stale");
  fs.writeFileSync(path.join(roundDir, "auditor_step_0001_01.png"), "keep");

  persistTrajectoryArtifacts("", { roundDir, roleName: "executor" });

  assert.equal(fs.existsSync(path.join(roundDir, "executor_step_0001_01.png")), false);
  assert.equal(fs.existsSync(path.join(roundDir, "auditor_step_0001_01.png")), true);
});
