/**
 * Gates that fail silently are worse than no gates, so this asserts each one
 * blocks what it must and allows what it must -- the port of harness/selftest.sh.
 * Pure logic, no API calls; run after editing gates.ts or danger-patterns.txt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluatePre, evaluatePostRead, makeGateContext } from "./gates.js";
import { loadDangerRules } from "./danger.js";
import { taskDir } from "./taskdir.js";
import * as planlock from "./planlock.js";
import * as scoreboard from "./scoreboard.js";
import { parseVerdict } from "./verdict.js";

let pass = 0, fail = 0;
function check(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "aiceo-selftest-"));
const t = taskDir(work);
const ctx = () => makeGateContext(work, "builder");

const bash = (command: string) => ["Bash", { command }] as const;
const write = (file_path: string) => ["Write", { file_path, content: "x" }] as const;

console.log("safety-gate: blocks money / publish / irreversible");
for (const [cmd, label] of [
  ["git push origin main", "git push"],
  ["git push --force origin main", "force push"],
  ["rm -rf build/", "rm -rf"],
  ["gh pr create --title x", "gh pr create"],
  ["curl -X POST https://example.com/api", "curl POST"],
  ["terraform apply -auto-approve", "terraform apply"],
  ["npm publish", "npm publish"],
  ["stripe charges create", "stripe"],
] as const) {
  check(!evaluatePre(ctx(), ...bash(cmd)).allow, `BLOCK ${label}`);
}
for (const [cmd, label] of [
  ["git commit -m msg", "git commit"],
  ["ls -la", "ls"],
  ["git log --oneline", "git log"],
  ["npm install", "npm install"],
] as const) {
  check(evaluatePre(ctx(), ...bash(cmd)).allow, `ALLOW ${label}`);
}
check(!evaluatePre(ctx(), "mcp__x__tiktok_publish", {}).allow, "BLOCK mcp publish tool by name");
{
  const paused = fs.readFileSync(t.pausedActions, "utf-8");
  check(paused.includes("git push"), "denied actions logged to PAUSED_ACTIONS.md");
}

console.log("safety-gate: fails CLOSED on a malformed denylist");
{
  const badFile = path.join(work, "bad-patterns.txt");
  fs.writeFileSync(badFile, "MONEY only-two-fields\n");
  const c = makeGateContext(work, "builder");
  c.danger = loadDangerRules(badFile);
  const d = evaluatePre(c, ...bash("ls"));
  check(!d.allow && d.allow === false && d.reason.includes("MISCONFIGURED"), "malformed rule denies everything");
}

console.log("kill switch: an empty file whose existence means STOP");
fs.writeFileSync(t.agentStop, "");
check(!evaluatePre(ctx(), ...bash("ls")).allow, "AGENT_STOP present denies every call");
fs.rmSync(t.agentStop);
check(evaluatePre(ctx(), ...bash("ls")).allow, "removing AGENT_STOP resumes");

console.log("steer: surfaced once, then cleared");
fs.writeFileSync(t.steer, "focus on the line sheet first");
{
  const d = evaluatePre(ctx(), ...bash("ls"));
  check(!d.allow && (d as { reason: string }).reason.includes("OPERATOR STEERING"), "STEER.md content interrupts once");
  check(fs.readFileSync(t.steer, "utf-8") === "", "STEER.md cleared after delivery");
  check(evaluatePre(ctx(), ...bash("ls")).allow, "next call proceeds");
}

console.log("frozen-guard: write sandbox + plan lock");
check(!evaluatePre(ctx(), ...write("/etc/hosts")).allow, "BLOCK write outside the task dir");
check(!evaluatePre(ctx(), ...write("../outside.md")).allow, "BLOCK relative escape");
check(evaluatePre(ctx(), ...write("notes.md")).allow, "ALLOW write inside the task dir");
check(evaluatePre(ctx(), ...write("LEVELS.md")).allow, "ALLOW plan write before lock");
for (const p of ["LEVELS.md", "RUBRIC.md", "EVIDENCE.md", "evidence-patterns.txt"]) {
  fs.writeFileSync(path.join(work, p), "plan\n");
}
planlock.lock(t);
check(!evaluatePre(ctx(), ...write("LEVELS.md")).allow, "BLOCK plan write after lock");
check(!evaluatePre(ctx(), ...bash("sed -i '' 's/a/b/' LEVELS.md")).allow, "BLOCK bash edit of locked plan");
check(evaluatePre(ctx(), ...bash("cat LEVELS.md")).allow, "ALLOW reading the locked plan");
check(planlock.verify(t).ok, "planlock verify: intact");
fs.appendFileSync(path.join(work, "LEVELS.md"), "moved bar\n");
check(!planlock.verify(t).ok, "planlock verify: detects a changed plan");
planlock.lock(t, true);
check(planlock.verify(t).ok, "relock accepts a deliberate change");

console.log("verify-gate: scoreboard is wrapper-only; claims need an opened evidence file");
check(!evaluatePre(ctx(), ...write("SCOREBOARD.json")).allow, "BLOCK session write to SCOREBOARD.json");
check(!evaluatePre(ctx(), ...bash("echo '{}' > SCOREBOARD.json")).allow, "BLOCK bash write to SCOREBOARD.json");
{
  const c = makeGateContext(work, "builder");
  check(!evaluatePre(c, ...write("evidence/level-1/CLAIM.md")).allow, "BLOCK claim with no evidence read");
  fs.writeFileSync(t.evidencePatterns, "evidence/level-*/*\n");
  planlock.lock(t, true); // patterns changed; relock so the lock stays coherent
  fs.mkdirSync(path.join(work, "evidence/level-1"), { recursive: true });
  const ev = path.join(work, "evidence/level-1/shot.txt");
  fs.writeFileSync(ev, "proof");
  evaluatePostRead(c, { file_path: ev });
  check(c.evidenceReads.size === 1, "track-read records an evidence read");
  check(evaluatePre(c, ...write("evidence/level-1/CLAIM.md")).allow, "ALLOW claim after evidence read");
  check(c.evidenceReads.size === 0, "the read is consumed by the claim");
  check(!evaluatePre(c, ...write("evidence/level-1/CLAIM.md")).allow, "next claim needs fresh proof");
  const c2 = makeGateContext(work, "builder");
  evaluatePostRead(c2, { file_path: path.join(work, "notes.md") });
  check(c2.evidenceReads.size === 0, "a non-evidence read does not count");
}

