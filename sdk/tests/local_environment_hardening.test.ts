// Ported 1:1 from LongHorizon-Harness tests/test_local_environment_hardening.py.
//
// The Python test monkeypatches `asyncio.create_subprocess_shell`; here the
// same guarantee is asserted end-to-end against a real child process, which is
// the closest in-process equivalent (port plan convention 7).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalEnvironment, openTrajectoryFile, shlexQuote } from "../src/environment/local.js";
import type { ExecResult } from "../src/types.js";

function tmpPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-env-"));
}

test("trajectory writer rejects symlinked parent", () => {
  const root = tmpPath();
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const run = path.join(root, "run");
  fs.mkdirSync(run);
  fs.symlinkSync(outside, path.join(run, "rounds"), "dir");

  assert.throws(() => openTrajectoryFile(path.join(run, "rounds", "trajectory.jsonl")));

  assert.equal(fs.existsSync(path.join(outside, "trajectory.jsonl")), false);
});

test("trajectory writer rejects hardlink without truncating alias", (t) => {
  const root = tmpPath();
  const run = path.join(root, "run");
  fs.mkdirSync(run);
  const target = path.join(root, "outside-trajectory.jsonl");
  fs.writeFileSync(target, "private trajectory");
  try {
    fs.linkSync(target, path.join(run, "trajectory.jsonl"));
  } catch {
    t.skip("filesystem does not support hard links");
    return;
  }

  assert.throws(() => openTrajectoryFile(path.join(run, "trajectory.jsonl")));

  assert.equal(fs.readFileSync(target, "utf-8"), "private trajectory");
});

test("screenshot path is shell quoted", async () => {
  // A caller-controlled scratch directory must not become shell syntax in
  // the fallback screenshot command.
  const root = tmpPath();
  const unsafe = path.join(root, "scratch;touch pwned");
  fs.mkdirSync(unsafe);
  const env = new LocalEnvironment(unsafe);
  const captured: string[] = [];
  (env as unknown as { exec: (command: string, timeout?: number) => Promise<ExecResult | null> }).exec = async (
    command: string,
  ) => {
    captured.push(command);
    return null;
  };

  await env.screenshot();
  const command = captured[0];

  const expected = shlexQuote(path.join(unsafe, "_lh_harness_screenshot.png"));
  assert.ok(command.includes(expected));
  assert.ok(!command.includes(`-f ${path.join(unsafe, "_lh_harness_screenshot.png")}`));
});

test("embedded agent does not inherit web control token", async () => {
  const previous = process.env.LH_HARNESS_WEB_TOKEN;
  process.env.LH_HARNESS_WEB_TOKEN = "control-secret";
  try {
    const result = await new LocalEnvironment(tmpPath()).exec(
      'printf %s "${LH_HARNESS_WEB_TOKEN-unset}"; printf %s "${HOME:+ home-kept}"',
      30,
    );

    assert.equal(result.exit_code, 0);
    assert.ok(!result.stdout.includes("control-secret"));
    assert.ok(result.stdout.startsWith("unset"));
    // The rest of the parent environment is still inherited.
    assert.ok(result.stdout.includes("home-kept"));
  } finally {
    if (previous === undefined) delete process.env.LH_HARNESS_WEB_TOKEN;
    else process.env.LH_HARNESS_WEB_TOKEN = previous;
  }
});

test("exec captures stdout, stderr and the exit code", async () => {
  const env = new LocalEnvironment(tmpPath());
  const result = await env.exec("printf 'out\\n'; printf 'err\\n' >&2; exit 3", 30);

  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
  assert.equal(result.exit_code, 3);
  assert.equal(result.termination_reason, undefined);
  assert.ok(result.duration_ms >= 0);
});

test("a timeout kills the process group and is reported as termination_reason", async () => {
  const env = new LocalEnvironment(tmpPath());
  const result = await env.exec("printf 'partial\\n'; sleep 30", 1);

  assert.equal(result.exit_code, -1);
  assert.equal(result.termination_reason, "timeout");
  assert.equal(result.stdout, "partial\n");
  assert.equal(result.stderr, "Command timed out after 1s");
});

test("tee mirrors stdout into the live trajectory file while it streams", async () => {
  const root = tmpPath();
  const roundDir = path.join(root, "round_001");
  fs.mkdirSync(roundDir, { recursive: true });
  const teePath = path.join(roundDir, "executor_raw_trajectory.jsonl");
  const env = new LocalEnvironment(root);

  const line = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
  const result = await env.exec(`printf '%s\\n' ${shlexQuote(line)}`, 30, teePath);

  assert.equal(result.exit_code, 0);
  assert.equal(fs.readFileSync(teePath, "utf-8"), line + "\n");
  // The streaming artifact writer normalised the same line beside it.
  const normalized = fs.readFileSync(path.join(roundDir, "executor_trajectory.jsonl"), "utf-8");
  assert.ok(normalized.includes('"text"'));
  assert.ok(normalized.includes('"step_num": 1'));
});

test("stagingDir is the configured tmp dir", () => {
  const root = tmpPath();
  assert.equal(new LocalEnvironment(root).stagingDir, root);
});

test("upload and download copy through the filesystem", async () => {
  const root = tmpPath();
  const env = new LocalEnvironment(root);
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "payload");

  await env.upload(source, path.join(root, "nested", "remote.txt"));
  assert.equal(fs.readFileSync(path.join(root, "nested", "remote.txt"), "utf-8"), "payload");

  await env.download(path.join(root, "nested", "remote.txt"), path.join(root, "back", "local.txt"));
  assert.equal(fs.readFileSync(path.join(root, "back", "local.txt"), "utf-8"), "payload");
});
