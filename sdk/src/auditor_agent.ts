// Ported 1:1 from LongHorizon-Harness src/lh_harness/auditor_agent.py
//
// The auditor's natural-language report is the harness's only trusted
// intermediate state, so every guard here is deliberately conservative:
// a report without a valid three-line control header is replaced rather than
// guessed at, a completion claim next to a nonempty blocking-constraint list is
// downgraded, and a workspace mutation observed during a read-only audit
// invalidates the audit. This harness is English-only: the upstream Chinese
// control-header synonyms and synthetic sentences were removed.

import { assistantTexts as decodeAgentAssistantTexts, visibleOutput as decodeAgentVisibleOutput } from "./agent_logs.js";
import { hardSignalLabels } from "./runtime_signals.js";
import { pyLstrip, pyRstrip, pyStrip } from "./utils/pystr.js";
import {
  DEFAULT_WORKSPACE_PATH,
  auditReport,
  type AuditReport,
  type AuditStatus,
  type ContractAuditStatus,
  type EpisodeResult,
  type IntegrityStatus,
  type PromptLanguage,
} from "./types.js";

export const COMPACT_REPORT_CHARS = 2_500;
export const STATE_SUMMARY_CHARS = 1_000;
export const ACTION_GUIDANCE_CHARS = 1_200;

// Metadata keys holding assistant-visible text, most specific first. Anything
// rewriting a report must go through these, not `actions_log`, which is ignored
// whenever one of them is present.
export const VISIBLE_OUTPUT_KEYS = [
  "executor_agent_visible_output",
  "visible_executor_output",
  "assistant_visible_output",
  "output_text",
] as const;

const STATUS_CONTROL_LINE_RE =
  /^\s*(?:\*\*)?\s*status\s*:\s*(complete|incomplete|blocked)\s*(?:\*\*)?\s*$/i;
const INTEGRITY_CONTROL_LINE_RE =
  /^\s*(?:\*\*)?\s*integrity\s*:\s*(clean|suspect|violation)\s*(?:\*\*)?\s*$/i;
const CONTRACT_AUDIT_CONTROL_LINE_RE =
  /^\s*(?:\*\*)?\s*contract(?:[_\s-]*audit)?\s*:\s*(aligned|unknown|needs[_\s-]*revision|invalid)\s*(?:\*\*)?\s*$/i;
const BLOCKING_ACCEPTANCE_SECTION_RE =
  /^\s*(?:[-*]\s*)?blocking\s+(?:acceptance\s+)?(?:constraints?|claims?)\s*:\s*(?<rest>.*)$/i;
const NO_BLOCKING_ACCEPTANCE_RE =
  /^\s*(?:[-*+]\s*|\d+[.)]\s*)?(?:none|nothing|n\/?a|not\s+applicable)(?:\s*[.,;:].*)?\s*$/i;
// Every heading the auditor contract prompt mandates must terminate the blocking
// section; otherwise a reordered report leaks the next section into it and the
// acceptance guard downgrades an otherwise clean audit.
const ACCEPTANCE_SECTION_BOUNDARY_RE =
  /^\s*(?:[-*]\s*)?(?:contract\s+conclusion|possible\s+scoring\s+risks|over-narrow|recommended\s+contract\s+revision|audit\s+facts|evidence|gaps?|next\s+step|state\s+update\s+for\s+manager|status|integrity|contract\s+audit|acceptance[-\s]*constraint\s+backcheck|original\s+constraint\s+inventory|contract\s+coverage\s+check|per[-\s]*constraint\s+backcheck)\s*:/im;
const DELETE_DECLARATION_RE =
  /^\s*(?:[-*]\s*)?(?:delete fabricated artifact|delete untrusted artifact|deleted fabricated artifact|deleted untrusted artifact)\s*:\s*(?<rest>.+)$/i;

// Harness-synthesized report fragments. The auditor's own report stays verbatim;
// only these harness-authored lines follow the run's prompt language, and the
// control-header keywords match what the parser above accepts for each language.
const CONTROL_HEADER: Record<PromptLanguage, [string, string, string]> = {
  en: ["Status", "Integrity", "Contract audit"],
};

