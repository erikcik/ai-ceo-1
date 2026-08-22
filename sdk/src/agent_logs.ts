// Ported 1:1 from LongHorizon-Harness src/lh_harness/agent_logs.py.
//
// Normalized reads of the machine logs the agent CLIs print on stdout.
//
// Each backend speaks a different format: Claude Code emits
// `--output-format stream-json` while `codex exec --json` emits thread events.
// The harness only ever needs three views of either: the assistant-visible text,
// an ordered step list for the dashboard, and a tool/command output view for
// crash detection, so format handling lives here instead of being re-derived at
// every call site.
//
// The Claude Agent SDK adapter writes exactly the `claude_stream_json` shape
// (`{"type":"assistant","message":{"role":"assistant","content":[...]}}`,
// `{"type":"user",...}` with tool_result blocks, `{"type":"result",...}`,
// `{"type":"system","subtype":"init",...}`), so the parser below reads it
// unchanged.

import { pyStrip } from "./utils/pystr.js";

export const CLAUDE_STREAM_JSON = "claude_stream_json";
export const CODEX_EXEC_JSON = "codex_exec_json";
export const DEEPSEEK_HARNESS_JSONL = "deepseek_harness_jsonl";
export const OPENCODE_RUN_JSON = "opencode_run_json";
// Untyped chat transcripts (one `{"role": ..., "content": ...}` object per line,
// optionally wrapped in `message`). Neither CLI emits this directly, but saved
// chat.jsonl transcripts and older runs use it.
export const CHAT_JSONL = "chat_jsonl";
export const UNKNOWN = "";

// Harness-normalized label for a Codex turn that died before answering, so it
// joins the same runtime-signal path as the `AGENT_EXIT=` convention.
export const TURN_FAILED_SIGNAL = "AGENT_TURN_FAILED";

export type JsonRecord = Record<string, any>;
export type TrajectoryStep = Record<string, any>;

const _CODEX_EVENTS = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
]);
const _CLAUDE_EVENTS = new Set(["system", "assistant", "user", "result"]);
// OpenCode `run --format json` emits one JSON event per line.  "error" is
// shared with Codex's `--json` protocol, so it is only matched after the Codex
// and Claude event families, which real logs open with before any error record.
const _OPENCODE_EVENTS = new Set(["step_start", "step_finish", "tool_use", "text", "error"]);
// Codex items that record an action rather than assistant prose.
const _CODEX_TOOL_ITEMS = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_tool_call",
  "web_search",
  "todo_list",
]);

// ----------------------------------------------------------------------------
// Python container/semantic shims
// ----------------------------------------------------------------------------

/** Python `collections.deque(maxlen=...)` restricted to the append-only use here. */
class Deque<T> {
  items: T[] = [];
  constructor(readonly maxlen: number | null, initial?: T[]) {
    if (initial) for (const item of initial) this.append(item);
  }
  append(item: T): void {
    this.items.push(item);
    if (this.maxlen !== null) while (this.items.length > this.maxlen) this.items.shift();
  }
  popleft(): T {
    return this.items.shift() as T;
  }
  get length(): number {
    return this.items.length;
  }
  list(): T[] {
    return this.items.slice();
  }
}

