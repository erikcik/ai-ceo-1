/**
 * The wrapper. Something outside the agent has to start each fresh session, run
 * the evaluator, and write the scoreboard, and that something is this program.
 *
 *   npm run loop -- <taskdir>
 *   MAX_CYCLES=3 BUILDER_MODEL=claude-opus-5 npm run loop -- <taskdir>
 *   touch <taskdir>/AGENT_STOP     stop after the current step
 *
 * Each cycle: one builder session on the first unpassed level, then one
 * evaluator session in a fresh context with no write tools. PASS flips the
 * scoreboard row (this file is the only caller of markPass). NEEDS_WORK becomes
 * NEXT_FINDINGS.md and the same level runs again. Model env vars are opt-in;
 * unset means the session uses whatever the claude CLI is pointed at.
 */
import fs from "node:fs";
import path from "node:path";
import { taskDir, exists, read } from "./taskdir.js";
import { ensureRepo, head, commitAll } from "./git.js";
import * as planlock from "./planlock.js";
import * as scoreboard from "./scoreboard.js";
import { memcheck } from "./memcheck.js";
import { parseVerdict } from "./verdict.js";
import { runSession } from "./session.js";

const root = process.argv[2];
if (!root) { console.error("usage: loop.ts <taskdir>"); process.exit(2); }
const t = taskDir(root);

const MAX_CYCLES = Number(process.env.MAX_CYCLES ?? 12);
const BUILDER_MODEL = process.env.BUILDER_MODEL || undefined;
const EVALUATOR_MODEL = process.env.EVALUATOR_MODEL || undefined;
const PROGRESS_BUDGET_TOKENS = Number(process.env.PROGRESS_BUDGET_TOKENS ?? 8000);