export const SYNTHETIC_TEXT: Record<string, Record<PromptLanguage, string>> = {
  invalid_header_facts: {
    en: "Audit facts: the auditor report lacks a valid three-line control header; the harness will not guess completion, integrity, or contract audit from the body.",
  },
  invalid_header_gap: {
    en: "Gap: the auditor must state status, integrity, and contract audit on the first three lines.",
  },
  invalid_header_excerpt: {
    en: "Original auditor output excerpt:",
  },
  deleted_ledger: {
    en: "Deletion ledger: the auditor deleted executor artifacts it confirmed to be fabricated or untrusted; those paths can no longer count as valid deliverables.",
  },
  deleted_paths: {
    en: "Deleted paths: ",
  },
  read_only_violation: {
    en: "Auditor read-only violation: the auditor window changed task workspace files while checking.",
  },
  restored: {
    en: "The harness restored the workspace snapshot taken before audit.",
  },
  not_restored: {
    en: "The harness detected a workspace mutation but did not confirm restoration; treat the audit as invalid.",
  },
  violation_claims_invalid: {
    en: "Any claim based on auditor-created or auditor-modified files is invalid.",
  },
  changed_paths: {
    en: "Changed paths observed: ",
  },
  executor_must_repair: {
    en: "The next executor must check and finish the missing deliverables itself; the auditor may only report state, never repair it.",
  },
  diagnostics_only: {
    en: "Original auditor report, for diagnostics only:",
  },
  activity_archive: {
    en:
      `Environment activity note: active processes or unstable file state were already observed under \`${DEFAULT_WORKSPACE_PATH}\` before the auditor ran, ` +
      "and the workspace changed again during the audit window. The harness did not roll these changes back, to avoid misreading real executor or " +
      "background-service progress as auditor writes. This note does not by itself invalidate the round's audit report.",
  },
  completion_guard: {
    en: "Harness completion guard: the auditor listed nonempty blocking constraints, so `complete` and an aligned contract decision are not accepted.",
  },
  runtime_failed: {
    en: "Auditor runtime failed before producing a trustworthy report.",
  },
  runtime_mutation_restored: {
    en: "Auditor also changed task workspace files; the harness restored the pre-audit snapshot.",
  },
  runtime_mutation_not_restored: {
    en: "Auditor also changed task workspace files, and restoration was not confirmed.",
  },
  no_claim_from_logs: {
    en: "No completion claim was accepted from raw runtime logs or echoed prompt text.",
  },
  runtime_failed_guidance: {
    en: "Auditor runtime failed; rerun the audit after fixing the runtime issue.",
  },
};

// --- Python string primitives -------------------------------------------------

/**
 * Python `str.splitlines()`: universal newlines (``\r\n`` counts once) plus the
 * extra Python line boundaries \v \f \x1c \x1d \x1e \x85 \u2028 \u2029, and no
 * trailing empty element when the text ends on a boundary.
 */
const PY_LINE_BOUNDARY_RE = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;

