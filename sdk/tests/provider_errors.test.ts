// Ported from LongHorizon-Harness tests/test_provider_errors.py
// Classification boundaries for terminal agent-CLI failures.
import assert from "node:assert/strict";
import { test } from "node:test";

import { GUARD_REJECTION_MESSAGE, classifyAgentRuntimeFailure } from "../src/provider_errors.js";
import { type EpisodeResult, episodeResult } from "../src/types.js";

test("a guard snapshot failure is not a runtime failure", () => {
  // The guard rejects the audit fail-closed when it cannot inspect every
  // workspace path (e.g. a build directory changing underneath the walk).
  // That is a local audit-validity problem: the episode itself ran to
  // completion, so classifying it as a provider failure -- and aborting the
  // whole run -- turns a transient filesystem race into a fatal outcome.
  const result = episodeResult({
    status: "error",
    error:
      "Auditor workspace read-only guard could not inspect every path; " +
      "the audit was rejected fail-closed.",
    metadata: {
      verifier_workspace_snapshot_errors: [
        "target/debug/incremental/x.o: OSError: [Errno 9] Bad file descriptor",
      ],
    },
  });

  assert.equal(classifyAgentRuntimeFailure(result), null);
});

test("a plain provider error is still terminal", () => {
  const result = episodeResult({ status: "error", error: "connection reset by peer" });

  const failure = classifyAgentRuntimeFailure(result);
  assert.notEqual(failure, null);
  assert.equal(failure?.abort_reason, "provider_network");
});

/** An episode whose audit the guard rejected fail-closed. */
function guardRejectedResult(overrides: Partial<EpisodeResult> = {}): EpisodeResult {
  const { metadata: metadataOverrides, ...rest } = overrides;
  return episodeResult({
    status: "error",
    error: GUARD_REJECTION_MESSAGE,
    ...rest,
    metadata: {
      verifier_workspace_snapshot_errors: [
        "target/debug/incremental/x.o: OSError: [Errno 9] Bad file descriptor",
      ],
      ...(metadataOverrides ?? {}),
    },
  });
}

test("a guard rejection with stderr noise is still round-level", () => {
  // Harmless stderr from a healthy episode must not resurrect the abort.
  const result = guardRejectedResult({ metadata: { stderr_tail: "warning: unused variable `x`" } });

  assert.equal(classifyAgentRuntimeFailure(result), null);
});

test("a guard rejection does not hide an authentication failure", () => {
  // Hiding it would make the manager retry until the round budget is exhausted
  // instead of surfacing the real authentication problem.
  const result = guardRejectedResult({
    error: `401 Unauthorized: invalid api key\n${GUARD_REJECTION_MESSAGE}`,
  });

  const failure = classifyAgentRuntimeFailure(result);
  assert.notEqual(failure, null);
  assert.equal(failure?.abort_reason, "provider_authentication");
});

test("a guard rejection does not hide a network failure in stderr", () => {
  const result = guardRejectedResult({ metadata: { stderr_tail: "connection reset by peer" } });

  const failure = classifyAgentRuntimeFailure(result);
  assert.notEqual(failure, null);
  assert.equal(failure?.abort_reason, "provider_network");
});

test("a guard rejection does not hide a hard runtime signal", () => {
  const result = guardRejectedResult({
    metadata: { runtime_signals: [{ signal: "AGENT_EXIT=1", evidence: "AGENT_EXIT=1" }] },
  });

  const failure = classifyAgentRuntimeFailure(result);
  assert.notEqual(failure, null);
  assert.equal(failure?.abort_reason, "provider_provider_error");
});

test("a guard rejection does not hide an episode timeout", () => {
  // A timed-out audited episode stays a timeout for manager recovery.
  const result = guardRejectedResult({ status: "timeout", error: "Episode timed out after 1800s" });

  const failure = classifyAgentRuntimeFailure(result);
  assert.notEqual(failure, null);
  assert.equal(failure?.abort_reason, "provider_timeout");
});

test("a guard rejection does not hide agent error records", () => {
  // Failure records in the actions log count as real evidence.
  const result = guardRejectedResult({
    actions_log: JSON.stringify({ type: "turn.failed", error: { message: "AGENT_TURN_FAILED" } }),
  });

  const failure = classifyAgentRuntimeFailure(result);
  assert.notEqual(failure, null);
  assert.equal(failure?.abort_reason, "provider_provider_error");
});

test("a healthy episode is never classified", () => {
  assert.equal(classifyAgentRuntimeFailure(episodeResult({ status: "done" })), null);
});

test("secrets in the failure evidence are redacted", () => {
  const result = episodeResult({
    status: "error",
    error: "401 Unauthorized (api_key=sk-abcdef123456)",
  });

  const failure = classifyAgentRuntimeFailure(result);
  assert.equal(failure?.kind, "authentication");
  assert.ok(failure?.message.includes("***REDACTED***"));
  assert.ok(!failure?.message.includes("sk-abcdef123456"));
});