/** Python `str.splitlines()` boundaries. */
function pySplitLines(value: string): string[] {
  if (value === "") return [];
  const parts = value.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function asText(value: unknown): string {
  // Python `str(raw or "")`.
  return value ? String(value) : "";
}

// ----------------------------------------------------------------------------
// Public views
// ----------------------------------------------------------------------------

export function detectFormat(raw: string): string {
  let sawChatRole = false;
  for (const record of jsonRecords(raw)) {
    const recordType = record["type"];
    if (recordType === "dsh.result") return DEEPSEEK_HARNESS_JSONL;
    if (isStr(recordType) && _CODEX_EVENTS.has(recordType)) return CODEX_EXEC_JSON;
    if (isStr(recordType) && _CLAUDE_EVENTS.has(recordType)) return CLAUDE_STREAM_JSON;
    if (isStr(recordType) && _OPENCODE_EVENTS.has(recordType)) return OPENCODE_RUN_JSON;
    if (chatMessage(record) !== null) sawChatRole = true;
  }
  return sawChatRole ? CHAT_JSONL : UNKNOWN;
}

/** Return the final assistant-visible text, or "" for an unknown format. */
export function visibleOutput(raw: string): string {
  const logFormat = detectFormat(raw);
  if (logFormat === DEEPSEEK_HARNESS_JSONL) {
    const texts = deepseekAssistantTexts(raw);
    return texts.length ? pyStrip(texts[texts.length - 1]) : "";
  }
  if (logFormat === CODEX_EXEC_JSON) {
    const texts = codexAssistantTexts(raw);
    return texts.length ? pyStrip(texts[texts.length - 1]) : "";
  }
  if (logFormat === CLAUDE_STREAM_JSON) {
    const [resultText, texts] = claudeTexts(raw);
    if (pyStrip(resultText)) return pyStrip(resultText);
    return pyStrip(texts.join("\n\n"));
  }
  if (logFormat === OPENCODE_RUN_JSON) {
    const texts = opencodeTexts(raw);
    return texts.length ? pyStrip(texts[texts.length - 1]) : "";
  }
  if (logFormat === CHAT_JSONL) {
    const texts = chatAssistantTexts(raw);
    return texts.length ? pyStrip(texts[texts.length - 1]) : "";
  }
  return "";
}

/**
 * `from ..agent_logs import visible_output as extract_claude_visible_output`
 * — the Claude adapter's name for the same parser.
 */
export const extractClaudeVisibleOutput = visibleOutput;

/** Return every assistant text block in order, oldest first. */
export function assistantTexts(raw: string): string[] {
  const logFormat = detectFormat(raw);
  if (logFormat === DEEPSEEK_HARNESS_JSONL) return deepseekAssistantTexts(raw);
  if (logFormat === CODEX_EXEC_JSON) return codexAssistantTexts(raw);
  if (logFormat === CLAUDE_STREAM_JSON) {
    const [resultText, texts] = claudeTexts(raw);
    if (pyStrip(resultText) && (!texts.length || pyStrip(texts[texts.length - 1]) !== pyStrip(resultText))) {
      texts.push(resultText);
    }
    return texts;
  }
  if (logFormat === OPENCODE_RUN_JSON) return opencodeTexts(raw);
  if (logFormat === CHAT_JSONL) return chatAssistantTexts(raw);
  return [];
}

/** Return tool/command output plus non-JSON lines, for crash detection. */
export function toolOutputView(raw: string): string {
  const logFormat = detectFormat(raw);
  const parts: string[] = [];
  for (const line of pySplitLines(asText(raw))) {
    const stripped = pyStrip(line);
    if (!stripped) continue;
    if (!stripped.startsWith("{")) {
      parts.push(line);
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(stripped);
    } catch {
      parts.push(line);
      continue;
    }
    if (!isPlainObject(record)) continue;
    if (logFormat === DEEPSEEK_HARNESS_JSONL) {
      if (record["type"] !== "dsh.result" || !record["is_error"]) continue;
      const text = record["error"] || record["text"];
      if (isStr(text) && pyStrip(text)) parts.push(pyStrip(text));
    } else if (logFormat === CODEX_EXEC_JSON) {
      parts.push(...codexToolOutput(record));
    } else if (logFormat === CLAUDE_STREAM_JSON) {
      parts.push(...claudeToolOutput(record));
    } else if (logFormat === OPENCODE_RUN_JSON) {
      parts.push(...opencodeToolOutput(record));
    }
  }
  return parts.filter((part) => part).join("\n");
}

/**
 * Return provider/runtime failures without including task tool output.
 *
 * Command output is untrusted task data and may legitimately contain source
 * examples such as `{"type": "turn.failed"}` or `AGENT_TURN_FAILED`.
 * Only top-level CLI protocol events (plus exact legacy wrapper markers) may
 * become hard runtime signals.
 */
export function runtimeEventView(raw: string): string {
  const logFormat = detectFormat(raw);
  const parts: string[] = [];
  for (const line of pySplitLines(asText(raw))) {
    const stripped = pyStrip(line);
    if (!stripped) continue;
    if (!stripped.startsWith("{")) {
      if (/^AGENT_EXIT=[1-9]\d*$/.test(stripped)) {
        parts.push(stripped);
      } else if (stripped === "Connection error." || stripped === "response.failed") {
        parts.push(stripped);
      }
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(stripped);
    } catch {
      continue;
    }
    if (!isPlainObject(record)) continue;
    const recordType = String(record["type"] || "");
    if (logFormat === DEEPSEEK_HARNESS_JSONL) {
      if (recordType !== "dsh.result" || !record["is_error"]) continue;
      const detail = record["error"] || record["text"] || "DeepSeek Harness failed";
      parts.push(`response.failed: ${detail}`);
    } else if (logFormat === CODEX_EXEC_JSON) {
      if (recordType === "turn.failed") {
        const error = record["error"];
        const message = isPlainObject(error) ? error["message"] : error;
        parts.push(`${TURN_FAILED_SIGNAL}: ${message || "codex turn failed"}`);
      } else if (recordType === "error") {
        const message = record["message"] || record["error"];
        if (message) parts.push(String(message));
      }
    } else if (logFormat === CLAUDE_STREAM_JSON && recordType === "result" && record["is_error"]) {
      const message = record["result"] || record["error"] || record["subtype"] || "claude response failed";
      parts.push(`response.failed: ${message}`);
    } else if (logFormat === OPENCODE_RUN_JSON && recordType === "error") {
      parts.push(`response.failed: ${opencodeErrorMessage(record)}`);
    }
  }
  return parts.join("\n");
}

/**
 * Turn a raw agent log into ordered, UI-friendly steps.
 *
 * Step kinds are shared across backends (`session`, `thinking`, `text`,
 * `tool_use`, `tool_result`, `result`) so the dashboard renders any agent
 * without knowing which CLI produced the log.
 */
export function parseTrajectory(
  raw: string,
  // Python: `parse_trajectory(raw, *, max_steps=None)`. Both the options-object
  // and the plain-number form are accepted so every call site reads naturally.
  options: { maxSteps?: number | null } | number | null = {},
): TrajectoryStep[] {
  const maxSteps = typeof options === "number" ? options : options === null ? null : options.maxSteps ?? null;
  const boundedSteps = maxSteps === null ? null : Math.max(1, Math.trunc(maxSteps));
  const logFormat = detectFormat(raw);
  if (logFormat === DEEPSEEK_HARNESS_JSONL) return deepseekTrajectory(raw, boundedSteps);
  if (logFormat === CODEX_EXEC_JSON) return codexTrajectory(raw, boundedSteps);
  if (logFormat === CLAUDE_STREAM_JSON) return claudeTrajectory(raw, boundedSteps);
  if (logFormat === OPENCODE_RUN_JSON) return opencodeTrajectory(raw, boundedSteps);
  return [];
}

// ----------------------------------------------------------------------------
// DeepSeek Harness (`dsh --profile headless` through deepseek_runner)
// ----------------------------------------------------------------------------

function deepseekAssistantTexts(raw: string): string[] {
  const texts: string[] = [];
  for (const record of jsonRecords(raw)) {
    if (record["type"] !== "dsh.result") continue;
    const text = record["text"];
    if (isStr(text) && pyStrip(text)) texts.push(text);
  }
  return texts;
}

function deepseekTrajectory(raw: string, maxSteps: number | null): TrajectoryStep[] {
  const steps = new Deque<TrajectoryStep>(maxSteps);
  for (const record of jsonRecords(raw)) {
    if (record["type"] !== "dsh.result") continue;
    const text = record["text"];
    const error = record["error"];
    const step: TrajectoryStep = {
      kind: "result",
      text: isStr(text) ? pyStrip(text) : "",
      is_error: Boolean(record["is_error"]),
    };
    if (Number.isInteger(record["exit_code"]) && typeof record["exit_code"] !== "boolean") {
      step["exit_code"] = record["exit_code"];
    }
    if (isStr(error) && pyStrip(error)) step["error"] = pyStrip(error);
    steps.append(step);
  }
  return steps.list();
}

// ----------------------------------------------------------------------------
// Codex (`codex exec --json`)
// ----------------------------------------------------------------------------

function codexAssistantTexts(raw: string): string[] {
  const texts: string[] = [];
  for (const record of jsonRecords(raw)) {
    if (record["type"] !== "item.completed") continue;
    const item = record["item"];
    if (!isPlainObject(item) || item["type"] !== "agent_message") continue;
    const text = item["text"];
    if (isStr(text) && pyStrip(text)) texts.push(text);
  }
  return texts;
}

function codexToolOutput(record: JsonRecord): string[] {
  const recordType = record["type"];
  if (recordType === "turn.failed") {
    const error = record["error"];
    const message = isPlainObject(error) ? error["message"] : null;
    return [`${TURN_FAILED_SIGNAL}: ${message || "codex turn failed"}`];
  }
  if (recordType === "error") {
    const message = record["message"];
    return message ? [String(message)] : [];
  }
  if (recordType !== "item.completed" && recordType !== "item.updated") return [];
  const item = record["item"];
  if (!isPlainObject(item)) return [];
  const itemType = item["type"];
  if (itemType === "command_execution") {
    const output = item["aggregated_output"];
    return output ? [String(output)] : [];
  }
  if (itemType === "mcp_tool_call") {
    const [text] = contentBlocksToText(codexMcpContent(item));
    return text ? [text] : [];
  }
  if (itemType === "error") {
    const message = item["message"];
    return message ? [String(message)] : [];
  }
  return [];
}

function codexTrajectory(raw: string, maxSteps: number | null): TrajectoryStep[] {
  // A 16 MiB JSONL file can still contain well over 100,000 tiny events.
  // Keep the newest UI-relevant steps in a ring buffer so a bounded input
  // cannot expand into an unbounded response/DOM. `null` preserves the
  // complete-parser behavior used outside the dashboard.
  const steps = new Deque<TrajectoryStep>(maxSteps);
  // Codex emits `item.started` then `item.completed` for tool items, but a
  // log tailed mid-run can be missing either side; track ids so each action
  // still renders exactly one call step and at most one result step.  The
  // bounded dashboard path also bounds this bookkeeping set; otherwise a
  // stream of tiny `item.started` records could consume memory even while
  // the returned step deque stayed small.
  const startedIds = new Set<string>();
  const startedOrder: Deque<string> | null = maxSteps !== null ? new Deque<string>(null) : null;
  const seenCap = maxSteps !== null ? Math.max(32, (maxSteps || 0) * 4) : null;
  for (const record of jsonRecords(raw)) {
    const recordType = record["type"];
    if (recordType === "thread.started") {
      steps.append({
        kind: "session",
        model: "codex",
        cwd: "",
        mcp_servers: [],
        tool_count: 0,
        thread_id: record["thread_id"] ?? "",
      });
      continue;
    }
    if (recordType === "error") {
      const message = record["message"];
      if (message) steps.append(toolResultStep("", String(message), [], true));
      continue;
    }
    if (recordType === "turn.failed") {
      const error = record["error"];
      const message = isPlainObject(error) ? error["message"] : null;
      steps.append({ kind: "result", text: String(message || "codex turn failed"), is_error: true });
      continue;
    }
    if (recordType === "turn.completed") {
      steps.append(codexResultStep(record, steps.items));
      continue;
    }
    if (recordType !== "item.started" && recordType !== "item.completed") continue;
    const item = record["item"];
    if (!isPlainObject(item)) continue;
    const itemType = item["type"];
    const itemId = String(item["id"] || "");
    if (itemType === "agent_message") {
      const text = item["text"];
      if (recordType === "item.completed" && isStr(text) && pyStrip(text)) {
        steps.append({ kind: "text", text });
      }
      continue;
    }
    if (itemType === "reasoning") {
      const summary = item["summary"];
      const text =
        item["text"] || (Array.isArray(summary) ? summary : []).filter((part: unknown) => isStr(part)).join("\n");
      if (recordType === "item.completed" && isStr(text) && pyStrip(text)) {
        steps.append({ kind: "thinking", text });
      }
      continue;
    }
    if (itemType === "error") {
      if (recordType === "item.completed") {
        steps.append(toolResultStep(itemId, String(item["message"] || ""), [], true));
      }
      continue;
    }
    if (!isStr(itemType) || !_CODEX_TOOL_ITEMS.has(itemType)) continue;
    if (recordType === "item.started" || !startedIds.has(itemId)) {
      if (!startedIds.has(itemId)) {
        startedIds.add(itemId);
        if (startedOrder !== null) {
          startedOrder.append(itemId);
          while (startedOrder.length > (seenCap || 0)) startedIds.delete(startedOrder.popleft());
        }
      }
      steps.append(codexToolUseStep(itemId, itemType, item));
    }
    if (recordType === "item.completed") {
      const result = codexToolResultStep(itemId, itemType, item);
      if (result !== null) steps.append(result);
    }
  }
  return steps.list();
}

function codexToolUseStep(itemId: string, itemType: string, item: JsonRecord): TrajectoryStep {
  if (itemType === "command_execution") {
    return { kind: "tool_use", id: itemId, name: "shell", input: { command: item["command"] ?? "" } };
  }
  if (itemType === "file_change") {
    return { kind: "tool_use", id: itemId, name: "apply_patch", input: { changes: item["changes"] || [] } };
  }
  if (itemType === "mcp_tool_call") {
    const name = pyStripChars(`${item["server"] ?? ""}/${item["tool"] ?? ""}`, "/");
    const args = item["arguments"];
    return {
      kind: "tool_use",
      id: itemId,
      name: name || "mcp",
      input: isPlainObject(args) ? args : { arguments: args },
    };
  }
  if (itemType === "web_search") {
    return { kind: "tool_use", id: itemId, name: "web_search", input: { query: item["query"] ?? "" } };
  }
  if (itemType === "todo_list") {
    return { kind: "tool_use", id: itemId, name: "todo_list", input: { items: item["items"] || [] } };
  }
  const payload: JsonRecord = {};
  for (const [key, value] of Object.entries(item)) {
    if (key !== "id" && key !== "type" && key !== "status") payload[key] = value;
  }
  return { kind: "tool_use", id: itemId, name: itemType, input: payload };
}

function codexToolResultStep(itemId: string, itemType: string, item: JsonRecord): TrajectoryStep | null {
  const failed = String(item["status"] || "") === "failed";
  if (itemType === "command_execution") {
    const exitCode = item["exit_code"];
    let text = String(item["aggregated_output"] || "");
    if (exitCode !== null && exitCode !== undefined) text = pyStrip(`${text}\n[exit_code=${exitCode}]`);
    return toolResultStep(itemId, text, [], failed || nonzeroExitCode(exitCode), item["status"]);
  }
  if (itemType === "file_change") {
    const changes = item["changes"] || [];
    const lines = (Array.isArray(changes) ? changes : [])
      .filter(isPlainObject)
      .map((change) => pyStrip(`${change["kind"] ?? ""} ${change["path"] ?? ""}`));
    return toolResultStep(itemId, lines.join("\n"), [], failed, item["status"]);
  }
  if (itemType === "mcp_tool_call") {
    const error = item["error"];
    if (isPlainObject(error) && error["message"]) {
      return toolResultStep(itemId, String(error["message"]), [], true, "failed");
    }
    const [text, images] = contentBlocksToText(codexMcpContent(item));
    return toolResultStep(itemId, text, images, failed, item["status"]);
  }
  if (itemType === "web_search" || itemType === "todo_list") {
    // These Codex items often carry no textual result, but item.completed
    // is still authoritative lifecycle evidence.  Emitting an empty paired
    // result prevents the UI from showing a permanently spinning tool row.
    return toolResultStep(itemId, "", [], failed, item["status"] || "completed");
  }
  return toolResultStep(itemId, "", [], failed, item["status"]);
}

function codexMcpContent(item: JsonRecord): unknown {
  const result = item["result"];
  if (isPlainObject(result)) return result["content"];
  return null;
}

function codexResultStep(record: JsonRecord, steps: TrajectoryStep[]): TrajectoryStep {
  // Reuse the trailing assistant text so the dashboard's duplicate-text drop
  // keeps a single final answer, the same way it does for Claude.
  let finalText = "";
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]["kind"] === "text") {
      finalText = String(steps[index]["text"] || "");
      break;
    }
  }
  const usage = isPlainObject(record["usage"]) ? record["usage"] : {};
  return {
    kind: "result",
    text: finalText,
    is_error: false,
    num_turns: 1,
    input_tokens: usage["input_tokens"] ?? null,
    cached_input_tokens: usage["cached_input_tokens"] ?? null,
    output_tokens: usage["output_tokens"] ?? null,
  };
}

