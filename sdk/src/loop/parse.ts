// Parsers for the structured tails of agent output. Every role ends its final
// message with one fenced JSON block; the prompt tailor uses `=== ROLE ===`
// section markers. Parsing is forgiving about surrounding prose and strict
// about the payload.

export function extractJsonBlock(text: string): Record<string, unknown> | null {
  const source = text ?? "";
  // Prefer the last fenced block (roles are told to end with it).
  const fence = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fence.exec(source)) !== null) blocks.push(match[1]!);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseObject(blocks[index]!);
    if (parsed) return parsed;
  }
  // Fallback: the last balanced top-level object in the text.
  const candidates = balancedObjects(source);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseObject(candidates[index]!);
    if (parsed) return parsed;
  }
  return null;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Common LLM slip: trailing commas.
    try {
      const value = JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1"));
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return out;
}

export const TAILOR_ROLES = ["planner", "rubric", "composer", "evaluator"] as const;
export type TailorRole = (typeof TAILOR_ROLES)[number];

/** `=== PLANNER === ... === RUBRIC === ...` → per-role briefing text. */
export function parseTailorSections(text: string): Record<TailorRole, string> {
  const result: Record<TailorRole, string> = { planner: "", rubric: "", composer: "", evaluator: "" };
  const pattern = /^[ \t]*===\s*([A-Za-z_]+)\s*===[ \t]*$/gm;
  const marks: { role: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    marks.push({ role: match[1]!.toLowerCase(), start: match.index, end: match.index + match[0].length });
  }
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]!;
    const next = marks[index + 1];
    const body = text.slice(mark.end, next ? next.start : text.length).trim();
    if ((TAILOR_ROLES as readonly string[]).includes(mark.role)) {
      result[mark.role as TailorRole] = body;
    }
  }
  return result;
}

/** Text before the final fenced JSON block — the role's narrative. */
export function narrativeBeforeJson(text: string): string {
  const source = text ?? "";
  const index = source.lastIndexOf("```json");
  const cut = index >= 0 ? index : source.lastIndexOf("```");
  return (cut >= 0 ? source.slice(0, cut) : source).trim();
}
