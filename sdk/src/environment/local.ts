// Ported 1:1 from LongHorizon-Harness src/lh_harness/environment/local.py.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TMP_DIR, type ExecResult } from "../types.js";
import { StreamingTrajectoryArtifactWriter } from "../trajectory_artifacts.js";
import { ensureDirNofollow, openPrivateRegularAt } from "../supervisor/control_bus.js";
import {
  killProcessGroup,
  signalProcessGroup,
  trackProcessGroup,
  untrackProcessGroup,
} from "../utils/process_group.js";
import type { Environment } from "./base.js";

// Agent CLIs can emit very large tool results or base64 screenshots.  Keep the
// useful tail (which contains the final assistant/result records) while
// bounding both the in-memory ExecResult and the live dashboard trajectory.
const _MAX_STDOUT_CAPTURE_BYTES = 32 * 1024 * 1024;
const _MAX_STDERR_CAPTURE_BYTES = 4 * 1024 * 1024;
const _MAX_LIVE_TRAJECTORY_BYTES = 16 * 1024 * 1024;
const _TEE_COMPACTION_SLACK_BYTES = 1024 * 1024;

// Claude Code emits one JSON object per line in stream-json mode. A single
// line (e.g. a tool_result carrying a base64 screenshot) can far exceed a
// default 64 KB stream limit and truncate the trajectory, so the reader below
// buffers whole lines up to this size.
const _STREAM_LINE_LIMIT = 64 * 1024 * 1024;

/** Python `bytearray` tail with a byte ceiling. */
export class ByteTail {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer, limit: number): void {
    if (!chunk.length || limit <= 0) return;
    if (chunk.length >= limit) {
      this.buffer = Buffer.from(chunk.subarray(chunk.length - limit));
      return;
    }
    const overflow = this.buffer.length + chunk.length - limit;
    if (overflow > 0) this.buffer = this.buffer.subarray(overflow);
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  get length(): number {
    return this.buffer.length;
  }

  bytes(): Buffer {
    return this.buffer;
  }

  /** Python `bytes(buf).decode("utf-8", errors="replace")`. */
  text(): string {
    return this.buffer.toString("utf-8");
  }
}

export function appendBoundedTail(buffer: ByteTail, chunk: Buffer, limit: number): void {
  buffer.append(chunk, limit);
}

/** An open, truncated live-trajectory file handle. */
export type TrajectoryFile = { fd: number; position: number };

/**
 * Open a live trajectory below an anchored, no-follow parent directory.
 *
 * The worker/agent can write the run tree while the dashboard reads it. A
 * normal `mkdir(); open(path, 'wb')` sequence would follow a swapped `round_*`
 * or `logs` symlink and redirect screenshots/tool traces outside the run. Keep
 * the parent validated through the open, then retain only the descriptor used
 * by the tee.
 */
