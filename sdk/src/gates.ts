/**
 * The checkpoint corridor, ported from .claude/hooks/*.sh to in-process code.
 *
 * In the bash harness the gates were shell scripts wired through
 * .claude/settings.json, which meant (a) they ran inside every interactive
 * session that opened the repo -- including the operator's own editing sessions,
 * the original pain -- and (b) frozen-guard had to defend the hook files
 * themselves from the model. Here the gates live in the harness PROCESS: a
 * session cannot edit, skip, or even see them, and an operator's interactive
 * `claude` session is untouched. frozen-guard shrinks to what still matters:
 * the plan lock, plus a write sandbox around the task dir.
 *
 * Order, identical to settings.json: kill-switch, steer, safety-gate,
 * [track-read on Read, PostToolUse], frozen-guard on writes, verify-gate on
 * writes. First denial wins; a denial cancels the call and its reason is placed
 * in the model's context, exactly like the bash hooks did.
 */
import fs from "node:fs";
import path from "node:path";
import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { dangerHaystack, loadDangerRules, matchDanger, type DangerRules } from "./danger.js";
import { globToRegExp, readGlobFile, taskDir, type TaskDir } from "./taskdir.js";
import { lockedPaths } from "./planlock.js";

export type Role = "planner" | "reviewer" | "builder" | "evaluator";

export type GateContext = {
  t: TaskDir;
  role: Role;
  danger: DangerRules;
  /** Evidence files opened this session (track-read); consumed by a CLAIM.md write. */
  evidenceReads: Set<string>;
  /** Set by the loop between sessions; also re-checked per call via the file. */
  log?: (line: string) => void;
};

export function makeGateContext(root: string, role: Role, log?: (l: string) => void): GateContext {
  return { t: taskDir(root), role, danger: loadDangerRules(), evidenceReads: new Set(), log };
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);
const BASH_WRITEISH =
  /(>|>>|\btee\b|\bsed\b[^|]*-i|\bcp\b|\bmv\b|\brm\b|\bchmod\b|\bln\b|\btruncate\b|\bdd\b|\bpatch\b|\bpython3?\b|\bperl\b|\bawk\b)/;

const PLAN_REASON = (p: string) =>
  `BLOCKED: ${p} is part of the approved plan lock. It states the standard you are being judged ` +
  `against, so you cannot edit it -- an agent that can rewrite its own acceptance criteria has no ` +
  `acceptance criteria. If it is genuinely wrong, say so plainly in PROGRESS.md and in ` +
  `evidence/level-<N>/CLAIM.md and carry on with the level as written; the operator decides and ` +
  `relocks if the plan should change.`;

const SANDBOX_REASON = (p: string) =>
  `BLOCKED: ${p} is outside the task directory. Every file this task produces lives under the ` +
  `task dir; the harness, its gates, and the rest of this machine are not writable from a session.`;

const SCOREBOARD_REASON =
  `BLOCKED: SCOREBOARD.json is written by the wrapper (sdk loop), never by a session. A level is ` +
  `marked passing only when the fresh-context evaluator returns PASS on the evidence you left on ` +
  `disk. Finish the level, write your evidence and evidence/level-<N>/CLAIM.md, and let the ` +
  `evaluator decide.`;

const NO_EVIDENCE_REASON =
  `BLOCKED: you have not opened any evidence file this session, so there is nothing behind this ` +
  `claim. Produce the artifacts your level requires (see EVIDENCE.md for what counts in this ` +
  `domain), open one with the Read tool, confirm it shows what you are about to claim, then write CLAIM.md.`;

/** Task-dir-relative normalized path, or null if the path escapes the task dir. */
function rel(t: TaskDir, p: unknown): string | null {
  if (typeof p !== "string" || !p) return null;
  const abs = path.resolve(t.root, p.startsWith("~/") ? p.replace("~", process.env.HOME ?? "~") : p);
  const r = path.relative(t.root, abs);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  return r.split(path.sep).join("/");
}

function isClaim(r: string): boolean {
  return /^evidence\/level-[^/]+\/CLAIM\.md$/.test(r);
}

