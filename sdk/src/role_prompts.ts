// Ported from LongHorizon-Harness src/lh_harness/role_prompts.py
//
// Six prompt builders, seven manager-output parsers and five history formatters.
// This harness is English-only: the upstream `zh` prompt bodies, Chinese route
// markers, and Chinese transcript headings were removed. Python semantics are
// otherwise mirrored, including the never-resetting `skipping_protocol` flag
// and the bare `[:n]` slice used for the verified deliverable.

import {
  AUDITOR_CONTRACT_BACKCHECK,
  CLI_AUDITOR_INSTRUCTIONS,
  CLI_EXECUTOR_INSTRUCTIONS,
  FINAL_RESPONSE_INSTRUCTIONS,
  FINAL_STATE_SEMANTIC_GUARD,
  GUI_AUDITOR_INSTRUCTIONS,
  GUI_EXECUTOR_INSTRUCTIONS,
  MANAGER_INSTRUCTIONS,
  PY_WHITESPACE,
  TASK_CONTRACT_RULES,
  USER_CLARIFICATION_NOTE,
  normalizePromptLanguage,
  stripPythonWhitespace,
} from "./prompt_texts.js";
import type { PromptLanguage } from "./prompt_texts.js";

export { normalizePromptLanguage };
export type { PromptLanguage };

/** Mirrors `types.RoleNextStep`. */
export type RoleNextStep = "gui" | "cli" | "done" | "blocked" | "invalid" | "ask";

/**
 * The subset of `types.ManagedRound` these functions read. Field names stay in
 * Python's snake_case because the on-disk round ledger keeps Python's keys.
 * Optional fields mirror the dataclass defaults (`""`).
 */
export interface ManagedRoundLike {
  round_index: number;
  next_step: RoleNextStep;
  plan_text: string;
  executor_output?: string;
  auditor_report?: string;
  harness_feedback?: string;
  task_state?: string;
  task_contract?: string;
}

export const MANAGER_NEXT_GUI: RoleNextStep = "gui";
export const MANAGER_NEXT_CLI: RoleNextStep = "cli";
export const MANAGER_NEXT_DONE: RoleNextStep = "done";
export const MANAGER_NEXT_BLOCKED: RoleNextStep = "blocked";
export const MANAGER_NEXT_INVALID: RoleNextStep = "invalid";
export const MANAGER_NEXT_ASK: RoleNextStep = "ask";

// Backward-compatible public constants now expose the production-default
// English catalog. Runtime builders select either catalog explicitly.
export const LH_HARNESS_MANAGER_INSTRUCTIONS = MANAGER_INSTRUCTIONS["en"];
export const LH_HARNESS_GUI_EXECUTOR_INSTRUCTIONS = GUI_EXECUTOR_INSTRUCTIONS["en"];
export const LH_HARNESS_CLI_EXECUTOR_INSTRUCTIONS = CLI_EXECUTOR_INSTRUCTIONS["en"];
export const LH_HARNESS_GUI_AUDITOR_INSTRUCTIONS = GUI_AUDITOR_INSTRUCTIONS["en"];
export const LH_HARNESS_CLI_AUDITOR_INSTRUCTIONS = CLI_AUDITOR_INSTRUCTIONS["en"];

// ---------------------------------------------------------------------------
// Python string / regex semantics
// ---------------------------------------------------------------------------

/** Contents of a character class equivalent to Python's `\s` for `str` patterns. */
const S_INNER =
  "\\u0009\\u000a\\u000b\\u000c\\u000d\\u001c-\\u001f\\u0020" +
  "\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Equivalent of Python's `\s`. */
const S = `[${S_INNER}]`;
/** Equivalent of Python's `^` under `re.MULTILINE` (only `\n` starts a new line). */
const BOL = "(?:(?<![\\s\\S])|(?<=\\n))";
/** Equivalent of Python's `\Z`. */
const EOS = "(?![\\s\\S])";
/** Equivalent of Python's `\w` for `str` patterns, for emulating `\b`. */
const WORD = "[\\p{L}\\p{N}_]";

/** `str.strip()` with Python's whitespace set. */
const pyStrip = stripPythonWhitespace;

/** `str.lstrip()` with Python's whitespace set. */
function pyLstrip(value: string): string {
  let start = 0;
  while (start < value.length && PY_WHITESPACE.includes(value[start]!)) start += 1;
  return value.slice(start);
}

