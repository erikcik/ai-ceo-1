// Runs the Python context selector before every composer round and records
// its decision so the operator can see exactly what the composer was shown.

import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Plan } from "./plan.js";

export const CONTEXT_SELECTOR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "context_selector.py",
);

export interface ContextSection {
  title: string;
  kind: string;
  path: string;
  text: string;
  reason: string;
  chars: number;
}

export interface ContextPack {
  sections: ContextSection[];
  dropped: { title: string; path: string; reason: string }[];
  keywords: string[];
  chars: number;
  selector: "python" | "fallback";
  error?: string;
}

export interface SelectContextOptions {
  stateDir: string;
  workspace: string;
  memoryDir: string;
  plan: Plan;
  subtaskId: string;
  round: number;
  maxChars?: number;
  python?: string;
}

export function selectComposerContext(options: SelectContextOptions): ContextPack {
  const payload = {
    state_dir: options.stateDir,
    workspace: options.workspace,
    memory_dir: options.memoryDir,
    subtask_id: options.subtaskId,
    round: options.round,
    plan: options.plan,
    max_chars: options.maxChars ?? 60_000,
  };
  const python = options.python ?? process.env.LH_HARNESS_PYTHON ?? "python3";
  const result = child_process.spawnSync(python, [CONTEXT_SELECTOR_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout) as Partial<ContextPack>;
      return {
        sections: Array.isArray(parsed.sections) ? (parsed.sections as ContextSection[]) : [],
        dropped: Array.isArray(parsed.dropped) ? parsed.dropped : [],
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
        chars: typeof parsed.chars === "number" ? parsed.chars : 0,
        selector: "python",
      };
    } catch (exc) {
      return { ...fallbackContext(options), error: `selector output unreadable: ${(exc as Error).message}` };
    }
  }
  const error = (result.stderr || result.error?.message || `exit ${result.status}`).toString().trim().slice(-2000);
  return { ...fallbackContext(options), error: `context_selector.py failed: ${error}` };
}

/** Minimal TS fallback when python3 is unavailable: previous note + latest evaluation only. */
function fallbackContext(options: SelectContextOptions): ContextPack {
  const sections: ContextSection[] = [];
  const add = (title: string, kind: string, file: string, reason: string, limit: number) => {
    try {
      const text = fs.readFileSync(file, "utf-8").slice(0, limit);
      if (text.trim()) sections.push({ title, kind, path: file, text, reason, chars: text.length });
    } catch {
      /* absent */
    }
  };
  if (options.round > 1) {
    add("Your previous progress note", "progress", path.join(options.stateDir, "progress", `${options.subtaskId}.md`), "same subtask, earlier round", 12_000);
    const evalDir = path.join(options.stateDir, "evaluations", options.subtaskId);
    try {
      const files = fs.readdirSync(evalDir).filter((name) => /^r\d+\.md$/.test(name)).sort();
      const latest = files[files.length - 1];
      if (latest) add("Latest evaluation of this subtask", "evaluation", path.join(evalDir, latest), "the evaluator's verdict", 16_000);
    } catch {
      /* none yet */
    }
  }
  return { sections, dropped: [], keywords: [], chars: sections.reduce((sum, item) => sum + item.chars, 0), selector: "fallback" };
}

/** Render the pack as prompt text; the operator-facing JSON keeps the paths and reasons. */
export function renderContextPack(pack: ContextPack): string {
  if (!pack.sections.length) return "(no prior context selected for this round)";
  return pack.sections
    .map((section) => `## ${section.title}\n_(why: ${section.reason}; from ${section.path})_\n\n${section.text.trim()}`)
    .join("\n\n");
}
