// Ported from LongHorizon-Harness tests/test_cli_isolation.py (adapter half; spec 03 §3.5).
/**
 * The Python file of this name covers two things: run-directory isolation in
 * `cli.py` (Phase 3 — the CLI does not exist yet in this port) and the CLI
 * isolation the adapters actually implement, which is what spec 03 §3.5
 * enumerates and what this file pins down:
 *
 *   1. CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 (no CLAUDE.md auto-loading)
 *   2. CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 (no prompt-history writes)
 *   3. LH_HARNESS_WEB_TOKEN stripped from the child environment
 *   4. `add_dirs` hard-rejected, so the working set is exactly the workspace
 *   5. harness-owned run directories denied and announced in the prompt
 *   6. an isolated per-run prompt directory with uuid-suffixed prompt files
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  ADD_DIRS_REJECTION_MESSAGE,
  ClaudeCodeAdapter,
  buildQueryOptions,
} from "../src/adapters/claude_code.js";
import {
  CommandAgentAdapter,
  episodePromptLabel,
  hiddenPathsNotice,
  redactSecrets,
} from "../src/adapters/cli_agent.js";
import { LocalEnvironment } from "../src/environment/local.js";
import { EpisodeBudget } from "../src/types.js";

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-iso-")));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function bench(commandTemplate: string, hiddenPaths: string[] = []) {
  const root = tmpRoot();
  const workspace = path.join(root, "workspace");
  const promptDir = path.join(root, "prompts");
  fs.mkdirSync(workspace);
  const env = new LocalEnvironment(path.join(root, "tmp"));
  const adapter = new CommandAgentAdapter({
    command_template: commandTemplate,
    prompt_dir: promptDir,
    workspace_path: workspace,
    hidden_paths: hiddenPaths,
  });
  return { root, workspace, promptDir, env, adapter, budget: new EpisodeBudget(30) };
}

test("additional directories are hard-rejected with the verbatim message", () => {
  assert.throws(
    () => new ClaudeCodeAdapter({ role: "composer", addDirs: ["/etc"] }),
    (err: Error) => err.message === ADD_DIRS_REJECTION_MESSAGE,
  );
  assert.throws(
    () => buildQueryOptions({ addDirs: ["/etc"] }),
    (err: Error) => err.message === ADD_DIRS_REJECTION_MESSAGE,
  );
});

test("the add-dir environment overrides are rejected the same way", () => {
  for (const name of ["LH_HARNESS_CLAUDECODE_ADD_DIRS", "LH_HARNESS_MCP_ADD_DIRS"]) {
    assert.throws(
      () => buildQueryOptions({ env: { [name]: `/etc${path.delimiter}/opt` } }),
      (err: Error) => err.message === ADD_DIRS_REJECTION_MESSAGE,
      `${name} must be rejected`,
    );
  }
  // A blank value carries no directories and must not trip the guard.
  assert.doesNotThrow(() => buildQueryOptions({ env: { LH_HARNESS_MCP_ADD_DIRS: "" } }));
});

test("the episode never asks the SDK for directories beyond the workspace", () => {
  const plan = buildQueryOptions({ workspacePath: "/tmp/ws", role: "composer" });
  assert.ok(!("additionalDirectories" in plan.sdkOptions));
  assert.equal(plan.sdkOptions.cwd, "/tmp/ws");
});

test("auto memory and prompt history are disabled and the role is announced", () => {
  const plan = buildQueryOptions({ role: "evaluator", env: {} });
  assert.equal(plan.envAdditions.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(plan.envAdditions.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");
  assert.equal(plan.envAdditions.LH_HARNESS_CLAUDE_ROLE, "evaluator");
  // Evaluator-only hardening: no `.git/index.lock`, no pager blocking the episode.
  assert.equal(plan.envAdditions.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(plan.envAdditions.GIT_PAGER, "cat");
  assert.equal(plan.envAdditions.PAGER, "cat");
});

test("non-auditor roles do not get the git/pager hardening", () => {
  const plan = buildQueryOptions({ role: "composer", env: {} });
  assert.ok(!("GIT_OPTIONAL_LOCKS" in plan.envAdditions));
  assert.ok(!("GIT_PAGER" in plan.envAdditions));
  assert.ok(!("PAGER" in plan.envAdditions));
});

test("the session inherits nothing from any settings file or CLAUDE.md", () => {
  const plan = buildQueryOptions({ role: "prompt_tailor", env: {} });
  assert.deepEqual(plan.sdkOptions.settingSources, []);
  assert.deepEqual(plan.sdkOptions.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.equal(plan.sdkOptions.strictMcpConfig, true);
});

test("the supervisor bearer token never reaches the agent", async () => {
  const { adapter, env, budget } = bench("printenv LH_HARNESS_WEB_TOKEN || echo TOKEN_ABSENT");
  const previous = process.env.LH_HARNESS_WEB_TOKEN;
  process.env.LH_HARNESS_WEB_TOKEN = "super-secret-bearer";
  try {
    const result = await adapter.runEpisode("hello", env, budget);
    assert.ok(!result.actions_log.includes("super-secret-bearer"));
    assert.ok(result.actions_log.includes("TOKEN_ABSENT"));
  } finally {
    if (previous === undefined) delete process.env.LH_HARNESS_WEB_TOKEN;
    else process.env.LH_HARNESS_WEB_TOKEN = previous;
  }
});

test("every episode owns a distinct uuid-suffixed prompt file", async () => {
  const { adapter, env, budget, promptDir, root } = bench("cat {prompt_path}");
  const live = path.join(root, "rounds", "round_003", "cli_auditor_raw_trajectory.jsonl");
  const first = await adapter.runEpisode("first prompt", env, budget, live);
  const second = await adapter.runEpisode("second prompt", env, budget, live);

  const firstPath = String(first.metadata.prompt_path);
  const secondPath = String(second.metadata.prompt_path);
  assert.notEqual(firstPath, secondPath);
  for (const candidate of [firstPath, secondPath]) {
    assert.equal(path.dirname(candidate), promptDir);
    assert.match(path.basename(candidate), /^round_003_cli_auditor_[0-9a-f]{12}\.md$/);
    assert.ok(fs.existsSync(candidate));
  }
  assert.ok(first.actions_log.startsWith("first prompt"));
  assert.ok(second.actions_log.startsWith("second prompt"));
});

test("the prompt announces the harness-owned paths", async () => {
  const hidden = ["/var/lh-harness/runs/run-1", "/var/lh-harness/logs"];
  const { adapter, env, budget } = bench("cat {prompt_path}", hidden);
  const result = await adapter.runEpisode("do the task", env, budget);
  const written = fs.readFileSync(String(result.metadata.prompt_path), "utf-8");
  assert.equal(written, "do the task" + hiddenPathsNotice(hidden));
  assert.ok(written.includes("Harness-owned paths (off limits):"));
  assert.ok(written.includes("- /var/lh-harness/runs/run-1"));
  assert.ok(
    written.includes(
      "These hold this run's own logs, prompts, and harness state. Never read, list, " +
        "search, or modify them, and never treat their contents as task input or evidence.",
    ),
  );
});

test("no hidden paths means no notice at all", () => {
  assert.equal(hiddenPathsNotice([]), "");
});

test("harness-owned paths become Read/Edit deny rules on the command line", () => {
  const hidden = tmpRoot();
  const plan = buildQueryOptions({ role: "rubric", hiddenPaths: [hidden], env: {} });
  const anchored = hidden.replace(/^\/+/, "");
  assert.deepEqual(plan.pathDenyRules, [
    `Read(//${anchored})`,
    `Read(//${anchored}/**)`,
    `Edit(//${anchored})`,
    `Edit(//${anchored}/**)`,
  ]);
  for (const rule of plan.pathDenyRules) assert.ok(plan.commandTemplate.includes(rule));
  // The SDK forwards the list to the same `--disallowedTools` flag, so the
  // path deny rules apply for real, exactly as the Python argv did.
  assert.deepEqual(plan.sdkOptions.disallowedTools, ["Bash", "mcp__*", ...plan.pathDenyRules]);
});

test("the episode command is wrapped in a cd and the prompt arrives on stdin", async () => {
  const { adapter, env, budget, workspace } = bench("cat {prompt_path}");
  const result = await adapter.runEpisode("payload", env, budget);
  const command = String(result.metadata.command);
  assert.ok(command.startsWith(`cd ${workspace} && `));
  assert.ok(command.endsWith(`cat ${result.metadata.prompt_path}`));
  assert.equal(result.metadata.workspace, workspace);
});

test("credentials are redacted before the command reaches an artifact", () => {
  const raw =
    "ANTHROPIC_API_KEY=sk-ant-secret ANTHROPIC_AUTH_TOKEN='sk-ant-secret' claude --api-key sk-live";
  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes("sk-ant-secret"));
  assert.ok(!redacted.includes("sk-live"));
  assert.equal(
    redacted,
    "ANTHROPIC_API_KEY=***REDACTED*** ANTHROPIC_AUTH_TOKEN=***REDACTED*** claude --api-key ***REDACTED***",
  );
});

test("the prompt label is derived from the trajectory path, never trusted for uniqueness", () => {
  assert.equal(episodePromptLabel(null), "episode_agent");
  assert.equal(episodePromptLabel(""), "episode_agent");
  assert.equal(
    episodePromptLabel("/runs/r1/rounds/round_007/gui_executor_raw_trajectory.jsonl"),
    "round_007_gui_executor",
  );
  // A parent that is not `round_\d+` falls back to "episode".
  assert.equal(episodePromptLabel("/runs/r1/final/manager_raw_trajectory.jsonl"), "episode_manager");
  // Unsafe characters collapse to "_" and leading/trailing "._" is stripped.
  assert.equal(episodePromptLabel("/runs/round_1/a b:c.jsonl"), "round_1_a_b_c");
});

test("a non-zero exit becomes an error episode with the stderr tail", async () => {
  const { adapter, env, budget } = bench("echo out; echo boom 1>&2; exit 3");
  const result = await adapter.runEpisode("x", env, budget);
  assert.equal(result.status, "error");
  assert.equal(result.metadata.exit_code, 3);
  assert.equal(result.error, "boom\n");
  assert.equal(result.metadata.stderr_tail, "boom\n");
  assert.equal(result.metadata.trajectory_format, "jsonl");
  assert.equal(result.metadata.actions_log_chars, result.actions_log.length);
  // No parser was configured, so the log is never marked diagnostics-only.
  assert.equal(result.metadata.actions_log_diagnostics_only, false);
});

test("a blown budget is reported as a timeout, not an error", async () => {
  const { adapter, env } = bench("sleep 5");
  const result = await adapter.runEpisode("x", env, new EpisodeBudget(1));
  assert.equal(result.status, "timeout");
  assert.equal(result.metadata.termination_reason, "timeout");
  assert.equal(result.error, "Episode timed out after 1s.");
});
