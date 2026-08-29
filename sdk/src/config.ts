// Ported 1:1 from LongHorizon-Harness src/lh_harness/config.py
//
// Single-backend port: `_AGENT_CHOICES` holds only `claude_code`, and the
// CONFIG_TEMPLATE's `agent`/`model` examples name Claude Code instead of Codex.
// Everything else -- key sets, validation order, error strings -- is verbatim.
// The three role resolvers at the bottom are ported from cli.py so cli.ts and
// the reasoning-effort chain test share one implementation (spec 06 sec 2.9).
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";

import { MAX_ROUNDS } from "./types.js";
import { normaliseReasoningEffort, supportsReasoningEffort } from "./agent_registry.js";

export const PROJECT_CONFIG_PATH = path.join(".lh-harness", "config.toml");

const _AGENT_CHOICES = new Set(["claude_code"]);
const _ROLE_NAMES = new Set(["planner", "composer", "evaluator", "prompt_tailor", "rubric", "final_response"]);
const _TIMEOUT_NAMES = new Set(["prompt_tailor", "planner", "rubric", "composer", "evaluator", "final_response"]);
const _RUN_KEYS = new Set([
  "agent",
  "model",
  "reasoning_effort",
  "env",
  "runs_root",
  "workspace",
  "harness_dir",
  "log_dir",
  "base_url",
  "prompt_language",
  "claude_mcp_config",
  "codex_mcp_config",
  "mcp_add_dirs",
  "guard_exclude_paths",
  "max_rounds",
  "max_eval_rounds",
  "min_research_agents",
  "research_model",
  "episode_budget_usd",
  "sources_dir",
  "memory_dir",
  "dashboard",
  "dashboard_port",
  "roles",
  "timeouts",
]);
const _STRING_KEYS = new Set([
  "model",
  "runs_root",
  "workspace",
  "harness_dir",
  "log_dir",
  "base_url",
  "claude_mcp_config",
  "codex_mcp_config",
  "research_model",
  "sources_dir",
  "memory_dir",
]);

export const CONFIG_TEMPLATE = `# lh-harness-eray project defaults.
# Explicit CLI arguments override these values.

[run]
agent = "claude_code"
model = "claude-opus-5"

# Reasoning depth forwarded to Claude Code (\`--effort\`): low, medium, high, xhigh, max.
# reasoning_effort = "high"

env = "local"
runs_root = "./.lh-harness/runs"
# Agents work in the directory lh-harness-eray was started from unless set here.
# workspace = "./workspace"

# base_url = "https://api.example.com/v1"

prompt_language = "en"
# claude_mcp_config = "/path/to/mcp.json"
mcp_add_dirs = []

# Build/cache directories the evaluator read-only guard should not snapshot,
# e.g. ["node_modules", ".next", "build"]. Agents can still read them.
guard_exclude_paths = []

# The loop: planner -> (rubric -> composer <-> evaluator) per subtask -> reply.
# max_rounds caps the total number of composer episodes in a run.
max_rounds = 25
# Composer/evaluator rounds per subtask before it is marked blocked.
max_eval_rounds = 3
# Research subagents the planner must spawn; the rubric agent and evaluator
# spawn a third of this per subtask (at least 3) and reuse sibling rubrics.
min_research_agents = 10
# Model alias for those research subagents.
research_model = "sonnet"
# Dollar ceiling per agent episode (0 = provider default).
episode_budget_usd = 0
# Operator reference material and the memory wiki (default: inside the workspace).
# sources_dir = "./sources"
# memory_dir = "./memory"

dashboard = true
dashboard_port = 0

# Seconds per agent session. Research-heavy roles (planner, evaluator) and
# the composer regularly need 30-50 minutes; a timeout counts as a failed
# round, never as a dead run.
[run.timeouts]
prompt_tailor = 900
planner = 3600
rubric = 1800
composer = 3600
evaluator = 3600
final_response = 900

# Models per role. prompt_tailor and final_response follow the planner;
# rubric follows the evaluator.
[run.roles.planner]
# model = "claude-opus-5"

[run.roles.composer]
# model = "claude-opus-5"

[run.roles.evaluator]
# model = "claude-opus-5"
`;

export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

/** Python's FileExistsError; `create_project_config` raises it without --force. */
export class FileExistsError extends Error {
  readonly code = "EEXIST";
  constructor(target: string) {
    super(target);
    this.name = "FileExistsError";
  }
}

export function createProjectConfig(
  target: string = PROJECT_CONFIG_PATH,
  force = false,
): string {
  if (fs.existsSync(target) && !force) throw new FileExistsError(target);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, CONFIG_TEMPLATE, "utf-8");
  return target;
}

