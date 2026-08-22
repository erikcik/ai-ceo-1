// Ported from LongHorizon-Harness tests/test_reasoning_effort_chain.py -- the
// pure resolution-chain and project-config halves. The adapter-transport and
// supervisor cases belong to the adapter/supervisor tasks; the Codex/OpenCode/
// DeepSeek backends are not ported, so an unregistered agent id stands in for
// "a backend with no effort switch".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ProjectConfigError,
  type RoleArgs,
  loadRunDefaults,
  resolveRoleModel,
  resolveRoleOption,
  resolveRoleReasoningEffort,
} from "../src/config.js";

const ROLES = [
  "manager",
  "executor",
  "gui_executor",
  "cli_executor",
  "auditor",
  "gui_auditor",
  "cli_auditor",
  "final_response",
];

function args(values: Record<string, string> = {}): RoleArgs {
  const base: RoleArgs = { agent: null, model: null, reasoning_effort: null };
  for (const role of ROLES) {
    base[`${role}_agent`] = null;
    base[`${role}_model`] = null;
    base[`${role}_reasoning_effort`] = null;
  }
  return { ...base, ...values };
}

function tmpConfig(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chain-"));
  const target = path.join(dir, "config.toml");
  fs.writeFileSync(target, body, "utf-8");
  return target;
}

test("a role agent falls back to the global value", () => {
  assert.equal(resolveRoleOption(args({ agent: "claude_code" }), "gui_executor", "agent"), "claude_code");
});

test("a role agent prefers the nearest override", () => {
  const values = args({ agent: "claude_code", executor_agent: "other_backend" });
  assert.equal(resolveRoleOption(values, "gui_executor", "agent"), "other_backend");
  assert.equal(resolveRoleOption(values, "manager", "agent"), "claude_code");
});

test("final_response inherits from the manager", () => {
  const values = args({ agent: "claude_code", manager_agent: "manager_backend" });
  assert.equal(resolveRoleOption(values, "final_response", "agent"), "manager_backend");
});

test("a role model falls back to the global value", () => {
  assert.equal(resolveRoleModel(args({ model: "claude-opus-5" }), "cli_auditor"), "claude-opus-5");
});

test("a role model does not cross an explicit backend switch", () => {
  // A Claude-only role must never inherit the global model merely because its
  // agent was overridden.
  const values = args({ model: "claude-opus-5", manager_agent: "other_backend" });

  assert.equal(resolveRoleModel(values, "manager"), null);
  assert.equal(resolveRoleModel(values, "gui_executor"), "claude-opus-5");
});

test("a model set at or below the agent boundary still wins", () => {
  const values = args({
    model: "claude-opus-5",
    manager_agent: "other_backend",
    manager_model: "other-model",
  });

  assert.equal(resolveRoleModel(values, "manager"), "other-model");
});

test("a role effort falls back to the global value", () => {
  assert.equal(resolveRoleReasoningEffort(args({ reasoning_effort: "high" }), "gui_executor", "claude_code"), "high");
});

test("a role effort prefers the nearest override", () => {
  const values = args({ reasoning_effort: "low", executor_reasoning_effort: "max" });

  assert.equal(resolveRoleReasoningEffort(values, "gui_executor", "claude_code"), "max");
  assert.equal(resolveRoleReasoningEffort(values, "manager", "claude_code"), "low");
});

test("a role effort does not cross an explicit backend switch", () => {
  // Effort tiers are backend-specific, so inheriting one across a switch would
  // send a tier the selected backend rejects or silently drops.
  const values = args({ reasoning_effort: "ultra", manager_agent: "other_backend" });

  assert.equal(resolveRoleReasoningEffort(values, "manager", "claude_code"), null);
  assert.equal(resolveRoleReasoningEffort(values, "gui_executor", "claude_code"), "ultra");
});

test("a role effort is dropped for a backend without the switch", () => {
  const values = args({ reasoning_effort: "high" });

  assert.equal(resolveRoleReasoningEffort(values, "manager", "deepseek_harness"), null);
});

test("the project config accepts a global and a per-role effort", () => {
  const config = tmpConfig(
    ["[run]", 'reasoning_effort = "high"', "[run.roles.manager]", 'reasoning_effort = "xhigh"'].join("\n"),
  );

  const defaults = loadRunDefaults(config);

  assert.equal(defaults.reasoning_effort, "high");
  assert.equal(defaults.manager_reasoning_effort, "xhigh");
});

test("the project config rejects a malformed effort", () => {
  const config = tmpConfig('[run]\nreasoning_effort = "a b"\n');

  assert.throws(
    () => loadRunDefaults(config),
    (exc: unknown) => exc instanceof ProjectConfigError && exc.message.includes("run.reasoning_effort"),
  );
});
