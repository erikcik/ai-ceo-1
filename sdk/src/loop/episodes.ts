// Running one agent episode and recording it. Carried over from the previous
// loop (manager.ts) so the on-disk episode records, trajectories and screenshot
// manifests keep the shapes the workbench and the trajectory viewer expect.
//
// Layout per episode:  <episodeRoot>/<role>_episodes/epNNN/
//   agent.log, chat.jsonl, metadata.json, claude_stream.jsonl,
//   <role>_raw_trajectory.jsonl, <role>_trajectory.jsonl, <role>_screenshots.json,
//   screenshot files, prompt.md, output.md

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentAdapter } from "../adapters/base.js";
import { assistantTexts as decodeAgentAssistantTexts, visibleOutput as decodeAgentVisibleOutput } from "../agent_logs.js";
import type { Environment } from "../environment/base.js";
import { atomicBytesWrite, ensureDirNofollow, openNofollow } from "../supervisor/control_bus.js";
import { persistTrajectoryArtifacts } from "../trajectory_artifacts.js";
import { episodeResult, type EpisodeBudget, type EpisodeResult } from "../types.js";
import { pyRstrip, pyStrip } from "../utils/pystr.js";

export const MAX_SAVED_TRAJECTORY_BYTES = 16 * 1024 * 1024;

export const VISIBLE_OUTPUT_KEYS = [
  "executor_agent_visible_output",
  "visible_executor_output",
  "assistant_visible_output",
  "output_text",
] as const;

export type EpisodeRunOptions = {
  signal?: AbortSignal;
  hooks?: unknown;
  agents?: unknown;
  systemPromptAppend?: string;
  maxBudgetUsd?: number;
};

export interface EpisodeCapableAdapter extends AgentAdapter {
  runEpisode(
    prompt: string,
    env: Environment,
    budget: EpisodeBudget,
    liveTrajectoryPath?: string | null,
    options?: EpisodeRunOptions,
  ): Promise<EpisodeResult>;
}

/** Run one episode; cancellation becomes a `cancelled` result instead of a throw. */
export async function runRoleEpisode(
  agent: AgentAdapter,
  prompt: string,
  env: Environment,
  budget: EpisodeBudget,
  options: { liveTrajectoryPath?: string | null; signal?: AbortSignal | null } & EpisodeRunOptions = {},
): Promise<EpisodeResult> {
  const started = monotonic();
  try {
    if (options.signal?.aborted) throw cancellationError();
    const extra: EpisodeRunOptions = {};
    if (options.signal) extra.signal = options.signal;
    if (options.hooks) extra.hooks = options.hooks;
    if (options.agents) extra.agents = options.agents;
    if (options.systemPromptAppend) extra.systemPromptAppend = options.systemPromptAppend;
    if (options.maxBudgetUsd) extra.maxBudgetUsd = options.maxBudgetUsd;
    return await (agent as EpisodeCapableAdapter).runEpisode(
      prompt,
      env,
      budget,
      options.liveTrajectoryPath ?? null,
      extra,
    );
  } catch (exc) {
    if (isCancellation(exc)) {
      return episodeResult({
        status: "cancelled",
        error: "Execution cancelled by operator",
        duration_ms: Math.trunc((monotonic() - started) * 1000),
        metadata: { cancelled: true },
      });
    }
    throw exc;
  }
}

export function visibleOutput(result: EpisodeResult): string {
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  for (const key of VISIBLE_OUTPUT_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && pyStrip(value)) return value;
  }
  if (metadata["actions_log_diagnostics_only"]) return "";
  const raw = result.actions_log || "";
  const decoded = decodeAgentVisibleOutput(raw);
  return decoded ? decoded : raw;
}

export function episodeStatus(result: EpisodeResult): Record<string, unknown> {
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  return {
    status: result.status,
    error: result.error ?? null,
    duration_ms: result.duration_ms,
    exit_code: metadata["exit_code"] ?? null,
    cost_usd: typeof metadata["total_cost_usd"] === "number" ? metadata["total_cost_usd"] : null,
    num_turns: typeof metadata["num_turns"] === "number" ? metadata["num_turns"] : null,
    runtime_signals: metadata["runtime_signals"] ?? null,
  };
}

export function workspaceMutationDetected(result: EpisodeResult): boolean {
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  return Boolean(metadata["verifier_workspace_mutation_detected"]);
}