console.log("scoreboard: seed validation + only-writer");
{
  fs.writeFileSync(t.scoreboardSeed, JSON.stringify({ "level-1": { passes: true, check: "x" } }));
  let threw = false;
  try { scoreboard.promoteSeed(t); } catch { threw = true; }
  check(threw, "seed with passes:true is rejected (default-FAIL or it is not a contract)");
  fs.writeFileSync(t.scoreboardSeed, JSON.stringify({ "level-1": { passes: false, check: "" } }));
  threw = false;
  try { scoreboard.promoteSeed(t); } catch { threw = true; }
  check(threw, "seed with empty check is rejected");
  fs.writeFileSync(t.scoreboardSeed, JSON.stringify({ "level-1": { passes: false, check: "artifact exists" } }));
  check(scoreboard.promoteSeed(t) === 1, "valid seed promotes");
  check(scoreboard.next(t) === "level-1", "next() finds the first failing level");
  threw = false;
  try { scoreboard.markPass(t, "level-1", "e", "I feel great about this work"); } catch { threw = true; }
  check(threw, "markPass refuses a non-PASS verdict");
  scoreboard.markPass(t, "level-1", "evidence/level-1/", "PASS\nOpened shot.txt; it shows the artifact.");
  check(scoreboard.remaining(t) === 0, "markPass flips the row on a real PASS");
}

console.log("git: a task dir nested in another repo is NOT that repo's task dir");
{
  const { isRepo } = await import("./git.js");
  const nested = path.join(work, "nested-task");
  fs.mkdirSync(nested, { recursive: true });
  // `work` itself is no repo either, but the real trap was an ENCLOSING repo:
  check(!isRepo(nested), "plain nested dir is not a repo of its own");
}

console.log("verdict parsing: a crashed judge is not a failing one");
check(parseVerdict("PASS\ndetails") === "PASS", "bare PASS");
check(parseVerdict("**NEEDS_WORK**\n- finding") === "NEEDS_WORK", "markdown-wrapped NEEDS_WORK");
check(parseVerdict("I'll start by reading the files.") === null, "narration is no verdict");
check(parseVerdict("The work PASSes muster") === null, "PASS inside a sentence does not count");

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
