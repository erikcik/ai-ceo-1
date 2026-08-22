// Ported 1:1 from LongHorizon-Harness src/lh_harness/runtime_signals.py.

import { TURN_FAILED_SIGNAL, runtimeEventView, toolOutputView } from "./agent_logs.js";
import { pyStrip } from "./utils/pystr.js";

export type RuntimeSignal = { signal: string; evidence: string };

function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const _HARD_RUNTIME_PATTERNS: RegExp[] = [
  /AGENT_EXIT=([1-9]\d*)/,
  new RegExp(reEscape(TURN_FAILED_SIGNAL)),
  /Connection error\./,
  /response\.failed/,
];
const _DIAGNOSTIC_TOOL_PATTERNS: RegExp[] = [/Traceback \(most recent call last\)/];

// A Traceback can legitimately appear in tool output (an agent running a script
// that raises), so only signals that mean the agent runtime itself died count as
// hard failures.
const _HARD_SIGNAL_PREFIXES: string[] = ["AGENT_EXIT=", TURN_FAILED_SIGNAL];
const _HARD_SIGNAL_VALUES: Set<string> = new Set(["Connection error.", "response.failed"]);

export function detectRuntimeSignals(log: string): RuntimeSignal[] {
  const runtimeEvents = runtimeEventView(log);
  const toolOutput = toolOutputView(log);
  const signals: RuntimeSignal[] = [];
  for (const pattern of _HARD_RUNTIME_PATTERNS) {
    const match = pattern.exec(runtimeEvents);
    if (match) signals.push({ signal: match[0], evidence: near(runtimeEvents, match.index) });
  }
  for (const pattern of _DIAGNOSTIC_TOOL_PATTERNS) {
    const match = pattern.exec(toolOutput);
    if (match) signals.push({ signal: match[0], evidence: near(toolOutput, match.index) });
  }
  return signals;
}

function signalLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const labels: string[] = [];
  for (const item of raw) {
    const signal =
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? (item as Record<string, unknown>)["signal"]
        : item;
    if (typeof signal === "string" && pyStrip(signal)) labels.push(pyStrip(signal));
  }
  return labels;
}

/** Labels for signals that mean the agent runtime failed, not the task. */
export function hardSignalLabels(raw: unknown): string[] {
  return signalLabels(raw).filter(
    (label) => _HARD_SIGNAL_PREFIXES.some((prefix) => label.startsWith(prefix)) || _HARD_SIGNAL_VALUES.has(label),
  );
}

function near(text: string, index: number, radius = 240): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end);
}
