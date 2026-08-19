/**
 * Initialization: one command turns an initialization prompt into the plan
 * artifacts and their gameability review, then STOPS for human approval --
 * because a plan nobody read is a plan nobody agreed to.
 *
 *   npm run plan -- <taskdir> "Task: ... Domain: ... Constraints: ... Budget: ..."
 *   npm run plan -- <taskdir> -f INIT_PROMPT.md
 *
 * Two fresh sessions: the planner, then a rubric-reviewer that never saw the
 * planner's reasoning and tries to find the cheapest way to score well without
 * doing the work. The reviewer has no Write tools; the harness saves its output
 * to RUBRIC_REVIEW.md. Does not start the loop.
 */
import fs from "node:fs";
import { taskDir, exists } from "./taskdir.js";
import { ensureRepo, commitAll } from "./git.js";
import { promoteSeed } from "./scoreboard.js";
import { runSession } from "./session.js";

const [root, ...rest] = process.argv.slice(2);
if (!root || rest.length === 0) {
  console.error('usage: plan.ts <taskdir> "<init prompt>" | plan.ts <taskdir> -f <file>');
  process.exit(2);
}
const initPrompt = rest[0] === "-f" ? fs.readFileSync(rest[1], "utf-8") : rest.join(" ");

const t = taskDir(root);
fs.mkdirSync(t.root, { recursive: true });

for (const f of [t.levels, t.scoreboard, t.rubric, t.evidenceMd]) {
  if (exists(f)) {
    console.error(`plan: ${f} already exists. This task is already initialized; archive it before re-planning.`);
    process.exit(2);
  }
}

ensureRepo(t.root);
fs.writeFileSync(t.initPrompt, initPrompt.trim() + "\n");
console.log(`plan: initialization prompt saved to INIT_PROMPT.md`);

const plannerModel = process.env.PLANNER_MODEL || undefined;
const reviewerModel = process.env.REVIEWER_MODEL || undefined;

console.log(`plan: [1/2] planner session (model=${plannerModel ?? "<cli default>"})`);
const planner = await runSession({
  t, role: "planner", name: "plan-planner", model: plannerModel,
  prompt: `The initialization prompt for this task is INIT_PROMPT.md in your working directory (read it first).

Write the five plan artifacts into the working directory exactly as your instructions specify:
EVIDENCE.md, evidence-patterns.txt, LEVELS.md, SCOREBOARD.seed.json, RUBRIC.md
(and optionally evaluator.addendum.md). Then summarize your decomposition and stop.`,
});
if (!planner.ok) { console.error(`plan: planner session failed -- see ${planner.logFile}`); process.exit(1); }

const missing = [t.levels, t.evidenceMd, t.evidencePatterns, t.rubric, t.scoreboardSeed].filter((f) => !exists(f));
if (missing.length) {
  console.error(`plan: planner finished but did not write: ${missing.join(", ")}`);
  console.error(`      Its summary is in ${planner.logFile}. If it refused, it says why there.`);
  process.exit(1);
}

const n = promoteSeed(t);
console.log(`plan: promoted ${n} default-FAIL rows to SCOREBOARD.json`);

console.log(`plan: [2/2] rubric-reviewer session (model=${reviewerModel ?? "<cli default>"})`);
const review = await runSession({
  t, role: "reviewer", name: "plan-reviewer", model: reviewerModel,
  prompt: `Review the rubric for this task. RUBRIC.md, LEVELS.md, EVIDENCE.md and SCOREBOARD.json are in your working directory. Your entire output is the review, beginning with ACCEPT or REVISE on its own line.`,
});
if (!review.ok || !review.text.trim()) {
  console.error(`plan: reviewer session produced no review -- see ${review.logFile}`);
  process.exit(1);
}
fs.writeFileSync(t.rubricReview, review.text.trim() + "\n");

commitAll(t.root, "plan: LEVELS, EVIDENCE, RUBRIC, scoreboard, review");

const verdictLine = review.text.trim().split("\n")[0].replace(/[`*#\s]/g, "");
console.log("\n" + "=".repeat(64));
console.log(`plan: done | planner $${planner.costUsd.toFixed(2)} (${planner.turns} turns) | reviewer $${review.costUsd.toFixed(2)}`);
console.log(`plan: rubric review verdict: ${verdictLine}`);
console.log(`
Next, the only manual gate in the system:
  1. Read LEVELS.md, RUBRIC.md and RUBRIC_REVIEW.md in ${t.root}
  2. If the review says REVISE, apply its findings to RUBRIC.md first
  3. Approve by starting the loop:  npm run loop -- ${root}
The plan files are hash-locked when the loop first runs.`);
