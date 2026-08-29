// External-tool capabilities the operator grants per task (addition over
// upstream). A capability either injects credential env vars into the worker,
// registers an MCP server for GUI-capable roles, or both. Selection is stored
// in the run reservation so it survives resume; the supervisor gates each
// worker to exactly the selected set.
import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type McpServerSpec = {
  /** Server key inside the mcpServers object handed to the agent. */
  name: string;
  command: string;
  args: string[];
  /** Env var names (from the worker env) forwarded to the MCP process. */
  envKeys?: string[];
};

export type Capability = {
  id: string;
  label: string;
  summary: string;
  /** Env var names this capability owns; stripped from any worker that lacks it. */
  envKeys: readonly string[];
  /** An MCP server this capability adds when selected. */
  mcp?: McpServerSpec;
  /** Always granted (cannot be toggled off). Browser is on by default. */
  alwaysOn?: boolean;
  /** Default state of the toggle in the UI. */
  defaultOn?: boolean;
  /** Docs shown next to the toggle. */
  note?: string;
  /** How an agent invokes this capability; injected into role prompts. */
  promptHint?: string;
};

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "browser",
    label: "Web browser",
    summary: "Navigate, click, type and screenshot web pages (Playwright MCP + headless Chromium).",
    envKeys: [],
    alwaysOn: true,
    defaultOn: true,
    note: "Configured by `lh-harness-eray start`; baked into the container image.",
    promptHint: "browser tools are available through the configured MCP server (navigate, click, type, screenshot).",
  },
  {
    id: "github",
    label: "GitHub",
    summary: "git clone/push and `gh` (create repos, PRs, issues) as your account.",
    envKeys: ["GH_TOKEN", "GITHUB_TOKEN"],
    defaultOn: false,
    note: "Uses a scoped token; a push is not reversible.",
    promptHint:
      "GH_TOKEN and GITHUB_TOKEN are set; `gh` and HTTPS git remotes authenticate with them automatically (for git, use `gh auth setup-git` or a `https://x-access-token:${GH_TOKEN}@github.com/...` remote).",
  },
  {
    id: "vercel",
    label: "Vercel",
    summary: "Deploy web projects with `vercel deploy` as your account.",
    envKeys: ["VERCEL_TOKEN"],
    defaultOn: false,
    note: "A deploy is public; consider limiting the token to one project.",
    promptHint:
      'VERCEL_TOKEN is set; deploy non-interactively with `vercel deploy --prod --yes --token "$VERCEL_TOKEN"` (use `npx -y vercel` if the `vercel` binary is not on PATH). Never run `vercel login`.',
  },
  {
    id: "higgsfield",
    label: "Higgsfield (AI media)",
    summary: "Generate images/video via the Higgsfield MCP server.",
    envKeys: ["HIGGSFIELD_API_KEY"],
    mcp: {
      name: "higgsfield",
      command: "npx",
      args: ["-y", "@higgsfield/mcp"],
      envKeys: ["HIGGSFIELD_API_KEY"],
    },
    defaultOn: false,
    note: "Needs a Higgsfield API key and available credits.",
    promptHint: "generate media through the `higgsfield` MCP server tools; HIGGSFIELD_API_KEY is set for it.",
  },
  {
    id: "email",
    label: "Email (Resend)",
    summary: "Send email through the Resend API.",
    envKeys: ["RESEND_API_KEY", "LH_EMAIL_FROM"],
    defaultOn: false,
    note: "Email is irreversible; keep an 'ask before sending' rule in the task.",
    promptHint:
      "send through the Resend HTTP API using RESEND_API_KEY (from-address in LH_EMAIL_FROM). Email is irreversible; follow any ask-before-sending rule in the task.",
  },
];

const BY_ID = new Map(CAPABILITIES.map((cap) => [cap.id, cap]));

export function getCapability(id: string): Capability | null {
  return BY_ID.get(id) ?? null;
}

