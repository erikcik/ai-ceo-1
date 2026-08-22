// Tests for src/auditor_agent.ts (LongHorizon-Harness src/lh_harness/auditor_agent.py).
//
// The Python suite has no dedicated auditor_agent test module; these pin the
// behaviours spec 03 §1.7-§1.10 calls load-bearing: the three-line control
// header, the invalid-header replacement, the blocking-constraint completion
// guard, the workspace cross-check branches, and the compaction markers.

import assert from "node:assert/strict";
import test from "node:test";

import {
  auditReportFromEpisodeResult,
  compactAuditorReportText,
  extractActionGuidance,
  extractAuditorReportText,
  extractCandidateArtifactPaths,
  extractStateSummary,
  hasValidAuditorControlHeader,
  inferContractAuditStatus,
  inferReportStatus,
  parseAuditReport,
} from "../src/auditor_agent.js";
import { episodeResult } from "../src/types.js";

const CLEAN = "Status: complete\nIntegrity: clean\nContract audit: aligned\n\nAudit facts: the file exists.";

// --- control header ---------------------------------------------------------

test("a complete/clean/aligned header parses into the completion gate", () => {
  const report = parseAuditReport(CLEAN, 3);

  assert.equal(report.round_id, "round_3");
  assert.equal(report.status, "complete");
  assert.equal(report.integrity_status, "clean");
  assert.equal(report.contract_audit_status, "aligned");
  assert.deepEqual(report.integrity_findings, []);
});

test("the header is accepted bolded and with loose spacing", () => {
  const raw = "**Status : complete**\n**Integrity : clean**\n**Contract audit : aligned**\n\nAudit facts: ok";

  assert.ok(hasValidAuditorControlHeader(raw));
  const report = parseAuditReport(raw, 1);
  assert.equal(report.status, "complete");
  assert.equal(report.integrity_status, "clean");
  assert.equal(report.contract_audit_status, "aligned");
});

test("trailing prose on a header line invalidates the header", () => {
  const raw = "Status: complete because everything worked\nIntegrity: clean\nContract audit: aligned";

  assert.equal(hasValidAuditorControlHeader(raw), false);
});

test("the three control lines must be the first three nonempty lines", () => {
  const raw = "Preamble line\nStatus: complete\nIntegrity: clean\nContract audit: aligned";

  assert.equal(hasValidAuditorControlHeader(raw), false);
});

test("a missing header defaults to blocked/unknown", () => {
  assert.equal(inferReportStatus("no header at all"), "blocked");
  assert.equal(inferContractAuditStatus("no header at all"), "unknown");
});

test("contract audit normalises hyphens and spaces", () => {
  const build = (value: string) => `Status: incomplete\nIntegrity: clean\nContract audit: ${value}`;

  assert.equal(inferContractAuditStatus(build("needs-revision")), "needs_revision");
  assert.equal(inferContractAuditStatus(build("needs revision")), "needs_revision");
  assert.equal(inferContractAuditStatus(build("banana")), "unknown");
});

// --- invalid-header fallback ------------------------------------------------

test("an invalid header is replaced by a blocked/suspect/unknown report that keeps an excerpt", () => {
  const report = parseAuditReport("everything looks fine to me, status great", 7);

  assert.equal(report.status, "blocked");
  assert.equal(report.integrity_status, "suspect");
  assert.equal(report.contract_audit_status, "unknown");
  assert.ok(report.report_text.startsWith("Status: blocked\nIntegrity: suspect\nContract audit: unknown\n"));
  assert.ok(
    report.report_text.includes(
      "Audit facts: the auditor report lacks a valid three-line control header; the harness will not guess completion, integrity, or contract audit from the body.",
    ),
  );
  assert.ok(report.report_text.includes("Original auditor output excerpt:"));
  assert.ok(report.report_text.includes("everything looks fine to me"));
  assert.equal(report.integrity_findings[0]!["type"], "integrity_control_header");
  assert.equal(report.integrity_findings[0]!["severity"], "suspect");
});