/** Allocate `<episodeRoot>/<role>_episodes/epNNN` and return its path. */
export function allocateEpisodeDir(episodeRoot: string, roleName: string): string {
  return nextEpisodeDir(path.join(episodeRoot, `${roleName}_episodes`));
}

/**
 * Persist a finished episode into `episodeDir`: raw + normalised trajectory,
 * screenshot manifest, metadata, agent.log/chat.jsonl, prompt and output.
 * Returns the trajectory artifact summary (screenshot count etc.).
 */
export function saveEpisode(options: {
  episodeDir: string;
  roleName: string;
  prompt: string;
  result: EpisodeResult;
}): Record<string, unknown> {
  const { episodeDir, roleName, result } = options;
  ensureDirNofollow(episodeDir);
  const trajectoryPath = path.join(episodeDir, `${roleName}_raw_trajectory.jsonl`);
  let preservedLiveTrajectory = false;
  let liveTrajectory = "";
  let liveTrajectoryTruncated = false;
  if (fs.existsSync(trajectoryPath)) {
    [liveTrajectory, liveTrajectoryTruncated] = readLocalTextTail(trajectoryPath, MAX_SAVED_TRAJECTORY_BYTES);
  }
  let [finalTrajectory, finalTrajectoryTruncated] = boundedTextTail(result.actions_log || "", MAX_SAVED_TRAJECTORY_BYTES);
  if (
    liveTrajectory &&
    (!finalTrajectory ||
      (!liveTrajectoryTruncated && liveTrajectory.startsWith(finalTrajectory) && liveTrajectory.length > finalTrajectory.length))
  ) {
    preservedLiveTrajectory = true;
  }
  if (!preservedLiveTrajectory || liveTrajectoryTruncated) {
    if (preservedLiveTrajectory) finalTrajectory = liveTrajectory;
    writeLocal(trajectoryPath, finalTrajectory);
  }
  const artifactSource = preservedLiveTrajectory ? liveTrajectory : finalTrajectory;
  let trajectoryArtifacts: Record<string, unknown>;
  try {
    trajectoryArtifacts = persistTrajectoryArtifacts(artifactSource, { roundDir: episodeDir, roleName }) as Record<string, unknown>;
  } catch (exc) {
    trajectoryArtifacts = {
      normalized_trajectory: "",
      screenshot_manifest: "",
      screenshot_count: 0,
      total_screenshot_bytes: 0,
      screenshots: [],
      persistence_error: exceptionText(exc),
    };
  }
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  const visible = pyStrip(visibleOutput(result));
  const stderrTail = pyStrip(String(metadata["stderr_tail"] || ""));
  const agentLogParts = [`role=${roleName}`, `status=${result.status}`, `duration_ms=${result.duration_ms}`];
  if (result.error) agentLogParts.push("", `error: ${result.error}`);
  if (stderrTail) agentLogParts.push("", "stderr:", stderrTail);
  if (visible) agentLogParts.push("", "assistant output:", visible);
  writeLocal(path.join(episodeDir, "agent.log"), pyRstrip(agentLogParts.join("\n")) + "\n");
  writeLocal(path.join(episodeDir, "claude_stream.jsonl"), readLocalBounded(trajectoryPath, MAX_SAVED_TRAJECTORY_BYTES) ?? "");
  writeLocal(path.join(episodeDir, "chat.jsonl"), episodeChatJsonl(result));
  writeLocal(path.join(episodeDir, "prompt.md"), options.prompt);
  writeLocal(path.join(episodeDir, "output.md"), visible ? `${visible}\n` : "");
  const episodeMetadata = {
    status: result.status,
    error: result.error ?? null,
    duration_ms: result.duration_ms,
    role: roleName,
    metadata,
    live_trajectory_preserved: preservedLiveTrajectory,
    trajectory_truncated: Boolean(liveTrajectoryTruncated || finalTrajectoryTruncated),
    trajectory_artifacts: trajectoryArtifacts,
  };
  writeLocal(path.join(episodeDir, "metadata.json"), jsonDumpsIndent2(jsonSafe(episodeMetadata)) + "\n");
  return trajectoryArtifacts;
}

function episodeChatJsonl(result: EpisodeResult): string {
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  const raw = result.actions_log || "";
  let texts = decodeAgentAssistantTexts(raw);
  if (!texts.length) {
    const visible = pyStrip(visibleOutput(result));
    if (visible) texts = [visible];
  }
  const records: Record<string, unknown>[] = [
    { type: "session", version: 3, id: "chat", timestamp: isoMilliseconds(new Date()), cwd: String(metadata["workspace"] || "") },
  ];
  for (const text of texts) {
    records.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
  }
  return records.map((record) => pyJsonDumps(record)).join("\n") + "\n";
}

