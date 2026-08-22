// Ported 1:1 from LongHorizon-Harness tests/webapi/test_resume_routes.py
//
// HTTP surface for in-place resume and operator round grants.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { RunSupervisor, supervisorRuntime, type WorkerProcess } from "../../src/supervisor/service.js";
import { MAX_ROUNDS } from "../../src/types.js";
import { startWebServer, type WebServerHandle } from "../../src/webapi/server.js";

const tempRoots: string[] = [];
const servers: WebServerHandle[] = [];
const workers: FakeProcess[] = [];
type FakeProcess = WorkerProcess & { returncode: number | null };

const realSpawn = supervisorRuntime.spawn;
const realKillpg = supervisorRuntime.killpg;
const realKill = supervisorRuntime.kill;

after(async () => {
  // A supervisor shutdown waits out its grace period for live workers; the
  // fakes never exit on their own, so retire them before closing the servers.
  for (const worker of workers) worker.returncode = 0;
  for (const handle of servers) await handle.close();
  for (const target of tempRoots) fs.rmSync(target, { recursive: true, force: true });
  supervisorRuntime.spawn = realSpawn;
  supervisorRuntime.killpg = realKillpg;
  supervisorRuntime.kill = realKill;
});

type Fixture = { url: string; supervisor: RunSupervisor; process: FakeProcess };

async function client(): Promise<Fixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-resume-"));
  tempRoots.push(tmp);
  const worker: FakeProcess = {
    pid: 4242,
    returncode: null,
    poll(): number | null {
      return this.returncode;
    },
  };
  workers.push(worker);
  supervisorRuntime.spawn = () => worker;
  supervisorRuntime.killpg = () => undefined;
  supervisorRuntime.kill = () => undefined;
  const root = path.join(tmp, "runs");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const supervisor = new RunSupervisor(root, { workspaceRoot: workspace });
  const handle = await startWebServer({
    runsRoot: root,
    supervisor,
    host: "127.0.0.1",
    port: 0,
    staticDir: null,
  });
  servers.push(handle);
  return { url: handle.url, supervisor, process: worker };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function stoppedRun(fixture: Fixture): Promise<string> {
  const created = await post(`${fixture.url}api/runs`, { task: "long job", max_rounds: 4 });
  const createdBody = await created.json();
  assert.equal(created.status, 200);
  const runId = createdBody.run.id as string;
  const stopped = await post(`${fixture.url}api/runs/${runId}/stop`, {});
  await stopped.text();
  assert.equal(stopped.status, 200);
  fixture.process.returncode = -15;
  const snapshot = await (await fetch(`${fixture.url}api/runs/${runId}/snapshot`)).json();
  assert.equal(snapshot.controls.can_resume, true);
  return runId;
}