test("the invalid-header replacement ignores the legacy language option", () => {
  const report = parseAuditReport("no header", 1, { language: "zh" });

  assert.ok(report.report_text.startsWith("Status: blocked\nIntegrity: suspect\nContract audit: unknown\n"));
  assert.ok(report.report_text.includes("Original auditor output excerpt:"));
});

// --- downgrade rules --------------------------------------------------------

test("an unaligned contract downgrades a complete status", () => {
  const report = parseAuditReport(
    "Status: complete\nIntegrity: clean\nContract audit: needs_revision\n\nAudit facts: partial",
    2,
  );

  assert.equal(report.status, "incomplete");
});

test("an integrity violation downgrades a complete status and collects a finding", () => {
  const report = parseAuditReport(
    "Status: complete\nIntegrity: violation\nContract audit: aligned\n\nAudit facts: fabricated",
    2,
  );

  assert.equal(report.status, "incomplete");
  assert.equal(report.integrity_status, "violation");
  assert.equal(report.integrity_findings[0]!["severity"], "violation");
  assert.equal(report.integrity_findings[0]!["evidence"], "Integrity: violation");
});

// --- blocking-constraint completion guard -----------------------------------

test("a nonempty blocking-constraint list refuses complete and aligned", () => {
  const raw = [
    "Status: complete",
    "Integrity: clean",
    "Contract audit: aligned",
    "",
    "Blocking constraints:",
    "- the report must be exported as PDF, which was not done",
    "",
    "Next step: export the PDF.",
  ].join("\n");

  const report = parseAuditReport(raw, 4);

  assert.equal(report.status, "incomplete");
  assert.equal(report.contract_audit_status, "unknown");
  assert.ok(
    report.report_text.includes(
      "Harness completion guard: the auditor listed nonempty blocking constraints, so `complete` and an aligned contract decision are not accepted.",
    ),
  );
});

test("an explicit 'none' blocking-constraint list leaves a clean completion alone", () => {
  const raw = [
    "Status: complete",
    "Integrity: clean",
    "Contract audit: aligned",
    "",
    "Blocking constraints: none",
    "",
    "Next step: nothing further.",
  ].join("\n");

  const report = parseAuditReport(raw, 4);

  assert.equal(report.status, "complete");
  assert.equal(report.contract_audit_status, "aligned");
  assert.ok(!report.report_text.includes("Harness completion guard"));
});

test("the next mandated heading terminates the blocking-constraint section", () => {
  const raw = [
    "Status: complete",
    "Integrity: clean",
    "Contract audit: aligned",
    "",
    "Blocking constraints:",
    "Audit facts: everything was verified",
    "Next step: nothing further.",
  ].join("\n");

  // Only the boundary heading follows, so the section is empty and the guard
  // must not fire.
  assert.equal(parseAuditReport(raw, 1).status, "complete");
});

test("a nonempty blocking-constraint list downgrades a complete status", () => {
  const raw = [
    "Status: complete",
    "Integrity: clean",
    "Contract audit: aligned",
    "",
    "Blocking constraints: the report has not been exported to PDF",
  ].join("\n");

  const report = parseAuditReport(raw, 1);

  assert.equal(report.status, "incomplete");
  assert.equal(report.contract_audit_status, "unknown");
  assert.ok(report.report_text.includes("Harness completion guard"));
});

// --- compaction markers -----------------------------------------------------

test("compaction keeps head and tail and reports the dropped character count", () => {
  const body = "A".repeat(3_000) + "TAILMARK";
  const compacted = compactAuditorReportText(body);

  assert.ok(compacted.startsWith("A"));
  assert.ok(compacted.endsWith("TAILMARK"));
  assert.ok(
    compacted.includes(`...[auditor report truncated ${body.length - 2_500} chars; kept head and tail]...`),
  );
});

test("the source clip uses its own marker at 8000 chars", () => {
  const body = "Status: complete\n" + "B".repeat(9_000) + "ENDMARK";
  const clipped = extractAuditorReportText(body);

  assert.ok(clipped.includes("...[auditor source truncated "));
  assert.ok(clipped.includes("kept head and tail]..."));
  assert.ok(clipped.endsWith("ENDMARK"));
});