/** `str.rstrip()` with Python's whitespace set. */
function pyRstrip(value: string): string {
  let end = value.length;
  while (end > 0 && PY_WHITESPACE.includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

/** `str.strip(chars)`. */
function pyStripChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start]!)) start += 1;
  while (end > start && chars.includes(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

/** `str.splitlines()` — Python splits on more boundaries than `String.split("\n")`. */
function pySplitlines(value: string): string[] {
  if (value === "") return [];
  const boundary = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/g;
  const out: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(value)) !== null) {
    out.push(value.slice(last, match.index));
    last = match.index + match[0].length;
  }
  if (last < value.length) out.push(value.slice(last));
  return out;
}

/** `str.split(sep, maxsplit=1)[-1]` for a one-character-class separator. */
function pySplitOnceTail(value: string, separators: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (separators.includes(value[index]!)) return value.slice(index + 1);
  }
  return value;
}

/** `str.rfind(sub, start, end)`: the match must lie entirely inside [start, end). */
function pyRfind(value: string, sub: string, start: number, end: number): number {
  if (end - start < sub.length) return -1;
  const index = value.lastIndexOf(sub, end - sub.length);
  return index >= start ? index : -1;
}

/** `Pattern.search(string, pos)` for a `g`-flagged regex. */
function searchFrom(pattern: RegExp, value: string, position: number): RegExpExecArray | null {
  pattern.lastIndex = position;
  const match = pattern.exec(value);
  pattern.lastIndex = 0;
  return match;
}

/** Decimal value of a Unicode `Nd` character, matching what Python's `int()` accepts. */
function unicodeDigitValue(char: string): number | null {
  const code = char.codePointAt(0);
  if (code === undefined) return null;
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const isDigit = (value: number): boolean =>
    value >= 0 && /\p{Nd}/u.test(String.fromCodePoint(value));
  if (!isDigit(code)) return null;
  for (let value = 0; value <= 9; value += 1) {
    if (!isDigit(code - value)) return null;
    if (!isDigit(code - value - 1)) return value;
  }
  return null;
}

/** `int(value)` for a string of Unicode decimal digits. */
function pyIntDigits(value: string): number | null {
  let total = 0;
  for (const char of value) {
    const digit = unicodeDigitValue(char);
    if (digit === null) return null;
    total = total * 10 + digit;
  }
  return total;
}

/** Code points, so slicing and `len()` count the way Python does. */
function pyChars(value: string): string[] {
  return Array.from(value);
}

