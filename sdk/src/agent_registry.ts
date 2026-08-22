// Ported 1:1 from LongHorizon-Harness src/lh_harness/agent_registry.py
//
// One declarative description of every agent backend the harness can drive.
//
// Agent facts used to be spread across the CLI's choices/default models, the
// model catalogue's labels and availability, and a hardcoded fallback list in
// the Web bundle. Adding or correcting a backend meant editing all three, and
// they drifted. This module owns the facts; the others read them.
//
// Availability is deliberately tri-state. A PATH lookup answers "is there a
// file with this name", which is not "can I drive this agent": a Microsoft
// Store App Execution Alias resolves fine and fails on every real call. An
// agent that is on PATH but cannot run is worse than a missing one, because it
// looks healthy while breaking every run, so it gets its own state instead of
// being folded into either `usable` or `missing`.
//
// Single-backend port: only `claude_code` is wired here; codex, opencode and
// deepseek_harness are not ported.
import { execFile } from "node:child_process";

import { DEFAULT_CLAUDE_MODEL } from "./types.js";
import { probeAgentCli, resolveAgentBinary } from "./utils/agent_cli.js";

export type Availability = "usable" | "found_but_broken" | "missing";

/**
 * How one agent accepts a reasoning-effort selection.
 *
 * `validation` records what the backend does with a value it does not
 * recognise, which is not cosmetic: Codex surfaces a provider 400 and the run
 * fails with a readable reason, while Claude Code prints a warning and
 * silently continues at its default effort. The workbench must not promise the
 * second case is verified.
 */
export type ReasoningSpec = {
  transport: "codex_config" | "cli_flag";
  flag: string;
  scope: "per_model" | "per_agent";
  source: "model_catalog" | "cli_help" | "declared";
  declared_choices: readonly string[];
  validation: "provider_error" | "silently_ignored";
};

export type AgentSpec = {
  id: string;
  label: string;
  binary: string;
  default_model: string;
  capabilities: ReadonlySet<string>;
  reasoning: ReasoningSpec | null;
};

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    id: "claude_code",
    label: "Claude Code",
    binary: "claude",
    default_model: DEFAULT_CLAUDE_MODEL,
    capabilities: new Set(["cli", "gui", "mcp", "role_isolation"]),
    reasoning: {
      transport: "cli_flag",
      flag: "--effort",
      scope: "per_agent",
      source: "cli_help",
      declared_choices: ["low", "medium", "high", "xhigh", "max"],
      validation: "silently_ignored",
    },
  },
];

export const AGENT_IDS: readonly string[] = AGENT_SPECS.map((spec) => spec.id);
const _SPECS_BY_ID = new Map(AGENT_SPECS.map((spec) => [spec.id, spec]));

export function agentSpec(agentId: string): AgentSpec {
  const spec = _SPECS_BY_ID.get(agentId);
  if (spec === undefined) throw new Error(`Unknown agent: ${agentId}`);
  return spec;
}

export function supportsReasoningEffort(agentId: string): boolean {
  const spec = _SPECS_BY_ID.get(agentId);
  return spec !== undefined && spec.reasoning !== null;
}

// The value reaches Codex as an inline TOML string and the other backends as an
// argv element. Quoting is handled by the adapters; this rejects the characters
// that would end the TOML string or smuggle a newline regardless of quoting. An
// allow-list of known tiers would be wrong: Codex accepts `ultra` client-side
// even though the API enumerates a shorter set, and operators must be able to
// pass values a future backend adds.
const _EFFORT_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Validate a reasoning-effort value; `""` means follow the provider default. */
export function normaliseReasoningEffort(
  value: unknown,
  options: { agentId?: string | null } = {},
): string {
  const agentId = options.agentId ?? null;
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("reasoning effort must be a string");
  const effort = value.trim();
  if (!effort) return "";
  if (!_EFFORT_RE.test(effort)) {
    throw new Error(
      "reasoning effort may only contain letters, digits, '.', '_', ':' or '-' " +
        "and must be at most 64 characters",
    );
  }
  if (agentId !== null && !supportsReasoningEffort(agentId)) {
    throw new Error(`${agentId} does not accept a reasoning effort`);
  }
  return effort;
}

export type AgentProbe = {
  agent_id: string;
  availability: Availability;
  binary: string;
  version: string;
  problem: string;
  /** Efforts discovered from the CLI itself, when the spec says to look. */
  discovered_efforts: readonly string[];
  /** `self.availability == "usable"` */
  usable: boolean;
};

function agentProbe(
  agentId: string,
  availability: Availability,
  extra: { binary?: string; version?: string; problem?: string; discovered_efforts?: readonly string[] } = {},
): AgentProbe {
  return {
    agent_id: agentId,
    availability,
    binary: extra.binary ?? "",
    version: extra.version ?? "",
    problem: extra.problem ?? "",
    discovered_efforts: extra.discovered_efforts ?? [],
    usable: availability === "usable",
  };
}

// Installations do not change during a session, and probing runs a subprocess
// per agent, so this is cached far longer than the model catalogue. The
// explicit refresh endpoint passes `force`.
const _PROBE_TTL_SECONDS = 300.0;
const _PROBE_TIMEOUT_SECONDS = 10;
let _probedAt = 0.0;
let _probed: Record<string, AgentProbe> | null = null;
let _probedKey: string | null = null;

