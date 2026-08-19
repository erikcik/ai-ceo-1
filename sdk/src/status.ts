import { taskDir } from "./taskdir.js";
import * as scoreboard from "./scoreboard.js";
import * as planlock from "./planlock.js";

const root = process.argv[2];
if (!root) { console.error("usage: status.ts <taskdir>"); process.exit(2); }
const t = taskDir(root);
console.log(scoreboard.status(t));
const check = planlock.verify(t);
console.log(check.ok ? "plan lock: intact" : `plan lock: ${check.changed.join(", ")}`);