function pySplitLines(value: string): string[] {
  if (value === "") return [];
  const out = value.split(PY_LINE_BOUNDARY_RE);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataOf(result: EpisodeResult): Record<string, unknown> {
  return isPlainObject(result.metadata) ? result.metadata : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- language helpers ---------------------------------------------------------

function language(_value: string | null | undefined): PromptLanguage {
  return "en";
}

function text(key: string, lang: string | null | undefined): string {
  return SYNTHETIC_TEXT[key]![language(lang)];
}

function controlHeader(
  status: string,
  integrity: string,
  contractAudit: string,
  options: { language: string },
): string {
  const [statusLabel, integrityLabel, contractLabel] = CONTROL_HEADER[language(options.language)];
  return `${statusLabel}: ${status}\n${integrityLabel}: ${integrity}\n${contractLabel}: ${contractAudit}`;
}

// --- public entry points ------------------------------------------------------

/**
 * Convert a auditor role episode into the structured report used by the runner.
 *
 * The role manager stores auditor output as natural language, but the
 * final report and stop checks need a compact status, integrity flag, and
 * artifact-deletion ledger.
 */
export function auditReportFromEpisodeResult(
  result: EpisodeResult,
  roundIndex: number,
  options: { language?: string } = {},
): AuditReport {
  const lang = options.language ?? "en";
  const metadata = metadataOf(result);
  const hardRuntimeSignals = hardSignalLabels(metadata["runtime_signals"]);
  if (result.status !== "done" || hardRuntimeSignals.length) {
    return auditReport({
      round_id: `round_${roundIndex}`,
      status: "blocked",
      report_text: runtimeFailureReport(result, hardRuntimeSignals, { language: lang }),
      action_guidance: text("runtime_failed_guidance", lang),
    });
  }

  let reportText = compactAuditorReportText(extractAuditorReportText(episodeVisibleOutput(result)));
  if (!hasValidControlHeader(reportText)) {
    reportText = invalidControlHeaderReport(reportText, { language: lang });
  }
  let status = inferReportStatus(reportText) as AuditStatus;
  let stateSummary = extractStateSummary(reportText);
  let actionGuidance = extractActionGuidance(reportText);
  const [inferredIntegrity, integrityFindings] = inferIntegrityFindings(reportText);
  let integrityStatus: IntegrityStatus = inferredIntegrity;
  let contractAuditStatus = inferContractAuditStatus(reportText) as ContractAuditStatus;
  let artifactActions =
    integrityStatus === "violation" ? extractDeletedArtifactActions(reportText) : [];
  if (metadata["verifier_workspace_mutation_detected"]) {
    const paths = mutationPaths(metadata["verifier_workspace_mutations"]);
    const restoreOnMutation =
      metadata["verifier_workspace_restore_on_mutation"] === undefined
        ? true
        : Boolean(metadata["verifier_workspace_restore_on_mutation"]);
    const restored = Boolean(metadata["verifier_workspace_restored"]);
    const allowedDeletePaths = allowedAuditorDeletePaths(metadata, {
      integrityStatus,
      declaredActions: artifactActions,
    });
    if (allowedDeletePaths.length) {
      artifactActions = reconcileDeletionActions({
        declaredActions: artifactActions,
        confirmedDeletedPaths: allowedDeletePaths,
      });
      let suffix = "\n\n" + text("deleted_ledger", lang);
      suffix += "\n" + text("deleted_paths", lang) + allowedDeletePaths.slice(0, 20).join(", ");
      reportText = compactAuditorReportText(reportText + suffix);
      stateSummary = extractStateSummary(reportText);
      actionGuidance = extractActionGuidance(reportText);
    } else if (restoreOnMutation) {
      const restoreText = text(restored ? "restored" : "not_restored", lang);
      let prefix =
        controlHeader("blocked", "violation", "unknown", { language: lang }) +
        "\n\n" +
        text("read_only_violation", lang) +
        ` ${restoreText} ` +
        text("violation_claims_invalid", lang) +
        "\n";
      if (paths.length) {
        prefix += text("changed_paths", lang) + paths.slice(0, 20).join(", ") + "\n";
      }
      prefix += text("executor_must_repair", lang) + "\n\n" + text("diagnostics_only", lang) + "\n";
      reportText = compactAuditorReportText(prefix + reportText);
      status = "blocked";
      stateSummary = extractStateSummary(reportText);
      actionGuidance = extractActionGuidance(reportText);
      integrityStatus = "violation";
      contractAuditStatus = "unknown";
      integrityFindings.push({
        type: "verifier_workspace_write",
        severity: "violation",
        evidence: "Auditor changed task workspace files during read-only audit.",
        paths,
        restored,
      });
    } else {
      let suffix = "\n\n" + text("activity_archive", lang);
      if (paths.length) {
        suffix += "\n" + text("changed_paths", lang) + paths.slice(0, 20).join(", ");
      }
      reportText = compactAuditorReportText(reportText + suffix);
      stateSummary = extractStateSummary(reportText);
      actionGuidance = extractActionGuidance(reportText);
    }
  }
  artifactActions = markUnconfirmedDeletionDeclarations(artifactActions);
  const guarded = applyAcceptanceConstraintGuard(reportText, status, contractAuditStatus, {
    language: lang,
  });
  reportText = guarded[0];
  status = guarded[1];
  contractAuditStatus = guarded[2];
  if ((integrityStatus === "violation" || contractAuditStatus !== "aligned") && status === "complete") {
    status = "incomplete";
  }
  return auditReport({
    round_id: `round_${roundIndex}`,
    status,
    report_text: reportText,
    state_summary: stateSummary,
    action_guidance: actionGuidance,
    integrity_status: integrityStatus,
    contract_audit_status: contractAuditStatus,
    integrity_findings: integrityFindings,
    artifact_actions: artifactActions,
  });
}

export function parseAuditReport(
  raw: string,
  roundIndex: number,
  options: { language?: string } = {},
): AuditReport {
  const lang = options.language ?? "en";
  let reportText = compactAuditorReportText(extractAuditorReportText(raw));
  if (!hasValidControlHeader(reportText)) {
    reportText = invalidControlHeaderReport(reportText, { language: lang });
  }
  let status = inferReportStatus(reportText) as AuditStatus;
  const [integrityStatus, integrityFindings] = inferIntegrityFindings(reportText);
  let contractAuditStatus = inferContractAuditStatus(reportText) as ContractAuditStatus;
  const guarded = applyAcceptanceConstraintGuard(reportText, status, contractAuditStatus, {
    language: lang,
  });
  reportText = guarded[0];
  status = guarded[1];
  contractAuditStatus = guarded[2];
  if ((integrityStatus === "violation" || contractAuditStatus !== "aligned") && status === "complete") {
    status = "incomplete";
  }
  return auditReport({
    round_id: `round_${roundIndex}`,
    status,
    report_text: reportText,
    state_summary: extractStateSummary(reportText),
    action_guidance: extractActionGuidance(reportText),
    integrity_status: integrityStatus,
    contract_audit_status: contractAuditStatus,
    integrity_findings: integrityFindings,
    artifact_actions: integrityStatus === "violation" ? extractDeletedArtifactActions(reportText) : [],
  });
}

export function auditorReportTextFromEpisodeResult(result: EpisodeResult): string {
  return compactAuditorReportText(extractAuditorReportText(episodeVisibleOutput(result)));
}

/** Prefer adapter-provided assistant text over the diagnostic trajectory. */
function episodeVisibleOutput(result: EpisodeResult): string {
  const metadata = metadataOf(result);
  for (const key of VISIBLE_OUTPUT_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && pyStrip(value)) return pyStrip(value);
  }
  if (metadata["actions_log_diagnostics_only"]) return "";
  const raw = result.actions_log || "";
  const decoded = decodeAgentVisibleOutput(raw);
  return decoded ? decoded : raw;
}

export function hasValidAuditorControlHeader(value: string): boolean {
  return hasValidControlHeader(String(value ?? ""));
}

export function inferReportStatus(value: string): string {
  return parseStatusControlHeader(value) ?? "blocked";
}

export function inferContractAuditStatus(value: string): string {
  return parseContractAuditControlHeader(value) ?? "unknown";
}

// --- acceptance-constraint completion guard -----------------------------------

function applyAcceptanceConstraintGuard(
  reportText: string,
  status: AuditStatus,
  contractAuditStatus: ContractAuditStatus,
  options: { language?: string } = {},
): [string, AuditStatus, ContractAuditStatus] {
  const lang = options.language ?? "en";
  if (status !== "complete" || !hasBlockingAcceptanceConstraints(reportText)) {
    return [reportText, status, contractAuditStatus];
  }
  const guarded = compactAuditorReportText(reportText + "\n\n" + text("completion_guard", lang));
  return [guarded, "incomplete", contractAuditStatus === "aligned" ? "unknown" : contractAuditStatus];
}

function hasBlockingAcceptanceConstraints(value: string): boolean {
  const lines = pySplitLines(String(value ?? ""));
  for (let index = 0; index < lines.length; index += 1) {
    const match = BLOCKING_ACCEPTANCE_SECTION_RE.exec(lines[index]!);
    if (!match) continue;
    const rest = pyStrip(match.groups?.rest ?? "");
    if (rest) return !isNoBlockingAcceptance(rest);
    const sectionLines: string[] = [];
    for (const following of lines.slice(index + 1)) {
      const stripped = pyStrip(following);
      if (!stripped) continue;
      if (ACCEPTANCE_SECTION_BOUNDARY_RE.exec(stripped)) break;
      sectionLines.push(stripped);
    }
    return sectionLines.length > 0 && !sectionLines.every((item) => isNoBlockingAcceptance(item));
  }
  return false;
}

function isNoBlockingAcceptance(value: string): boolean {
  return NO_BLOCKING_ACCEPTANCE_RE.test(stripBackticks(pyStrip(String(value ?? ""))));
}

/** Python `str.strip("`")`. */
function stripBackticks(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "`") start += 1;
  while (end > start && value[end - 1] === "`") end -= 1;
  return value.slice(start, end);
}

