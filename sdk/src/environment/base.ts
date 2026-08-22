/**
 * Ported 1:1 from LongHorizon-Harness src/lh_harness/environment/base.py.
 * The pluggable execution-environment protocol. Only `local` ships today.
 */
import type { ExecResult } from "../types.js";

export interface Environment {
  /** Run a shell command; `timeout` in seconds; `teePath` mirrors stdout to a file as it streams. */
  exec(command: string, timeout?: number, teePath?: string | null): Promise<ExecResult>;
  screenshot(): Promise<Buffer>;
  upload(localPath: string, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  /** The run's own tmp dir, used to stage uploads (Python: `env.staging_dir`). */
  readonly stagingDir?: string;
}