// ----------------------------------------------------------------------------
// Claude Code (`--output-format stream-json`)
// ----------------------------------------------------------------------------

function claudeTexts(raw: string): [string, string[]] {
  let resultText = "";
  const texts: string[] = [];
  for (const record of jsonRecords(raw)) {
    const recordType = record["type"];
    if (recordType === "result" && isStr(record["result"])) {
      resultText = record["result"];
      continue;
    }
    if (recordType !== "assistant") continue;
    const message = record["message"];
    if (!isPlainObject(message) || !Array.isArray(message["content"])) continue;
    for (const block of message["content"]) {
      if (isPlainObject(block) && block["type"] === "text") {
        const text = block["text"];
        if (isStr(text) && pyStrip(text)) texts.push(text);
      }
    }
  }
  return [resultText, texts];
}

function claudeToolOutput(record: JsonRecord): string[] {
  if (record["type"] !== "user") return [];
  const message = record["message"];
  if (!isPlainObject(message) || !Array.isArray(message["content"])) return [];
  const parts: string[] = [];
  for (const block of message["content"]) {
    if (isPlainObject(block) && block["type"] === "tool_result") {
      const [text] = contentBlocksToText(block["content"]);
      if (text) parts.push(text);
    }
  }
  return parts;
}

function claudeTrajectory(raw: string, maxSteps: number | null): TrajectoryStep[] {
  let steps = new Deque<TrajectoryStep>(maxSteps);
  for (const record of jsonRecords(raw)) {
    const recordType = record["type"];
    if (recordType === "system") {
      if (record["subtype"] === "init") {
        const servers = record["mcp_servers"] || [];
        steps.append({
          kind: "session",
          model: record["model"] ?? "",
          cwd: record["cwd"] ?? "",
          mcp_servers: (Array.isArray(servers) ? servers : []).filter(isPlainObject).map((s) => s["name"]),
          tool_count: (Array.isArray(record["tools"]) ? record["tools"] : []).length,
        });
      }
      // skip thinking_tokens and other noisy system deltas
      continue;
    }
    if (recordType === "assistant") {
      const message = isPlainObject(record["message"]) ? record["message"] : {};
      const content = message["content"];
      for (const block of Array.isArray(content) ? content : []) {
        if (!isPlainObject(block)) continue;
        const blockType = block["type"];
        if (blockType === "thinking") {
          const text = block["thinking"];
          if (isStr(text) && pyStrip(text)) steps.append({ kind: "thinking", text });
        } else if (blockType === "text") {
          const text = block["text"];
          if (isStr(text) && pyStrip(text)) steps.append({ kind: "text", text });
        } else if (blockType === "tool_use") {
          steps.append({
            kind: "tool_use",
            id: block["id"] ?? "",
            name: block["name"] ?? "",
            input: block["input"] || {},
          });
        }
      }
      continue;
    }
    if (recordType === "user") {
      const message = isPlainObject(record["message"]) ? record["message"] : {};
      const content = message["content"];
      for (const block of Array.isArray(content) ? content : []) {
        if (!isPlainObject(block) || block["type"] !== "tool_result") continue;
        const [text, images] = contentBlocksToText(block["content"]);
        steps.append(
          toolResultStep(String(block["tool_use_id"] ?? ""), text, images, Boolean(block["is_error"])),
        );
      }
      continue;
    }
    if (recordType === "result") {
      const resultText = isStr(record["result"]) ? record["result"] : "";
      // Claude's final `result` copies the last assistant text block, so it
      // would render twice. Drop the duplicate and keep the richer step.
      const buffered = steps.list();
      for (let index = buffered.length - 1; index >= 0; index -= 1) {
        if (buffered[index]["kind"] === "text") {
          if (pyStrip(String(buffered[index]["text"] ?? "")) === pyStrip(resultText)) buffered.splice(index, 1);
          break;
        }
      }
      steps = new Deque<TrajectoryStep>(maxSteps, buffered);
      steps.append({
        kind: "result",
        text: resultText,
        is_error: Boolean(record["is_error"]),
        duration_ms: record["duration_ms"] ?? null,
        num_turns: record["num_turns"] ?? null,
        cost_usd: record["total_cost_usd"] ?? null,
      });
    }
  }
  return steps.list();
}