// --- control header parsing ---------------------------------------------------

function parseStatusControlHeader(value: string): string | null {
  const lines = firstNonemptyLines(value, 1);
  if (!lines.length) return null;
  const match = STATUS_CONTROL_LINE_RE.exec(lines[0]!);
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  if (token === "complete") return "complete";
  if (token === "blocked") return "blocked";
  return "incomplete";
}

function parseIntegrityControlHeader(value: string): IntegrityStatus | null {
  const lines = firstNonemptyLines(value, 2);
  if (lines.length < 2) return null;
  const match = INTEGRITY_CONTROL_LINE_RE.exec(lines[1]!);
  if (!match) return null;
  return match[1]!.toLowerCase() as IntegrityStatus;
}

function parseContractAuditControlHeader(value: string): string | null {
  const lines = firstNonemptyLines(value, 3);
  if (lines.length < 3) return null;
  const match = CONTRACT_AUDIT_CONTROL_LINE_RE.exec(lines[2]!);
  if (!match) return null;
  const token = match[1]!.toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (token === "aligned") return "aligned";
  if (token === "needs_revision") return "needs_revision";
  if (token === "invalid") return "invalid";
  return "unknown";
}

function hasValidControlHeader(value: string): boolean {
  return (
    parseStatusControlHeader(value) !== null &&
    parseIntegrityControlHeader(value) !== null &&
    parseContractAuditControlHeader(value) !== null
  );
}

