/**
 * The denylist safety-gate enforces: sdk/danger-patterns.txt, unchanged format
 * from the bash harness (CATEGORY<TAB>regex<TAB>reason). A malformed rule makes
 * the gate FAIL CLOSED -- every call is denied until an operator fixes the file
 * -- because a gate that silently drops rules reports clean while enforcing
 * nothing (that is exactly how the first bash version failed).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DangerRule = { category: string; rx: RegExp; why: string };
export type DangerRules =
  | { ok: true; rules: DangerRule[] }
  | { ok: false; error: string };

export const DEFAULT_PATTERNS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "danger-patterns.txt");

export function loadDangerRules(file: string = DEFAULT_PATTERNS_FILE): DangerRules {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return { ok: false, error: `danger-patterns file missing: ${file}` };
  }
  const rules: DangerRule[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const bits = line.split("\t");
    if (bits.length < 3) {
      return { ok: false, error: `danger-patterns.txt line ${i + 1} is not CATEGORY<TAB>regex<TAB>reason` };
    }
    const [category, pattern] = [bits[0].trim(), bits[1]];
    const why = bits.slice(2).join("\t").trim();
    try {
      rules.push({ category, rx: new RegExp(pattern, "i"), why });
    } catch (e) {
      return { ok: false, error: `danger-patterns.txt line ${i + 1} is not a valid regex (${e})` };
    }
  }
  return { ok: true, rules };
}

/**
 * The haystack is purpose-built: the fields that describe what the call DOES
 * (tool name, command, paths, url) -- never file contents, so writing prose
 * about `git push` does not trip it.
 */
export function dangerHaystack(toolName: string, toolInput: Record<string, unknown>): string {
  const parts = [toolName];
  for (const key of ["command", "file_path", "path", "url", "notebook_path", "query"]) {
    const v = toolInput[key];
    if (typeof v === "string") parts.push(v);
  }
  return parts.filter(Boolean).join("\n");
}

export function matchDanger(rules: DangerRule[], hay: string): DangerRule | null {
  for (const r of rules) if (r.rx.test(hay)) return r;
  return null;
}
