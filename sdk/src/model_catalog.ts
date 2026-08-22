// Ported 1:1 from LongHorizon-Harness src/lh_harness/model_catalog.py
//
// Best-effort, provenance-aware model discovery for local agent CLIs.
//
// The workbench must not present a documentation catalogue as proof that the
// currently logged-in user can run every model. Claude Code exposes no stable
// account-scoped model command, so its entries are deliberately labelled as
// suggestions rather than verified entitlements.
//
// Single-backend port: only `claude_code` is discovered (codex / opencode /
// deepseek_harness are not ported). The models declared in providers.json are
// appended to the Claude catalogue as `<provider>:<id>` so third-party and
// self-hosted backends appear in the dashboard picker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_SPECS,
  type AgentProbe,
  type AgentSpec,
  probeAgents,
  reasoningChoices,
} from "./agent_registry.js";
import { loadProviders } from "./providers.js";
import { DEFAULT_CLAUDE_MODEL } from "./types.js";
import { which } from "./utils/agent_cli.js";

const _CACHE_TTL_SECONDS = 30.0;
const _MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const _MODEL_ID_LIMIT = 256;
let _cachedAt = 0.0;
let _cachedResult: Record<string, unknown> | null = null;
let _cachedKey: string | null = null;
const _UNSET = Symbol("unset");

export type ModelEntry = { id: string; label: string; availability: string } & Record<string, unknown>;
export type DiscoveryRecord = {
  status: string;
  source: string;
  account_scoped: boolean;
  refreshed_at: string | number | null;
  warning: string;
};

function monotonic(): number {
  return Number(process.hrtime.bigint() / 1_000_000n) / 1000;
}

/**
 * Return agent/model choices plus honest discovery provenance.
 *
 * Results are cached briefly because Web polls `/api/meta`. `force` is used by
 * the explicit refresh endpoint and never by ordinary polling.
 */
export async function discoverModelCatalog(
  options: { force?: boolean; claudeBinary?: string | null | typeof _UNSET } = {},
): Promise<Record<string, unknown>> {
  const force = options.force ?? false;
  const now = monotonic();
  const rawClaude = options.claudeBinary === undefined ? _UNSET : options.claudeBinary;
  if (rawClaude !== _UNSET && rawClaude !== null && typeof rawClaude !== "string") {
    throw new TypeError("claude_binary must be a string or None");
  }
  const claudeBinary = rawClaude === _UNSET ? which("claude") : (rawClaude as string | null);
  const cacheKey = JSON.stringify([claudeBinary || ""]);

  if (!force && _cachedResult !== null && _cachedKey === cacheKey && now - _cachedAt < _CACHE_TTL_SECONDS) {
    return _copyJson(_cachedResult);
  }

  const [claudeModels, claudeDiscovery] = _discoverClaudeModels(claudeBinary);
  const modelsByAgent: Record<string, ModelEntry[]> = { claude_code: claudeModels };
  const discoveryByAgent: Record<string, DiscoveryRecord> = { claude_code: claudeDiscovery };
  const resolvedBinaries: Record<string, string | null> = { claude_code: claudeBinary };
  const probes = await probeAgents({ force, binaries: resolvedBinaries });
  const agents: Record<string, unknown>[] = [];
  for (const spec of AGENT_SPECS) {
    const probe = probes[spec.id];
    const binary = probe && probe.binary ? probe.binary : (resolvedBinaries[spec.id] ?? null);
    agents.push({
      id: spec.id,
      label: spec.label,
      // `available` stays a boolean for older clients; the tri-state lives
      // beside it so "on PATH but broken" is not rendered as a healthy backend.
      available: Boolean(probe && probe.usable),
      availability: probe ? probe.availability : "missing",
      version: probe ? probe.version : "",
      problem: probe ? probe.problem : "",
      binary,
      capabilities: [...spec.capabilities].sort(),
      default_model: spec.default_model,
      models: modelsByAgent[spec.id] ?? [],
      discovery: discoveryByAgent[spec.id] ?? {},
      reasoning: _reasoningPayload(spec, probe ?? null),
    });
  }
  const result = { agents, models: modelsByAgent, model_discovery: discoveryByAgent };
  _cachedAt = monotonic();
  _cachedKey = cacheKey;
  _cachedResult = _copyJson(result);
  return result;
}

/** One agent's catalogue entry, for callers that only care about one backend. */
export async function modelCatalog(
  agentId: string,
  options: { force?: boolean; claudeBinary?: string | null } = {},
): Promise<Record<string, unknown> | null> {
  const catalog = await discoverModelCatalog(options);
  const agents = catalog.agents as Record<string, unknown>[];
  return agents.find((agent) => agent.id === agentId) ?? null;
}