test("resume defaults to continuing the same run", async () => {
  const fixture = await client();
  const runId = await stoppedRun(fixture);
  fixture.process.returncode = null;

  const response = await post(`${fixture.url}api/runs/${runId}/resume`, {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.run.id, runId, "continue must reuse the run id");
  assert.equal(body.run.owner.resume_kind, "continue");
  assert.equal(body.run.owner.resume_epoch, 1);
  // The owner projection must never leak argv/prompts to the browser.
  assert.ok(!("command" in body.run.owner));
});

test("resume retry creates a new run", async () => {
  const fixture = await client();
  const runId = await stoppedRun(fixture);
  fixture.process.returncode = null;

  const response = await post(`${fixture.url}api/runs/${runId}/resume`, { mode: "retry" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.notEqual(body.run.id, runId);
  assert.equal(body.run.owner.resume_kind, "retry");
});

test("resume accepts an extra round grant", async () => {
  const fixture = await client();
  const runId = await stoppedRun(fixture);
  fixture.process.returncode = null;

  const response = await post(`${fixture.url}api/runs/${runId}/resume`, { extra_rounds: 9 });
  await response.text();

  assert.equal(response.status, 200);
  assert.ok((fixture.supervisor.owner(runId).command as string[]).includes("--max-rounds=9"));
});

for (const mode of ["rewind", "CONTINUE", "continue retry", 7]) {
  test(`resume rejects the unknown mode ${JSON.stringify(mode)}`, async () => {
    const fixture = await client();
    const runId = await stoppedRun(fixture);

    const response = await post(`${fixture.url}api/runs/${runId}/resume`, { mode });
    await response.text();

    assert.equal(response.status, 422);
  });
}

for (const body of [{}, { mode: "" }]) {
  test(`resume treats an absent mode as continue (${JSON.stringify(body)})`, async () => {
    const fixture = await client();
    const runId = await stoppedRun(fixture);
    fixture.process.returncode = null;

    const response = await post(`${fixture.url}api/runs/${runId}/resume`, body);
    const parsed = await response.json();

    assert.equal(response.status, 200);
    assert.equal(parsed.run.id, runId);
  });
}

for (const extra of [0, -1, MAX_ROUNDS + 1, 1.5, true, "many"]) {
  test(`resume rejects the out-of-range grant ${JSON.stringify(extra)}`, async () => {
    const fixture = await client();
    const runId = await stoppedRun(fixture);

    const response = await post(`${fixture.url}api/runs/${runId}/resume`, { extra_rounds: extra });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.ok(String(body.detail).includes("extra_rounds"));
  });
}

test("resume replays a repeated idempotency key", async () => {
  const fixture = await client();
  const runId = await stoppedRun(fixture);
  fixture.process.returncode = null;
  const headers = { "Idempotency-Key": "resume-once" };

  const first = await post(`${fixture.url}api/runs/${runId}/resume`, {}, headers);
  await first.text();
  const second = await post(`${fixture.url}api/runs/${runId}/resume`, {}, headers);
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(secondBody.run.owner.resume_epoch, 1, "a replay must not bump the epoch");
});

test("resume conflicts when a key is reused for another request", async () => {
  const fixture = await client();
  const runId = await stoppedRun(fixture);
  fixture.process.returncode = null;
  const headers = { "Idempotency-Key": "shared" };

  const first = await post(`${fixture.url}api/runs/${runId}/resume`, {}, headers);
  await first.text();
  assert.equal(first.status, 200);

  const conflict = await post(`${fixture.url}api/runs/${runId}/resume`, { extra_rounds: 3 }, headers);
  await conflict.text();

  assert.equal(conflict.status, 409);
});

test("a resumed run can be stopped again over http", async () => {
  const fixture = await client();
  const runId = await stoppedRun(fixture);
  fixture.process.returncode = null;

  const resumed = await post(`${fixture.url}api/runs/${runId}/resume`, {});
  await resumed.text();
  assert.equal(resumed.status, 200);

  const stopped = await post(`${fixture.url}api/runs/${runId}/stop`, {});
  const body = await stopped.json();

  assert.equal(stopped.status, 200);
  assert.equal(body.command_id, "lifecycle-stop@1");
  assert.ok(!body.idempotent, "a new generation's stop is a real stop");
});

test("the snapshot reports a stop that has not taken effect", async () => {
  // SIGKILL costs the run its report, so Web only offers the escalation once a
  // graceful stop is provably in flight. That needs both fields.
  const fixture = await client();
  const created = await post(`${fixture.url}api/runs`, { task: "ignores sigterm", max_rounds: 2 });
  const runId = (await created.json()).run.id as string;

  const idle = (await (await fetch(`${fixture.url}api/runs/${runId}/snapshot`)).json()).run;
  assert.ok(!("requested_action" in idle));
  assert.ok(!("stop_requested_at" in idle));

  const stopped = await post(`${fixture.url}api/runs/${runId}/stop`, {});
  await stopped.text();
  assert.equal(stopped.status, 200);

  const stopping = (await (await fetch(`${fixture.url}api/runs/${runId}/snapshot`)).json()).run;
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.requested_action, "stop");
  assert.equal(typeof stopping.stop_requested_at, "number");

  const aborted = await post(`${fixture.url}api/runs/${runId}/abort`, {});
  await aborted.text();
  assert.equal(aborted.status, 200);

  const escalated = (await (await fetch(`${fixture.url}api/runs/${runId}/snapshot`)).json()).run;
  assert.equal(escalated.requested_action, "abort", "an escalation must be observable");
});

test("the snapshot exposes the resume generation", async () => {
  // Clients keep lifecycle monotonic, so without this counter a reopened run
  // looks like a stale non-terminal frame after a terminal one and is dropped.
  const fixture = await client();
  const runId = await stoppedRun(fixture);

  const before = (await (await fetch(`${fixture.url}api/runs/${runId}/snapshot`)).json()).run;
  assert.ok(!("resume_epoch" in before));

  fixture.process.returncode = null;
  const resumed = await post(`${fixture.url}api/runs/${runId}/resume`, {});
  await resumed.text();
  assert.equal(resumed.status, 200);

  const snapshot = await (await fetch(`${fixture.url}api/runs/${runId}/snapshot`)).json();
  assert.equal(snapshot.run.resume_epoch, 1);
  assert.ok(!["cancelled", "failed", "completed", "incomplete", "blocked"].includes(snapshot.run.status));
});

test("approval resolve rejects an out-of-range round grant", async () => {
  const fixture = await client();
  const created = await post(`${fixture.url}api/runs`, { task: "gate me", max_rounds: 2 });
  const runId = (await created.json()).run.id as string;

  const response = await post(`${fixture.url}api/runs/${runId}/approvals/does-not-matter/resolve`, {
    action: "continue",
    extra_rounds: MAX_ROUNDS + 1,
  });
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.ok(String(body.detail).includes("extra_rounds"));
});