function invalidControlHeaderReport(raw: string, options: { language?: string } = {}): string {
  const lang = options.language ?? "en";
  const clipped = compactAuditorReportText(raw, { maxChars: 1_800 });
  return (
    controlHeader("blocked", "suspect", "unknown", { language: lang }) +
    "\n" +
    text("invalid_header_facts", lang) +
    "\n" +
    text("invalid_header_gap", lang) +
    "\n\n" +
    text("invalid_header_excerpt", lang) +
    `\n${clipped}`
  );
}

// --- report text extraction ---------------------------------------------------

export function extractAuditorReportText(raw: string, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 8_000;
  let texts = decodeAgentAssistantTexts(raw);
  if (!texts.length) texts = assistantTextsFromCompactedOpenclawLog(raw);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const item = texts[index]!;
    if (looksLikeReport(item)) {
      return clipReportSource(trimToReportStart(item), maxChars);
    }
  }
  if (texts.length) {
    return clipReportSource(
      trimToReportStart(texts.map((item) => pyStrip(item)).filter((item) => item).join("\n\n")),
      maxChars,
    );
  }
  return clipReportSource(trimToReportStart(pyStrip(raw)), maxChars);
}

export function compactAuditorReportText(value: string, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? COMPACT_REPORT_CHARS;
  const stripped = pyStrip(value);
  if (stripped.length <= maxChars) return stripped;
  const headChars = Math.max(1, Math.trunc(maxChars * 0.7));
  const tailChars = Math.max(1, maxChars - headChars);
  return (
    pyRstrip(stripped.slice(0, headChars)) +
    `\n\n...[auditor report truncated ${stripped.length - maxChars} chars; kept head and tail]...\n\n` +
    pyLstrip(stripped.slice(stripped.length - tailChars))
  );
}

