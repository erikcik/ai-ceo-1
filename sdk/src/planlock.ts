/**
 * The plan lock: sha256 of the plan files, recorded at approval. The builder is
 * judged against LEVELS.md and RUBRIC.md, so it must not edit them -- while a
 * deliberate operator change stays possible (relock). The loop verifies before
 * every cycle and halts rather than grading against a moved bar.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PLAN_PATHS, type TaskDir } from "./taskdir.js";

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function lock(t: TaskDir, relock = false): void {
  if (fs.existsSync(t.planLock) && !relock) {
    throw new Error("plan lock already exists; use relock to accept a deliberate change");
  }
  const missing = PLAN_PATHS.filter((p) => {
    const f = path.join(t.root, p);
    return !fs.existsSync(f) || fs.statSync(f).size === 0;
  });
  if (missing.length) throw new Error(`cannot lock, missing: ${missing.join(", ")}`);
  const lines = [
    "# Plan lock -- the standard this task is judged against, as approved.",
    "# Written by the sdk harness. The frozen-guard gate denies session writes to these",
    "# paths; the loop halts if any hash stops matching. Operator: relock to accept a",
    "# change you made on purpose.",
    `# locked: ${new Date().toISOString()}`,
    ...PLAN_PATHS.map((p) => `${sha256(path.join(t.root, p))}  ${p}`),
  ];
  fs.writeFileSync(t.planLock, lines.join("\n") + "\n");
}

export type LockCheck = { ok: true } | { ok: false; changed: string[] } | { ok: false; changed: string[]; missing: true };

export function verify(t: TaskDir): { ok: boolean; changed: string[] } {
  if (!fs.existsSync(t.planLock)) return { ok: false, changed: ["<no lock file>"] };
  const changed: string[] = [];
  for (const line of fs.readFileSync(t.planLock, "utf-8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!m) continue;
    const f = path.join(t.root, m[2]);
    if (!fs.existsSync(f) || sha256(f) !== m[1]) changed.push(m[2]);
  }
  return { ok: changed.length === 0, changed };
}

/** Taskdir-relative paths the frozen-guard denies writes to. Empty until locked. */
export function lockedPaths(t: TaskDir): string[] {
  if (!fs.existsSync(t.planLock)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(t.planLock, "utf-8").split("\n")) {
    const m = line.match(/^[0-9a-f]{64}\s+(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
