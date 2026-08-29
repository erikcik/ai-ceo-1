// In-process Agent SDK hooks — the harness's enforcement layer. Prompts ask;
// hooks make sure. Every hook is a plain function so its behaviour can be read
// and unit-tested without an agent:
//
//   kill switch / steering   AGENT_STOP and STEER.md in the workspace root
//   write scope              a role may only write inside the folders it owns
//   evidence ledger          every composer write is recorded with hashes
//   stop gate                the composer cannot end without a progress note
//                            that mentions every contract criterion

import fs from "node:fs";
import path from "node:path";

import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

import { sha256File } from "./episodes.js";

export type HookSet = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

const WRITE_TOOL_MATCHER = "Write|Edit|MultiEdit|NotebookEdit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolPath(input: unknown, cwd: string): string | null {
  if (!isRecord(input)) return null;
  const raw = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof raw !== "string" || !raw) return null;
  return path.resolve(cwd, raw);
}

function inside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
});

const allow = () => ({ continue: true });

// ---------------------------------------------------------------------------
// Operator controls
// ---------------------------------------------------------------------------

export function operatorControlHooks(workspace: string): HookSet {
  const stopFile = path.join(workspace, "AGENT_STOP");
  const steerFile = path.join(workspace, "STEER.md");
  const hook: HookCallback = async () => {
    if (fs.existsSync(stopFile)) {
      return deny("Kill switch engaged: AGENT_STOP exists in the workspace. Stop working and end your turn now.");
    }
    let steer = "";
    try {
      steer = fs.readFileSync(steerFile, "utf-8").trim();
    } catch {
      steer = "";
    }
    if (steer) {
      try {
        fs.writeFileSync(steerFile, "", "utf-8");
      } catch {
        /* leave it */
      }
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          additionalContext: `OPERATOR STEERING: ${steer}\n\nIncorporate this guidance, then continue toward the subtask goal.`,
        },
      };
    }
    return allow();
  };
  return { PreToolUse: [{ matcher: "*", hooks: [hook] }] };
}

// ---------------------------------------------------------------------------
// Write scope
// ---------------------------------------------------------------------------

export interface WriteScope {
  /** Absolute directories (or files) the role may write into. */
  allowed: string[];
  /** Absolute paths that are always denied, even inside an allowed root. */
  denied: string[];
  roleName: string;
}

export function writeScopeHooks(scope: WriteScope, cwd: string): HookSet {
  const hook: HookCallback = async (input) => {
    if (!isRecord(input) || !("tool_input" in input)) return allow();
    const target = toolPath(input.tool_input, cwd);
    if (!target) return allow();
    for (const blocked of scope.denied) {
      if (inside(target, blocked)) {
        return deny(`${scope.roleName} may not modify ${blocked}: it is harness-owned (contracts, evaluations, plan). Satisfy it instead of editing it.`);
      }
    }
    if (!scope.allowed.some((root) => inside(target, root))) {
      return deny(`${scope.roleName} may only write under: ${scope.allowed.join(", ")}. Attempted: ${target}.`);
    }
    return allow();
  };
  return { PreToolUse: [{ matcher: WRITE_TOOL_MATCHER, hooks: [hook] }] };
}

// ---------------------------------------------------------------------------
// Evidence ledger + stop gate (composer)
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  ts: number;
  subtask: string;
  round: number;
  kind: "write" | "bash";
  tool: string;
  path?: string;
  sha256_before?: string | null;
  sha256_after?: string | null;
  bytes?: number | null;
  command?: string;
}

