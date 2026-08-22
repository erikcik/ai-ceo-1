// Ported from LongHorizon-Harness tests/test_model_catalog.py
// The Codex/DeepSeek/OpenCode halves are dropped with their backends; the
// classification cases that lived in this file are kept verbatim.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resetProbeCache } from "../src/agent_registry.js";
import {
  _discoverClaudeModels,
  _validModelId,
  discoverModelCatalog,
  modelCatalog,
  resetCatalogCache,
} from "../src/model_catalog.js";
import { classifyAgentRuntimeFailure } from "../src/provider_errors.js";
import { loadProviders } from "../src/providers.js";
import { episodeResult } from "../src/types.js";

beforeEach(() => {
  resetProbeCache();
  resetCatalogCache();
});
afterEach(() => {
  resetProbeCache();
  resetCatalogCache();
});

function stub(target: string, body: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `#!/bin/sh\n${body}`, "utf-8");
  fs.chmodSync(target, 0o755);
  return target;
}

test("the claude catalog leads with the default model and the CLI aliases", () => {
  const [models, discovery] = _discoverClaudeModels("/usr/local/bin/claude");

  assert.deepEqual(models.slice(0, 4), [
    { id: "claude-opus-5", label: "claude-opus-5 · default", availability: "suggested" },
    { id: "opus", label: "opus · Claude alias", availability: "suggested" },
    { id: "sonnet", label: "sonnet · Claude alias", availability: "suggested" },
    { id: "haiku", label: "haiku · Claude alias", availability: "suggested" },
  ]);
  assert.equal(discovery.status, "suggested");
  assert.equal(discovery.source, "claude_cli_aliases_and_history");
  assert.equal(discovery.account_scoped, false);
  assert.equal(discovery.refreshed_at, null);
  assert.ok(discovery.warning.includes("Claude Code"));
});

test("a missing claude CLI makes the catalog unavailable, not empty", () => {
  const [models, discovery] = _discoverClaudeModels(null);

  assert.ok(models.length >= 4);
  assert.equal(discovery.status, "unavailable");
  assert.equal(discovery.warning, "Claude Code CLI not found.");
});

test("providers.json models are offered as <provider>:<id>", () => {
  const providers = loadProviders();
  const declared: string[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    for (const model of provider.models ?? []) declared.push(`${name}:${model.id}`);
  }
  const [models] = _discoverClaudeModels("/usr/local/bin/claude");
  const ids = models.map((entry) => entry.id);

  for (const id of declared) assert.ok(ids.includes(id), `${id} is missing from the catalog`);
  for (const id of declared) {
    const entry = models.find((item) => item.id === id);
    assert.equal(entry?.availability, "suggested");
    assert.ok(entry?.label);
  }
});

test("the catalog reports the agent, its capabilities and its reasoning payload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-"));
  const claude = stub(
    path.join(dir, "claude"),
    'if [ "$1" = "--version" ]; then echo "2.1.212"; exit 0; fi\n' +
      'echo "  --effort <level>  Effort level (low, medium, high, xhigh, max)"\n',
  );

  const catalog = await discoverModelCatalog({ claudeBinary: claude });
  const agents = catalog.agents as Record<string, unknown>[];
  const agent = agents.find((item) => item.id === "claude_code")!;

  assert.equal(agents.length, 1);
  assert.equal(agent.label, "Claude Code");
  assert.equal(agent.available, true);
  assert.equal(agent.availability, "usable");
  assert.equal(agent.version, "2.1.212");
  assert.equal(agent.binary, claude);
  assert.deepEqual(agent.capabilities, ["cli", "gui", "mcp", "role_isolation"]);
  assert.equal(agent.default_model, "claude-opus-5");

  const reasoning = agent.reasoning as Record<string, unknown>;
  assert.equal(reasoning.supported, true);
  assert.equal(reasoning.transport, "cli_flag");
  assert.equal(reasoning.flag, "--effort");
  assert.equal(reasoning.provider_default, "");
  assert.equal(reasoning.scope, "per_agent");
  assert.equal(reasoning.source, "cli_help");
  assert.equal(reasoning.allow_custom, true);
  assert.equal(reasoning.validation, "silently_ignored");
  assert.deepEqual(reasoning.choices, [
    { id: "low", label: "low" },
    { id: "medium", label: "medium" },
    { id: "high", label: "high" },
    { id: "xhigh", label: "xhigh" },
    { id: "max", label: "max" },
  ]);

  const models = catalog.models as Record<string, unknown[]>;
  assert.deepEqual(models.claude_code, agent.models);
  const discovery = catalog.model_discovery as Record<string, Record<string, unknown>>;
  assert.equal(discovery.claude_code.source, "claude_cli_aliases_and_history");
});

