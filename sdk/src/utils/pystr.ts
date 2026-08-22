// Ported 1:1 from LongHorizon-Harness src/lh_harness/ (Python string semantics helpers).
//
// Python's `str.strip()` removes every character for which `str.isspace()` is
// true; that set is not the same as the one `String.prototype.trim()` removes
// (Python strips \x1c-\x1f and \x85 but not ﻿; JS does the opposite).
// These helpers keep the ported code byte-faithful to the original.

/** Characters Python's `str.strip()` removes (i.e. `str.isspace()` is true). */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LSTRIP_RE = new RegExp(`^[${PY_SPACE}]+`);
const RSTRIP_RE = new RegExp(`[${PY_SPACE}]+$`);

/** Python `str.strip()`. */
export function pyStrip(value: string): string {
  return value.replace(LSTRIP_RE, "").replace(RSTRIP_RE, "");
}

/** Python `str.lstrip()`. */
export function pyLstrip(value: string): string {
  return value.replace(LSTRIP_RE, "");
}

/** Python `str.rstrip()`. */
export function pyRstrip(value: string): string {
  return value.replace(RSTRIP_RE, "");
}

/**
 * Python `re.split(pattern, text, maxsplit=1)` without capture groups:
 * returns `[head, tail]` on the first match, else `[text]`.
 */
export function pySplitOnce(text: string, pattern: RegExp): string[] {
  const re = pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
  const match = re.exec(text);
  if (match === null) return [text];
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}

/** Python `str.rfind(sub[, start[, end]])`; -1 when absent. */
export function pyRfind(text: string, sub: string, start = 0, end?: number): number {
  const stop = end === undefined ? text.length : end;
  const index = text.slice(0, stop).lastIndexOf(sub);
  return index < start ? -1 : index;
}
