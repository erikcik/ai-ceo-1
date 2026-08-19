/**
 * One fresh session = one query() call. What loop.sh did with `claude -p`
 * subprocesses this does in-process: same claude binary underneath, but the
 * result comes back as a typed object (verdict text, cost, turn count) instead
 * of a log file to scrape, and the gates ride along as hooks no session can see.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildHooks, makeGateContext, type Role } from "./gates.js";
import type { TaskDir } from "./taskdir.js";

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export function rolePrompt(role: Role): string {
  return fs.readFileSync(path.join(PROMPTS, `${role}.md`), "utf-8");
}

export type SessionResult = {
  ok: boolean;
  text: string;        // the final result text (the evaluator's verdict lives here)
  costUsd: number;
  turns: number;
  logFile: string;
};

const ROLE_DISALLOWED: Record<Role, string[]> = {
  // the judge and the reviewer physically lack write tools -- not a prompt, a capability
  evaluator: ["Write", "Edit", "NotebookEdit", "MultiEdit", "Task", "WebSearch", "WebFetch"],
  reviewer: ["Write", "Edit", "NotebookEdit", "MultiEdit", "Task", "WebSearch", "WebFetch"],
  planner: ["Task"],
  builder: ["Task"],
};

export async function runSession(opts: {
  t: TaskDir;
  role: Role;
  prompt: string;       // the per-run assignment; the role contract is prepended
  name: string;         // log file stem
  model?: string;
  maxTurns?: number;
}): Promise<SessionResult> {
  const { t, role, name } = opts;
  fs.mkdirSync(t.logsDir, { recursive: true });
  const logFile = path.join(t.logsDir, `${name}.log`);
  const log = fs.createWriteStream(logFile, { flags: "w" });
  log.write(`### ${role} session | ${new Date().toISOString()} | model=${opts.model ?? "<cli default>"}\n\n`);

  const ctx = makeGateContext(t.root, role, (l) => log.write(`[gate] ${l}\n`));
  const fullPrompt = `${rolePrompt(role)}\n\n---\n\n${opts.prompt}`;

  let text = "";
  let costUsd = 0;
  let turns = 0;
  let ok = false;

  const q = query({
    prompt: fullPrompt,
    options: {
      ...(opts.model ? { model: opts.model } : {}),
      cwd: t.root,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [],            // the session inherits NOTHING from any .claude/ dir
      permissionMode: "bypassPermissions", // autonomy is safe because the gates below always run
      hooks: buildHooks(ctx),
      disallowedTools: ROLE_DISALLOWED[role],
      maxTurns: opts.maxTurns ?? 120,
    },
  });

  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) {
          log.write(block.text + "\n");
          const first = block.text.trim().split("\n")[0].slice(0, 110);
          console.log(`    [${role}] ${first}`);
        }
        if (block.type === "tool_use") log.write(`[tool_use] ${block.name} ${JSON.stringify(block.input).slice(0, 300)}\n`);
      }
    }
    if (msg.type === "result") {
      turns = msg.num_turns;
      costUsd = "total_cost_usd" in msg ? msg.total_cost_usd : 0;
      if (msg.subtype === "success") {
        ok = true;
        text = msg.result;
      } else {
        text = "";
        log.write(`\n### session ended: ${msg.subtype}\n`);
      }
      log.write(`\n### result | ok=${ok} turns=${turns} cost=$${costUsd.toFixed(3)}\n`);
    }
  }
  log.end();
  return { ok, text, costUsd, turns, logFile };
}