export function openTrajectoryFile(target: string): TrajectoryFile {
  const parent = ensureDirNofollow(path.dirname(target));
  let fd: number | null = null;
  try {
    fd = openPrivateRegularAt(parent, path.basename(target), fs.constants.O_WRONLY, 0o600);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw osError("trajectory file is not a private regular file");
    }
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // best effort
    }
    // Truncate only after the regular-file/unique-inode check. Passing
    // O_TRUNC into the open would damage an external hard-link alias before we
    // had a chance to reject it.
    fs.ftruncateSync(fd, 0);
    const handle: TrajectoryFile = { fd, position: 0 };
    fd = null;
    return handle;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export class LocalEnvironment implements Environment {
  private readonly _tmpDir: string;

  constructor(tmpDir: string | null = null) {
    // Library usage falls back to user-scoped scratch storage.
    this._tmpDir = tmpDir ? expanduser(tmpDir) : DEFAULT_TMP_DIR;
  }

  /** Where callers may stage files before uploading them into this env. */
  get stagingDir(): string {
    return this._tmpDir;
  }

  async exec(command: string, timeout = 30, teePath: string | null = null): Promise<ExecResult> {
    const start = monotonic();
    let proc: ChildProcessWithoutNullStreams | null = null;
    let ioTask: Promise<void> | null = null;
    const stdoutChunks = new ByteTail();
    const stderrChunks = new ByteTail();
    let exited = false;
    let exitCode: number | null = null;
    try {
      // The Web bearer token protects the supervisor control plane.  An
      // embedded `run --dashboard` executes agent CLIs directly from this
      // process, so relying only on the standalone supervisor's worker
      // sanitisation would expose that credential to the agent.
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv["LH_HARNESS_WEB_TOKEN"];
      proc = spawn(command, {
        shell: true,
        // Own session, so one killpg reaps the agent CLI and everything it
        // spawned. It also detaches the child from our terminal, so Ctrl+C
        // never reaches it, so every exit path below must kill it.
        detached: true,
        env: childEnv,
        stdio: ["inherit", "pipe", "pipe"],
      }) as unknown as ChildProcessWithoutNullStreams;
      const child = proc;
      const waited = new Promise<void>((resolve) => {
        child.on("close", (code, signal) => {
          exited = true;
          // Python reports a signal death as a negative return code.
          exitCode = code === null ? (signal ? -(os.constants.signals[signal] ?? 1) : null) : code;
          resolve();
        });
        child.on("error", () => {
          exited = true;
          exitCode = -1;
          resolve();
        });
      });
      trackProcessGroup(child.pid ?? 0);
      // Always drain incrementally. Besides powering the live dashboard, this
      // leaves the bytes already received available if a timeout or
      // cancellation happens before the child exits normally.
      ioTask = communicateStreaming(child, teePath, stdoutChunks, stderrChunks, waited);
      const timedOut = await waitFor(ioTask, timeout);
      if (timedOut) {
        await this.terminate(child, () => exited);
        await finishIo(ioTask);
        const capturedStderr = stderrChunks.text();
        const timeoutMessage = `Command timed out after ${timeout}s`;
        return {
          stdout: stdoutChunks.text(),
          stderr: pyLstripNewlines(capturedStderr + "\n" + timeoutMessage),
          exit_code: -1,
          duration_ms: Math.trunc((monotonic() - start) * 1000),
          termination_reason: "timeout",
        };
      }
      return {
        stdout: stdoutChunks.text(),
        stderr: stderrChunks.text(),
        exit_code: exitCode !== null ? exitCode : -1,
        duration_ms: Math.trunc((monotonic() - start) * 1000),
      };
    } catch (error) {
      // Covers Ctrl+C and task cancellation: kill the agent before the
      // exception unwinds, or it keeps running with no parent.
      if (proc !== null) await this.terminate(proc, () => exited);
      await finishIo(ioTask);
      throw error;
    } finally {
      if (proc !== null) untrackProcessGroup(proc.pid ?? 0);
    }
  }

  /** SIGTERM the agent's whole group, escalating to SIGKILL if it lingers. */
  private async terminate(proc: ChildProcessWithoutNullStreams | null, hasExited: () => boolean): Promise<void> {
    if (proc === null || hasExited()) return;
    const pid = proc.pid ?? 0;
    signalProcessGroup(pid, "SIGTERM");
    if (await waitForExit(hasExited, 5)) return;
    signalProcessGroup(pid, "SIGKILL");
    if (await waitForExit(hasExited, 5)) return;
    // Cancelled again mid-wait: fall back to the blocking sweep so the agent
    // cannot outlive us.
    killProcessGroup(pid);
  }

  async screenshot(): Promise<Buffer> {
    fs.mkdirSync(this._tmpDir, { recursive: true });
    const target = path.join(this._tmpDir, "_lh_harness_screenshot.png");
    try {
      fs.rmSync(target, { force: true });
    } catch {
      return Buffer.alloc(0);
    }
    const quotedPath = shlexQuote(target);
    const command =
      os.platform() === "darwin"
        ? `screencapture -x ${quotedPath} 2>/dev/null`
        : `gnome-screenshot -f ${quotedPath} 2>/dev/null || ` + `import -window root ${quotedPath} 2>/dev/null`;
    const result = await this.exec(command, 10);
    if (result !== null && result !== undefined && result.exit_code !== 0) return Buffer.alloc(0);
    return fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(remotePath), { recursive: true });
    copy2(localPath, remotePath);
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    copy2(remotePath, localPath);
  }
}

/**
 * Drain both streams while optionally teeing stdout to a live file.
 *
 * stdout is written incrementally (one line at a time) so an external reader
 * (the dashboard) sees the agent's stream-json trajectory grow live. The caller
 * owns the chunk buffers, so partial output survives even when the wait is
 * interrupted by timeout or cancellation.
 */