// ----------------------------------------------------------------------------
// OpenCode (`opencode run --format json`)
// ----------------------------------------------------------------------------

function opencodeTexts(raw: string): string[] {
  const texts: string[] = [];
  for (const record of jsonRecords(raw)) {
    if (record["type"] !== "text") continue;
    const part = record["part"];
    if (!isPlainObject(part) || part["type"] !== "text") continue;
    const text = part["text"];
    if (isStr(text) && pyStrip(text)) texts.push(text);
  }
  return texts;
}

function opencodeToolOutput(record: JsonRecord): string[] {
  if (record["type"] !== "tool_use") return [];
  const part = record["part"];
  if (!isPlainObject(part) || part["type"] !== "tool") return [];
  const state = part["state"];
  if (!isPlainObject(state) || String(state["status"] || "") !== "completed") return [];
  const output = state["output"];
  if (isStr(output) && pyStrip(output)) return [output];
  return [];
}

function opencodeErrorMessage(record: JsonRecord): string {
  const payload = record["error"];
  if (isPlainObject(payload)) {
    const data = isPlainObject(payload["data"]) ? payload["data"] : payload;
    if (isPlainObject(data)) {
      const message = data["message"];
      if (isStr(message) && pyStrip(message)) return pyStrip(message);
    }
    const name = payload["name"];
    if (isStr(name) && pyStrip(name)) return pyStrip(name);
  }
  const message = record["message"];
  if (isStr(message) && pyStrip(message)) return pyStrip(message);
  return "opencode run failed";
}