/** The env var names owned by any capability (the full gated set). */
export function allCapabilityEnvKeys(): string[] {
  return CAPABILITIES.flatMap((cap) => [...cap.envKeys]);
}

/** Normalize a requested selection: always-on ids are forced in, unknowns dropped. */
export function resolveCapabilities(requested: readonly string[] | null | undefined): string[] {
  const chosen = new Set<string>();
  for (const cap of CAPABILITIES) if (cap.alwaysOn) chosen.add(cap.id);
  for (const id of requested ?? []) if (BY_ID.has(String(id))) chosen.add(String(id));
  return CAPABILITIES.filter((cap) => chosen.has(cap.id)).map((cap) => cap.id);
}

/**
 * Given the process env, produce the worker env for a run: every capability
 * env key not owned by a selected capability is removed, so an unselected
 * integration is invisible to that worker.
 */
export function gateWorkerEnv(
  baseEnv: NodeJS.ProcessEnv,
  selected: readonly string[],
): NodeJS.ProcessEnv {
  const selectedSet = new Set(selected);
  const keptKeys = new Set<string>();
  for (const cap of CAPABILITIES) {
    if (selectedSet.has(cap.id)) for (const key of cap.envKeys) keptKeys.add(key);
  }
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of allCapabilityEnvKeys()) {
    if (!keptKeys.has(key)) delete env[key];
  }
  return env;
}

/**
 * Write the per-run MCP config (browser server, if configured, plus the MCP
 * server of every selected capability that declares one) and return its path,
 * or null when there is nothing to write. `browserConfigPath` is the static
 * config the deployment already set up for the browser.
 */
export function writeRunMcpConfig(
  runDir: string,
  selected: readonly string[],
  env: NodeJS.ProcessEnv,
  browserConfigPath: string | null,
): string | null {
  const selectedSet = new Set(selected);
  const servers: Record<string, unknown> = {};
  if (selectedSet.has("browser") && browserConfigPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(browserConfigPath, "utf-8"));
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        Object.assign(servers, parsed.mcpServers);
      }
    } catch {
      /* browser server unavailable: continue without it */
    }
  }
  for (const cap of CAPABILITIES) {
    if (!selectedSet.has(cap.id) || !cap.mcp) continue;
    const spec = cap.mcp;
    const serverEnv: Record<string, string> = {};
    for (const key of spec.envKeys ?? []) {
      const value = env[key];
      if (value) serverEnv[key] = value;
    }
    servers[spec.name] = {
      command: spec.command,
      args: spec.args,
      ...(Object.keys(serverEnv).length ? { env: serverEnv } : {}),
    };
  }
  if (!Object.keys(servers).length) return null;
  const target = path.join(runDir, "tmp", "mcp.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  return target;
}

/**
 * How the supervisor tells the worker which capabilities the operator granted.
 * The worker cannot re-derive this from env presence alone: a granted
 * capability may lack its credential (report it as blocked, not invisible).
 */
export const GRANTED_CAPABILITIES_ENV = "LH_HARNESS_GRANTED_CAPABILITIES";

/** Parse the supervisor's granted-capability list; null when the var is unset. */
export function parseGrantedCapabilities(value: string | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  const ids = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item);
  return resolveCapabilities(ids);
}

/**
 * Fallback for unsupervised runs (direct `lh-harness-eray run`), where no gating
 * happened: every capability whose credential is present in the env is
 * effectively available, plus the always-on ones.
 */
export function deriveCapabilitiesFromEnv(env: NodeJS.ProcessEnv): string[] {
  return CAPABILITIES.filter(
    (cap) => cap.alwaysOn || (cap.envKeys.length > 0 && cap.envKeys.some((key) => Boolean(env[key]))),
  ).map((cap) => cap.id);
}

/**
 * The "Provisioned external tools" prompt section for the given grant set.
 * Injected into manager/executor/auditor prompts so agents know which
 * integrations the operator already provisioned instead of asking the user
 * for credentials that are sitting in their environment.
 */