test("a broken CLI is reported beside the tri-state, not as available", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-"));
  const broken = stub(path.join(dir, "claude"), "exit 3\n");

  const agent = (await modelCatalog("claude_code", { claudeBinary: broken }))!;

  assert.equal(agent.available, false);
  assert.equal(agent.availability, "found_but_broken");
  assert.ok(String(agent.problem).includes("not usable"));
});

test("a non-string binary argument is rejected", async () => {
  await assert.rejects(
    () => discoverModelCatalog({ claudeBinary: 5 as unknown as string }),
    /claude_binary must be a string or None/,
  );
});

test("custom model ids are accepted up to the 256-char limit", () => {
  assert.equal(_validModelId("orca:obsidian/Qwen3.8-27B"), true);
  assert.equal(_validModelId("x".repeat(256)), true);
  assert.equal(_validModelId("x".repeat(257)), false);
  assert.equal(_validModelId("bad\nid"), false);
  assert.equal(_validModelId("bad\rid"), false);
  assert.equal(_validModelId("  "), false);
  assert.equal(_validModelId(5), false);
});

test("an invalid-model failure keeps the provider message", () => {
  const message =
    "The 'definitely-bad' model is not supported when using Codex with a ChatGPT account.";
  const result = episodeResult({
    status: "error",
    actions_log: JSON.stringify({ type: "turn.failed", error: { message } }),
    metadata: {
      runtime_signals: [{ signal: "AGENT_TURN_FAILED", evidence: `AGENT_TURN_FAILED: ${message}` }],
    },
  });

  const failure = classifyAgentRuntimeFailure(result);

  assert.notEqual(failure, null);
  assert.equal(failure?.kind, "model_unavailable");
  assert.equal(failure?.abort_reason, "provider_model_unavailable");
  assert.ok(failure?.user_message.includes(message));
});

test("an invalid-model failure unwraps nested provider JSON", () => {
  const message =
    "The 'definitely-bad' model is not supported when using Codex with a ChatGPT account.";
  const wrapped = JSON.stringify({
    type: "error",
    status: 400,
    error: { type: "invalid_request_error", message },
  });
  const result = episodeResult({
    status: "error",
    actions_log: JSON.stringify({ type: "turn.failed", error: { message: wrapped } }),
  });

  const failure = classifyAgentRuntimeFailure(result);

  assert.notEqual(failure, null);
  assert.equal(failure?.user_message, `Model unavailable: ${message}`);
  assert.ok(!failure?.user_message.includes('{"type"'));
});

test("the classifier keeps a local episode timeout authoritative", () => {
  const failure = classifyAgentRuntimeFailure(
    episodeResult({ status: "timeout", error: "Episode timed out after 1800s." }),
  );

  assert.notEqual(failure, null);
  assert.equal(failure?.kind, "timeout");
  assert.equal(failure?.abort_reason, "provider_timeout");
  assert.equal(failure?.user_message, "Agent execution timed out: Episode timed out after 1800s.");
});

test("an invalid api key is classified as authentication", () => {
  const message = "API Error: 400 invalid api key";
  const result = episodeResult({
    status: "error",
    actions_log: JSON.stringify({ type: "result", is_error: true, result: message }),
  });

  const failure = classifyAgentRuntimeFailure(result);

  assert.notEqual(failure, null);
  assert.equal(failure?.kind, "authentication");
  assert.equal(failure?.abort_reason, "provider_authentication");
  assert.equal(failure?.user_message, `Provider login or credentials invalid: ${message}`);
});
