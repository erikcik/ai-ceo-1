import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gateWorkerEnv,
  resolveCapabilities,
  writeRunMcpConfig,
  capabilityStatus,
  parseEnvFile,
} from "../src/capabilities.js";

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

test("parseEnvFile reads KEY=VALUE, ignoring comments and quotes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-env-"));
  const target = path.join(dir, "secrets.env");
  fs.writeFileSync(target, "# comment\nGH_TOKEN=abc\nLH_EMAIL_FROM=\"you@example.com\"\n\n");
  const parsed = parseEnvFile(target);
  assert.equal(parsed.GH_TOKEN, "abc");
  assert.equal(parsed.LH_EMAIL_FROM, "you@example.com");
});
