// Ported 1:1 from LongHorizon-Harness tests/test_runtime_signals.py.
import assert from "node:assert/strict";
import test from "node:test";

import { detectRuntimeSignals, hardSignalLabels } from "../src/runtime_signals.js";

function jsonl(...records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("source code in command output cannot fake a runtime failure", () => {
  const log = jsonl(
    { type: "thread.started", thread_id: "thread-1" },
    {
      type: "item.completed",
      item: {
        id: "item-1",
        type: "command_execution",
        status: "completed",
        aggregated_output:
          'Result(status="error", actions_log=json.dumps(' +
          '{"type": "turn.failed", "error": {"message": message}}), ' +
          'metadata={"runtime_signals": [{"signal": "AGENT_TURN_FAILED"}]})\n' +
          "Connection error.\nresponse.failed\nAGENT_EXIT=9",
      },
    },
    {
      type: "item.completed",
      item: { id: "item-2", type: "agent_message", text: "Task completed." },
    },
    { type: "turn.completed", usage: {} },
  );

  assert.deepEqual(hardSignalLabels(detectRuntimeSignals(log)), []);
});

test("top-level turn.failed event is a hard runtime failure", () => {
  const log = jsonl(
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.failed", error: { message: "model access denied" } },
  );

  const signals = detectRuntimeSignals(log);

  assert.deepEqual(hardSignalLabels(signals), ["AGENT_TURN_FAILED"]);
  assert.ok(signals[0].evidence.includes("model access denied"));
});

// --- extra coverage for the Claude stream-json shape the SDK adapter writes ---

test("a failed claude result record becomes a hard response.failed signal", () => {
  const log = jsonl(
    { type: "system", subtype: "init", model: "claude-opus-5", cwd: "/w", tools: [], mcp_servers: [] },
    { type: "result", subtype: "error_during_execution", is_error: true, result: "provider unavailable" },
  );

  const signals = detectRuntimeSignals(log);

  assert.deepEqual(hardSignalLabels(signals), ["response.failed"]);
  assert.ok(signals[0].evidence.includes("provider unavailable"));
});

test("claude tool_result output cannot fake a runtime failure", () => {
  const log = jsonl(
    { type: "system", subtype: "init", model: "claude-opus-5", cwd: "/w", tools: [], mcp_servers: [] },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "Connection error.\nresponse.failed\nAGENT_EXIT=3" }],
          },
        ],
      },
    },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  );

  assert.deepEqual(hardSignalLabels(detectRuntimeSignals(log)), []);
});

test("a python traceback in tool output is a soft diagnostic signal only", () => {
  const log = jsonl(
    { type: "system", subtype: "init", model: "claude-opus-5", cwd: "/w", tools: [], mcp_servers: [] },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError",
          },
        ],
      },
    },
  );

  const signals = detectRuntimeSignals(log);

  assert.deepEqual(
    signals.map((signal) => signal.signal),
    ["Traceback (most recent call last)"],
  );
  assert.deepEqual(hardSignalLabels(signals), []);
});

test("a bare AGENT_EXIT wrapper line is a hard signal", () => {
  const signals = detectRuntimeSignals("AGENT_EXIT=7\n");

  assert.deepEqual(hardSignalLabels(signals), ["AGENT_EXIT=7"]);
});

test("AGENT_EXIT=0 is not a signal", () => {
  assert.deepEqual(detectRuntimeSignals("AGENT_EXIT=0\n"), []);
});

test("hard_signal_labels tolerates malformed inputs", () => {
  assert.deepEqual(hardSignalLabels(null), []);
  assert.deepEqual(hardSignalLabels("AGENT_EXIT=1"), []);
  assert.deepEqual(hardSignalLabels([{ signal: "  response.failed  " }]), ["response.failed"]);
  assert.deepEqual(hardSignalLabels([{ signal: "" }, { nope: 1 }, 5]), []);
  assert.deepEqual(hardSignalLabels(["AGENT_TURN_FAILED: boom"]), ["AGENT_TURN_FAILED: boom"]);
});