function opencodeTrajectory(raw: string, maxSteps: number | null): TrajectoryStep[] {
  const steps = new Deque<TrajectoryStep>(maxSteps);
  const seenIds = new Set<string>();
  const seenOrder: Deque<string> | null = maxSteps !== null ? new Deque<string>(null) : null;
  const seenCap = maxSteps !== null ? Math.max(32, (maxSteps || 0) * 4) : null;
  for (const record of jsonRecords(raw)) {
    const recordType = record["type"];
    const part = isPlainObject(record["part"]) ? record["part"] : {};
    const partType = part["type"];
    if (recordType === "text" && partType === "text") {
      const text = part["text"];
      if (isStr(text) && pyStrip(text)) steps.append({ kind: "text", text });
      continue;
    }
    if (recordType === "tool_use" && partType === "tool") {
      opencodeToolSteps(record, part, steps, seenIds, seenOrder, seenCap);
      continue;
    }
    if (recordType === "step_finish" && String(part["reason"] || "") === "stop") {
      steps.append(opencodeResultStep(record, part, steps.items));
    }
  }
  return steps.list();
}

function opencodeToolSteps(
  record: JsonRecord,
  part: JsonRecord,
  steps: Deque<TrajectoryStep>,
  seenIds: Set<string>,
  seenOrder: Deque<string> | null,
  seenCap: number | null,
): void {
  const partId = String(part["id"] || record["id"] || "");
  const state = isPlainObject(part["state"]) ? part["state"] : {};
  const status = String(state["status"] || "");
  if (!seenIds.has(partId)) {
    seenIds.add(partId);
    if (seenOrder !== null) {
      seenOrder.append(partId);
      while (seenOrder.length > (seenCap || 0)) seenIds.delete(seenOrder.popleft());
    }
    const inputValue = state["input"];
    steps.append({
      kind: "tool_use",
      id: partId,
      name: String(part["tool"] || "tool"),
      input: isPlainObject(inputValue) ? inputValue : { input: inputValue },
    });
  }
  if (status === "completed" || status === "failed" || status === "error") {
    const output = state["output"];
    const text = output !== null && output !== undefined ? String(output) : "";
    steps.append(toolResultStep(partId, text, [], status !== "completed", status));
  }
}

