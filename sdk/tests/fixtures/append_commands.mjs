// Append N control commands from a separate OS process.
//
// The Python suite proves revision atomicity with a ThreadPoolExecutor; the Node
// port's serialisation point is a cross-process lock file, so the equivalent
// test has to use real processes.
//
// usage: node --import tsx tests/fixtures/append_commands.mjs <runDir> <worker> <count>
import { ControlBus } from "../../src/supervisor/control_bus.js";

const [runDir, worker, count] = process.argv.slice(2);
const bus = new ControlBus(runDir);
const revisions = [];
for (let index = 0; index < Number(count); index += 1) {
  revisions.push(bus.append("test", { worker: Number(worker), index }).revision);
}
process.stdout.write(`${JSON.stringify(revisions)}\n`);
