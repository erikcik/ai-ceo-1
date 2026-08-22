#!/usr/bin/env node
// CLI launcher: runs src/cli.ts through tsx so no build step is needed. The
// loader is resolved to an absolute file URL because Node resolves a bare
// `--import` specifier against the child's cwd, which is the user's project.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const loader = import.meta.resolve("tsx");
const cli = path.join(here, "..", "src", "cli.ts");
const child = spawn(process.execPath, ["--import", loader, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
