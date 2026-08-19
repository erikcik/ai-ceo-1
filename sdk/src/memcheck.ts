/**
 * MAINTAIN needs a concrete worklist: which memory files are over budget, which
 * are missing from the index, which index lines point at nothing. The loop
 * pastes this into the builder's prompt.
 */
import fs from "node:fs";
import path from "node:path";
import type { TaskDir } from "./taskdir.js";

export function memcheck(t: TaskDir, budgetTokens = 2000): string {
  if (!fs.existsSync(t.memoryDir)) return "memory/ does not exist yet -- this task has no lessons recorded.";
  const budget = budgetTokens * 4;
  const index = path.join(t.memoryDir, "INDEX.md");
  const files = fs.readdirSync(t.memoryDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md").sort();
  const problems: string[] = [];
  let listed = new Set<string>();
  if (!fs.existsSync(index)) {
    problems.push("INDEX.md is missing -- create it with one summary line per memory file.");
  } else {
    for (const line of fs.readFileSync(index, "utf-8").split("\n")) {
      const m = line.match(/^\s*[-*+]\s*`?([A-Za-z0-9._-]+\.md)`?/);
      if (m) listed.add(m[1]);
    }
    listed.delete("INDEX.md");
  }
  for (const f of files) if (!listed.has(f)) problems.push(`${f} is not in INDEX.md -- add a one-line summary for it.`);
  for (const f of [...listed].filter((x) => !files.includes(x)).sort())
    problems.push(`INDEX.md lists ${f}, which does not exist -- remove the line or restore the file.`);
  for (const f of files) {
    const n = fs.statSync(path.join(t.memoryDir, f)).size;
    if (n > budget)
      problems.push(`${f} is ~${Math.floor(n / 4)} tokens, over the ${budgetTokens} budget -- condense it, or split it into two topics and index both.`);
  }
  if (!problems.length) return `memory/ is healthy: ${files.length} file(s), all indexed, all under budget.`;
  return "MAINTAIN worklist:\n" + problems.map((p) => `  - ${p}`).join("\n");
}
