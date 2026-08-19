import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

import fs from "node:fs";
import path from "node:path";

/**
 * True only when cwd is the TOP of its own repo. `rev-parse --git-dir` alone
 * finds any enclosing repo, which in the first sdk smoke run made a task dir
 * nested inside the harness repo commit the harness's working tree wholesale.
 * A task dir owns its history or it does not have one.
 */
export function isRepo(cwd: string): boolean {
  try {
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    return path.resolve(top) === path.resolve(cwd) && fs.existsSync(path.join(cwd, ".git"));
  } catch { return false; }
}

/** Init a repo with an initial commit if the task dir is not one yet. */
export function ensureRepo(cwd: string): void {
  if (isRepo(cwd)) return;
  git(cwd, ["init", "-q"]);
  git(cwd, ["add", "-A"]);
  try { git(cwd, ["commit", "-q", "-m", "task init", "--allow-empty"]); } catch { /* identity missing: surfaced later */ }
}

export function head(cwd: string): string {
  try { return git(cwd, ["rev-parse", "HEAD"]); } catch { return ""; }
}

/** The commit-on-stop backstop, run by the wrapper after every session. */
export function commitAll(cwd: string, message: string): void {
  try {
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", message]);
  } catch { /* nothing to commit, or no identity -- non-fatal by design */ }
}
