// Ported 1:1 from LongHorizon-Harness src/lh_harness/utils/process_group.py.
//
// Guarantee that agent CLIs die with the harness.
//
// Every agent runs in its own session (`detached: true`) so a single `killpg`
// reaps the CLI plus whatever it spawned. The trade-off is that the child no
// longer shares our terminal's process group, so Ctrl+C reaches only the
// harness. Without the bookkeeping here, killing the harness would leave a
// `claude` process running against the same workspace.
//
// Two layers cover the realistic exit paths:
//
// * `LocalEnvironment.exec` kills its own child on timeout and on cancellation.
// * The handlers installed here catch what `exec` cannot see (SIGTERM, SIGHUP,
//   and interpreter shutdown) and sweep any still-tracked group.

const _tracked: Set<number> = new Set();
let _installed = false;

const _SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };

export function trackProcessGroup(pid: number): void {
  installHandlers();
  _tracked.add(pid);
}

export function untrackProcessGroup(pid: number): void {
  _tracked.delete(pid);
}

/** Best-effort `killpg`; false means the group is already gone. */
export function signalProcessGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig as NodeJS.Signals);
  } catch {
    return false;
  }
  return true;
}

/**
 * SIGTERM the group, then SIGKILL whatever ignored it.
 *
 * Blocking, so it suits signal and exit handlers. Async callers should
 * escalate around `await proc.wait()` rather than block the event loop.
 */
export function killProcessGroup(pid: number, options: { graceSeconds?: number } = {}): void {
  const graceSeconds = options.graceSeconds ?? 1.0;
  if (!signalProcessGroup(pid, "SIGTERM")) return;
  const deadline = monotonic() + graceSeconds;
  while (monotonic() < deadline) {
    // Signal 0 only probes for existence; once the group is gone the CLI has
    // flushed its trajectory and there is nothing left to escalate against.
    if (!signalProcessGroup(pid, 0)) return;
    sleepSync(0.05);
  }
  signalProcessGroup(pid, "SIGKILL");
}

export function killAllTracked(): void {
  const pids = Array.from(_tracked);
  _tracked.clear();
  for (const pid of pids) killProcessGroup(pid);
}

function installHandlers(): void {
  if (_installed) return;
  _installed = true;

  process.on("exit", killAllTracked);

  // Leave a caller-installed handler alone; overriding it would break the
  // embedding application's own shutdown. SIGINT is deliberately absent: Node
  // already terminates on it, which unwinds through `exec` and triggers the
  // per-child kill there.
  for (const sig of ["SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
    try {
      if (process.listenerCount(sig) > 0) continue;
      process.on(sig, terminatingHandler);
    } catch {
      continue;
    }
  }
}

function terminatingHandler(this: unknown, signum: NodeJS.Signals): void {
  killAllTracked();
  // Restore the default action so our own exit code stays 128+signum.
  try {
    process.removeListener(signum, terminatingHandler);
    process.kill(process.pid, signum);
  } catch {
    process.exit(128 + (_SIGNAL_NUMBERS[signum] ?? 0));
  }
}

function monotonic(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds + nanoseconds / 1e9;
}

/** Synchronous sleep; the Python helper is blocking by design. */
function sleepSync(seconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, Math.max(0, seconds * 1000));
}