export function nextEpisodeDir(episodeRoot: string): string {
  ensureDirNofollow(episodeRoot);
  let highest = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(episodeRoot);
  } catch (exc) {
    throw new Error(`cannot scan episode root: ${episodeRoot}`, { cause: exc });
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (index >= 10_000) throw new Error(`too many episode entries: ${episodeRoot}`);
    const name = entries[index]!;
    if (name.length === 5 && name.startsWith("ep") && /^\d+$/.test(name.slice(2))) {
      highest = Math.max(highest, Number.parseInt(name.slice(2), 10));
    }
  }
  const episodeDir = path.join(episodeRoot, `ep${pad3(highest + 1)}`);
  if (lstatOrNull(episodeDir) !== null) throw new Error(`episode path already exists: ${episodeDir}`);
  ensureDirNofollow(episodeDir);
  return episodeDir;
}

/** Task-level `agent.log` / `chat.jsonl` merged over every `<role>_episodes` tree. */
export function mergeEpisodeLogs(logDir: string): void {
  const agentSections: string[] = [];
  const chatLines: string[] = [];
  let totalChars = 0;
  let totalChatChars = 0;
  const maxChars = 64 * 1024 * 1024;
  let roots: string[] = [];
  try {
    roots = fs.readdirSync(logDir).filter((name) => name.endsWith("_episodes")).sort();
  } catch {
    return;
  }
  for (const rootName of roots) {
    const root = path.join(logDir, rootName);
    let entries: string[];
    try {
      entries = fs.readdirSync(root).slice(0, 1_000).sort();
    } catch {
      continue;
    }
    for (const entryName of entries) {
      const episodeDir = path.join(root, entryName);
      const entryStat = lstatOrNull(episodeDir);
      if (entryStat === null || !entryStat.isDirectory()) continue;
      const agentText = readLocalBounded(path.join(episodeDir, "agent.log"), MAX_SAVED_TRAJECTORY_BYTES) ?? "";
      const section = `\n===== ${rootName}/${entryName} agent.log =====\n${agentText}\n`;
      if (totalChars + section.length > maxChars) break;
      agentSections.push(section);
      totalChars += section.length;
      const chatText = readLocalBounded(path.join(episodeDir, "chat.jsonl"), MAX_SAVED_TRAJECTORY_BYTES) ?? "";
      for (const line of chatText.split("\n")) {
        if (!pyStrip(line)) continue;
        if (totalChatChars + line.length + 1 > maxChars) break;
        chatLines.push(line);
        totalChatChars += line.length + 1;
      }
    }
  }
  const resultDir = path.dirname(logDir);
  writeLocal(path.join(resultDir, "agent.log"), agentSections.join(""));
  writeLocal(path.join(resultDir, "chat.jsonl"), chatLines.length ? chatLines.join("\n") + "\n" : "");
}

// ---------------------------------------------------------------------------
// Event stream (same record shape as before: schema_version, event_id, ts, event)
// ---------------------------------------------------------------------------

export function appendEvent(eventsPath: string, event: string, payload: Record<string, unknown>): void {
  ensureDirNofollow(path.dirname(eventsPath));
  const nofollow = (fs.constants as unknown as Record<string, number>)["O_NOFOLLOW"];
  if (!nofollow) throw new Error("secure event append requires O_NOFOLLOW");
  let parentFd: number | null = null;
  let fd: number | null = null;
  try {
    parentFd = openNofollow(path.dirname(eventsPath), { directory: true });
    fd = fs.openSync(eventsPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | nofollow, 0o600);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("event log is not a private regular file");
    const size = Number(metadata.size);
    let existing = "";
    if (size > 0) {
      const buffer = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const chunk = fs.readSync(fd, buffer, read, size - read, read);
        if (chunk === 0) break;
        read += chunk;
      }
      existing = buffer.subarray(0, read).toString("utf-8");
    }
    let sequence = 1;
    for (const line of existing.split("\n")) if (pyStrip(line)) sequence += 1;
    const parents = pathParents(eventsPath);
    const runId = parents.length > 2 ? path.basename(parents[2]!) : "local";
    const record = {
      schema_version: 1,
      event_id: `${runId}:${String(sequence).padStart(6, "0")}`,
      ts: Date.now() / 1000,
      event,
      ...(jsonSafe(payload) as Record<string, unknown>),
    };
    fs.writeSync(fd, pyJsonDumps(record, { sortKeys: true }) + "\n");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best effort */
    }
  } finally {
    closeQuietly(fd);
    closeQuietly(parentFd);
  }
}

