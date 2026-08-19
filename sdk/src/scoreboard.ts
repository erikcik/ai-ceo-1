/**
 * The only writer of SCOREBOARD.json. In the bash harness that exclusivity was
 * a hook denying every other route; here it is structural -- sessions run with
 * the same deny, and this module is only ever called by the wrapper, only after
 * an evaluator PASS whose verdict text it re-checks itself.
 */
import fs from "node:fs";
import { parseVerdict } from "./verdict.js";
import type { TaskDir } from "./taskdir.js";

type Row = { passes: boolean; check: string; evidence?: string; passed_at?: string };
type Board = Record<string, Row | unknown>;

function readBoard(file: string): Board {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function rows(b: Board): [string, Row][] {
  return Object.entries(b).filter(
    ([k, v]) => !k.startsWith("_") && typeof v === "object" && v !== null,
  ) as [string, Row][];
}

/** Validate a planner seed (every row default-FAIL with a non-empty check) and promote it. */
export function promoteSeed(t: TaskDir): number {
  if (!fs.existsSync(t.scoreboardSeed)) throw new Error("SCOREBOARD.seed.json not found -- the planner did not write it");
  if (fs.existsSync(t.scoreboard)) throw new Error("SCOREBOARD.json already exists; refusing to overwrite a live contract");
  const seed = readBoard(t.scoreboardSeed);
  const rs = rows(seed);
  if (rs.length === 0) throw new Error("scoreboard seed has no level rows");
  for (const [k, v] of rs) {
    if (v.passes !== false) throw new Error(`seed row ${k} does not start false -- a contract is default-FAIL or it is not a contract`);
    if (!String(v.check ?? "").trim()) throw new Error(`seed row ${k} has no check -- state the observable evidence that proves this level`);
  }
  fs.writeFileSync(t.scoreboard, JSON.stringify(seed, null, 2) + "\n");
  return rs.length;
}

export function next(t: TaskDir): string | null {
  const todo = rows(readBoard(t.scoreboard)).filter(([, v]) => !v.passes);
  return todo.length ? todo[0][0] : null;
}

export function remaining(t: TaskDir): number {
  return rows(readBoard(t.scoreboard)).filter(([, v]) => !v.passes).length;
}

export function status(t: TaskDir): string {
  return rows(readBoard(t.scoreboard))
    .map(([k, v]) => `  ${v.passes ? "PASS" : "----"}  ${k}  ${v.check}`)
    .join("\n");
}

/** Flip one row to passing. Refuses unless the verdict text actually says PASS. */
export function markPass(t: TaskDir, level: string, evidence: string, verdictText: string): void {
  if (parseVerdict(verdictText) !== "PASS") {
    throw new Error(`refusing to mark ${level}: the verdict text does not begin with PASS`);
  }
  const b = readBoard(t.scoreboard);
  const row = b[level] as Row | undefined;
  if (!row || typeof row !== "object") throw new Error(`no scoreboard row named ${level}`);
  row.passes = true;
  row.evidence = evidence;
  row.passed_at = new Date().toISOString();
  fs.writeFileSync(t.scoreboard, JSON.stringify(b, null, 2) + "\n");
}