export function extractStateSummary(value: string, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? STATE_SUMMARY_CHARS;
  const lines = pySplitLines(value).map((line) => pyRstrip(line));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/(state\s+summary|state\s+card)/i.test(line)) continue;
    const collected = [stripHeading(line)];
    for (const follow of lines.slice(index + 1, index + 7)) {
      const stripped = pyStrip(follow);
      if (!stripped) break;
      if (isMajorHeading(stripped)) break;
      collected.push(stripped);
    }
    const summary = pyStrip(collected.filter((item) => item).join("\n"));
    if (summary) return head(summary, maxChars);
  }

  const collected: string[] = [];
  for (const line of lines) {
    const stripped = pyStrip(line);
    if (!stripped) continue;
    if (/(next\s+step|next\s+round|task\s+agent)/i.test(stripped)) break;
    collected.push(stripped);
    if (collected.length >= 6) break;
  }
  return head(collected.join("\n"), maxChars);
}

export function extractActionGuidance(value: string, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? ACTION_GUIDANCE_CHARS;
  const lines = pySplitLines(value);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/(next\s+step|next\s+round|task\s+agent)/i.test(line)) continue;
    const collected: string[] = [];
    const first = pyStrip(
      line.replace(
        /^\s*(?:[-*]\s*)?(?:next\s+step|next\s+round|task\s+agent)\s*[:-]?\s*/i,
        "",
      ),
    );
    if (first) collected.push(first);
    for (const follow of lines.slice(index + 1, index + 6)) {
      const stripped = pyStrip(follow);
      if (!stripped) break;
      if (
        /^(status|completed|missing|evidence|commands)\s*:/i.test(
          stripped,
        )
      ) {
        break;
      }
      collected.push(stripped);
    }
    const guidance = pyStrip(collected.join("\n"));
    if (guidance) return tail(guidance, maxChars);
  }
  return "";
}

export function inferIntegrityFindings(value: string): [IntegrityStatus, Record<string, unknown>[]] {
  const integrityStatus = parseIntegrityControlHeader(value);
  const lines = firstNonemptyLines(value, 2);
  const evidence = lines.length >= 2 ? lines[1]! : "missing integrity control header";
  if (integrityStatus === "clean") return ["clean", []];
  if (integrityStatus === "violation") {
    return [
      "violation",
      [{ type: "integrity_control_header", severity: "violation", evidence, paths: [] }],
    ];
  }
  return ["suspect", [{ type: "integrity_control_header", severity: "suspect", evidence, paths: [] }]];
}

export function extractDeletedArtifactActions(value: string): Record<string, unknown>[] {
  const actions: Record<string, unknown>[] = [];
  for (const line of pySplitLines(value)) {
    const normalized = pyStrip(line);
    if (!normalized) continue;
    const match = DELETE_DECLARATION_RE.exec(normalized);
    if (!match) continue;
    const rest = pyStrip(match.groups?.rest ?? "");
    for (const path of extractCandidateArtifactPaths(rest)) {
      if (actions.some((action) => action["path"] === path)) continue;
      actions.push({
        action: "delete",
        status: "delete_declared_unverified",
        path,
        reason: extractDeleteReason(rest),
        declaration: head(normalized, 600),
      });
    }
  }
  return actions;
}

export function extractCandidateArtifactPaths(value: string): string[] {
  const patterns = [
    new RegExp(`(?<path>${escapeRegExp(DEFAULT_WORKSPACE_PATH)}/[^\\s\`'"<>:;|]+)`, "g"),
    /(?<![A-Za-z0-9_./-])(?<path>(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|gif|webp|svg|pdf|txt|md|csv|json|html|htm|mp4|mov|wav|zip|tar|gz))/g,
  ];
  const paths: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const path = rstripChars(match.groups?.path ?? "", ".,)]}");
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths.slice(0, 20);
}

function extractDeleteReason(line: string): string {
  const match = /reason\s*:\s*([\s\S]+)$/i.exec(line);
  if (match) return head(pyStrip(match[1]!), 300);
  return head(line, 300);
}