// ---------------------------------------------------------------------------
// Bounded no-follow local reads / writes and small utilities
// ---------------------------------------------------------------------------

export function writeLocal(filePath: string, text: string): void {
  atomicBytesWrite(filePath, Buffer.from(text, "utf-8"));
}

export function readLocalBounded(filePath: string, maxBytes: number, options: { tail?: boolean } = {}): string | null {
  const tail = options.tail ?? false;
  let fd: number | null = null;
  try {
    fd = openNofollow(filePath);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) return null;
    const size = Number(metadata.size);
    const start = tail ? Math.max(0, size - maxBytes) : 0;
    const chunks: Buffer[] = [];
    let remaining = maxBytes + 1;
    let position = start;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(remaining, 1024 * 1024));
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      chunks.push(buffer.subarray(0, read));
      position += read;
      remaining -= read;
    }
    let raw = Buffer.concat(chunks).subarray(0, maxBytes);
    if (tail && start) {
      const firstNewline = raw.indexOf(0x0a);
      raw = firstNewline >= 0 ? raw.subarray(firstNewline + 1) : Buffer.alloc(0);
    }
    return raw.toString("utf-8");
  } catch {
    return null;
  } finally {
    closeQuietly(fd);
  }
}

export function readLocalTextTail(filePath: string, maxBytes: number): [string, boolean] {
  let fd: number | null = null;
  try {
    fd = openNofollow(filePath);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) return ["", false];
    const size = Number(metadata.size);
    const truncated = size > maxBytes;
    const start = truncated ? size - maxBytes : 0;
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, size - start));
    let read = 0;
    while (read < buffer.length) {
      const chunk = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
      if (chunk === 0) break;
      read += chunk;
    }
    return [buffer.subarray(0, read).toString("utf-8"), truncated];
  } catch {
    return ["", false];
  } finally {
    closeQuietly(fd);
  }
}

export function boundedTextTail(text: string, maxBytes: number): [string, boolean] {
  const raw = Buffer.from(text, "utf-8");
  if (raw.length <= maxBytes) return [text, false];
  return [raw.subarray(raw.length - maxBytes).toString("utf-8"), true];
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonSafe(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[String(key)] = jsonSafe(item);
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

export function pyJsonDumps(value: unknown, options: { sortKeys?: boolean } = {}): string {
  const sortKeys = options.sortKeys ?? false;
  const encode = (item: unknown): string => {
    if (item === null || item === undefined) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") return Number.isFinite(item) ? String(item) : Number.isNaN(item) ? "NaN" : item > 0 ? "Infinity" : "-Infinity";
    if (Array.isArray(item)) return "[" + item.map(encode).join(", ") + "]";
    if (typeof item === "object") {
      let keys = Object.keys(item as Record<string, unknown>);
      if (sortKeys) keys = keys.sort();
      return "{" + keys.map((key) => `${JSON.stringify(key)}: ${encode((item as Record<string, unknown>)[key])}`).join(", ") + "}";
    }
    return JSON.stringify(String(item));
  };
  return encode(value);
}

export function jsonDumpsIndent2(value: unknown): string {
  return JSON.stringify(jsonSafe(value), null, 2);
}

export function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function pathParents(target: string): string[] {
  const out: string[] = [];
  let current = path.dirname(target);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

export function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
}

export function monotonic(): number {
  return performance.now() / 1000;
}

function isoMilliseconds(value: Date): string {
  return value.toISOString().replace(/Z$/, "+00:00");
}

export function cancellationError(): Error {
  const error = new Error("Execution cancelled by operator");
  error.name = "AbortError";
  return error;
}

export function isCancellation(exc: unknown): boolean {
  if (exc === null || typeof exc !== "object") return false;
  const name = (exc as { name?: unknown }).name;
  return name === "AbortError" || name === "CancelledError";
}

export function exceptionText(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

export function sha256File(target: string): string | null {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return stat.isFile() ? "large" : null;
    return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  } catch {
    return null;
  }
}