async function communicateStreaming(
  proc: ChildProcessWithoutNullStreams,
  teePath: string | null,
  stdoutChunks: ByteTail,
  stderrChunks: ByteTail,
  waited: Promise<void>,
): Promise<void> {
  const target = teePath ? teePath : null;

  const readStdout = async (): Promise<void> => {
    // Open in binary truncating mode once at episode start. Every later save
    // is guarded against replacing this partial stream with empty output.
    const fh = target !== null ? openTrajectoryFile(target) : null;
    let artifactWriter = target !== null ? StreamingTrajectoryArtifactWriter.fromLivePath(target) : null;
    const teeTail = new ByteTail();
    let teeSize = 0;
    let compactAfter = _MAX_LIVE_TRAJECTORY_BYTES;
    try {
      for await (const line of readLines(proc.stdout)) {
        stdoutChunks.append(line, _MAX_STDOUT_CAPTURE_BYTES);
        if (fh !== null) {
          try {
            teeTail.append(line, _MAX_LIVE_TRAJECTORY_BYTES);
            fs.writeSync(fh.fd, line, 0, line.length, fh.position);
            fh.position += line.length;
            teeSize += line.length;
            if (teeSize > compactAfter) {
              // Keep the most recent complete-ish JSONL tail. The first
              // retained line may be partial; all trajectory parsers
              // deliberately skip malformed records and continue with later
              // complete lines.
              const tail = teeTail.bytes();
              fs.writeSync(fh.fd, tail, 0, tail.length, 0);
              fs.ftruncateSync(fh.fd, tail.length);
              fh.position = tail.length;
              teeSize = tail.length;
              compactAfter = _MAX_LIVE_TRAJECTORY_BYTES + _TEE_COMPACTION_SLACK_BYTES;
            }
          } catch {
            // ignore tee write failures
          }
        }
        if (artifactWriter !== null) {
          try {
            artifactWriter.consumeLine(line);
          } catch {
            // Raw provider output is still the authoritative diagnostic
            // stream. A screenshot persistence error must not deadlock or
            // abort the agent process.
            artifactWriter = null;
          }
        }
      }
    } finally {
      if (fh !== null) {
        try {
          fs.closeSync(fh.fd);
        } catch {
          // ignore
        }
      }
    }
  };

  const readStderr = async (): Promise<void> => {
    for await (const chunk of readChunks(proc.stderr, 64 * 1024)) {
      stderrChunks.append(chunk, _MAX_STDERR_CAPTURE_BYTES);
    }
  };

  await Promise.all([readStdout(), readStderr(), waited]);
}

/** Yield complete lines (terminator included), then any trailing partial line. */
async function* readLines(stream: NodeJS.ReadableStream | null): AsyncGenerator<Buffer> {
  if (stream === null || stream === undefined) return;
  let pending = Buffer.alloc(0);
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8")]);
    let index = pending.indexOf(0x0a);
    while (index !== -1) {
      yield pending.subarray(0, index + 1);
      pending = pending.subarray(index + 1);
      index = pending.indexOf(0x0a);
    }
    if (pending.length > _STREAM_LINE_LIMIT) {
      yield pending;
      pending = Buffer.alloc(0);
    }
  }
  if (pending.length) yield pending;
}

async function* readChunks(stream: NodeJS.ReadableStream | null, _limit: number): AsyncGenerator<Buffer> {
  if (stream === null || stream === undefined) return;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8");
  }
}

async function finishIo(ioTask: Promise<void> | null): Promise<void> {
  if (ioTask === null) return;
  await waitFor(ioTask, 5);
}

/** Resolve `true` when the timeout fired first; `false` when the task finished. */
async function waitFor(task: Promise<void>, timeoutSeconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, timeoutSeconds * 1000));
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([task.then(() => false).catch(() => false), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForExit(hasExited: () => boolean, timeoutSeconds: number): Promise<boolean> {
  const deadline = monotonic() + timeoutSeconds;
  while (monotonic() < deadline) {
    if (hasExited()) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
  return hasExited();
}

// ----------------------------------------------------------------------------
// Small Python shims
// ----------------------------------------------------------------------------

function monotonic(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds + nanoseconds / 1e9;
}

function expanduser(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Python `str.lstrip("\n")`. */
function pyLstripNewlines(value: string): string {
  return value.replace(/^\n+/, "");
}

/** Python `shlex.quote`. */
export function shlexQuote(value: string): string {
  if (value === "") return "''";
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Python `shutil.copy2`: contents plus mode and timestamps. */
function copy2(source: string, destination: string): void {
  fs.copyFileSync(source, destination);
  const info = fs.statSync(source);
  try {
    fs.chmodSync(destination, info.mode);
    fs.utimesSync(destination, info.atime, info.mtime);
  } catch {
    // best effort
  }
}

function osError(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = "EPERM";
  return error;
}