/** Test/refresh helper: drop the module-global catalogue cache. */
export function resetCatalogCache(): void {
  _cachedResult = null;
  _cachedKey = null;
  _cachedAt = 0.0;
}

export function _discoverClaudeModels(binary: string | null): [ModelEntry[], DiscoveryRecord] {
  const recent = _recentClaudeModels();
  const ids = [DEFAULT_CLAUDE_MODEL, "opus", "sonnet", "haiku", ...recent];
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const modelId of ids) {
    if (!_validModelId(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    let label: string;
    let availability: string;
    if (modelId === DEFAULT_CLAUDE_MODEL) {
      label = `${modelId} · default`;
      availability = "suggested";
    } else if (recent.includes(modelId)) {
      label = `${modelId} · recently used`;
      availability = "recent";
    } else {
      label = `${modelId} · Claude alias`;
      availability = "suggested";
    }
    models.push(_modelEntry(modelId, label, availability));
  }
  // Port addition: third-party / self-hosted backends declared in
  // providers.json. A `<provider>:<id>` ref routes one session through the
  // OpenAI-wire shim (see providers.ts); the entitlement is still only proven
  // when the worker starts, so these stay "suggested" like the aliases above.
  for (const entry of _providerModels()) {
    if (!_validModelId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(_modelEntry(entry.id, entry.label, "suggested"));
  }
  return [
    models,
    {
      status: binary ? "suggested" : "unavailable",
      source: "claude_cli_aliases_and_history",
      account_scoped: false,
      refreshed_at: null,
      warning: binary
        ? "Claude Code provides no stable account-level model listing command; these are CLI aliases plus recent local usage, and actual access is verified when the worker starts."
        : "Claude Code CLI not found.",
    },
  ];
}

function _providerModels(): { id: string; label: string }[] {
  let providers: Record<string, { models?: { id: string; label: string }[] }>;
  try {
    providers = loadProviders();
  } catch {
    return [];
  }
  const entries: { id: string; label: string }[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    for (const model of provider.models ?? []) {
      if (typeof model?.id !== "string" || !model.id.trim()) continue;
      entries.push({ id: `${name}:${model.id}`, label: String(model.label || `${name}:${model.id}`) });
    }
  }
  return entries;
}

function _recentClaudeModels(): string[] {
  const target = path.join(os.homedir(), ".claude.json");
  let payload: Record<string, unknown>;
  try {
    payload = _readJsonObject(target);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const projects = payload.projects;
  if (!isObject(projects)) return [];
  for (const project of Object.values(projects)) {
    const usage = isObject(project) ? project.lastModelUsage : null;
    if (!isObject(usage)) continue;
    for (const modelId of Object.keys(usage)) {
      if (_validModelId(modelId) && modelId.startsWith("claude-")) found.add(modelId);
    }
  }
  return [...found].sort().reverse().slice(0, 8);
}

function _readJsonObject(target: string): Record<string, unknown> {
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > _MAX_CATALOG_BYTES) throw new Error("catalog is missing or too large");
  const payload = JSON.parse(fs.readFileSync(target, "utf-8"));
  if (!isObject(payload)) throw new Error("catalog is not an object");
  return payload;
}

function _modelEntry(modelId: string, label: string, availability: string): ModelEntry {
  return { id: modelId, label, availability };
}

/** Describe how (and whether) this agent accepts a reasoning effort. */
export function _reasoningPayload(spec: AgentSpec, probe: AgentProbe | null): Record<string, unknown> {
  if (spec.reasoning === null) {
    return {
      supported: false,
      note: `${spec.label} has no thinking-depth switch; control reasoning strength through model choice.`,
    };
  }
  const reasoning = spec.reasoning;
  const choices = reasoningChoices(spec, probe);
  const detected = Boolean(probe && probe.discovered_efforts.length);
  return {
    supported: true,
    transport: reasoning.transport,
    flag: reasoning.flag,
    // What the backend applies when the harness passes nothing. Only Codex
    // persists this where the harness can read it, and Codex is not ported.
    provider_default: "",
    // A per-model scope means the client must re-read the selected model's own
    // list instead of caching one list for the whole agent.
    scope: reasoning.scope,
    source: detected ? "cli_help" : reasoning.source,
    allow_custom: true,
    choices: choices.map((value) => ({ id: value, label: value })),
    // Codex surfaces an unknown value as a provider 400 and the run fails with
    // a readable reason; Claude Code prints a warning and silently continues at
    // its default, so a custom value cannot be presented as verified there.
    validation: reasoning.validation,
  };
}

export function _validModelId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.trim().length <= _MODEL_ID_LIMIT &&
    !value.includes("\u0000") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _copyJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}
