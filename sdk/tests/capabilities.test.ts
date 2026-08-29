import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capabilityPromptNote,
  capabilityStatus,
  deriveCapabilitiesFromEnv,
  discoverHostSecrets,
  gateWorkerEnv,
  parseEnvFile,
  parseGrantedCapabilities,
  resolveCapabilities,
  writeRunMcpConfig,
} from "../src/capabilities.js";

test("discoverHostSecrets skips an expired Vercel CLI token", { skip: process.platform !== "darwin" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-home-"));
  const authDir = path.join(home, "Library", "Application Support", "com.vercel.cli");
  fs.mkdirSync(authDir, { recursive: true });
  const authPath = path.join(authDir, "auth.json");
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // expiresAt in seconds, already past: the CLI's ~8h OAuth token is dead.
    fs.writeFileSync(authPath, JSON.stringify({ token: "dead", expiresAt: 1_000_000_000 }));
    assert.equal(discoverHostSecrets().VERCEL_TOKEN, undefined, "expired token must not be discovered");
    // Same stamp in the future (milliseconds this time): discovered.
    fs.writeFileSync(authPath, JSON.stringify({ token: "alive", expiresAt: Date.now() + 3_600_000 }));
    assert.equal(discoverHostSecrets().VERCEL_TOKEN, "alive");
    // No expiry stamp at all (a hand-made long-lived token): discovered.
    fs.writeFileSync(authPath, JSON.stringify({ token: "manual" }));
    assert.equal(discoverHostSecrets().VERCEL_TOKEN, "manual");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("resolveCapabilities forces always-on and drops unknowns", () => {
  assert.deepEqual(resolveCapabilities(["github", "nonsense"]), ["browser", "github"]);
  assert.deepEqual(resolveCapabilities(null), ["browser"]);
});

test("gateWorkerEnv hides the secrets of unselected capabilities", () => {
  const base = { GH_TOKEN: "gh", GITHUB_TOKEN: "gh", VERCEL_TOKEN: "vc", RESEND_API_KEY: "re", PATH: "/usr/bin" };
  const withGithub = gateWorkerEnv(base, resolveCapabilities(["github"]));
  assert.equal(withGithub.GH_TOKEN, "gh");
  assert.equal(withGithub.GITHUB_TOKEN, "gh");
  assert.equal(withGithub.VERCEL_TOKEN, undefined, "an unselected capability's secret must be stripped");
  assert.equal(withGithub.RESEND_API_KEY, undefined);
  assert.equal(withGithub.PATH, "/usr/bin", "non-capability env is preserved");
  const none = gateWorkerEnv(base, resolveCapabilities([]));
  assert.equal(none.GH_TOKEN, undefined);
  assert.equal(none.VERCEL_TOKEN, undefined);
});

test("writeRunMcpConfig composes browser + selected MCP servers only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-"));
  const browser = path.join(dir, "browser.json");
  fs.writeFileSync(browser, JSON.stringify({ mcpServers: { playwright: { command: "playwright-mcp", args: ["--headless"] } } }));
  const withHiggs = writeRunMcpConfig(dir, resolveCapabilities(["higgsfield"]), { HIGGSFIELD_API_KEY: "k" }, browser);
  assert.ok(withHiggs);
  const parsed = JSON.parse(fs.readFileSync(withHiggs, "utf-8"));
  assert.ok(parsed.mcpServers.playwright, "browser server is present");
  assert.ok(parsed.mcpServers.higgsfield, "selected capability server is present");
  assert.equal(parsed.mcpServers.higgsfield.env.HIGGSFIELD_API_KEY, "k");
  // Browser off + no MCP capability => no config written.
  const none = writeRunMcpConfig(dir, [], {}, browser);
  assert.equal(none, null);
});

test("capabilityStatus marks a capability ready only when its credential is present", () => {
  const status = capabilityStatus({ GH_TOKEN: "x" });
  const github = status.find((item) => item.id === "github");
  const vercel = status.find((item) => item.id === "vercel");
  assert.equal(github?.ready, true);
  assert.equal(vercel?.ready, false);
  assert.equal(status.find((item) => item.id === "browser")?.ready, true, "always-on browser is always ready");
});

test("parseGrantedCapabilities distinguishes unset from empty and normalizes", () => {
  assert.equal(parseGrantedCapabilities(undefined), null, "unset means no supervisor grant list");
  assert.equal(parseGrantedCapabilities(null), null);
  assert.deepEqual(parseGrantedCapabilities(""), ["browser"], "empty grant still forces always-on");
  assert.deepEqual(parseGrantedCapabilities("vercel, github ,bogus"), ["browser", "github", "vercel"]);
});

test("deriveCapabilitiesFromEnv reflects present credentials plus always-on", () => {
  assert.deepEqual(deriveCapabilitiesFromEnv({}), ["browser"]);
  assert.deepEqual(deriveCapabilitiesFromEnv({ VERCEL_TOKEN: "vc", RESEND_API_KEY: "re" }), [
    "browser",
    "vercel",
    "email",
  ]);
});

test("capabilityPromptNote announces granted tools without leaking values", () => {
  const env = { GH_TOKEN: "secret-gh", GITHUB_TOKEN: "secret-gh", VERCEL_TOKEN: "secret-vc" };
  const note = capabilityPromptNote(resolveCapabilities(["github", "vercel"]), env);
  assert.match(note, /Provisioned external tools/);
  assert.match(note, /GitHub: GH_TOKEN and GITHUB_TOKEN are set/);
  assert.match(note, /Vercel: VERCEL_TOKEN is set/);
  assert.match(note, /Never ask the user to paste a token/);
  assert.match(note, /Not granted this run: Higgsfield \(AI media\), Email \(Resend\)/);
  assert.ok(!note.includes("secret-gh") && !note.includes("secret-vc"), "credential values must never appear");
});

test("capabilityPromptNote reports a granted capability whose credential is missing", () => {
  const note = capabilityPromptNote(resolveCapabilities(["email"]), {});
  assert.match(note, /Email \(Resend\): granted by the operator, but its credential is not configured/);
});

test("capabilityPromptNote read-only variant swaps the usage rules", () => {
  const note = capabilityPromptNote(resolveCapabilities(["vercel"]), { VERCEL_TOKEN: "vc" }, { readOnly: true });
  assert.match(note, /read-only verification/);
  assert.ok(!note.includes("Never ask the user to paste a token"));
});

test("parseEnvFile reads KEY=VALUE, ignoring comments and quotes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-env-"));
  const target = path.join(dir, "secrets.env");
  fs.writeFileSync(target, "# comment\nGH_TOKEN=abc\nLH_EMAIL_FROM=\"you@example.com\"\n\n");
  const parsed = parseEnvFile(target);
  assert.equal(parsed.GH_TOKEN, "abc");
  assert.equal(parsed.LH_EMAIL_FROM, "you@example.com");
});
