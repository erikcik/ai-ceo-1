// Ported 1:1 from LongHorizon-Harness src/lh_harness/environment/remote_files.py.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import posix from "node:path/posix";

import { DEFAULT_TMP_DIR } from "../types.js";
import type { Environment } from "./base.js";

/** Python `shlex.quote`. */
function shlexQuote(value: string): string {
  if (value === "") return "''";
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Python `str.rstrip("/")`. */
function rstripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function writeRemoteText(
  env: Environment,
  remotePath: string,
  content: string,
  mode = "0644",
): Promise<void> {
  const parent = posix.dirname(rstripSlash(remotePath));
  if (parent) await ensureRemoteDir(env, parent);

  let tmpPath: string | null = null;
  try {
    // Prompts can carry task secrets, so stage them in the run's own tmp dir
    // rather than a directory shared by every run on the machine.
    const staging = (env as { stagingDir?: string }).stagingDir;
    const tmpDir = staging ? String(staging) : DEFAULT_TMP_DIR;
    fs.mkdirSync(tmpDir, { recursive: true });
    tmpPath = path.join(tmpDir, `lh_harness_remote_${crypto.randomBytes(8).toString("hex")}`);
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    await env.upload(tmpPath, remotePath);
  } finally {
    if (tmpPath !== null) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // FileNotFoundError
      }
    }
  }

  const result = await env.exec(`chmod ${shlexQuote(mode)} ${shlexQuote(remotePath)}`, 30);
  if (result.exit_code !== 0) {
    throw new Error(`failed chmod ${remotePath}: ${result.stderr || result.stdout}`);
  }
}

export async function ensureRemoteDir(env: Environment, remotePath: string): Promise<void> {
  const result = await env.exec(`mkdir -p ${shlexQuote(remotePath)}`, 30);
  if (result.exit_code !== 0) {
    throw new Error(`failed creating ${remotePath}: ${result.stderr || result.stdout}`);
  }
}
