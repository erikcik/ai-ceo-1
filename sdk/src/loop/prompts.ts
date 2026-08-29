// Role prompts are markdown files next to this module (`prompts/*.md`) so the
// operator can read exactly what every agent is told. A prompt is assembled as:
//
//   common.md  (where you are, files, memory, capabilities)
//   <role>.md  (the role's own instructions)
//   the task-specific briefing the prompt tailor wrote for this role
//   the inputs for this episode (task, plan, subtask, contract, context pack)
//
// `{{name}}` placeholders are filled from a flat variable map; unknown names
// become empty strings rather than leaking braces into the prompt.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

export type LoopRole = "prompt_tailor" | "planner" | "rubric" | "composer" | "evaluator" | "final_response";

export const LOOP_ROLES: readonly LoopRole[] = [
  "prompt_tailor",
  "planner",
  "rubric",
  "composer",
  "evaluator",
  "final_response",
];

const cache = new Map<string, string>();

export function loadPromptTemplate(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), "utf-8");
  cache.set(name, text);
  return text;
}

export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

export interface PromptSection {
  title: string;
  body: string;
}

export interface RolePromptInput {
  role: LoopRole;
  /** Placeholder values shared by common.md and the role file. */
  vars: Record<string, string | number | null | undefined>;
  /** The prompt tailor's briefing for this role ("" for roles without one). */
  briefing: string;
  /** Episode inputs, appended in order as `# <title>` sections. */
  sections: PromptSection[];
}

const SECTION_LIMIT_CHARS = 120_000;

export function buildRolePrompt(input: RolePromptInput): string {
  const vars = { ...input.vars, role: input.role };
  const parts: string[] = [
    renderTemplate(loadPromptTemplate("common"), vars),
    renderTemplate(loadPromptTemplate(input.role), vars),
  ];
  if (input.briefing.trim()) {
    parts.push(`# Task-specific briefing for the ${input.role}\n\n${input.briefing.trim()}`);
  }
  for (const section of input.sections) {
    const body = section.body.length > SECTION_LIMIT_CHARS
      ? `${section.body.slice(0, SECTION_LIMIT_CHARS)}\n\n[truncated: ${section.body.length - SECTION_LIMIT_CHARS} more characters]`
      : section.body;
    parts.push(`# ${section.title}\n\n${body.trim()}`);
  }
  return parts.map((part) => part.trim()).filter((part) => part).join("\n\n---\n\n") + "\n";
}

/** Short, plain description of each role for the console and the workbench. */
export const ROLE_LABELS: Record<LoopRole, string> = {
  prompt_tailor: "Prompt tailor",
  planner: "Planner",
  rubric: "Rubric agent",
  composer: "Composer",
  evaluator: "Evaluator",
  final_response: "Final response",
};