export function appendLedger(ledgerPath: string, entry: LedgerEntry): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function readLedger(ledgerPath: string): LedgerEntry[] {
  let text = "";
  try {
    text = fs.readFileSync(ledgerPath, "utf-8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface ComposerHookOptions {
  workspace: string;
  subtaskId: string;
  round: number;
  ledgerPath: string;
  progressPath: string;
  criteriaIds: string[];
  /** How many times the stop gate may block before letting the session end. */
  maxStopBlocks?: number;
  /** Paths the composer must never write (contract, evaluations, plan). */
  denied: string[];
}

/** Check a progress note against the contract; returns the missing pieces. */
export function progressNoteGaps(progressPath: string, criteriaIds: string[]): string[] {
  let text = "";
  try {
    text = fs.readFileSync(progressPath, "utf-8");
  } catch {
    return ["the progress note does not exist"];
  }
  const gaps: string[] = [];
  if (!/^Status:\s*(done|partial|blocked)/im.test(text)) gaps.push("a `Status: done | partial | blocked` line");
  if (!/^##\s*Evidence/im.test(text)) gaps.push("an `## Evidence` section");
  if (!/^##\s*How to verify/im.test(text)) gaps.push("a `## How to verify` section");
  const missing = criteriaIds.filter((id) => !new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
  if (missing.length) gaps.push(`a line for criterion ${missing.join(", ")} in the Evidence section`);
  return gaps;
}

export function composerHooks(options: ComposerHookOptions): HookSet {
  const pending = new Map<string, string | null>();
  let stopBlocks = 0;
  const maxStopBlocks = options.maxStopBlocks ?? 3;

  const preWrite: HookCallback = async (input) => {
    if (!isRecord(input) || !("tool_input" in input)) return allow();
    const target = toolPath(input.tool_input, options.workspace);
    if (!target) return allow();
    for (const blocked of options.denied) {
      if (inside(target, blocked)) {
        return deny(`The composer may not modify ${blocked}. Contracts, evaluations and the plan are harness-owned; satisfy the contract instead.`);
      }
    }
    pending.set(target, sha256File(target));
    return allow();
  };

  const postWrite: HookCallback = async (input) => {
    if (!isRecord(input) || !("tool_input" in input)) return allow();
    const target = toolPath(input.tool_input, options.workspace);
    if (!target) return allow();
    const before = pending.has(target) ? pending.get(target)! : null;
    pending.delete(target);
    let bytes: number | null = null;
    try {
      bytes = fs.statSync(target).size;
    } catch {
      bytes = null;
    }
    appendLedger(options.ledgerPath, {
      ts: Date.now() / 1000,
      subtask: options.subtaskId,
      round: options.round,
      kind: "write",
      tool: String(input.tool_name ?? "Write"),
      path: target,
      sha256_before: before,
      sha256_after: sha256File(target),
      bytes,
    });
    return allow();
  };

  const postBash: HookCallback = async (input) => {
    const raw = input as unknown as Record<string, unknown>;
    if (!isRecord(raw) || !isRecord(raw.tool_input)) return allow();
    const command = typeof raw.tool_input.command === "string" ? raw.tool_input.command : "";
    if (!command) return allow();
    appendLedger(options.ledgerPath, {
      ts: Date.now() / 1000,
      subtask: options.subtaskId,
      round: options.round,
      kind: "bash",
      tool: "Bash",
      command: command.slice(0, 500),
    });
    return allow();
  };

  const stopGate: HookCallback = async () => {
    const gaps = progressNoteGaps(options.progressPath, options.criteriaIds);
    if (!gaps.length) return { continue: true };
    if (stopBlocks >= maxStopBlocks) {
      return { continue: true, systemMessage: `progress note still incomplete after ${stopBlocks} reminders: ${gaps.join("; ")}` };
    }
    stopBlocks += 1;
    return {
      decision: "block" as const,
      reason:
        `You cannot end this session yet. The progress note at ${options.progressPath} is missing: ${gaps.join("; ")}. ` +
        `Write it now (sections: Status line, ## Done, ## Evidence with one line per criterion id [${options.criteriaIds.join(", ")}], ` +
        `## How to verify, ## Known gaps, ## Notes for the evaluator, ## Memory saved), then end.`,
    };
  };

  return {
    PreToolUse: [{ matcher: WRITE_TOOL_MATCHER, hooks: [preWrite] }],
    PostToolUse: [
      { matcher: WRITE_TOOL_MATCHER, hooks: [postWrite] },
      { matcher: "Bash", hooks: [postBash] },
    ],
    Stop: [{ hooks: [stopGate] }],
  };
}

/** Merge several hook sets (matchers are kept separate so each runs). */
export function mergeHookSets(...sets: HookSet[]): HookSet {
  const out: HookSet = {};
  for (const set of sets) {
    for (const [event, matchers] of Object.entries(set) as [HookEvent, HookCallbackMatcher[]][]) {
      out[event] = [...(out[event] ?? []), ...matchers];
    }
  }
  return out;
}