fs.mkdirSync(t.logsDir, { recursive: true });
const loopLog = path.join(t.logsDir, "loop.log");
function say(s: string) {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${s}`;
  console.log(line);
  fs.appendFileSync(loopLog, line + "\n");
}

// --- preflight: a domain with no written evidence taxonomy cannot tell --------
// --- finished from claimed, so refuse to start rather than run blind ----------
const missing: string[] = [];
if (!exists(t.levels)) missing.push("LEVELS.md (the ordered plan -- run plan first)");
if (!exists(t.scoreboard)) missing.push("SCOREBOARD.json (the default-FAIL contract)");
if (!exists(t.evidenceMd)) missing.push("EVIDENCE.md (the evidence taxonomy for this domain)");
if (!exists(t.evidencePatterns)) missing.push("evidence-patterns.txt (machine-readable evidence patterns)");
if (!exists(t.rubric)) missing.push("RUBRIC.md (how quality is scored)");
if (missing.length) {
  console.error("loop: refusing to start. Missing:\n" + missing.map((m) => `  - ${m}`).join("\n"));
  process.exit(2);
}
ensureRepo(t.root);

// Lock the plan on first run: fixed at approval, changed only by an operator.
if (!exists(t.planLock)) {
  planlock.lock(t);
  say("plan locked (.plan-lock.sha256)");
}

say(`loop start | builder=${BUILDER_MODEL ?? "<cli default>"} evaluator=${EVALUATOR_MODEL ?? "<cli default>"} max_cycles=${MAX_CYCLES}`);
say(`preflight ok | ${scoreboard.remaining(t)} level(s) still failing`);

let cycle = 0;
let totalCost = 0;
while (true) {
  if (exists(t.agentStop)) { say("exit: AGENT_STOP present"); break; }

  const check = planlock.verify(t);
  if (!check.ok) {
    say(`exit: the plan changed since approval (${check.changed.join(", ")}) -- halting rather than grading against a moved bar`);
    process.exit(1);
  }

  const level = scoreboard.next(t);
  if (!level) { say("exit: every level in SCOREBOARD.json passes"); break; }

  cycle += 1;
  if (cycle > MAX_CYCLES) { say(`exit: MAX_CYCLES=${MAX_CYCLES} reached with ${level} unfinished`); process.exit(1); }

  const before = head(t.root);
  say(`cycle ${cycle} | level=${level} | build`);

  // ---- builder session (fresh context; gates ride along as hooks) ----
  const findings = exists(t.nextFindings)
    ? "\nThe previous session attempted this same level and the evaluator returned NEEDS_WORK.\nIts findings are in NEXT_FINDINGS.md -- read that file first and treat it as your work list.\n"
    : "";

  // progress-budget: over budget, condensing is the newborn session's first task
  const progress = read(t.progress);
  let budgetNote = "";
  if (progress && progress.length > PROGRESS_BUDGET_TOKENS * 4) {
    budgetNote = `\nPROGRESS.md is over its size budget: roughly ${Math.floor(progress.length / 4)} tokens against a ${PROGRESS_BUDGET_TOKENS} limit. Your FIRST task this session, before any other work, is to condense it back under budget: edit it in place (never append), keep the current state and what the next session must know, and delete narration of work that is already committed. Then start the level.\n`;
  }

  const builder = await runSession({
    t, role: "builder", name: `cycle-${cycle}-${level}-build`, model: BUILDER_MODEL,
    prompt: `Execute level '${level}' from LEVELS.md, following your builder contract exactly.
${findings}${budgetNote}
Memory state -- fold any MAINTAIN worklist into your end-of-session memory pass:
${memcheck(t)}

Work only on '${level}'. Leave the evidence artifacts its acceptance criteria require, write
evidence/${level}/CLAIM.md, update PROGRESS.md and memory/, and commit. A fresh evaluator that
never saw this session will judge only what is on disk.`,
  });
  totalCost += builder.costUsd;
  say(`cycle ${cycle} | build finished (ok=${builder.ok}, $${builder.costUsd.toFixed(2)}) | log=${path.relative(t.root, builder.logFile)}`);
  commitAll(t.root, `cycle ${cycle}: ${level} builder session`); // commit-on-stop backstop

  if (exists(t.agentStop)) { say("exit: AGENT_STOP present after build"); break; }

  // ---- evaluator session (fresh context, no write tools) ----
  say(`cycle ${cycle} | level=${level} | evaluate`);
  const evalPrompt = `Review level '${level}'. Read its acceptance criteria in LEVELS.md, the taxonomy in
EVIDENCE.md, the scoring in RUBRIC.md, and the builder's claim in evidence/${level}/CLAIM.md.
Open every artifact it names and check the claim against what the artifact actually shows.
Compare against the baseline commit ${before || "HEAD~1"}. Return PASS or NEEDS_WORK per your instructions.`;

  let judge = await runSession({ t, role: "evaluator", name: `cycle-${cycle}-${level}-verdict`, model: EVALUATOR_MODEL, prompt: evalPrompt });
  let verdict = judge.ok ? parseVerdict(judge.text) : null;

  // A judge that CRASHED is not a judge that said NEEDS_WORK. Retry once, then halt.
  if (!verdict) {
    say(`cycle ${cycle} | no verdict in evaluator output -- retrying once`);
    judge = await runSession({ t, role: "evaluator", name: `cycle-${cycle}-${level}-verdict-retry`, model: EVALUATOR_MODEL, prompt: evalPrompt });
    verdict = judge.ok ? parseVerdict(judge.text) : null;
  }
  totalCost += judge.costUsd;
  if (!verdict) {
    say(`exit: the evaluator produced no PASS/NEEDS_WORK verdict twice for ${level}. Its output is in ${path.relative(t.root, judge.logFile)}; the scoreboard is unchanged. This is an evaluator failure, not a finding -- fix it and re-run.`);
    process.exit(1);
  }
  const verdictFile = path.join(t.logsDir, `cycle-${cycle}-${level}-verdict.md`);
  fs.writeFileSync(verdictFile, judge.text.trim() + "\n");
  say(`cycle ${cycle} | verdict=${verdict} ($${judge.costUsd.toFixed(2)}) | file=${path.relative(t.root, verdictFile)}`);

  // ---- act on the verdict ----
  if (verdict === "PASS") {
    scoreboard.markPass(t, level, `evidence/${level}/ (see ${path.relative(t.root, verdictFile)})`, judge.text);
    if (exists(t.nextFindings)) fs.rmSync(t.nextFindings);
    say(`cycle ${cycle} | ${level} -> PASS recorded on the scoreboard`);
  } else {
    fs.writeFileSync(t.nextFindings, judge.text.trim() + "\n");
    say(`cycle ${cycle} | ${level} stays false; findings handed to the next session`);
  }

  commitAll(t.root, `loop cycle ${cycle}: ${level} -> ${verdict}`);
  const after = head(t.root);
  if (before === after && verdict !== "PASS") {
    say(`exit: cycle ${cycle} produced no change and no PASS -- stopping rather than spinning`);
    process.exit(1);
  }
}

say(`loop end | total session cost $${totalCost.toFixed(2)}`);
console.log("\n" + scoreboard.status(t));