function opencodeResultStep(record: JsonRecord, part: JsonRecord, steps: TrajectoryStep[]): TrajectoryStep {
  let finalText = "";
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]["kind"] === "text") {
      finalText = String(steps[index]["text"] || "");
      break;
    }
  }
  const tokens = isPlainObject(part["tokens"]) ? part["tokens"] : {};
  const cache = isPlainObject(tokens["cache"]) ? tokens["cache"] : {};
  const result: TrajectoryStep = {
    kind: "result",
    text: finalText,
    is_error: false,
    num_turns: 1,
    input_tokens: tokens["input"] ?? null,
    output_tokens: tokens["output"] ?? null,
    reasoning_tokens: tokens["reasoning"] ?? null,
    cached_input_tokens: cache["read"] ?? null,
  };
  const cost = part["cost"];
  if (typeof cost === "number") result["cost_usd"] = cost;
  return result;
}

// ----------------------------------------------------------------------------
// Untyped chat transcripts
// ----------------------------------------------------------------------------

/** Return the assistant message in an untyped chat record, else null. */
function chatMessage(record: JsonRecord): JsonRecord | null {
  const recordType = record["type"];
  if (isStr(recordType) && (_CODEX_EVENTS.has(recordType) || _CLAUDE_EVENTS.has(recordType))) return null;
  const message = isPlainObject(record["message"]) ? record["message"] : record;
  if (!isPlainObject(message) || message["role"] !== "assistant") return null;
  return message;
}