/** `lh-harness-eray init` entry point; same behaviour as `create_project_config`. */
export function writeConfigTemplate(force = false, target: string = PROJECT_CONFIG_PATH): string {
  return createProjectConfig(target, force);
}

export function loadRunDefaults(source: string = PROJECT_CONFIG_PATH): Record<string, unknown> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    return {};
  }
  if (!stat.isFile()) return {};
  let payload: unknown;
  try {
    payload = parse(fs.readFileSync(source, "utf-8"));
  } catch (exc) {
    throw new ProjectConfigError(`could not read ${source}: ${errText(exc)}`);
  }
  if (!isTable(payload)) throw new ProjectConfigError(`${source} must contain a TOML table`);
  const unknownRoot = Object.keys(payload).filter((key) => key !== "run");
  if (unknownRoot.length) {
    throw new ProjectConfigError(`unknown top-level key(s): ${_names(unknownRoot)}`);
  }
  const run = payload.run ?? {};
  if (!isTable(run)) throw new ProjectConfigError("[run] must be a TOML table");
  return _flattenRunTable(run);
}

export function _flattenRunTable(run: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(run).filter((key) => !_RUN_KEYS.has(key));
  if (unknown.length) throw new ProjectConfigError(`unknown [run] key(s): ${_names(unknown)}`);

  const defaults: Record<string, unknown> = {};
  // Python iterates a set here, so the assignment order is unspecified; the
  // resulting dict is keyed, never ordered-compared.
  for (const key of _STRING_KEYS) {
    if (key in run) defaults[key] = _string(run[key], `run.${key}`);
  }

  if ("agent" in run) defaults.agent = _choice(run.agent, "run.agent", _AGENT_CHOICES);
  if ("reasoning_effort" in run) {
    defaults.reasoning_effort = _reasoningEffort(run.reasoning_effort, "run.reasoning_effort");
  }
  if ("env" in run) defaults.env = _choice(run.env, "run.env", new Set(["local"]));
  if ("prompt_language" in run) {
    defaults.prompt_language = _choice(run.prompt_language, "run.prompt_language", new Set(["en"]));
  }
  if ("max_rounds" in run) defaults.max_rounds = _positiveInt(run.max_rounds, "run.max_rounds");
  if ("max_eval_rounds" in run) defaults.max_eval_rounds = _positiveInt(run.max_eval_rounds, "run.max_eval_rounds");
  if ("min_research_agents" in run) {
    const value = run.min_research_agents;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new ProjectConfigError("run.min_research_agents must be an integer of at least 0");
    }
    defaults.min_research_agents = value;
  }
  if ("episode_budget_usd" in run) {
    const value = run.episode_budget_usd;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ProjectConfigError("run.episode_budget_usd must be a number of at least 0");
    }
    defaults.episode_budget_usd = value;
  }
  if ("dashboard" in run) defaults.dashboard = _boolean(run.dashboard, "run.dashboard");
  if ("dashboard_port" in run) defaults.dashboard_port = _port(run.dashboard_port, "run.dashboard_port");
  if ("mcp_add_dirs" in run) {
    const value = run.mcp_add_dirs;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item)) {
      throw new ProjectConfigError("run.mcp_add_dirs must be an array of non-empty strings");
    }
    defaults.mcp_add_dir = [...value];
  }
  if ("guard_exclude_paths" in run) {
    const value = run.guard_exclude_paths;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item)) {
      throw new ProjectConfigError("run.guard_exclude_paths must be an array of non-empty strings");
    }
    defaults.guard_exclude_path = [...value];
  }

  const roles = run.roles ?? {};
  if (!isTable(roles)) throw new ProjectConfigError("[run.roles] must be a TOML table");
  const unknownRoles = Object.keys(roles).filter((role) => !_ROLE_NAMES.has(role));
  if (unknownRoles.length) throw new ProjectConfigError(`unknown role(s): ${_names(unknownRoles)}`);
  for (const [role, values] of Object.entries(roles)) {
    if (!isTable(values)) throw new ProjectConfigError(`[run.roles.${role}] must be a TOML table`);
    const unknownRoleKeys = Object.keys(values).filter(
      (key) => key !== "agent" && key !== "model" && key !== "reasoning_effort",
    );
    if (unknownRoleKeys.length) {
      throw new ProjectConfigError(`unknown [run.roles.${role}] key(s): ${_names(unknownRoleKeys)}`);
    }
    if ("agent" in values) {
      defaults[`${role}_agent`] = _choice(values.agent, `run.roles.${role}.agent`, _AGENT_CHOICES);
    }
    if ("model" in values) {
      defaults[`${role}_model`] = _string(values.model, `run.roles.${role}.model`);
    }
    if ("reasoning_effort" in values) {
      defaults[`${role}_reasoning_effort`] = _reasoningEffort(
        values.reasoning_effort,
        `run.roles.${role}.reasoning_effort`,
      );
    }
  }

  const timeouts = run.timeouts ?? {};
  if (!isTable(timeouts)) throw new ProjectConfigError("[run.timeouts] must be a TOML table");
  const unknownTimeouts = Object.keys(timeouts).filter((role) => !_TIMEOUT_NAMES.has(role));
  if (unknownTimeouts.length) {
    throw new ProjectConfigError(`unknown timeout role(s): ${_names(unknownTimeouts)}`);
  }
  for (const [role, value] of Object.entries(timeouts)) {
    defaults[`${role}_timeout`] = _positiveInt(value, `run.timeouts.${role}`);
  }
  return defaults;
}