test("extraction trims everything before the control header", () => {
  const raw = "chatter about the plan\nStatus: blocked\nIntegrity: suspect\nContract audit: unknown";

  assert.equal(
    extractAuditorReportText(raw),
    "Status: blocked\nIntegrity: suspect\nContract audit: unknown",
  );
});

test("a compacted OpenClaw log is decoded when the JSONL decoder finds nothing", () => {
  const raw = ["[toolCall:bash]", "ls -la", "[assistant]", "Status: blocked", "Integrity: suspect", "Contract audit: unknown"].join("\n");

  assert.equal(
    extractAuditorReportText(raw),
    "Status: blocked\nIntegrity: suspect\nContract audit: unknown",
  );
});

// --- summary / guidance extraction ------------------------------------------

test("the state summary stops at the next major heading", () => {
  const raw = ["State summary: the CSV is present", "with 12 rows", "Evidence: wc -l data.csv"].join("\n");

  assert.equal(extractStateSummary(raw), "the CSV is present\nwith 12 rows");
});

test("action guidance strips its own label and is tail-truncated", () => {
  const raw = ["Status: incomplete", "Next step: export the PDF", "then verify the checksum"].join("\n");

  assert.equal(extractActionGuidance(raw), "export the PDF\nthen verify the checksum");
});

test("candidate artifact paths are recognised by extension and de-duplicated", () => {
  const paths = extractCandidateArtifactPaths("removed reports/summary.pdf and reports/summary.pdf, plus out/chart.png.");

  assert.deepEqual(paths, ["reports/summary.pdf", "out/chart.png"]);
});

// --- episode-level entry point ----------------------------------------------

test("a failed episode short-circuits into a runtime-failure report", () => {
  const report = auditReportFromEpisodeResult(
    episodeResult({ status: "error", error: "provider exploded", actions_log: CLEAN }),
    5,
  );

  assert.equal(report.round_id, "round_5");
  assert.equal(report.status, "blocked");
  assert.equal(report.action_guidance, "Auditor runtime failed; rerun the audit after fixing the runtime issue.");
  assert.ok(report.report_text.startsWith("Status: blocked\nIntegrity: suspect\nContract audit: unknown\n"));
  assert.ok(report.report_text.includes("Auditor runtime failed before producing a trustworthy report."));
  assert.ok(report.report_text.includes("Episode status: error."));
  assert.ok(report.report_text.includes("Runtime error: provider exploded"));
  assert.ok(report.report_text.endsWith("No completion claim was accepted from raw runtime logs or echoed prompt text."));
});

test("a hard runtime signal blocks the audit even on a done episode", () => {
  const report = auditReportFromEpisodeResult(
    episodeResult({
      status: "done",
      actions_log: CLEAN,
      metadata: { runtime_signals: [{ signal: "AGENT_TURN_FAILED", evidence: "AGENT_TURN_FAILED: boom" }] },
    }),
    1,
  );

  assert.equal(report.status, "blocked");
  assert.ok(report.report_text.includes("Runtime signals: AGENT_TURN_FAILED"));
});

test("adapter-published visible output outranks the raw actions log", () => {
  const report = auditReportFromEpisodeResult(
    episodeResult({
      status: "done",
      actions_log: "Status: complete\nIntegrity: clean\nContract audit: aligned",
      metadata: { assistant_visible_output: "Status: blocked\nIntegrity: suspect\nContract audit: unknown" },
    }),
    1,
  );

  assert.equal(report.status, "blocked");
});

