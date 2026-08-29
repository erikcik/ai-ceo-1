// Ported from LongHorizon-Harness adapters/claude_code.py (spec 03 §3, §1.5 layers C/D).
/**
 * Option building only — nothing here reaches the API. `buildQueryOptions()` is
 * the pure half of the adapter, and the episode wrapper (guard snapshots,
 * metadata envelope, Layer-D escalation) is exercised through a subclass whose
 * `runQueryEpisode` returns a canned result instead of calling `query()`.
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
  type ClaudeCodeAdapterOptions,
} from "../src/adapters/claude_code.js";
import { redactSecrets } from "../src/adapters/cli_agent.js";
import { GUARD_REJECTION_MESSAGE } from "../src/provider_errors.js";
import type { Environment } from "../src/environment/base.js";
import { EpisodeBudget, type EpisodeResult, type EpisodeStatus } from "../src/types.js";

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-")));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

/** Constructor defaults that keep every case off the real process environment. */
function plan(options: ClaudeCodeAdapterOptions = {}) {
  return buildQueryOptions({ workspacePath: "/tmp/ws", promptDir: "/tmp/prompts", env: {}, ...options });
}

// --- constructor ------------------------------------------------------------

test("additional directories are rejected with the exact ValueError text", () => {
  assert.throws(
    () => new ClaudeCodeAdapter({ addDirs: ["/etc"], env: {} }),
    (err: Error) =>
      err.message ===
      "Claude Code role isolation does not allow additional directories; " +
        "put task files inside the run workspace instead.",
  );
  assert.equal(
    ADD_DIRS_REJECTION_MESSAGE,
    "Claude Code role isolation does not allow additional directories; " +
      "put task files inside the run workspace instead.",
  );
});

test("the constructor surfaces the plan on the adapter", () => {
  const adapter = new ClaudeCodeAdapter({
    role: "evaluator",
    model: "claude-opus-5",
    workspacePath: "/tmp/ws/",
    promptDir: "/tmp/prompts/",
    reasoningEffort: "high",
    guardExcludePaths: ["/tmp/ws/build"],
    env: {},
  });
  assert.equal(adapter.role, "evaluator");
  assert.equal(adapter.policy.permission_mode, "bypassPermissions");
  assert.equal(adapter.reasoningEffort, "high");
  assert.equal(adapter.computerMcpConfigured, false);
  assert.deepEqual([...adapter.guardExcludePaths], ["/tmp/ws/build"]);
  // Trailing slashes are stripped, exactly as the base class does.
  assert.equal(adapter.workspacePath, "/tmp/ws");
  assert.equal(adapter.promptDir, "/tmp/prompts");
  assert.equal(adapter.commandTemplate, adapter.plan.commandTemplate);
});

test("an unknown role never builds a plan", () => {
  assert.throws(
    () => buildQueryOptions({ role: "reviewer" as never, env: {} }),
    /Unknown Claude Code role: reviewer/,
  );
});

// --- role policy ------------------------------------------------------------

test("every role maps to its documented SDK deny-list", () => {
  const noSideEffects = [
    "Bash",
    "Write",
    "Edit",
    "NotebookEdit",
    "Task",
    "mcp__*",
    "WebSearch",
    "WebFetch",
  ];
  const expected: Record<string, string[]> = {
    prompt_tailor: noSideEffects,
    final_response: noSideEffects,
    planner: [],
    rubric: ["Bash", "mcp__*"],
    composer: [],
    evaluator: [],
  };
  for (const [role, tools] of Object.entries(expected)) {
    const built = plan({ role: role as never });
    assert.deepEqual(built.sdkOptions.disallowedTools, tools, role);
    // The metadata keeps the CLI's own name for the subagent tool.
    assert.ok(!built.policyDisallowedTools.includes("Task"), role);
    if (tools.includes("Task")) {
      assert.ok(built.policyDisallowedTools.includes("Agent"), role);
    }
  }
});

