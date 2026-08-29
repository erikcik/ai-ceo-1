import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { composerHooks, operatorControlHooks, progressNoteGaps, readLedger, writeScopeHooks } from "../../src/loop/hooks.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lh-hooks-"));
}

const noop = { signal: new AbortController().signal };

async function fire(set: ReturnType<typeof writeScopeHooks>, event: "PreToolUse" | "PostToolUse" | "Stop", input: Record<string, unknown>) {
  const matchers = set[event] ?? [];
  let last: unknown = { continue: true };
  for (const matcher of matchers) {
    const toolName = String(input.tool_name ?? "");
    if (matcher.matcher && matcher.matcher !== "*" && !new RegExp(`^(${matcher.matcher})$`).test(toolName)) continue;
    for (const hook of matcher.hooks) last = await hook(input as never, undefined, noop);
  }
  return last as Record<string, unknown>;
}

test("write scope denies files outside the allowed roots and always-denied paths", async () => {
  const ws = tmp();
  const allowed = path.join(ws, "state", "research");
  const denied = path.join(ws, "state", "contracts");
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(denied, { recursive: true });
  const set = writeScopeHooks({ roleName: "planner", allowed: [allowed], denied: [denied] }, ws);
  const ok = await fire(set, "PreToolUse", { tool_name: "Write", tool_input: { file_path: path.join(allowed, "a.md") } });
  assert.equal((ok.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision, undefined);
  const outside = await fire(set, "PreToolUse", { tool_name: "Write", tool_input: { file_path: path.join(ws, "index.html") } });
  assert.equal((outside.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
  const blocked = await fire(set, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(denied, "x.json") } });
  assert.match(String((blocked.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /harness-owned/);
  // Relative paths resolve against the workspace.
  const relative = await fire(set, "PreToolUse", { tool_name: "Write", tool_input: { file_path: "state/research/b.md" } });
  assert.equal((relative.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision, undefined);
});

test("composer hooks ledger every write with hashes, record bash, deny the contract and gate the stop", async () => {
  const ws = tmp();
  const stateDir = path.join(ws, ".lh-harness", "runs", "r1", "state");
  const ledgerPath = path.join(stateDir, "evidence", "s1", "ledger.jsonl");
  const progressPath = path.join(stateDir, "progress", "s1.md");
  const contractsDir = path.join(stateDir, "contracts");
  fs.mkdirSync(contractsDir, { recursive: true });
  const set = composerHooks({
    workspace: ws,
    subtaskId: "s1",
    round: 1,
    ledgerPath,
    progressPath,
    criteriaIds: ["c1", "c2"],
    denied: [contractsDir],
    maxStopBlocks: 2,
  });
  const target = path.join(ws, "site", "index.html");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await fire(set, "PreToolUse", { tool_name: "Write", tool_input: { file_path: target } });
  fs.writeFileSync(target, "<h1>hi</h1>");
  await fire(set, "PostToolUse", { tool_name: "Write", tool_input: { file_path: target } });
  await fire(set, "PostToolUse", { tool_name: "Bash", tool_input: { command: "ffprobe out.mp4" } });
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]!.kind, "write");
  assert.equal(ledger[0]!.sha256_before, null);
  assert.match(String(ledger[0]!.sha256_after), /^[0-9a-f]{64}$/);
  assert.equal(ledger[1]!.command, "ffprobe out.mp4");

  const deny = await fire(set, "PreToolUse", { tool_name: "Write", tool_input: { file_path: path.join(contractsDir, "s1.json") } });
  assert.equal((deny.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");

  // Stop gate: blocked until the progress note is complete, at most maxStopBlocks times.
  const first = await fire(set, "Stop", { hook_event_name: "Stop" });
  assert.equal(first.decision, "block");
  assert.match(String(first.reason), /does not exist/);
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, "# s1\nStatus: done\n\n## Done\nx\n## Evidence\n- c1 → shot.png\n## How to verify\nls\n");
  const second = await fire(set, "Stop", { hook_event_name: "Stop" });
  assert.equal(second.decision, "block");
  assert.match(String(second.reason), /criterion c2/);
  const third = await fire(set, "Stop", { hook_event_name: "Stop" });
  assert.equal(third.continue, true);
  assert.match(String(third.systemMessage), /still incomplete/);
  assert.deepEqual(progressNoteGaps(progressPath, ["c1"]), []);
});

test("operator controls: AGENT_STOP denies, STEER.md is surfaced once", async () => {
  const ws = tmp();
  const set = operatorControlHooks(ws);
  const plain = await fire(set, "PreToolUse", { tool_name: "Read", tool_input: {} });
  assert.equal(plain.continue, true);
  fs.writeFileSync(path.join(ws, "STEER.md"), "use blue");
  const steered = await fire(set, "PreToolUse", { tool_name: "Read", tool_input: {} });
  assert.match(String((steered.hookSpecificOutput as Record<string, unknown>).additionalContext), /OPERATOR STEERING: use blue/);
  assert.equal(fs.readFileSync(path.join(ws, "STEER.md"), "utf-8"), "");
  fs.writeFileSync(path.join(ws, "AGENT_STOP"), "");
  const stopped = await fire(set, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal((stopped.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
});