const _UNRESOLVED = Symbol("unresolved");
type Target = string | null | typeof _UNRESOLVED;

function monotonic(): number {
  return Number(process.hrtime.bigint() / 1_000_000n) / 1000;
}

/**
 * Probe every known agent CLI, in parallel, and cache the result.
 *
 * `binaries` overrides discovery per agent id. Callers that already resolved a
 * path (the Web API resolves once per request so its response is
 * self-consistent) must be able to probe exactly that path; re-resolving here
 * could otherwise report a different installation than the one a run uses.
 */
export async function probeAgents(
  options: { force?: boolean; binaries?: Record<string, string | null> | null } = {},
): Promise<Record<string, AgentProbe>> {
  const force = options.force ?? false;
  const overrides = new Map<string, string | null>();
  for (const [key, value] of Object.entries(options.binaries ?? {})) {
    if (_SPECS_BY_ID.has(key)) overrides.set(key, value);
  }
  const targets = new Map<string, Target>();
  for (const spec of AGENT_SPECS) {
    targets.set(spec.id, overrides.has(spec.id) ? (overrides.get(spec.id) ?? null) : _UNRESOLVED);
  }
  const cacheKey = JSON.stringify(
    AGENT_SPECS.map((spec) => {
      const target = targets.get(spec.id);
      return [spec.id, target === _UNRESOLVED ? "" : String(target ?? "")];
    }),
  );
  const now = monotonic();
  if (!force && _probed !== null && _probedKey === cacheKey && now - _probedAt < _PROBE_TTL_SECONDS) {
    return { ..._probed };
  }
  const results = await Promise.all(
    AGENT_SPECS.map((spec) => _probeOne(spec, targets.get(spec.id) as Target)),
  );
  const probed: Record<string, AgentProbe> = {};
  for (const probe of results) probed[probe.agent_id] = probe;
  _probed = probed;
  _probedKey = cacheKey;
  _probedAt = monotonic();
  return { ...probed };
}

/** Test/refresh helper: drop the module-global probe cache. */
export function resetProbeCache(): void {
  _probed = null;
  _probedKey = null;
  _probedAt = 0.0;
}

async function _probeOne(spec: AgentSpec, target: Target): Promise<AgentProbe> {
  let cli;
  try {
    if (target === _UNRESOLVED) {
      cli = await probeAgentCli(spec.binary, { timeout: _PROBE_TIMEOUT_SECONDS });
    } else if (!target) {
      return agentProbe(spec.id, "missing", { problem: `\`${spec.binary}\` was not found` });
    } else {
      cli = await probeAgentCli(spec.binary, { timeout: _PROBE_TIMEOUT_SECONDS, path: String(target) });
    }
  } catch (exc) {
    // probing must never break metadata for one agent
    return agentProbe(spec.id, "missing", {
      problem: `probe failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    });
  }
  if (!cli.found) return agentProbe(spec.id, "missing", { problem: cli.problem });
  if (!cli.usable) {
    return agentProbe(spec.id, "found_but_broken", { binary: cli.path, problem: cli.problem });
  }
  let efforts: readonly string[] = [];
  if (spec.reasoning !== null && spec.reasoning.source === "cli_help") {
    efforts = await _effortsFromCliHelp(cli.path, spec.reasoning.flag);
  }
  return agentProbe(spec.id, "usable", {
    binary: cli.path,
    version: cli.version,
    discovered_efforts: efforts,
  });
}

/** Resolve the effort choices to offer, preferring what the CLI reported. */
export function reasoningChoices(spec: AgentSpec, probe: AgentProbe | null): readonly string[] {
  if (spec.reasoning === null) return [];
  if (probe !== null && probe.discovered_efforts.length) return probe.discovered_efforts;
  return spec.reasoning.declared_choices;
}

// `claude --help` wraps the tier list onto a continuation line:
//     --effort <level>        Effort level for the current session
//                             (low, medium, high, xhigh, max)
// so the text after the flag is flattened before the parenthesised list is read.
const _HELP_TIER_RE = /\(([^()]{2,200})\)/;
const _HELP_TOKEN_RE = /^[a-z][a-z0-9_-]*$/;

async function _effortsFromCliHelp(binary: string, flag: string): Promise<readonly string[]> {
  const helpText = await _cliHelpText(binary);
  const index = helpText.indexOf(flag);
  if (index < 0) return [];
  const window = helpText.slice(index, index + 400).trim().split(/\s+/).join(" ");
  const match = _HELP_TIER_RE.exec(window);
  if (!match) return [];
  const values: string[] = [];
  for (const token of match[1].split(",")) {
    const candidate = token.trim().toLowerCase();
    if (_HELP_TOKEN_RE.test(candidate) && !values.includes(candidate)) values.push(candidate);
  }
  // A single word in parentheses is prose ("(default)"), not a tier list.
  return values.length > 1 ? values : [];
}

function _cliHelpText(binary: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--help"],
      { timeout: _PROBE_TIMEOUT_SECONDS * 1000, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          resolve("");
          return;
        }
        resolve((stdout || "") + (stderr || ""));
      },
    );
  }).then(
    (value) => value as string,
    () => "",
  );
}

export function resolveAgentBinaryFor(agentId: string): string | null {
  return resolveAgentBinary(agentSpec(agentId).binary);
}