test("a workspace mutation during a read-only audit invalidates the audit", () => {
  const report = auditReportFromEpisodeResult(
    episodeResult({
      status: "done",
      actions_log: CLEAN,
      metadata: {
        verifier_workspace_mutation_detected: true,
        verifier_workspace_restore_on_mutation: true,
        verifier_workspace_restored: false,
        verifier_workspace_mutations: { added: ["notes.txt"], changed: [], deleted: [], type_changed: [] },
        verifier_workspace_mutation_counts: { added: 1, changed: 0, deleted: 0, type_changed: 0 },
      },
    }),
    2,
  );

  assert.equal(report.status, "blocked");
  assert.equal(report.integrity_status, "violation");
  assert.equal(report.contract_audit_status, "unknown");
  assert.ok(report.report_text.startsWith("Status: blocked\nIntegrity: violation\nContract audit: unknown\n"));
  assert.ok(
    report.report_text.includes(
      "Auditor read-only violation: the auditor window changed task workspace files while checking.",
    ),
  );
  assert.ok(
    report.report_text.includes(
      "The harness detected a workspace mutation but did not confirm restoration; treat the audit as invalid.",
    ),
  );
  assert.ok(report.report_text.includes("Changed paths observed: notes.txt"));
  assert.ok(report.report_text.includes("Original auditor report, for diagnostics only:"));
  const finding = report.integrity_findings.find((item) => item["type"] === "verifier_workspace_write");
  assert.ok(finding);
  assert.equal(finding!["severity"], "violation");
  assert.deepEqual(finding!["paths"], ["notes.txt"]);
  assert.equal(finding!["restored"], false);
});

test("declared-and-confirmed deletions become a ledger without downgrading the verdict", () => {
  const raw = [
    "Status: incomplete",
    "Integrity: violation",
    "Contract audit: aligned",
    "",
    "Delete fabricated artifact: out/fake.png reason: it was never produced by the tool",
  ].join("\n");
  const report = auditReportFromEpisodeResult(
    episodeResult({
      status: "done",
      actions_log: raw,
      metadata: {
        verifier_workspace_mutation_detected: true,
        verifier_workspace_restored: false,
        verifier_workspace_mutations: { added: [], changed: [], deleted: ["out/fake.png"], type_changed: [] },
        verifier_workspace_mutation_counts: { added: 0, changed: 0, deleted: 1, type_changed: 0 },
      },
    }),
    3,
  );

  assert.equal(report.status, "incomplete");
  assert.equal(report.integrity_status, "violation");
  assert.ok(
    report.report_text.includes(
      "Deletion ledger: the auditor deleted executor artifacts it confirmed to be fabricated or untrusted; those paths can no longer count as valid deliverables.",
    ),
  );
  assert.ok(report.report_text.includes("Deleted paths: out/fake.png"));
  assert.equal(report.artifact_actions.length, 1);
  assert.equal(report.artifact_actions[0]!["status"], "deleted_by_auditor");
  assert.equal(report.artifact_actions[0]!["path"], "out/fake.png");
});

test("an unconfirmed deletion declaration stays marked unverified", () => {
  const raw = [
    "Status: incomplete",
    "Integrity: violation",
    "Contract audit: aligned",
    "",
    "Delete fabricated artifact: out/fake.png",
  ].join("\n");
  const report = auditReportFromEpisodeResult(episodeResult({ status: "done", actions_log: raw }), 3);

  assert.equal(report.artifact_actions.length, 1);
  assert.equal(report.artifact_actions[0]!["status"], "delete_declared_unverified");
});

test("restore_on_mutation=false only archives the activity note", () => {
  const report = auditReportFromEpisodeResult(
    episodeResult({
      status: "done",
      actions_log: CLEAN,
      metadata: {
        verifier_workspace_mutation_detected: true,
        verifier_workspace_restore_on_mutation: false,
        verifier_workspace_mutations: { added: ["build/out.js"], changed: [], deleted: [], type_changed: [] },
        verifier_workspace_mutation_counts: { added: 1, changed: 0, deleted: 0, type_changed: 0 },
      },
    }),
    4,
  );

  assert.equal(report.status, "complete");
  assert.equal(report.integrity_status, "clean");
  assert.equal(report.contract_audit_status, "aligned");
  assert.ok(report.report_text.includes("Environment activity note:"));
  assert.ok(report.report_text.includes("Changed paths observed: build/out.js"));
});