/** `text[:max_chars]` counted in code points. */
function pyHead(value: string, maxChars: number): string {
  const chars = pyChars(value);
  if (chars.length <= maxChars) return value;
  return chars.slice(0, maxChars).join("");
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export interface BuildRoleManagerPromptOptions {
  task: string;
  rounds: ManagedRoundLike[];
  roundIndex: number;
  taskState?: string;
  taskContract?: string;
  roundBudget?: number | null;
  language?: string;
  maxHistoryChars?: number;
}

export function buildRoleManagerPrompt(options: BuildRoleManagerPromptOptions): string {
  const {
    task,
    rounds,
    roundIndex,
    taskState = "",
    taskContract = "",
    roundBudget = null,
    language = "en",
    maxHistoryChars = 36_000,
  } = options;
  const lang = normalizePromptLanguage(language);
  const configuredBudget = Math.max(roundIndex, Math.trunc(roundBudget || roundIndex));
  const remainingRounds = Math.max(1, configuredBudget - roundIndex + 1);
  const auditorReports = formatVerifiedIntermediateContext(rounds, {
    maxChars: maxHistoryChars,
    language: lang,
  });
  const harnessFeedback = formatHarnessFeedbackContext(rounds, { maxChars: maxHistoryChars });
  return `${pyStrip(MANAGER_INSTRUCTIONS[lang])}

Original task:
${pyRstrip(task)}

Task-contract and final-state rules:
${pyStrip(TASK_CONTRACT_RULES[lang])}

${pyStrip(USER_CLARIFICATION_NOTE[lang])}

Mandatory final-state guard:
${pyStrip(FINAL_STATE_SEMANTIC_GUARD[lang])}

Current stable task contract:
${pyStrip(taskContract) || "(No task contract yet. Initialize it from the original task in this round.)"}

Previous current-task state:
${pyStrip(taskState) || "(No maintained state yet. Initialize it from the original task.)"}

Historical auditor reports by round (authority for trusted intermediate state):
${auditorReports || "(No auditor reports yet.)"}

Harness management feedback (not an audit; only for protocol/completion correction):
${harnessFeedback || "(No harness feedback.)"}

Round budget:
- Current management round: ${roundIndex}
- Configured round limit: ${configuredBudget}
- Rounds remaining, including this one: ${remainingRounds}
- If only one round remains, do not schedule a prerequisite-only subtask that deliberately postpones core requirements. Route the most complete executable subtask possible, or ask/block when completion is impossible.

Output only the next management result.
`;
}

export interface BuildRoleExecutorPromptOptions {
  task: string;
  planText: string;
  nextStep: RoleNextStep;
  taskState?: string;
  taskContract?: string;
  relatedAuditorReports?: string;
  workspacePath?: string;
  language?: string;
}

export function buildRoleExecutorPrompt(options: BuildRoleExecutorPromptOptions): string {
  const {
    task,
    planText,
    nextStep,
    taskState = "",
    taskContract = "",
    relatedAuditorReports = "",
    workspacePath = "",
    language = "en",
  } = options;
  const lang = normalizePromptLanguage(language);
  const gui = nextStep === MANAGER_NEXT_GUI;
  const roleName = gui ? "GUI/visual" : "CLI/non-GUI";
  const roleInstructions = gui ? GUI_EXECUTOR_INSTRUCTIONS[lang] : CLI_EXECUTOR_INSTRUCTIONS[lang];
  return `${pyStrip(roleInstructions)}

Original task:
${pyRstrip(task)}

Task-contract rules:
${pyStrip(TASK_CONTRACT_RULES[lang])}

${pyStrip(USER_CLARIFICATION_NOTE[lang])}

Final-state guard for this subtask:
${pyStrip(FINAL_STATE_SEMANTIC_GUARD[lang])}

Current task state (manager-maintained; facts must come from auditors):
${pyStrip(taskState) || "(No maintained task state.)"}

Stable task contract:
${pyStrip(taskContract) || "(No separate contract was maintained; use the Task contract section in the assigned plan.)"}

Real task state and deliverables:
- Workspace root: ${pyStrip(workspacePath) || "(Use the executor environment's current workspace.)"}
- Durable files belong in that workspace (or in the explicitly requested target application), not in the harness run-record directory.
- Report exact paths and observable target-application state so the Auditor can independently verify them. Harness prompts, trajectories, and role output logs are execution records, not proof that the task succeeded.

Assigned ${roleName} subtask contract:
${pyRstrip(planText)}

Related auditor reports selected by round id:
${pyStrip(relatedAuditorReports) || "(The manager referenced no related auditor report.)"}

Complete only this subtask. Treat audited state and the stable contract as the trusted semantic boundary. Do not repeat audited work or use suspect, violating, fabricated, untrusted, or deleted artifacts. If context is missing or another dominant task type is required, stop and report it; do not guess or globally replan.
`;
}

export interface BuildRoleAuditorPromptOptions {
  task: string;
  planText: string;
  executorOutput: string;
  nextStep: RoleNextStep;
  taskState?: string;
  taskContract?: string;
  relatedAuditorReports?: string;
  workspacePath?: string;
  maxExecutorOutputChars?: number;
  language?: string;
}

export function buildRoleAuditorPrompt(options: BuildRoleAuditorPromptOptions): string {
  const {
    task,
    planText,
    executorOutput,
    nextStep,
    taskState = "",
    taskContract = "",
    relatedAuditorReports = "",
    workspacePath = "",
    maxExecutorOutputChars = 24_000,
    language = "en",
  } = options;
  const lang = normalizePromptLanguage(language);
  const gui = nextStep === MANAGER_NEXT_GUI;
  const roleName = gui ? "GUI/visual" : "CLI/non-GUI";
  const roleInstructions = gui ? GUI_AUDITOR_INSTRUCTIONS[lang] : CLI_AUDITOR_INSTRUCTIONS[lang];
  return `${pyStrip(roleInstructions)}

Original task:
${pyRstrip(task)}

Mandatory final-state guard:
${pyStrip(FINAL_STATE_SEMANTIC_GUARD[lang])}

Current task state (background only; audit only this subtask):
${pyStrip(taskState) || "(No maintained task state.)"}

Stable task contract (primary target reference, but do not assume it is correct):
${pyStrip(taskContract) || "(No separate contract was maintained; use the Task contract section in the assigned plan.)"}

Independent evidence boundary:
- Real workspace root: ${pyStrip(workspacePath) || "(Use the auditor environment's current workspace.)"}
- Independently inspect claimed files, commands/tests/logs/services, and the current target GUI/application when relevant. Executor text is only a claim.
- Harness prompts, trajectories, role outputs, and prior reports are run records, not task deliverables or standalone completion evidence. Do not require every subtask to create a file when its consumed result is legitimately application state, a user-facing response, or independently observable external state.
- If the Executor deliberately saved a screenshot or visual artifact in the real task environment, inspect that artifact and its current source state. Private Dashboard trajectory images are operator run records and are not injected as audit evidence.

Just-finished ${roleName} subtask:
${pyRstrip(planText)}

Executor natural-language output:
${clipPreserve(pyRstrip(executorOutput), maxExecutorOutputChars)}

Related auditor reports (background, never a substitute for direct read-only audit):
${pyStrip(relatedAuditorReports) || "(The manager referenced no related auditor report.)"}

${pyStrip(AUDITOR_CONTRACT_BACKCHECK[lang])}

Audit only whether this subtask truly completed, stayed within its dominant boundary, and remained trustworthy. Record still-trusted state, new trusted artifacts, and untrusted/deleted artifacts. End with \`State update for manager:\`. Never output JSON.
`;
}

export interface BuildRoleAuditorFormatRepairPromptOptions {
  reportText: string;
  language?: string;
}

export function buildRoleAuditorFormatRepairPrompt(
  options: BuildRoleAuditorFormatRepairPromptOptions,
): string {
  const { reportText, language = "en" } = options;
  normalizePromptLanguage(language);
  return `Your previous auditor report lacks a valid three-line control header. This is formatting repair, not a new audit: use no tools and change no environment state. Re-emit the same report from its existing content only.

The first three nonempty lines must be exactly one value from each group:
Status: complete | Status: incomplete | Status: blocked
Integrity: clean | Integrity: suspect | Integrity: violation
Contract audit: aligned | Contract audit: unknown | Contract audit: needs_revision | Contract audit: invalid

Use aligned only when the report's acceptance-constraint backcheck explicitly supports it. If the conclusion cannot be determined, conservatively use:
Status: blocked
Integrity: suspect
Contract audit: unknown

Previous auditor report:
${pyStrip(reportText) || "(empty report)"}

Output only the repaired auditor report. Do not explain the repair and do not output JSON.
`;
}

export interface BuildRoleFinalResponsePromptOptions {
  task: string;
  rounds: ManagedRoundLike[];
  status: string;
  abortReason: string;
  taskState: string;
  operatorInstructions?: string;
  language?: string;
  maxEvidenceChars?: number;
  maxDeliverableChars?: number;
}

export function buildRoleFinalResponsePrompt(
  options: BuildRoleFinalResponsePromptOptions,
): string {
  const {
    task,
    rounds,
    status,
    abortReason,
    taskState,
    operatorInstructions = "",
    language = "en",
    maxEvidenceChars = 6_000,
    maxDeliverableChars = 24_000,
  } = options;
  const lang = normalizePromptLanguage(language);
  const findings = formatAuditFindings(rounds, { maxChars: maxEvidenceChars, language: lang });
  // A successful completion is grounded in the latest clean/complete/aligned
  // auditor report. Give the response writer the corresponding executor output
  // as well as the condensed audit: the audit often confirms links, figures, or
  // other required details without repeating the whole user-facing deliverable.
  let verifiedDeliverable = "";
  if (status === "complete") {
    let candidate = "";
    for (let index = rounds.length - 1; index >= 0; index -= 1) {
      const item = rounds[index]!;
      const executorOutput = pyStrip(item.executor_output ?? "");
      if (executorOutput && pyStrip(item.auditor_report ?? "")) {
        candidate = executorOutput;
        break;
      }
    }
    verifiedDeliverable = pyHead(candidate, maxDeliverableChars);
  }
  let outcome = `Run outcome: ${status}`;
  if (abortReason) outcome += ` (ended because: ${abortReason})`;
  return `${pyStrip(FINAL_RESPONSE_INSTRUCTIONS[lang])}

Original request:
${pyRstrip(task)}

Authoritative operator follow-up instructions:
${pyStrip(operatorInstructions) || "(None.)"}

${outcome}

Verified state:
${pyStrip(taskState) || "(Nothing was verified.)"}

Audit findings:
${findings || "(No audit was produced.)"}

Verified deliverable from the accepted executor:
${verifiedDeliverable || "(No standalone deliverable was produced.)"}

Write the reply now. Output only the reply.
`;
}

// ---------------------------------------------------------------------------
// Audit findings
// ---------------------------------------------------------------------------

// Control headers and the backcheck protocol are addressed to the manager, so the
// user-facing reply only needs the prose findings underneath them.
const AUDIT_HEADER_RE = new RegExp(
  `^(?:\\*\\*)?${S}*(?:status|integrity|contract(?:[_${S_INNER}-]*audit)?)${S}*:`,
  "i",
);
const AUDIT_PROTOCOL_RE = new RegExp(
  `^(?:\\*\\*)?${S}*(?:acceptance[-${S_INNER}]constraint${S}+backcheck|contract${S}+conclusion|original${S}+constraint${S}+inventory` +
    `|contract${S}+coverage${S}+check|per[-${S_INNER}]constraint${S}+backcheck|blocking${S}+constraints` +
    `|possible${S}+scoring${S}+risks|over[-${S_INNER}]narrow[^:]*|recommended${S}+contract${S}+revision` +
    `|state${S}+update${S}+for${S}+manager)${S}*:`,
  "i",
);

export interface FormatAuditFindingsOptions {
  maxChars?: number;
  language?: string;
}

/** Condense each round's audit into the findings a user-facing reply needs. */
export function formatAuditFindings(
  rounds: ManagedRoundLike[],
  options: FormatAuditFindingsOptions = {},
): string {
  const { maxChars = 6_000, language = "en" } = options;
  normalizePromptLanguage(language);
  const sections: string[] = [];
  for (const item of rounds) {
    const report = pyStrip(item.auditor_report ?? "");
    if (!report) continue;
    const body: string[] = [];
    const verdicts: string[] = [];
    // Faithful quirk: once set this is never reset, so every protocol section
    // after the first one is dropped for the rest of the report.
    let skippingProtocol = false;
    for (const line of pySplitlines(report)) {
      const value = pyStrip(line);
      if (!value) continue;
      if (AUDIT_HEADER_RE.test(value)) {
        const verdict = pyStripChars(
          pyStrip(pySplitOnceTail(value, ":")),
          "*",
        );
        if (verdict) verdicts.push(verdict);
        continue;
      }
      if (AUDIT_PROTOCOL_RE.test(value)) {
        skippingProtocol = true;
        continue;
      }
      if (skippingProtocol) continue;
      body.push(value);
    }
    const heading =
      `Round ${item.round_index}` + (verdicts.length ? ` (${verdicts.join("/")})` : "");
    sections.push([heading, clipPreserve(body.join("\n"), 1200)].join("\n"));
  }
  return clipPreserve(sections.join("\n\n"), maxChars);
}

// ---------------------------------------------------------------------------
// Manager-output parsers
// ---------------------------------------------------------------------------

const ROUTE_COMMENT_RE = /(?:—|–|--|\/\/|#|\()/;

export function parseRoleManagerNextStep(text: string | null | undefined): RoleNextStep {
  for (const line of pySplitlines(text ? String(text) : "")) {
    let normalized = pyStripChars(pyStrip(line), "*")
      .replaceAll(" ", "")
      .toLowerCase();
    // Models commonly append a short rationale after the required route,
    // e.g. `Next: done — all constraints passed`. Treat only an explicitly
    // delimited suffix as commentary so prose such as `Next: done later`
    // remains invalid.
    const comment = ROUTE_COMMENT_RE.exec(normalized);
    if (comment) normalized = normalized.slice(0, comment.index);
    if (normalized === "next:gui") return MANAGER_NEXT_GUI;
    if (normalized === "next:cli") return MANAGER_NEXT_CLI;
    if (normalized === "next:ask") return MANAGER_NEXT_ASK;
    if (normalized === "next:done" || normalized === "next:complete") return MANAGER_NEXT_DONE;
    if (normalized === "next:blocked") return MANAGER_NEXT_BLOCKED;
  }
  return MANAGER_NEXT_INVALID;
}

const QUESTION_HEAD_EN_RE = new RegExp(`^question${S}*:`, "i");
const QUESTION_STOP_RE = new RegExp(
  `^${S}*(?:\\*\\*)?${S}*(?:choices|current${S}+task${S}+state|task${S}+contract|dependency${S}+assessment|next|task` +
    `|acceptance${S}+criteria|related${S}+audit${S}+reports|related${S}+audited${S}+state|boundaries)${S}*:`,
  "i",
);

/** Return the `Question:` block from a `Next: ask` plan (question for the human). */
export function extractRoleManagerQuestion(planText: string | null | undefined): string {
  const lines = pySplitlines(planText ? String(planText) : "");
  let collecting = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (!collecting) {
      if (QUESTION_HEAD_EN_RE.test(pyStripChars(pyStrip(line), "*"))) {
        collecting = true;
        // Split on the heading's own colon; a colon later in the question
        // text must not truncate it.
        const rest = pySplitOnceTail(line, ":");
        if (pyStrip(rest)) collected.push(pyStrip(rest));
      }
      continue;
    }
    // stop at the next known section header
    if (QUESTION_STOP_RE.test(line)) break;
    collected.push(pyRstrip(line));
  }
  return pyStrip(collected.join("\n"));
}

const CHOICES_LINE_RE = new RegExp(`^${S}*choices${S}*:${S}*(.+)$`, "i");
const CHOICE_SPLIT_RE = new RegExp(`${S}*[|,/]${S}*`);
const YES_NO_RE = new RegExp(`(?<!${WORD})(?:yes${S}*/${S}*no|whether)(?!${WORD})`, "iu");

/**
 * Return quick-answer choices for a `Next: ask` gate.
 *
 * Prefers an explicit `Choices:` line (e.g. `Choices: Yes | No`); when absent
 * but the question is clearly yes/no, falls back to `["Yes", "No"]`. Empty
 * means the human just types a free-form answer.
 */
export function extractRoleManagerAnswerChoices(planText: string | null | undefined): string[] {
  for (const line of pySplitlines(planText ? String(planText) : "")) {
    const stripped = pyStripChars(pyStrip(line), "*");
    const match = CHOICES_LINE_RE.exec(stripped);
    if (match) {
      const raw = match[1]!;
      const parts = raw.split(CHOICE_SPLIT_RE);
      const choices = parts.map((part) => pyStrip(part)).filter((part) => part !== "");
      if (choices.length) return choices.slice(0, 6);
    }
  }
  const question = extractRoleManagerQuestion(planText);
  if (YES_NO_RE.test(question)) return ["Yes", "No"];
  return [];
}

const MANAGER_ROUTE_LINE_RE = new RegExp(
  `${BOL}${S}*(?:\\*\\*)?${S}*next${S}*:${S}*(?:gui|cli|ask|done|complete|blocked)`,
  "gi",
);

/**
 * Return the final state+route block from a noisy assistant transcript.
 *
 * Claude Code stream logs can contain separate thinking and final assistant
 * message records. The manager contract is the final natural-language
 * task-state plus route block, not wrapper transcript headings.
 */
export function extractRoleManagerPlanText(text: string | null | undefined): string {
  const raw = pyStrip(text ? String(text) : "");
  MANAGER_ROUTE_LINE_RE.lastIndex = 0;
  const matches = [...raw.matchAll(MANAGER_ROUTE_LINE_RE)];
  if (!matches.length) return raw;
  const routeStart = matches[matches.length - 1]!.index;
  const lowered = raw.toLowerCase();
  const starts = [
    pyRfind(lowered, "current task state", 0, routeStart),
    pyRfind(lowered, "task contract", 0, routeStart),
  ].filter((position) => position >= 0);
  if (starts.length) return pyStrip(raw.slice(Math.min(...starts)));
  return pyStrip(raw.slice(routeStart));
}

const TASK_STATE_HEADER_RE = new RegExp(
  `${BOL}${S}*(?:\\*\\*)?${S}*current${S}+task${S}+state${S}*:`,
  "gi",
);
const TASK_STATE_BOUNDARY_RE = new RegExp(
  `${BOL}${S}*(?:\\*\\*)?${S}*(?:task${S}+contract|dependency${S}+assessment` +
    `|next${S}*:${S}*(?:gui|cli|ask|done|complete|blocked))`,
  "gi",
);
const TASK_CONTRACT_HEADER_RE = new RegExp(
  `${BOL}${S}*(?:\\*\\*)?${S}*task${S}+contract${S}*:`,
  "gi",
);
const TASK_CONTRACT_BOUNDARY_RE = new RegExp(
  `${BOL}${S}*(?:\\*\\*)?${S}*(?:dependency${S}+assessment` +
    `|next${S}*:${S}*(?:gui|cli|ask|done|complete|blocked))`,
  "gi",
);
const RELATED_REPORT_SECTION_RE = new RegExp(
  `${BOL}${S}*(?:\\*\\*)?${S}*related${S}+(?:audit${S}+reports|audited${S}+state)${S}*:${S}*(.*?)` +
    `(?=${BOL}${S}*(?:\\*\\*)?${S}*(?:boundaries|task|acceptance${S}+criteria|next)${S}*:|${EOS})`,
  "gis",
);
const ROUND_REF_SOURCE = `(?<!${WORD})round_(\\p{Nd}+)(?!${WORD})`;
const ROUND_REF_RE = new RegExp(ROUND_REF_SOURCE, "iu");
const ROUND_REF_RE_G = new RegExp(ROUND_REF_SOURCE, "giu");

export interface ExtractRoleSectionOptions {
  fallback?: string;
}

export function extractRoleTaskState(
  text: string | null | undefined,
  options: ExtractRoleSectionOptions = {},
): string {
  const { fallback = "" } = options;
  const raw = pyStrip(text ? String(text) : "");
  const match = searchFrom(TASK_STATE_HEADER_RE, raw, 0);
  if (!match) return pyStrip(fallback);
  const boundary = searchFrom(TASK_STATE_BOUNDARY_RE, raw, match.index + match[0].length);
  const end = boundary ? boundary.index : raw.length;
  const state = pyStrip(raw.slice(match.index, end));
  return state || pyStrip(fallback);
}

export function extractRoleTaskContract(
  text: string | null | undefined,
  options: ExtractRoleSectionOptions = {},
): string {
  const { fallback = "" } = options;
  const raw = pyStrip(text ? String(text) : "");
  const match = searchFrom(TASK_CONTRACT_HEADER_RE, raw, 0);
  if (!match) return pyStrip(fallback);
  const boundary = searchFrom(TASK_CONTRACT_BOUNDARY_RE, raw, match.index + match[0].length);
  const end = boundary ? boundary.index : raw.length;
  const contract = pyStrip(raw.slice(match.index, end));
  return contract || pyStrip(fallback);
}

export function extractRelatedReportRefs(text: string | null | undefined): string[] {
  const raw = text ? String(text) : "";
  RELATED_REPORT_SECTION_RE.lastIndex = 0;
  const sections = [...raw.matchAll(RELATED_REPORT_SECTION_RE)].map((match) => match[1] ?? "");
  const searchText = sections.length ? sections.join("\n") : raw;
  const refs: string[] = [];
  const seen = new Set<number>();
  ROUND_REF_RE_G.lastIndex = 0;
  for (const match of searchText.matchAll(ROUND_REF_RE_G)) {
    const value = match[1] ?? "";
    if (!value) continue;
    const number = pyIntDigits(value);
    if (number === null || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    refs.push(`round_${String(number).padStart(3, "0")}`);
  }
  return refs;
}

export function roundRefToIndex(ref: string | null | undefined): number | null {
  const match = ROUND_REF_RE.exec(ref ? String(ref) : "");
  if (!match) return null;
  const value = match[1] ?? "";
  if (!value) return null;
  return pyIntDigits(value);
}

// ---------------------------------------------------------------------------
// History / context formatters
// ---------------------------------------------------------------------------

export interface FormatRelatedAuditorReportsOptions {
  maxChars?: number;
  language?: string;
}

export function formatRelatedAuditorReports(
  rounds: ManagedRoundLike[],
  refs: string[],
  options: FormatRelatedAuditorReportsOptions = {},
): string {
  const { maxChars = 60_000, language = "en" } = options;
  const selected: ManagedRoundLike[] = [];
  const refNumbers = new Set<number>();
  for (const item of refs) {
    const index = roundRefToIndex(item);
    if (index !== null) refNumbers.add(index);
  }
  for (const item of rounds) {
    if (refNumbers.has(item.round_index) && pyStrip(item.auditor_report ?? "")) {
      selected.push(item);
    }
  }
  return formatVerifiedIntermediateContext(selected, { maxChars, language });
}

export interface FormatHarnessFeedbackContextOptions {
  maxChars?: number;
}

export function formatHarnessFeedbackContext(
  rounds: ManagedRoundLike[],
  options: FormatHarnessFeedbackContextOptions = {},
): string {
  const { maxChars = 12_000 } = options;
  const sections: string[] = [];
  for (const item of rounds) {
    const feedback = pyStrip(item.harness_feedback ?? "");
    if (!feedback) continue;
    sections.push([`--- Round ${item.round_index} harness feedback ---`, feedback].join("\n"));
  }
  return clipPreserve(sections.join("\n\n"), maxChars);
}

export interface FormatVerifiedIntermediateContextOptions {
  maxChars?: number;
  language?: string;
}

export function formatVerifiedIntermediateContext(
  rounds: ManagedRoundLike[],
  options: FormatVerifiedIntermediateContextOptions = {},
): string {
  const { maxChars = 30_000, language = "en" } = options;
  normalizePromptLanguage(language);
  const sections: string[] = [];
  for (const item of rounds) {
    const report = pyStrip(item.auditor_report ?? "");
    if (!report) continue;
    const subtask = pyStrip(item.plan_text ?? "");
    sections.push(
      [
        `--- Round ${item.round_index} auditor report ---`,
        `round_id: round_${String(item.round_index).padStart(3, "0")}`,
        "Assigned subtask:",
        subtask ? clipPreserve(subtask, 1600) : "(none)",
        "Original auditor report:",
        clipPreserve(report, 5000),
      ].join("\n"),
    );
  }
  return clipPreserve(sections.join("\n\n"), maxChars);
}

export interface FormatManagementHistoryOptions {
  includeEmpty?: boolean;
  maxChars?: number;
}

export function formatManagementHistory(
  rounds: ManagedRoundLike[],
  options: FormatManagementHistoryOptions = {},
): string {
  const { includeEmpty = false, maxChars = 36_000 } = options;
  const sections: string[] = [];
  for (const item of rounds) {
    const planText = item.plan_text ?? "";
    const executorOutput = item.executor_output ?? "";
    const auditorReport = item.auditor_report ?? "";
    const harnessFeedback = item.harness_feedback ?? "";
    const taskContract = item.task_contract ?? "";
    if (!includeEmpty && !(planText || executorOutput || auditorReport || harnessFeedback)) {
      continue;
    }
    sections.push(
      [
        `--- Round ${item.round_index}: ${item.next_step} ---`,
        "Stable task contract:",
        taskContract ? clipPreserve(pyStrip(taskContract), 3000) : "(none)",
        "Manager subtask:",
        clipPreserve(pyStrip(planText), 5000),
        "Executor agent output:",
        executorOutput ? clipPreserve(pyStrip(executorOutput), 5000) : "(none)",
        "Auditor natural-language report:",
        auditorReport ? clipPreserve(pyStrip(auditorReport), 6000) : "(none)",
        "Harness management feedback:",
        harnessFeedback ? clipPreserve(pyStrip(harnessFeedback), 2000) : "(none)",
      ].join("\n"),
    );
  }
  return clipPreserve(sections.join("\n\n"), maxChars);
}

/** The universal 65 % head / 35 % tail clipper (`_clip_preserve`). */
export function clipPreserve(text: string, maxChars: number): string {
  const chars = pyChars(text);
  if (maxChars <= 0 || chars.length <= maxChars) return text;
  const headChars = Math.max(1, Math.trunc(maxChars * 0.65));
  const tailChars = Math.max(1, maxChars - headChars);
  return (
    pyRstrip(chars.slice(0, headChars).join("")) +
    `\n\n...[truncated ${chars.length - maxChars} chars; kept head and tail]...\n\n` +
    pyLstrip(chars.slice(chars.length - tailChars).join(""))
  );
}