function looksLikeReport(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.includes("status") || lowered.includes("missing");
}

function trimToReportStart(value: string): string {
  const re = /^\s*(?:\*\*)?\s*status\s*:\s*(?:complete|incomplete|blocked)/im;
  const match = re.exec(value);
  if (match) return pyStrip(value.slice(match.index));
  return pyStrip(value);
}

function assistantTextsFromCompactedOpenclawLog(raw: string): string[] {
  const texts: string[] = [];
  let role: string | null = null;
  let current: string[] = [];

  const flush = (): void => {
    if (role === "assistant") {
      const value = pyStrip(current.join("\n"));
      if (value) texts.push(value);
    }
    current = [];
  };

  for (const line of pySplitLines(raw)) {
    const marker = /^\[(assistant|toolResult|tool)(?::[^\]]*)?\]\s*$/.exec(pyStrip(line));
    if (marker) {
      flush();
      role = marker[1]!;
      continue;
    }
    if (/^\[toolCall:[^\]]+\]/.test(pyStrip(line))) {
      flush();
      role = null;
      continue;
    }
    if (role === "assistant") current.push(line);
  }
  flush();
  return texts;
}

// --- truncation primitives (three of them; deliberately not unified) ----------

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function clipReportSource(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const headChars = Math.max(1, Math.trunc(maxChars * 0.7));
  const tailChars = Math.max(1, maxChars - headChars);
  return (
    pyRstrip(value.slice(0, headChars)) +
    `\n\n...[auditor source truncated ${value.length - maxChars} chars; kept head and tail]...\n\n` +
    pyLstrip(value.slice(value.length - tailChars))
  );
}

function head(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return pyRstrip(value.slice(0, maxChars)) + `\n...[truncated ${value.length - maxChars} chars]`;
}

function firstNonemptyLines(value: string, count: number): string[] {
  const lines: string[] = [];
  for (const line of pySplitLines(String(value ?? ""))) {
    const stripped = pyStrip(line);
    if (!stripped) continue;
    lines.push(stripped);
    if (lines.length >= count) break;
  }
  return lines;
}

function stripHeading(line: string): string {
  return pyStrip(
    line.replace(
      /^\s*(?:[-*]\s*)?(?:state\s+summary|state\s+card)\s*[:-]?\s*/i,
      "",
    ),
  );
}

function isMajorHeading(line: string): boolean {
  return /^(status|completed|missing|evidence|commands|state|next)\s*:/i.test(
    line,
  );
}

/** Python `str.rstrip(chars)`. */
function rstripChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

// --- workspace cross-check ----------------------------------------------------

function allowedAuditorDeletePaths(
  metadata: Record<string, unknown>,
  options: { integrityStatus: string; declaredActions: Record<string, unknown>[] },
): string[] {
  const counts = metadata["verifier_workspace_mutation_counts"];
  const mutations = metadata["verifier_workspace_mutations"];
  if (!isPlainObject(counts) || !isPlainObject(mutations)) return [];
  const deletedCount = toInt(counts["deleted"]);
  const nonDeleteCount = toInt(counts["added"]) + toInt(counts["changed"]) + toInt(counts["type_changed"]);
  if (deletedCount <= 0) return [];
  if (metadata["verifier_workspace_restored"]) return [];
  const deletedRaw = mutations["deleted"];
  const deletedPaths = Array.isArray(deletedRaw)
    ? deletedRaw.map((item) => String(item)).filter((item) => pyStrip(item))
    : [];
  const declared = new Set<string>();
  for (const action of options.declaredActions) {
    if (action["action"] !== "delete") continue;
    const relpath = workspaceRelpath(action["path"]);
    if (relpath) declared.add(relpath);
  }
  if (nonDeleteCount || options.integrityStatus !== "violation" || declared.size === 0) return [];
  return deletedPaths.filter((path) => declared.has(workspaceRelpath(path)));
}

function toInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function reconcileDeletionActions(options: {
  declaredActions: Record<string, unknown>[];
  confirmedDeletedPaths: string[];
}): Record<string, unknown>[] {
  const confirmed = new Map<string, string>();
  for (const path of options.confirmedDeletedPaths) confirmed.set(workspaceRelpath(path), path);
  const reconciled: Record<string, unknown>[] = [];
  const matched = new Set<string>();
  for (const action of options.declaredActions) {
    const copied: Record<string, unknown> = { ...action };
    const key = workspaceRelpath(copied["path"]);
    if (key && confirmed.has(key)) {
      copied["status"] = "deleted_by_auditor";
      copied["path"] = String(copied["path"] || confirmed.get(key));
      matched.add(key);
    } else {
      copied["status"] = "delete_declared_unverified";
      if (!("reason" in copied)) {
        copied["reason"] =
          "auditor declared deletion, but the workspace diff did not confirm that this path was deleted";
      }
    }
    reconciled.push(copied);
  }

  for (const path of options.confirmedDeletedPaths) {
    if (matched.has(workspaceRelpath(path))) continue;
    reconciled.push({
      action: "delete",
      status: "deleted_by_auditor",
      path,
      reason: "workspace diff recorded auditor deletion during integrity audit",
      declaration: "Auditor deleted this path during integrity audit; see report_text for rationale.",
    });
  }
  return reconciled;
}

function markUnconfirmedDeletionDeclarations(
  actions: Record<string, unknown>[],
): Record<string, unknown>[] {
  const marked: Record<string, unknown>[] = [];
  for (const action of actions) {
    const copied: Record<string, unknown> = { ...action };
    if (copied["status"] === "deleted_by_auditor") {
      marked.push(copied);
      continue;
    }
    if (copied["action"] === "delete") {
      copied["status"] = "delete_declared_unverified";
      if (!("reason" in copied)) {
        copied["reason"] = "auditor declared deletion, but no matching workspace deletion was observed";
      }
    }
    marked.push(copied);
  }
  return marked;
}

function workspaceRelpath(raw: unknown): string {
  let path = pyStrip(String(raw ?? ""));
  if (!path) return "";
  path = rstripChars(path, ".,)]}");
  const prefix = `${DEFAULT_WORKSPACE_PATH}/`;
  if (path === DEFAULT_WORKSPACE_PATH) return ".";
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return lstripChars(path, "./");
}

/** Python `str.lstrip(chars)`. */
function lstripChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start]!)) start += 1;
  return value.slice(start);
}

function mutationPaths(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const paths: string[] = [];
  for (const key of ["added", "changed", "deleted", "type_changed"]) {
    const value = raw[key];
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) paths.push(String(item));
    }
  }
  return paths;
}

function runtimeFailureReport(
  result: EpisodeResult,
  runtimeSignals: string[],
  options: { language?: string } = {},
): string {
  const lang = options.language ?? "en";
  const lines = [
    controlHeader("blocked", "suspect", "unknown", { language: lang }),
    "",
    text("runtime_failed", lang),
  ];
  if (result.status !== "done") lines.push(`Episode status: ${result.status}.`);
  if (result.error) lines.push(`Runtime error: ${result.error}`);
  if (runtimeSignals.length) lines.push("Runtime signals: " + runtimeSignals.slice(0, 8).join(", "));

  const metadata = metadataOf(result);
  const episodeDir = metadata["episode_dir"];
  const agentLogPath = metadata["agent_log_path"];
  const chatJsonlPath = metadata["chat_jsonl_path"];
  if (episodeDir) lines.push(`Episode dir: ${episodeDir}`);
  if (agentLogPath) lines.push(`Agent log: ${agentLogPath}`);
  if (chatJsonlPath) lines.push(`Chat log: ${chatJsonlPath}`);

  if (metadata["verifier_workspace_mutation_detected"]) {
    const paths = mutationPaths(metadata["verifier_workspace_mutations"]);
    const restored = Boolean(metadata["verifier_workspace_restored"]);
    lines.push(text(restored ? "runtime_mutation_restored" : "runtime_mutation_not_restored", lang));
    if (paths.length) lines.push(text("changed_paths", lang) + paths.slice(0, 20).join(", "));
  }

  lines.push("");
  lines.push(text("no_claim_from_logs", lang));
  return pyStrip(lines.join("\n"));
}