function chatAssistantTexts(raw: string): string[] {
  const texts: string[] = [];
  for (const record of jsonRecords(raw)) {
    const message = chatMessage(record);
    if (message === null) continue;
    const [text] = contentBlocksToText(message["content"]);
    if (pyStrip(text)) texts.push(text);
  }
  return texts;
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

function* jsonRecords(raw: string): Generator<JsonRecord> {
  // Python streams from StringIO, which splits on "\n" after universal-newline
  // translation, so only \n / \r\n / \r are line boundaries here.
  const text = asText(raw);
  if (!text) return;
  for (const line of text.split(/\r\n|[\n\r]/)) {
    const stripped = pyStrip(line);
    if (!stripped.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(stripped);
    } catch {
      continue;
    }
    if (isPlainObject(record)) yield record;
  }
}

function toolResultStep(
  toolUseId: string,
  text: string,
  images: string[],
  isError: boolean,
  status: unknown = null,
): TrajectoryStep {
  const result: TrajectoryStep = {
    kind: "tool_result",
    tool_use_id: toolUseId,
    text,
    images, // data URLs with the base64 payload embedded
    has_image: Boolean(images.length),
    is_error: isError,
  };
  if (status !== null && status !== undefined && pyStrip(String(status))) result["status"] = String(status);
  return result;
}

/** Interpret numeric exit codes without treating the string `"0"` as failure. */
function nonzeroExitCode(value: unknown): boolean {
  if (typeof value === "boolean" || value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) !== 0 : false;
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (!/^[+-]?\d+$/.test(text)) return false;
    return Number(text) !== 0;
  }
  return false;
}

