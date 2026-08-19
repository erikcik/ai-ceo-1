/**
 * Read the verdict out of an evaluator's output: the first line that is exactly
 * PASS or NEEDS_WORK after stripping markdown emphasis and whitespace (never
 * underscores -- NEEDS_WORK contains one). Null means no verdict at all, which
 * the loop treats as a crashed judge, not a failing one: in the first bash
 * smoke run an evaluator died on an API error mid-sentence and the wrapper
 * handed the error text to the next builder as its work list.
 */
export function parseVerdict(text: string): "PASS" | "NEEDS_WORK" | null {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[`*#\s]/g, "");
    if (line === "PASS") return "PASS";
    if (line === "NEEDS_WORK") return "NEEDS_WORK";
  }
  return null;
}
