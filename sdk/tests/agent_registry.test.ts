// Ported from LongHorizon-Harness tests/test_agent_registry.py
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  AGENT_IDS,
  AGENT_SPECS,
  agentSpec,
  normaliseReasoningEffort,
  probeAgents,
  reasoningChoices,
  resetProbeCache,
  supportsReasoningEffort,
} from "../src/agent_registry.js";

// The probe cache is module-global; a stale entry would leak between tests.
beforeEach(() => resetProbeCache());
afterEach(() => resetProbeCache());

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lh-registry-"));
}

function stub(target: string, body: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `#!/bin/sh\n${body}`, "utf-8");
  fs.chmodSync(target, 0o755);
  return target;
}

test("the registry declares exactly the agents this port wires", () => {
  assert.deepEqual([...AGENT_IDS], ["claude_code"]);
  const spec = agentSpec("claude_code");
  assert.equal(spec.label, "Claude Code");
  assert.equal(spec.binary, "claude");
  assert.equal(spec.default_model, "claude-opus-5");
  assert.deepEqual([...spec.capabilities].sort(), ["cli", "gui", "mcp", "role_isolation"]);
  assert.equal(AGENT_SPECS.length, 1);
});

test("a binary on PATH but not runnable is not reported usable", async () => {
  // Worse than missing: it looks healthy while breaking every run, so it must
  // never collapse into `usable` or `missing`.
  const broken = stub(path.join(tmpdir(), "claude"), "exit 3\n");

  const probes = await probeAgents({ binaries: { claude_code: broken } });

  assert.equal(probes.claude_code.availability, "found_but_broken");
  assert.equal(probes.claude_code.usable, false);
  assert.equal(probes.claude_code.binary, broken);
  assert.ok(probes.claude_code.problem.includes("not usable"));
});

test("a binary that prints no version is not reported usable", async () => {
  const silent = stub(path.join(tmpdir(), "claude"), "exit 0\n");

  const probes = await probeAgents({ binaries: { claude_code: silent } });

  assert.equal(probes.claude_code.availability, "found_but_broken");
});

test("a missing binary is missing, not broken", async () => {
  const probes = await probeAgents({ binaries: { claude_code: "" } });

  assert.equal(probes.claude_code.availability, "missing");
  assert.equal(probes.claude_code.binary, "");
});

test("a runnable binary reports its version", async () => {
  const good = stub(path.join(tmpdir(), "claude"), 'echo "claude-cli 9.9.9"\nexit 0\n');

  const probes = await probeAgents({ binaries: { claude_code: good } });

  assert.equal(probes.claude_code.availability, "usable");
  assert.equal(probes.claude_code.version, "9.9.9");
  assert.equal(probes.claude_code.problem, "");
});

test("an explicit binary is probed instead of rediscovered", async () => {
  // The Web API resolves a path once per request so its response is
  // self-consistent; re-resolving here could describe another installation.
  const chosen = stub(path.join(tmpdir(), "chosen", "claude"), 'echo "1.0.0"\nexit 0\n');

  const probes = await probeAgents({ binaries: { claude_code: chosen } });

  assert.equal(probes.claude_code.binary, chosen);
});

test("claude effort tiers are read from cli help", async () => {
  // `claude --help` wraps the tier list onto a continuation line.
  const claude = stub(
    path.join(tmpdir(), "claude"),
    'if [ "$1" = "--version" ]; then echo "2.1.212"; exit 0; fi\n' +
      "cat <<EOF\n" +
      "  --effort <level>                      Effort level for the current session\n" +
      "                                        (low, medium, high, xhigh, max)\n" +
      "  --other-flag                          Something else\n" +
      "EOF\n",
  );

  const probes = await probeAgents({ binaries: { claude_code: claude } });
  const spec = agentSpec("claude_code");

  assert.deepEqual([...probes.claude_code.discovered_efforts], ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual([...reasoningChoices(spec, probes.claude_code)], [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("effort discovery falls back to declared tiers when help is unparsable", async () => {
  const claude = stub(
    path.join(tmpdir(), "claude"),
    'if [ "$1" = "--version" ]; then echo "2.1.212"; exit 0; fi\n' +
      'echo "  --effort <level>   Effort level (default)"\n',
  );

  const probes = await probeAgents({ binaries: { claude_code: claude } });
  const spec = agentSpec("claude_code");

  // A single parenthesised word is prose, not a tier list.
  assert.deepEqual([...probes.claude_code.discovered_efforts], []);
  assert.deepEqual([...reasoningChoices(spec, probes.claude_code)], [
    ...(spec.reasoning?.declared_choices ?? []),
  ]);
});

test("claude_code declares how it receives an effort", () => {
  const reasoning = agentSpec("claude_code").reasoning;
  assert.notEqual(reasoning, null);
  assert.equal(reasoning?.flag, "--effort");
  assert.equal(reasoning?.transport, "cli_flag");
  assert.equal(reasoning?.scope, "per_agent");
  assert.equal(reasoning?.source, "cli_help");
  assert.equal(reasoning?.validation, "silently_ignored");
  assert.deepEqual([...(reasoning?.declared_choices ?? [])], ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(supportsReasoningEffort("claude_code"), true);
});

test("an agent that is not registered declares no reasoning", () => {
  assert.equal(supportsReasoningEffort("deepseek_harness"), false);
});

for (const value of ['a"b', "a'b", "high medium", "high\nlow", "x".repeat(65), "high;rm -rf /", "$(whoami)", "`id`"]) {
  test(`reasoning effort rejects a value that could break out: ${JSON.stringify(value)}`, () => {
    assert.throws(() => normaliseReasoningEffort(value), /reasoning effort may only contain/);
  });
}

for (const value of ["high", "ultra", "x-high", "a.b_c:d", "MAX", "2"]) {
  test(`reasoning effort accepts a value beyond the known tiers: ${value}`, () => {
    // Codex accepts `ultra` client-side even though its API enumerates a
    // shorter set, so an allow-list would reject values that actually work.
    assert.equal(normaliseReasoningEffort(value), value);
  });
}

test("a blank reasoning effort means follow the provider default", () => {
  assert.equal(normaliseReasoningEffort(null), "");
  assert.equal(normaliseReasoningEffort(""), "");
  assert.equal(normaliseReasoningEffort("   "), "");
});

test("a reasoning effort is rejected for an agent without the switch", () => {
  assert.throws(
    () => normaliseReasoningEffort("high", { agentId: "deepseek_harness" }),
    /does not accept a reasoning effort/,
  );
  // Blank stays acceptable: it asks for nothing.
  assert.equal(normaliseReasoningEffort("", { agentId: "deepseek_harness" }), "");
});

test("a non-string reasoning effort is rejected", () => {
  assert.throws(() => normaliseReasoningEffort(3), /reasoning effort must be a string/);
});

test("an unknown agent id is rejected", () => {
  assert.throws(() => agentSpec("not-an-agent"), /Unknown agent/);
});