test("the SDK options carry the isolation settings for every role", () => {
  const built = plan({ role: "composer", model: "claude-opus-5" });
  assert.deepEqual(built.sdkOptions, {
    model: "claude-opus-5",
    cwd: "/tmp/ws",
    settingSources: [],
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [],
    strictMcpConfig: true,
  });
});

// --- environment prefix -----------------------------------------------------

test("an api key populates both Anthropic credential variables", () => {
  const built = plan({ apiKey: "sk-ant-test", role: "prompt_tailor" });
  assert.equal(built.envAdditions.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(built.envAdditions.ANTHROPIC_AUTH_TOKEN, "sk-ant-test");
  // The template still carries the value; `redactSecrets` masks it on the way
  // into `metadata.command`, which is the only copy that reaches an artifact.
  assert.ok(built.commandTemplate.includes("ANTHROPIC_API_KEY=sk-ant-test"));
  assert.equal(
    redactSecrets(built.commandTemplate).includes("sk-ant-test"),
    false,
  );
});

test("the base url loses a trailing slash and then a trailing /v1", () => {
  for (const [given, expected] of [
    ["https://api.example.com/v1", "https://api.example.com"],
    ["https://api.example.com/v1/", "https://api.example.com"],
    ["https://api.example.com/", "https://api.example.com"],
    ["https://api.example.com", "https://api.example.com"],
    ["https://api.example.com/gateway/v1//", "https://api.example.com/gateway"],
  ] as const) {
    assert.equal(plan({ baseUrl: given }).envAdditions.ANTHROPIC_BASE_URL, expected, given);
  }
});

test("the env prefix keeps Python's order", () => {
  const built = plan({ apiKey: "k", baseUrl: "https://api.example.com/v1", role: "evaluator" });
  assert.deepEqual(Object.keys(built.envAdditions), [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
    "LH_HARNESS_CLAUDE_ROLE",
    "GIT_OPTIONAL_LOCKS",
    "GIT_PAGER",
    "PAGER",
  ]);
});

// --- provider routing -------------------------------------------------------

test("a <provider>:<model> id routes through providers.json and strips Anthropic creds", () => {
  const built = plan({
    model: "orca:obsidian/Qwen3.8-27B",
    apiKey: "sk-ant-operator",
    baseUrl: "https://api.anthropic.com",
    env: { ORCA_API_KEY: "orca-key" },
  });
  assert.equal(built.provider, "orca");
  assert.equal(built.model, "obsidian/Qwen3.8-27B");
  assert.equal(built.sdkOptions.model, "obsidian/Qwen3.8-27B");
  assert.equal(built.providerEnv?.ANTHROPIC_BASE_URL, "https://www.orcarouter.ai");
  assert.equal(built.providerEnv?.ANTHROPIC_AUTH_TOKEN, "orca-key");
  assert.equal(built.providerEnv?.ANTHROPIC_API_KEY, undefined);
  assert.equal(built.providerEnv?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  // The operator's own key must not be layered back on through the env prefix.
  assert.ok(!("ANTHROPIC_API_KEY" in built.envAdditions));
  assert.ok(!("ANTHROPIC_BASE_URL" in built.envAdditions));
  // An OpenAI-wire provider needs the local shim in front of it.
  assert.equal(built.shim?.wire, "openai");
  assert.equal(built.shim?.upstreamBase, "https://www.orcarouter.ai");
});

test("a provider without its key fails before the episode starts", () => {
  assert.throws(
    () => plan({ model: "orca:obsidian/Qwen3.8-27B", env: {} }),
    /provider 'orca' requires ORCA_API_KEY to be set/,
  );
});

test("a plain model id is passed through untouched", () => {
  const built = plan({ model: "claude-opus-5" });
  assert.equal(built.model, "claude-opus-5");
  assert.equal(built.provider, undefined);
  assert.equal(built.providerEnv, undefined);
  assert.equal(built.shim, undefined);
});

// --- reasoning effort -------------------------------------------------------

test("a known effort reaches the SDK and the recorded command line", () => {
  const built = plan({ reasoningEffort: "max" });
  assert.equal(built.reasoningEffort, "max");
  assert.equal(built.sdkOptions.effort, "max");
  assert.ok(built.commandTemplate.includes("--effort max"));
});

test("an effort the SDK does not know is dropped silently but stays on record", () => {
  const built = plan({ reasoningEffort: "ultra" });
  assert.equal(built.reasoningEffort, "ultra");
  assert.equal(built.sdkOptions.effort, undefined);
  // Claude Code warns and continues at its default, so the run is not failed.
  assert.ok(built.commandTemplate.includes("--effort ultra"));
});

test("a blank effort follows the provider default", () => {
  const built = plan({ reasoningEffort: "   " });
  assert.equal(built.reasoningEffort, "");
  assert.equal(built.sdkOptions.effort, undefined);
  assert.ok(!built.commandTemplate.includes("--effort"));
});

test("a malformed effort is rejected by the shared validator", () => {
  assert.throws(() => plan({ reasoningEffort: "much effort!" }), /reasoning effort may only contain/);
});

// --- mcp config -------------------------------------------------------------

test("the computer MCP config is loaded only for roles that may have it", () => {
  const root = tmpRoot();
  const config = path.join(root, "mcp.json");
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { computer: { command: "noop" } } }));

  const executor = plan({ role: "composer", mcpConfig: config });
  assert.equal(executor.computerMcpConfigured, true);
  assert.equal(executor.mcpConfigPath, config);
  assert.ok(executor.commandTemplate.includes(`--mcp-config ${config}`));

  const tailor = plan({ role: "prompt_tailor", mcpConfig: config });
  assert.equal(tailor.computerMcpConfigured, false);
  assert.equal(tailor.mcpConfigPath, null);
  assert.ok(!tailor.commandTemplate.includes("--mcp-config"));
});