/**
 * Flatten a tool-result payload into text plus embedded image data URLs.
 *
 * Both Anthropic (`source.data` / `source.media_type`) and MCP
 * (`data` / `mimeType`) image block shapes are accepted so screenshots
 * render inline without any extra file writes.
 */
function contentBlocksToText(content: unknown): [string, string[]] {
  if (isStr(content)) return [content, []];
  if (!Array.isArray(content)) return [content === null || content === undefined ? "" : String(content), []];
  const parts: string[] = [];
  const images: string[] = [];
  for (const block of content) {
    if (isStr(block)) {
      parts.push(block);
      continue;
    }
    if (!isPlainObject(block)) continue;
    const blockType = block["type"];
    if (blockType === "text" && isStr(block["text"])) {
      parts.push(block["text"]);
    } else if (blockType === "image") {
      const dataUrl = imageBlockToDataUrl(block);
      if (dataUrl) {
        images.push(dataUrl);
        parts.push("[image]");
      }
    }
  }
  return [parts.join("\n"), images];
}

function imageBlockToDataUrl(block: JsonRecord): string {
  const source = isPlainObject(block["source"]) ? block["source"] : block;
  const data = source["data"];
  if (!isStr(data) || !data) return "";
  const mediaType = source["media_type"] || source["mimeType"] || "image/png";
  return `data:${mediaType};base64,${data}`;
}

/** Python `str.strip(chars)` for a single-character set (used for `"/"`). */
function pyStripChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}
