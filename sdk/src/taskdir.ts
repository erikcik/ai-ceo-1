/**
 * The task directory layout. Everything the bash harness kept at the repo root
 * lives here instead -- the harness (this sdk/ package) and the task workspace
 * are now separate directories, so the machinery is never inside the folder the
 * agent works on. That separation IS the frozen core in the SDK world: gates run
 * in this process, out of any session's reach.
 */
import fs from "node:fs";
import path from "node:path";

export type TaskDir = {
  root: string;
  initPrompt: string;
  levels: string;
  evidenceMd: string;
  evidencePatterns: string;
  rubric: string;
  rubricReview: string;
  scoreboardSeed: string;
  scoreboard: string;
  progress: string;
  nextFindings: string;
  pausedActions: string;
  agentStop: string;
  steer: string;
  planLock: string;
  evaluatorAddendum: string;
  memoryDir: string;
  evidenceDir: string;
  logsDir: string;
};

export function taskDir(root: string): TaskDir {
  const r = path.resolve(root);
  return {
    root: r,
    initPrompt: path.join(r, "INIT_PROMPT.md"),
    levels: path.join(r, "LEVELS.md"),
    evidenceMd: path.join(r, "EVIDENCE.md"),
    evidencePatterns: path.join(r, "evidence-patterns.txt"),
    rubric: path.join(r, "RUBRIC.md"),
    rubricReview: path.join(r, "RUBRIC_REVIEW.md"),
    scoreboardSeed: path.join(r, "SCOREBOARD.seed.json"),
    scoreboard: path.join(r, "SCOREBOARD.json"),
    progress: path.join(r, "PROGRESS.md"),
    nextFindings: path.join(r, "NEXT_FINDINGS.md"),
    pausedActions: path.join(r, "PAUSED_ACTIONS.md"),
    agentStop: path.join(r, "AGENT_STOP"),
    steer: path.join(r, "STEER.md"),
    planLock: path.join(r, ".plan-lock.sha256"),
    evaluatorAddendum: path.join(r, "evaluator.addendum.md"),
    memoryDir: path.join(r, "memory"),
    evidenceDir: path.join(r, "evidence"),
    logsDir: path.join(r, "logs"),
  };
}

/** The per-task plan files that get hash-locked at approval (taskdir-relative). */
export const PLAN_PATHS = ["LEVELS.md", "RUBRIC.md", "EVIDENCE.md", "evidence-patterns.txt"];

export function read(p: string): string | null {
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** Shell-glob (case-statement semantics: * crosses /) -> anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Read one glob per line, # comments and blanks ignored. */
export function readGlobFile(p: string): RegExp[] {
  const text = read(p);
  if (text === null) return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(globToRegExp);
}