test("LH_HARNESS_CLAUDECODE_MCP_CONFIG is the fallback source", () => {
  const root = tmpRoot();
  const config = path.join(root, "mcp.json");
  fs.writeFileSync(config, "{}");
  const built = plan({ role: "evaluator", env: { LH_HARNESS_CLAUDECODE_MCP_CONFIG: config } });
  assert.equal(built.computerMcpConfigured, true);
  assert.equal(built.mcpConfigPath, config);
});

// --- command line -----------------------------------------------------------

test("the recorded command line mirrors the Python argv exactly", () => {
  const built = plan({ role: "prompt_tailor", model: "claude-opus-5" });
  assert.equal(
    built.commandTemplate,
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 " +
      "LH_HARNESS_CLAUDE_ROLE=prompt_tailor claude --print --output-format stream-json --verbose " +
      "--dangerously-skip-permissions --disallowedTools Bash Write Edit NotebookEdit Agent 'mcp__*' " +
      "WebSearch WebFetch --model claude-opus-5 < {prompt_path}",
  );
});

// --- episode wrapper: layers C and D ---------------------------------------

class FakeClaudeCodeAdapter extends ClaudeCodeAdapter {
  constructor(
    options: ClaudeCodeAdapterOptions,
    private readonly episode: { status: EpisodeStatus; error?: string | null },
    private readonly duringEpisode: () => void = () => {},
  ) {
    super(options);
  }

  protected override async runQueryEpisode(): Promise<EpisodeResult> {
    this.duringEpisode();
    return {
      status: this.episode.status,
      actions_log: "",
      error: this.episode.error ?? null,
      duration_ms: 1,
      metadata: { exit_code: this.episode.status === "done" ? 0 : 1 },
    };
  }
}

const NOOP_ENV: Environment = {
  async exec() {
    return { stdout: "", stderr: "", exit_code: 0, duration_ms: 0 };
  },
  async screenshot() {
    return Buffer.alloc(0);
  },
  async upload() {},
  async download() {},
};

function auditorBench(during: () => void, status: EpisodeStatus = "done", error: string | null = null) {
  const root = tmpRoot();
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "keep.txt"), "content");
  const adapter = new FakeClaudeCodeAdapter(
    {
      role: "evaluator",
      workspacePath: workspace,
      promptDir: path.join(root, "prompts"),
      guardExcludePaths: [path.join(workspace, "build")],
      env: {},
    },
    { status, error },
    during,
  );
  return { adapter, workspace };
}

