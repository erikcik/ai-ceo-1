/**
 * Third-party model providers. Every session normally runs on the claude CLI's
 * configured Anthropic account; a model ref of the form "<provider>:<model>"
 * routes that one session to an Anthropic-compatible API declared in
 * providers.json instead. The registry holds only the base URL and the NAME of
 * the env var carrying the key -- the key itself never lives in the repo.
 *
 *   BUILDER_MODEL=orca:obsidian/Qwen3.8-27B npm run loop -- ../runs/mytask
 *
 * Provider selection stays with the operator, set through the *_MODEL env vars
 * when a run is initialized. An initialization prompt cannot choose a provider,
 * for the same reason it cannot choose a model: what executes the work is part
 * of the frozen core's operator surface, not the task's.
 *
 * Two things change inside a third-party session, and the caller must know both:
 *  - WebSearch/WebFetch are server-side Anthropic tools and do not exist behind
 *    another base URL, so session.ts disallows them; web research happens
 *    through Bash (curl GETs pass the safety gate, mutating verbs do not).
 *  - total_cost_usd is computed against Anthropic pricing, so treat reported
 *    session cost as unreliable for provider-routed sessions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Provider = {
  baseUrl: string;          // API root of the provider
  apiKeyEnv: string;        // env var the key is read from at run time
  smallFastModel?: string;  // model for the CLI's internal small/fast calls; defaults to the session model
  /**
   * Which wire format the backend speaks. "anthropic" (default) means
   * <baseUrl>/v1/messages exists and sessions talk to it near-directly;
   * "openai" means only <baseUrl>/v1/chat/completions exists and the local
   * shim translates each request/response (see shim.ts).
   */
  wire?: "anthropic" | "openai";
  /** Merged into every upstream request body (openai wire only) -- e.g. vLLM's chat_template_kwargs. */
  extraBody?: Record<string, unknown>;
  /** Models to offer in the operator console's dropdown, as {id, label}. */
  models?: { id: string; label: string }[];
  /**
   * Extended-thinking policy, anthropic wire only. Default "disabled": the shim
   * injects `thinking:{"type":"disabled"}`, because open-weight backends tend
   * to default thinking ON when the field is absent, and a slow self-hosted
   * model can spend 15-30 minutes per turn on reasoning tokens while the
   * stream keeps the connection alive -- which looks exactly like a hang.
   * Set "backend-default" to skip the shim and let the server decide.
   */
  thinking?: "disabled" | "backend-default";
  note?: string;
};

const REGISTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "providers.json");

export function loadProviders(file: string = REGISTRY): Record<string, Provider> {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export type ResolvedModel = {
  model?: string;
  provider?: string;
  /** Full replacement env for the session subprocess (the SDK does not merge). */
  env?: Record<string, string | undefined>;
  /** When set, the session must route through ensureShim(shim) and use the returned local base URL. */
  shim?: import("./shim.js").ShimConfig;
};

/**
 * "orca:obsidian/Qwen3.8-27B" -> that model on the orca provider.
 * Anything without a registered "<provider>:" prefix passes through untouched,
 * so plain Anthropic ids ("claude-opus-5", "sonnet") behave exactly as before.
 */
export function resolveModel(
  ref?: string,
  providers: Record<string, Provider> = loadProviders(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModel {
  if (!ref) return {};
  const m = ref.match(/^([a-z][a-z0-9_-]*):(.+)$/i);
  if (!m || !providers[m[1]]) {
    if (m && !providers[m[1]] && !ref.startsWith("claude")) {
      const known = Object.keys(providers).join(", ") || "<none>";
      throw new Error(`model ref '${ref}' names unknown provider '${m[1]}' (providers.json declares: ${known})`);
    }
    return { model: ref };
  }
  const [, name, model] = m;
  const p = providers[name];
  const key = env[p.apiKeyEnv];
  if (!key) throw new Error(`provider '${name}' requires ${p.apiKeyEnv} to be set; the key is never stored in the repo`);
  const shim: import("./shim.js").ShimConfig | undefined =
    p.wire === "openai"
      ? { upstreamBase: p.baseUrl, wire: "openai", extraBody: p.extraBody }
      : p.thinking === "backend-default"
        ? undefined
        : { upstreamBase: p.baseUrl, wire: "anthropic" };
  return {
    model,
    provider: name,
    ...(shim ? { shim } : {}),
    env: {
      ...env,
      ANTHROPIC_BASE_URL: p.baseUrl,
      ANTHROPIC_AUTH_TOKEN: key,
      // the operator's Anthropic credentials must never reach a third party
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      // internal small-model calls must also stay on the provider
      ANTHROPIC_SMALL_FAST_MODEL: p.smallFastModel ?? model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: p.smallFastModel ?? model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // self-hosted third-party backends are slower than Anthropic's; don't let
      // the CLI's default request timeout kill an otherwise healthy session
      API_TIMEOUT_MS: env.API_TIMEOUT_MS ?? "600000",
    },
  };
}

/** Server-side Anthropic tools that do not exist behind a third-party base URL. */
export const PROVIDER_UNAVAILABLE_TOOLS = ["WebSearch", "WebFetch"];