function _string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectConfigError(`${name} must be a non-empty string`);
  }
  return value;
}

function _choice(value: unknown, name: string, choices: Set<string>): string {
  const result = _string(value, name);
  if (!choices.has(result)) throw new ProjectConfigError(`${name} must be one of: ${_names([...choices])}`);
  return result;
}

function _reasoningEffort(value: unknown, name: string): string {
  try {
    return normaliseReasoningEffort(_string(value, name));
  } catch (exc) {
    if (exc instanceof ProjectConfigError) throw exc;
    throw new ProjectConfigError(`${name}: ${errText(exc)}`);
  }
}

function _positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ProjectConfigError(`${name} must be an integer of at least 1`);
  }
  if (name.endsWith("max_rounds") && value > MAX_ROUNDS) {
    throw new ProjectConfigError(`${name} must be at most ${MAX_ROUNDS}`);
  }
  return value;
}

function _port(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ProjectConfigError(`${name} must be an integer from 0 to 65535`);
  }
  return value;
}

function _boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ProjectConfigError(`${name} must be true or false`);
  return value;
}

function _names(values: Iterable<string>): string {
  return [...values].sort().join(", ");
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function errText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// ---------------------------------------------------------------------------
// Role resolution chain -- ported from cli.py (`_resolve_role_*`), kept here so
// cli.ts, the supervisor and the tests share one implementation. `args` is the
// flat argparse namespace: `agent`, `model`, `reasoning_effort` plus one
// `<role>_agent` / `<role>_model` / `<role>_reasoning_effort` per role.
// ---------------------------------------------------------------------------

/** Role options as (dest prefix, broader option it falls back to). */
export const ROLE_PARENTS: Readonly<Record<string, string | null>> = {
  planner: null,
  composer: null,
  evaluator: null,
  prompt_tailor: "planner",
  rubric: "evaluator",
  final_response: "planner",
};

export type RoleArgs = Record<string, unknown>;

function argValue(args: RoleArgs, name: string): string | null {
  const value = args[name];
  return typeof value === "string" && value ? value : null;
}

/** Walk a role's fallback chain up to the global `--agent` / `--model`. */
export function resolveRoleOption(args: RoleArgs, role: string, suffix: string): string | null {
  let current: string | null = role;
  while (current) {
    const value = argValue(args, `${current}_${suffix}`);
    if (value) return value;
    current = ROLE_PARENTS[current] ?? null;
  }
  return argValue(args, suffix);
}

/** Resolve a model without crossing an explicit backend switch. */
export function resolveRoleModel(args: RoleArgs, role: string): string | null {
  let current: string | null = role;
  while (current) {
    const value = argValue(args, `${current}_model`);
    if (value) return value;
    if (argValue(args, `${current}_agent`)) return null;
    current = ROLE_PARENTS[current] ?? null;
  }
  return argValue(args, "model");
}

/** Resolve a role's effort without crossing an explicit backend switch. */
export function resolveRoleReasoningEffort(
  args: RoleArgs,
  role: string,
  agentName: string,
): string | null {
  // Imported lazily in Python to avoid a cycle; the ESM import is hoisted here.
  if (!supportsReasoningEffort(agentName)) return null;
  let current: string | null = role;
  while (current) {
    const value = argValue(args, `${current}_reasoning_effort`);
    if (value) return value;
    if (argValue(args, `${current}_agent`)) return null;
    current = ROLE_PARENTS[current] ?? null;
  }
  return argValue(args, "reasoning_effort");
}