test("the claude metadata block is attached to every episode", async () => {
  const { adapter } = auditorBench(() => {});
  const result = await adapter.runEpisode("prompt", NOOP_ENV, new EpisodeBudget(30));
  assert.equal(result.metadata.claude_role, "evaluator");
  assert.equal(result.metadata.claude_permission_mode, "bypassPermissions");
  assert.equal(result.metadata.claude_dangerously_skip_permissions, true);
  assert.equal(result.metadata.claude_hooks_enabled, false);
  assert.equal(result.metadata.claude_native_sandbox_enabled, false);
  assert.equal(result.metadata.claude_tool_policy, "default-minus-disallowed");
  assert.deepEqual(result.metadata.claude_disallowed_tools, []);
  assert.equal(result.metadata.claude_computer_mcp_loaded, false);
  assert.equal(result.metadata.claude_workspace_read_only, true);
  assert.equal(result.metadata.claude_reasoning_effort, "");
});

test("an untouched auditor workspace reports the guard with no mutation", async () => {
  const { adapter, workspace } = auditorBench(() => {});
  const result = await adapter.runEpisode("prompt", NOOP_ENV, new EpisodeBudget(30));
  assert.equal(result.status, "done");
  assert.equal(result.metadata.verifier_workspace_guard, true);
  assert.equal(result.metadata.verifier_workspace_restored, false);
  assert.equal(result.metadata.verifier_workspace_mutation_detected, false);
  assert.deepEqual(result.metadata.verifier_guard_exclude_paths, [path.join(workspace, "build")]);
  assert.equal(result.error, null);
});

test("an auditor write is recorded as a mutation without changing the status", async () => {
  const { adapter, workspace } = auditorBench(() => {
    fs.writeFileSync(path.join(workspace, "sneaky.txt"), "written by the auditor");
  });
  const result = await adapter.runEpisode("prompt", NOOP_ENV, new EpisodeBudget(30));
  assert.equal(result.status, "done");
  assert.equal(result.metadata.verifier_workspace_mutation_detected, true);
  assert.deepEqual(
    (result.metadata.verifier_workspace_mutations as { added: string[] }).added,
    ["sneaky.txt"],
  );
  assert.equal(result.error, null);
});

test("a guard that could not inspect every path fails the audit closed", async () => {
  const { adapter, workspace } = auditorBench(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const result = await adapter.runEpisode("prompt", NOOP_ENV, new EpisodeBudget(30));
  assert.ok((result.metadata.verifier_workspace_snapshot_errors as string[]).length > 0);
  assert.equal(result.status, "error");
  assert.equal(result.error, GUARD_REJECTION_MESSAGE);
  assert.equal(
    GUARD_REJECTION_MESSAGE,
    "Auditor workspace read-only guard could not inspect every path; " +
      "the audit was rejected fail-closed.",
  );
});

test("a real timeout stays visible to the runtime-failure classifier", async () => {
  const { adapter, workspace } = auditorBench(
    () => {
      fs.rmSync(workspace, { recursive: true, force: true });
    },
    "timeout",
    "Episode timed out after 300s.",
  );
  const result = await adapter.runEpisode("prompt", NOOP_ENV, new EpisodeBudget(30));
  assert.equal(result.status, "timeout");
  assert.equal(result.error, `Episode timed out after 300s.\n${GUARD_REJECTION_MESSAGE}`);
});

test("non-auditor roles never run the workspace guard", async () => {
  const root = tmpRoot();
  const adapter = new FakeClaudeCodeAdapter(
    { role: "composer", workspacePath: root, promptDir: path.join(root, "prompts"), env: {} },
    { status: "done" },
  );
  const result = await adapter.runEpisode("prompt", NOOP_ENV, new EpisodeBudget(30));
  for (const key of Object.keys(result.metadata)) {
    assert.ok(!key.startsWith("verifier_"), `unexpected guard key ${key}`);
  }
});