/** The PreToolUse corridor as a pure-ish function (reads task-dir files, mutates nothing but STEER/PAUSED). */
export function evaluatePre(ctx: GateContext, toolName: string, toolInput: Record<string, unknown>): GateDecision {
  const { t } = ctx;

  // --- kill switch: an empty file whose existence means STOP -----------------
  if (fs.existsSync(t.agentStop)) {
    return { allow: false, reason: "Kill switch engaged: AGENT_STOP file exists. Agent is halted. Remove the file to resume." };
  }

  // --- steer: surface the operator note once, then clear it ------------------
  try {
    if (fs.existsSync(t.steer)) {
      const note = fs.readFileSync(t.steer, "utf-8");
      if (note.trim()) {
        fs.writeFileSync(t.steer, "");
        return {
          allow: false,
          reason: `OPERATOR STEERING: ${note.trim()}\n\nPause what you were about to do, incorporate this guidance, then continue toward the level goal.`,
        };
      }
    }
  } catch { /* unreadable steer file never blocks work */ }

  // --- safety gate: money / publish / irreversible ---------------------------
  if (!ctx.danger.ok) {
    return {
      allow: false,
      reason: `SAFETY GATE MISCONFIGURED: ${ctx.danger.error}. Every tool call is blocked until an operator fixes it. Stop and report this.`,
    };
  }
  const hay = dangerHaystack(toolName, toolInput);
  if (hay.trim()) {
    const hit = matchDanger(ctx.danger.rules, hay);
    if (hit) {
      const detail = String(toolInput.command ?? toolInput.url ?? toolInput.file_path ?? "(no command)")
        .split(/\s+/).join(" ").slice(0, 300).replace(/\|/g, "\\|");
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      try {
        const fresh = !fs.existsSync(t.pausedActions);
        fs.appendFileSync(
          t.pausedActions,
          (fresh
            ? "# Paused actions\n\nActions the safety gate blocked. Each row is something an agent tried to do\nthat spends money, posts publicly, or cannot be undone. Nothing here has\nhappened. Review and run anything you approve yourself, then delete the row.\n\n| when | category | tool | action | why blocked |\n|---|---|---|---|---|\n"
            : "") + `| ${stamp} | ${hit.category} | ${toolName} | \`${detail}\` | ${hit.why} |\n`,
        );
      } catch { /* the deny still stands even if the ledger write failed */ }
      return {
        allow: false,
        reason:
          `BLOCKED by safety gate [${hit.category}]: ${hit.why}. This action has been logged to ` +
          `PAUSED_ACTIONS.md for the operator to review and run manually. Do not retry it, do not ` +
          `look for another route to the same effect, and do not ask for permission -- note it in ` +
          `PROGRESS.md and continue with the rest of the level.`,
      };
    }
  }

  // --- frozen-guard: plan lock + task-dir write sandbox ----------------------
  const locked = new Set(lockedPaths(t));
  if (WRITE_TOOLS.has(toolName)) {
    const target = toolInput.file_path ?? toolInput.notebook_path;
    const r = rel(t, target);
    if (r === null) return { allow: false, reason: SANDBOX_REASON(String(target)) };
    if (locked.has(r)) return { allow: false, reason: PLAN_REASON(r) };

    // --- verify-gate ---------------------------------------------------------
    if (r === "SCOREBOARD.json") return { allow: false, reason: SCOREBOARD_REASON };
    if (isClaim(r)) {
      if (ctx.evidenceReads.size === 0) return { allow: false, reason: NO_EVIDENCE_REASON };
      ctx.evidenceReads.clear(); // consumed: the next claim needs fresh proof
    }
  }

  if (toolName === "Bash") {
    const cmd = String(toolInput.command ?? "");
    if (BASH_WRITEISH.test(cmd)) {
      for (const token of cmd.match(/[\w./~-]+/g) ?? []) {
        const r = rel(t, token);
        if (r !== null && locked.has(r)) return { allow: false, reason: PLAN_REASON(token) };
        if (r === "SCOREBOARD.json") return { allow: false, reason: SCOREBOARD_REASON };
      }
    }
  }

  return { allow: true };
}

/** track-read: a Read of a file matching the evidence taxonomy counts as evidence opened. */
export function evaluatePostRead(ctx: GateContext, toolInput: Record<string, unknown>): void {
  const p = toolInput.file_path;
  if (typeof p !== "string" || !p || !fs.existsSync(p)) return;
  const patterns = readGlobFile(ctx.t.evidencePatterns);
  if (patterns.length === 0) return; // no taxonomy -> nothing ever counts, claims stay blocked
  const r = rel(ctx.t, p);
  for (const rx of patterns) {
    if (rx.test(p) || (r !== null && rx.test(r))) {
      ctx.evidenceReads.add(p);
      return;
    }
  }
}

/** Assemble the SDK hooks object for one session. */
export function buildHooks(ctx: GateContext): Partial<Record<"PreToolUse" | "PostToolUse", HookCallbackMatcher[]>> {
  const deny = (reason: string): SyncHookJSONOutput => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const d = evaluatePre(ctx, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
            if (!d.allow) {
              ctx.log?.(`gate DENY ${input.tool_name}: ${d.reason.slice(0, 120)}`);
              return deny(d.reason);
            }
            return {};
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "Read",
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name === "PostToolUse") {
              evaluatePostRead(ctx, (input.tool_input ?? {}) as Record<string, unknown>);
            }
            return {};
          },
        ],
      },
    ],
  };
}
