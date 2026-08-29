// Ported from LongHorizon-Harness adapters/claude_permissions.py (spec 03 §1.5, §3.2).
/**
 * The four read-only layers, unit by unit: the role deny-list (A), the path
 * deny rules (B) and the workspace snapshot guard (C). Layer D lives in the
 * claude_code adapter test.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  isAuditorRole,
  pathDenyRules,
  policyForRole,
  snapshotWorkspace,
  workspaceSnapshotDiff,
} from "../src/adapters/claude_permissions.js";

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-perm-")));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

test("prompt_tailor and final_response get the no-side-effect deny list", () => {
  for (const role of ["prompt_tailor", "final_response"]) {
    const policy = policyForRole(role);
    assert.equal(policy.permission_mode, "bypassPermissions");
    assert.deepEqual([...policy.disallowed_tools], [
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
      "Agent",
      "mcp__*",
      "WebSearch",
      "WebFetch",
    ]);
    assert.equal(policy.load_computer_mcp, false);
    assert.equal(policy.workspace_read_only, true);
    assert.equal(policy.subagents, false);
  }
});

test("planner and composer keep every tool and may load the computer MCP", () => {
  for (const role of ["planner", "composer"]) {
    const policy = policyForRole(role);
    assert.deepEqual([...policy.disallowed_tools], []);
    assert.equal(policy.load_computer_mcp, true);
    assert.equal(policy.workspace_read_only, false);
    assert.equal(policy.subagents, true);
    assert.equal(isAuditorRole(role), false);
  }
});

test("the rubric agent loses Bash and the MCP servers but keeps subagents", () => {
  const policy = policyForRole("rubric");
  assert.deepEqual([...policy.disallowed_tools], ["Bash", "mcp__*"]);
  assert.equal(policy.load_computer_mcp, false);
  assert.equal(policy.workspace_read_only, false);
  assert.equal(policy.subagents, true);
  assert.equal(isAuditorRole("rubric"), false);
});

test("the evaluator keeps every tool — hence the snapshot guard", () => {
  const policy = policyForRole("evaluator");
  assert.deepEqual([...policy.disallowed_tools], []);
  assert.ok(!policy.disallowed_tools.includes("Bash"));
  assert.equal(policy.load_computer_mcp, true);
  assert.equal(policy.workspace_read_only, true);
  assert.equal(policy.subagents, true);
  assert.equal(isAuditorRole("evaluator"), true);
  assert.equal(isAuditorRole("composer"), false);
});

test("an unknown role is rejected with the verbatim message", () => {
  assert.throws(() => policyForRole("reviewer"), /^Error: Unknown Claude Code role: reviewer$/);
});

test("path deny rules anchor at the filesystem root and de-duplicate", () => {
  const root = tmpRoot();
  const rules = pathDenyRules([root, root]);
  const anchored = root.replace(/^\/+/, "");
  assert.deepEqual(rules, [
    `Read(//${anchored})`,
    `Read(//${anchored}/**)`,
    `Edit(//${anchored})`,
    `Edit(//${anchored}/**)`,
  ]);
});

test("snapshot records files with a sha256 and skips hidden trees", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "task.txt"), "hello");
  fs.mkdirSync(path.join(root, "logs"));
  fs.writeFileSync(path.join(root, "logs", "events.jsonl"), "{}\n");

  const full = snapshotWorkspace(root);
  assert.deepEqual(full.errors, []);
  assert.ok("task.txt" in full.records);
  assert.ok("logs/events.jsonl" in full.records);
  const record = full.records["task.txt"];
  assert.equal(record[0], "file");
  assert.equal(record[2], 5);
  assert.equal(record[4], crypto.createHash("sha256").update("hello").digest("hex"));

  const guarded = snapshotWorkspace(root, [path.join(root, "logs")]);
  assert.ok("task.txt" in guarded.records);
  assert.ok(!("logs" in guarded.records));
  assert.ok(!("logs/events.jsonl" in guarded.records));
});

test("files above 4 MiB are recorded without a digest", () => {
  const root = tmpRoot();
  const big = path.join(root, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 4 * 1024 * 1024 + 1);
  const small = path.join(root, "small.bin");
  fs.writeFileSync(small, "");
  fs.truncateSync(small, 4 * 1024 * 1024);

  const snap = snapshotWorkspace(root);
  assert.equal(snap.records["big.bin"][4], null);
  assert.equal(typeof snap.records["small.bin"][4], "string");
});

test("symlinks are recorded but never followed", () => {
  const outside = tmpRoot();
  fs.writeFileSync(path.join(outside, "secret.txt"), "private");
  const root = tmpRoot();
  fs.symlinkSync(outside, path.join(root, "link"));

  const snap = snapshotWorkspace(root);
  assert.equal(snap.records["link"][0], "symlink");
  assert.equal(snap.records["link"][3], outside);
  assert.ok(!("link/secret.txt" in snap.records));
});

test("a missing workspace yields the one snapshot error", () => {
  const missing = path.join(tmpRoot(), "gone");
  const snap = snapshotWorkspace(missing);
  assert.deepEqual(snap.records, {});
  assert.equal(snap.errors.length, 1);
  assert.ok(snap.errors[0].startsWith("workspace does not exist: "));
});

test("the diff reports added, changed, deleted and type_changed", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "keep.txt"), "same");
  fs.writeFileSync(path.join(root, "edit.txt"), "before");
  fs.writeFileSync(path.join(root, "gone.txt"), "bye");
  fs.writeFileSync(path.join(root, "swap"), "file now");
  const before = snapshotWorkspace(root);

  fs.writeFileSync(path.join(root, "new.txt"), "fresh");
  fs.writeFileSync(path.join(root, "edit.txt"), "after-and-longer");
  fs.rmSync(path.join(root, "gone.txt"));
  fs.rmSync(path.join(root, "swap"));
  fs.mkdirSync(path.join(root, "swap"));
  const after_ = snapshotWorkspace(root);

  const diff = workspaceSnapshotDiff(before, after_);
  assert.deepEqual(Object.keys(diff), [
    "verifier_workspace_guard",
    "verifier_workspace_restore_on_mutation",
    "verifier_workspace_restored",
    "verifier_workspace_mutation_detected",
    "verifier_workspace_mutations",
    "verifier_workspace_mutation_counts",
    "verifier_workspace_snapshot_errors",
  ]);
  assert.equal(diff.verifier_workspace_guard, true);
  assert.equal(diff.verifier_workspace_restore_on_mutation, true);
  // Hard-coded false upstream: no restoration is implemented anywhere.
  assert.equal(diff.verifier_workspace_restored, false);
  assert.equal(diff.verifier_workspace_mutation_detected, true);
  assert.deepEqual(diff.verifier_workspace_mutations, {
    added: ["new.txt"],
    changed: ["edit.txt"],
    deleted: ["gone.txt"],
    type_changed: ["swap"],
  });
  assert.deepEqual(diff.verifier_workspace_mutation_counts, {
    added: 1,
    changed: 1,
    deleted: 1,
    type_changed: 1,
  });
  assert.deepEqual(diff.verifier_workspace_snapshot_errors, []);
});

test("an untouched workspace reports no mutation", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "b.txt"), "b");

  const diff = workspaceSnapshotDiff(snapshotWorkspace(root), snapshotWorkspace(root));
  assert.equal(diff.verifier_workspace_mutation_detected, false);
  assert.deepEqual(diff.verifier_workspace_mutations, {
    added: [],
    changed: [],
    deleted: [],
    type_changed: [],
  });
});

test("snapshot errors from both walks are concatenated and capped at 100", () => {
  const before = { records: {}, errors: Array.from({ length: 80 }, (_, i) => `before-${i}`) };
  const after_ = { records: {}, errors: Array.from({ length: 80 }, (_, i) => `after-${i}`) };
  const diff = workspaceSnapshotDiff(before, after_);
  const errors = diff.verifier_workspace_snapshot_errors as string[];
  assert.equal(errors.length, 100);
  assert.equal(errors[0], "before-0");
  assert.equal(errors[99], "after-19");
});