export function capabilityPromptNote(
  selected: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: { readOnly?: boolean },
): string {
  const selectedSet = new Set(selected);
  const lines: string[] = [];
  const missing: string[] = [];
  for (const cap of CAPABILITIES) {
    if (!selectedSet.has(cap.id)) continue;
    const credentialed = cap.envKeys.length === 0 || cap.envKeys.some((key) => Boolean(env[key]));
    if (!credentialed) {
      lines.push(
        `- ${cap.label}: granted by the operator, but its credential is not configured. Treat it as unavailable and report the blocker instead of improvising access.`,
      );
      continue;
    }
    lines.push(`- ${cap.label}: ${cap.promptHint ?? cap.summary}`);
  }
  for (const cap of CAPABILITIES) {
    if (!selectedSet.has(cap.id)) missing.push(cap.label);
  }
  if (!lines.length) return "";
  const rules = options?.readOnly
    ? "These integrations are for read-only verification here (inspect deployments, repos, or sent state); never create, deploy, push, send, or mutate through them, and never print credential values."
    : "These credentials are already provisioned by the operator. Never ask the user to paste a token or log in for them, never print credential values into output or files, and never run interactive login flows.";
  const notGranted = missing.length
    ? `\nNot granted this run: ${missing.join(", ")}. Do not assume or request those credentials mid-run; if one is genuinely required, report it so the operator can be asked.`
    : "";
  return `Provisioned external tools (operator-granted for this run):\n${lines.join("\n")}\n${rules}${notGranted}`;
}

/** Which selected capabilities have their credentials present in this env. */
export function capabilityStatus(env: NodeJS.ProcessEnv): { id: string; label: string; ready: boolean; alwaysOn: boolean }[] {
  return CAPABILITIES.map((cap) => ({
    id: cap.id,
    label: cap.label,
    alwaysOn: Boolean(cap.alwaysOn),
    ready: cap.envKeys.length === 0 ? true : cap.envKeys.some((key) => Boolean(env[key])),
  }));
}

// --- host credential discovery (best-effort) --------------------------------

export const SECRETS_FILE = path.join(process.env.LH_HARNESS_STATE_ROOT || path.join(os.homedir(), ".lh-harness"), "secrets.env");

function readCli(command: string, args: string[]): string | null {
  try {
    const result = child_process.spawnSync(command, args, { encoding: "utf-8", timeout: 15_000 });
    if (result.status === 0) {
      const value = (result.stdout || "").trim();
      return value || null;
    }
  } catch {
    /* tool absent */
  }
  return null;
}

/** Discover GitHub and Vercel tokens already present on the host. */
export function discoverHostSecrets(): Record<string, string> {
  const found: Record<string, string> = {};
  const gh = readCli("gh", ["auth", "token"]);
  if (gh) {
    found.GH_TOKEN = gh;
    found.GITHUB_TOKEN = gh;
  }
  try {
    const vercelAuth = path.join(os.homedir(), "Library", "Application Support", "com.vercel.cli", "auth.json");
    const parsed = JSON.parse(fs.readFileSync(vercelAuth, "utf-8"));
    // The Vercel CLI stores a short-lived OAuth token (hours) next to an
    // `expiresAt` stamp (seconds or milliseconds). Copying an expired one
    // into secrets.env plants a credential that is guaranteed to 403.
    const expiresAtRaw = Number(parsed?.expiresAt);
    const expiresAtMs =
      Number.isFinite(expiresAtRaw) && expiresAtRaw > 0
        ? expiresAtRaw > 1e12
          ? expiresAtRaw
          : expiresAtRaw * 1000
        : null;
    const expired = expiresAtMs !== null && expiresAtMs <= Date.now();
    if (parsed?.token && !expired) found.VERCEL_TOKEN = String(parsed.token);
  } catch {
    /* not logged into vercel */
  }
  return found;
}

/** Parse a KEY=VALUE env file (comments and blanks ignored). */
export function parseEnvFile(target: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = fs.readFileSync(target, "utf-8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
