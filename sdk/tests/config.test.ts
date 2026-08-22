// Covers src/config.ts (ported from LongHorizon-Harness src/lh_harness/config.py):
// the `init` template must parse back into valid defaults, and every validation
// error message must stay verbatim.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CONFIG_TEMPLATE,
  FileExistsError,
  PROJECT_CONFIG_PATH,
  ProjectConfigError,
  createProjectConfig,
  loadRunDefaults,
  writeConfigTemplate,
} from "../src/config.js";

function tmpfile(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-config-"));
  const target = path.join(dir, "config.toml");
  fs.writeFileSync(target, body, "utf-8");
  return target;
}

function failure(body: string): string {
  const target = tmpfile(body);
  try {
    loadRunDefaults(target);
  } catch (exc) {
    assert.ok(exc instanceof ProjectConfigError, `expected ProjectConfigError, got ${exc}`);
    return (exc as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(body)} to be rejected`);
}

test("the project config path is project-scoped", () => {
  assert.equal(PROJECT_CONFIG_PATH, path.join(".lh-harness", "config.toml"));
});

test("a missing config file is not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-config-"));
  assert.deepEqual(loadRunDefaults(path.join(dir, "nope.toml")), {});
});

test("the init template parses back into the documented defaults", () => {
  const target = tmpfile(CONFIG_TEMPLATE);

  const defaults = loadRunDefaults(target);

  assert.deepEqual(defaults, {
    model: "claude-opus-5",
    runs_root: "./.lh-harness/runs",
    agent: "claude_code",
    env: "local",
    prompt_language: "en",
    max_rounds: 25,
    dashboard: true,
    dashboard_port: 0,
    mcp_add_dir: [],
    guard_exclude_path: [],
    manager_timeout: 900,
    gui_executor_timeout: 1800,
    cli_executor_timeout: 1800,
    auditor_timeout: 900,
  });
});

test("the template only names the backend this port wires", () => {
  assert.ok(CONFIG_TEMPLATE.includes('agent = "claude_code"'));
  assert.ok(CONFIG_TEMPLATE.includes('model = "claude-opus-5"'));
  assert.ok(!CONFIG_TEMPLATE.includes('agent = "codex"'));
  assert.ok(!CONFIG_TEMPLATE.includes('model = "gpt-5.6-sol"'));
  assert.ok(CONFIG_TEMPLATE.includes("only Claude Code is wired in this port"));
});

test("init writes the template and refuses to clobber it without force", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-config-"));
  const target = path.join(dir, ".lh-harness", "config.toml");

  assert.equal(createProjectConfig(target), target);
  assert.equal(fs.readFileSync(target, "utf-8"), CONFIG_TEMPLATE);
  assert.throws(() => createProjectConfig(target), (exc: unknown) => exc instanceof FileExistsError);

  fs.writeFileSync(target, "# replaced\n", "utf-8");
  assert.equal(writeConfigTemplate(true, target), target);
  assert.equal(fs.readFileSync(target, "utf-8"), CONFIG_TEMPLATE);
});

test("roles, timeouts and list options are flattened onto argparse dests", () => {
  const target = tmpfile(
    [
      "[run]",
      'agent = "claude_code"',
      'reasoning_effort = "high"',
      "mcp_add_dirs = [\"/a\", \"/b\"]",
      'guard_exclude_paths = ["target"]',
      "[run.roles.manager]",
      'agent = "claude_code"',
      'model = "claude-opus-5"',
      'reasoning_effort = "xhigh"',
      "[run.timeouts]",
      "manager = 42",
      "",
    ].join("\n"),
  );

  assert.deepEqual(loadRunDefaults(target), {
    agent: "claude_code",
    reasoning_effort: "high",
    mcp_add_dir: ["/a", "/b"],
    guard_exclude_path: ["target"],
    manager_agent: "claude_code",
    manager_model: "claude-opus-5",
    manager_reasoning_effort: "xhigh",
    manager_timeout: 42,
  });
});

test("a malformed TOML file names the source", () => {
  const message = failure("[run\n");
  assert.ok(message.startsWith("could not read "), message);
});

test("every validation error message is verbatim", () => {
  assert.equal(failure('[other]\nx = 1\n'), "unknown top-level key(s): other");
  assert.equal(failure("run = 1\n"), "[run] must be a TOML table");
  assert.equal(failure("[run]\nnope = 1\nalso = 2\n"), "unknown [run] key(s): also, nope");
  assert.equal(failure("[run]\nmodel = 1\n"), "run.model must be a non-empty string");
  assert.equal(failure('[run]\nmodel = "  "\n'), "run.model must be a non-empty string");
  assert.equal(failure('[run]\nbase_url = ""\n'), "run.base_url must be a non-empty string");
  assert.equal(failure('[run]\nagent = "codex"\n'), "run.agent must be one of: claude_code");
  assert.equal(
    failure('[run]\nreasoning_effort = "a b"\n'),
    "run.reasoning_effort: reasoning effort may only contain letters, digits, '.', '_', ':' or '-' and must be at most 64 characters",
  );
  assert.equal(failure('[run]\nenv = "remote"\n'), "run.env must be one of: local");
  assert.equal(
    failure('[run]\nprompt_language = "fr"\n'),
    "run.prompt_language must be one of: en",
  );
  assert.equal(failure("[run]\nmax_rounds = 0\n"), "run.max_rounds must be an integer of at least 1");
  assert.equal(failure("[run]\nmax_rounds = true\n"), "run.max_rounds must be an integer of at least 1");
  assert.equal(failure("[run]\nmax_rounds = 1001\n"), "run.max_rounds must be at most 1000");
  assert.equal(failure("[run]\ndashboard = 1\n"), "run.dashboard must be true or false");
  assert.equal(
    failure("[run]\ndashboard_port = 65536\n"),
    "run.dashboard_port must be an integer from 0 to 65535",
  );
  assert.equal(
    failure("[run]\ndashboard_port = -1\n"),
    "run.dashboard_port must be an integer from 0 to 65535",
  );
  assert.equal(
    failure('[run]\nmcp_add_dirs = ["a", ""]\n'),
    "run.mcp_add_dirs must be an array of non-empty strings",
  );
  assert.equal(
    failure("[run]\nmcp_add_dirs = 3\n"),
    "run.mcp_add_dirs must be an array of non-empty strings",
  );
  assert.equal(
    failure("[run]\nguard_exclude_paths = [1]\n"),
    "run.guard_exclude_paths must be an array of non-empty strings",
  );
  assert.equal(failure("[run]\nroles = 3\n"), "[run.roles] must be a TOML table");
  assert.equal(failure("[run.roles.nope]\n"), "unknown role(s): nope");
  assert.equal(failure("[run.roles]\nmanager = 3\n"), "[run.roles.manager] must be a TOML table");
  assert.equal(
    failure("[run.roles.manager]\nnope = 1\n"),
    "unknown [run.roles.manager] key(s): nope",
  );
  assert.equal(
    failure('[run.roles.manager]\nagent = "opencode"\n'),
    "run.roles.manager.agent must be one of: claude_code",
  );
  assert.equal(
    failure("[run.roles.manager]\nmodel = 1\n"),
    "run.roles.manager.model must be a non-empty string",
  );
  assert.equal(
    failure('[run.roles.manager]\nreasoning_effort = "a\\"b"\n'),
    "run.roles.manager.reasoning_effort: reasoning effort may only contain letters, digits, '.', '_', ':' or '-' and must be at most 64 characters",
  );
  assert.equal(failure("[run]\ntimeouts = 3\n"), "[run.timeouts] must be a TOML table");
  assert.equal(failure("[run.timeouts]\nfinal_response = 5\n"), "unknown timeout role(s): final_response");
  assert.equal(failure("[run.timeouts]\nmanager = 0\n"), "run.timeouts.manager must be an integer of at least 1");
});
