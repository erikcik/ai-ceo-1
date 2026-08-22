import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCapabilities, writeRunMcpConfig } from "../src/capabilities.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude_code.js";

// The end-to-end guarantee the operator cares about: an Auditor really receives
// the Playwright browser server, in exactly the way both deployment modes wire
// it (a per-run MCP config composed from the browser config the deployment set
// up). This mirrors the supervisor's writeRunMcpConfig → worker env → adapter
// chain without launching an agent.
function perRunConfigLikeSupervisor(runDir: string, granted: string[]): string {
  // Stand in for the deployment's browser config: Docker bakes
  // /app/mcp/playwright.mcp.json; `start` (host) exports the plugin's.
  const browser = path.join(runDir, "browser.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    browser,
    JSON.stringify({ mcpServers: { playwright: { command: "playwright-mcp", args: ["--headless", "--isolated", "--no-sandbox"] } } }),
  );
  const config = writeRunMcpConfig(runDir, resolveCapabilities(granted), {}, browser);
  assert.ok(config, "the per-run MCP config must be written when the browser is granted");
  return config as string;
}

for (const role of ["gui_auditor", "cli_auditor", "auditor_format_repair"] as const) {
  test(`the ${role} receives the Playwright browser server`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gui-"));
    const config = perRunConfigLikeSupervisor(dir, ["browser"]);
    const adapter = new ClaudeCodeAdapter({ role, mcpConfig: config, workspacePath: dir });
    const servers = adapter.computerUseServers();
    assert.ok(servers, `${role} must load computer-use servers`);
    assert.ok(servers?.playwright, `${role} must have the playwright server`);
    assert.equal((servers?.playwright as { command: string }).command, "playwright-mcp");
    assert.equal(adapter.computerMcpConfigured, true);
  });
}

test("executors also get the browser; the manager and final reply do not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gui-"));
  const config = perRunConfigLikeSupervisor(dir, ["browser"]);
  for (const role of ["gui_executor", "cli_executor"] as const) {
    const adapter = new ClaudeCodeAdapter({ role, mcpConfig: config, workspacePath: dir });
    assert.ok(adapter.computerUseServers()?.playwright, `${role} must have the browser`);
  }
  for (const role of ["manager", "final_response"] as const) {
    const adapter = new ClaudeCodeAdapter({ role, mcpConfig: config, workspacePath: dir });
    assert.equal(adapter.computerUseServers(), null, `${role} must get no tools`);
  }
});
