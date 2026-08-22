// Ported 1:1 from LongHorizon-Harness tests/webapi/test_hardening.py

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";

import { DashboardState } from "../../src/dashboard/state.js";
import { RunSupervisor } from "../../src/supervisor/service.js";
import { EventTailer, _setEventBoundsForTests } from "../../src/webapi/events.js";
import { _MAX_CONTROL_BODY_BYTES, startWebServer, type WebServerHandle } from "../../src/webapi/server.js";

const tempRoots: string[] = [];
const servers: WebServerHandle[] = [];

function tmpDir(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hardening-"));
  tempRoots.push(target);
  return target;
}

async function serve(options: Record<string, unknown>): Promise<WebServerHandle> {
  const handle = await startWebServer({ host: "127.0.0.1", port: 0, staticDir: null, ...options } as never);
  servers.push(handle);
  return handle;
}

after(async () => {
  for (const handle of servers) await handle.close();
  for (const target of tempRoots) fs.rmSync(target, { recursive: true, force: true });
});

function runFixture(tmp: string): { root: string; state: DashboardState } {
  const root = path.join(tmp, "runs");
  const run = path.join(root, "run-1");
  const role = path.join(run, "logs", "role_management");
  fs.mkdirSync(path.join(role, "rounds", "round_001"), { recursive: true });
  fs.writeFileSync(
    path.join(role, "events.jsonl"),
    `${JSON.stringify({ event: "role_harness_start", ts: 1 })}\n`,
    "utf-8",
  );
  return { root, state: new DashboardState(path.join(run, "logs"), { runsRoot: root, controlEnabled: true }) };
}


/** `fetch` forbids a custom Host header, so DNS-rebind cases use node:http. */
function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function wsAuthProtocols(token: string): string[] {
  const encoded = Buffer.from(token, "utf-8").toString("base64url");
  return ["lh-harness-auth.v1", `lh-harness-token.${encoded}`];
}

type TestSocket = {
  socket: WebSocket;
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  accepted: string | null;
};

function openSocket(url: string, protocols?: string[]): Promise<TestSocket> {
  const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
  const queue: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  socket.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString("utf-8")) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  const next = (timeoutMs = 5000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const buffered = queue.shift();
      if (buffered) {
        resolve(buffered);
        return;
      }
      const timer = setTimeout(() => reject(new Error("timed out waiting for a WebSocket frame")), timeoutMs);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, next, accepted: socket.protocol || null }));
    socket.once("error", reject);
  });
}

/** Resolve with the close code a rejected handshake reports. */
function closeCode(url: string, protocols?: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("timed out waiting for a close")), 5000);
    socket.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.once("error", () => undefined);
  });
}

test("event tail is absolute and bad records are diagnostic", () => {
  const target = path.join(tmpDir(), "events.jsonl");
  const lines: string[] = [];
  for (let index = 0; index < 250; index += 1) {
    lines.push(JSON.stringify({ event: "manager_round_done", round: index + 1 }));
  }
  lines.push(JSON.stringify({ schema_version: "bad", event: "broken" }));
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");

  const tailer = new EventTailer(target, { run_id: "run-1" });
  const items = tailer.read({ limit: 200 });
  assert.equal(items[0].event_id, "run-1:000051");
  assert.equal(items[items.length - 1].event_id, "run-1:000250");
  assert.ok(tailer.last_warnings.some((warning) => warning.includes("schema_version")));

  const replay = tailer.read({ after: "run-1:000001", limit: 500 });
  assert.equal(replay[0].event_id, "run-1:000002");
  const contiguous = tailer.read({ after: "run-1:000001", limit: 2 });
  assert.deepEqual(contiguous.map((item) => item.event_id), ["run-1:000002", "run-1:000003"]);
  tailer.read({ after: "run-1:999999" });
  assert.equal(tailer.last_cursor_gap, true);
  assert.equal(tailer.last_resync_required, true);
});

test("event tail rejects symlink and hardlink aliases", () => {
  const tmp = tmpDir();
  const outside = path.join(tmp, "outside-events.jsonl");
  fs.writeFileSync(outside, `${JSON.stringify({ event: "secret" })}\n`, "utf-8");
  const link = path.join(tmp, "events.jsonl");
  fs.symlinkSync(outside, link);
  assert.deepEqual(new EventTailer(link, { run_id: "run-1" }).read(), []);

  fs.unlinkSync(link);
  fs.linkSync(outside, link);
  assert.deepEqual(new EventTailer(link, { run_id: "run-1" }).read(), []);
});

test("event tail rejects foreign run identity and duplicate cursors", () => {
  const target = path.join(tmpDir(), "events.jsonl");
  const records = [
    { event_id: "run-1:000001", run_id: "run-1", event: "role_harness_start" },
    // Neither an explicit foreign run id nor a foreign cursor may cross the
    // stream boundary selected by the API route.
    { event_id: "run-2:000002", run_id: "run-2", event: "role_harness_done" },
    { event_id: "run-2:000003", event: "role_harness_done" },
    // Duplicate ids make replay ambiguous.  The earliest record wins.
    { event_id: "run-1:000001", event: "role_harness_done" },
    { event_id: "run-1:000005", event: "manager_round_done", round: 1 },
  ];
  fs.writeFileSync(target, records.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf-8");

  const tailer = new EventTailer(target, { run_id: "run-1" });
  const items = tailer.read({ limit: 20 });

  assert.deepEqual(items.map((item) => item.event_id), ["run-1:000001", "run-1:000005"]);
  assert.ok(items.every((item) => item.run_id === "run-1"));
  assert.ok(tailer.last_warnings.some((warning) => warning.includes("run_id does not match")));
  assert.ok(tailer.last_warnings.some((warning) => warning.includes("does not belong")));
  assert.ok(tailer.last_warnings.some((warning) => warning.includes("duplicate event_id")));
});

test("event tail is byte bounded and uses stable offset ids", () => {
  const previous = _setEventBoundsForTests({ maxLogBytes: 180 });
  try {
    const target = path.join(tmpDir(), "events.jsonl");
    let payload = "";
    for (let index = 1; index < 20; index += 1) {
      payload += `${JSON.stringify({
        schema_version: 1,
        event_id: `run-1:${String(index).padStart(6, "0")}`,
        event: "manager_round_done",
        round: index,
      })}\n`;
    }
    // A legacy record without an id exercises the offset-based fallback used
    // once the head of the file is outside the retention window.
    payload += `${JSON.stringify({ event: "manager_round_start", round: 20 })}\n`;
    fs.writeFileSync(target, payload, "utf-8");

    const tailer = new EventTailer(target, { run_id: "run-1" });
    const items = tailer.read({ limit: 20 });

    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.offset !== null));
    assert.ok(items.some((item) => item.event_id.startsWith("run-1:offset-")));
    assert.ok(tailer.last_warnings.some((warning) => warning.includes("exceeds")));

    // A cursor from the discarded head must force a snapshot resync.
    tailer.read({ after: "run-1:000001" });
    assert.equal(tailer.last_resync_required, true);
  } finally {
    _setEventBoundsForTests(previous);
  }
});

test("api auth and websocket origin are enforced", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1", authToken: "secret" });
  const wsBase = handle.url.replace("http://", "ws://");

  const unauthorized = await fetch(`${handle.url}api/meta`);
  await unauthorized.text();
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

  const authorized = await fetch(`${handle.url}api/meta`, { headers: { Authorization: "Bearer secret" } });
  await authorized.text();
  assert.equal(authorized.status, 200);

  assert.equal(
    await closeCode(`${wsBase}api/runs/run-1/stream?replay=0&token=secret`, undefined),
    4401,
  );
  // The long-lived token must not be accepted from a query string.
  const evilOrigin = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}api/runs/run-1/stream?replay=0`, wsAuthProtocols("secret"), {
      headers: { Origin: "https://evil.example" },
    });
    const timer = setTimeout(() => reject(new Error("timed out")), 5000);
    socket.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.once("error", () => undefined);
  });
  assert.equal(evilOrigin, 4403);

  const { socket, next, accepted } = await openSocket(
    `${wsBase}api/runs/run-1/stream?replay=0`,
    wsAuthProtocols("secret"),
  );
  try {
    assert.equal((await next()).kind, "snapshot");
    assert.equal(accepted, "lh-harness-auth.v1");
  } finally {
    socket.close();
  }
});

test("a multi-run registry does not create a phantom local run", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const handle = await serve({ state, runsRoot: root });

  const response = await fetch(`${handle.url}api/runs/local/snapshot`);
  await response.text();

  assert.equal(response.status, 404);
  assert.ok(!fs.existsSync(path.join(root, "local", "control")));
});

test("html artifacts are attachments", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const target = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001", "proof.html");
  fs.writeFileSync(target, "<script>alert(1)</script>", "utf-8");
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const response = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/proof.html/raw`);
  await response.text();

  assert.equal(response.status, 200);
  assert.ok((response.headers.get("content-type") || "").startsWith("text/plain"));
  assert.ok((response.headers.get("content-disposition") || "").startsWith("attachment;"));
});

test("non-raster documents are attachments and the filename is header safe", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const roundDir = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001");
  // The filesystem permits both quote-bearing and non-ASCII names.  They must
  // not corrupt the response header or alter its disposition semantics.
  fs.writeFileSync(path.join(roundDir, 'x";foo.pdf'), Buffer.from("%PDF-fixture"));
  fs.writeFileSync(path.join(roundDir, "günaydın.svgz"), Buffer.from("not-an-inline-document"));
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const pdf = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/x%22%3Bfoo.pdf/raw`);
  await pdf.text();
  const svgz = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/g%C3%BCnayd%C4%B1n.svgz/raw`);
  await svgz.text();

  assert.equal(pdf.status, 200);
  assert.ok((pdf.headers.get("content-type") || "").startsWith("application/octet-stream"));
  assert.ok(
    (pdf.headers.get("content-disposition") || "").startsWith('attachment; filename="x_foo.pdf"; filename*=UTF-8\'\''),
  );
  assert.equal(svgz.status, 200);
  assert.ok((svgz.headers.get("content-type") || "").startsWith("text/plain"));
  assert.ok(
    (svgz.headers.get("content-disposition") || "").startsWith(
      'attachment; filename="g_nayd_n.svgz"; filename*=UTF-8\'\'',
    ),
  );
});

test("an artifact query token is not an authentication fallback", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const target = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001", "proof.txt");
  fs.writeFileSync(target, "private", "utf-8");
  const handle = await serve({ state, runsRoot: root, runId: "run-1", authToken: "secret" });

  const response = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/proof.txt/raw?token=secret`);
  await response.text();

  assert.equal(response.status, 401);
});

test("an artifact round symlink cannot escape the log root", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "not for the dashboard", "utf-8");
  const rounds = path.join(root, "run-1", "logs", "role_management", "rounds");
  fs.rmdirSync(path.join(rounds, "round_001"));
  fs.symlinkSync(outside, path.join(rounds, "round_001"), "dir");
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const listed = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts`);
  const body = await listed.json();
  assert.equal(listed.status, 200);
  assert.deepEqual(body.artifacts, []);

  const secret = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/secret.txt`);
  await secret.text();
  assert.equal(secret.status, 404);
});

test("a run symlink cannot escape the runs root or a cached state", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(outside, "logs", "role_management"), { recursive: true });
  fs.writeFileSync(
    path.join(outside, "logs", "report.json"),
    JSON.stringify({ task: "SECRET_OUTSIDE", status: "complete" }),
    "utf-8",
  );
  fs.symlinkSync(outside, path.join(root, "evil"), "dir");
  const handle = await serve({ state, runsRoot: root });

  const runs = await (await fetch(`${handle.url}api/runs`)).json();
  assert.ok(runs.runs.every((item: any) => item.id !== "evil"));
  const evil = await fetch(`${handle.url}api/runs/evil/snapshot`);
  await evil.text();
  assert.equal(evil.status, 404);
  const ours = await fetch(`${handle.url}api/runs/run-1/snapshot`);
  const text = await ours.text();
  assert.equal(ours.status, 200);
  assert.ok(!text.includes("SECRET_OUTSIDE"));
});

for (const targetInsideRoot of [true, false]) {
  test(`a logs symlink cannot cross a run (inside root: ${targetInsideRoot})`, async () => {
    const tmp = tmpDir();
    const { root, state } = runFixture(tmp);
    const siblingLogs = path.join(root, "run-2", "logs", "role_management");
    fs.mkdirSync(siblingLogs, { recursive: true });
    fs.writeFileSync(
      path.join(siblingLogs, "report.json"),
      JSON.stringify({ task: "SECRET_SIBLING", status: "complete" }),
      "utf-8",
    );
    const outsideLogs = path.join(tmp, "outside", "logs", "role_management");
    fs.mkdirSync(outsideLogs, { recursive: true });
    fs.writeFileSync(
      path.join(outsideLogs, "report.json"),
      JSON.stringify({ task: "SECRET_EXTERNAL", status: "complete" }),
      "utf-8",
    );
    const target = targetInsideRoot ? path.dirname(siblingLogs) : path.dirname(outsideLogs);
    const originalLogs = path.join(root, "run-1", "logs");
    fs.rmSync(originalLogs, { recursive: true, force: true });
    fs.symlinkSync(target, originalLogs, "dir");

    // The state was cached before the swap.  Registry validation must still
    // reject it rather than trusting the old DashboardState object.
    const handle = await serve({ state, runsRoot: root, runId: "run-1" });
    const snapshot = await fetch(`${handle.url}api/runs/run-1/snapshot`);
    const text = await snapshot.text();
    assert.equal(snapshot.status, 404);
    assert.ok(!text.includes("SECRET_"));
    const runs = await (await fetch(`${handle.url}api/runs`)).json();
    assert.ok(runs.runs.every((item: any) => item.id !== "run-1"));

    const browserState = new DashboardState(null, { runsRoot: root });
    assert.equal(browserState.selectRun("run-1"), false);
  });
}

test("artifact and trajectory final symlinks are not followed", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const roundDir = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001");
  const outside = path.join(tmp, "outside-files");
  fs.mkdirSync(outside);
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "must stay private", "utf-8");
  fs.symlinkSync(secret, path.join(roundDir, "secret.txt"));
  fs.symlinkSync(secret, path.join(roundDir, "manager_raw_trajectory.jsonl"));
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  for (const target of [
    "api/runs/run-1/rounds/1/artifacts/secret.txt",
    "api/runs/run-1/rounds/1/artifacts/secret.txt/raw",
    "api/runs/run-1/rounds/1/trajectory/manager",
  ]) {
    const response = await fetch(`${handle.url}${target}`);
    await response.text();
    assert.equal(response.status, 404, target);
  }
});

for (const child of ["role_management", "rounds"]) {
  test(`the run registry rejects a nested ${child} boundary symlink`, async () => {
    const tmp = tmpDir();
    const { root, state } = runFixture(tmp);
    const role = path.join(root, "run-1", "logs", "role_management");
    if (child === "role_management") {
      const real = path.join(tmp, "real-role");
      fs.mkdirSync(real);
      fs.rmSync(role, { recursive: true, force: true });
      fs.symlinkSync(real, role, "dir");
    } else {
      const rounds = path.join(role, "rounds");
      const real = path.join(tmp, "real-rounds");
      fs.mkdirSync(real);
      fs.rmSync(rounds, { recursive: true, force: true });
      fs.symlinkSync(real, rounds, "dir");
    }
    const handle = await serve({ state, runsRoot: root, runId: "run-1" });

    const snapshot = await fetch(`${handle.url}api/runs/run-1/snapshot`);
    await snapshot.text();
    assert.equal(snapshot.status, 404);
    const runs = await (await fetch(`${handle.url}api/runs`)).json();
    assert.ok(runs.runs.every((item: any) => item.id !== "run-1"));
    assert.equal(new DashboardState(null, { runsRoot: root }).selectRun("run-1"), false);
  });
}

test("create run rejects float rounds and enforces the ceiling", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const supervisor = new RunSupervisor(root, { workspaceRoot: path.join(tmp, "workspace") });
  const handle = await serve({ state, runsRoot: root, supervisor });

  const float = await fetch(`${handle.url}api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "x", max_rounds: 1.5 }),
  });
  await float.text();
  assert.equal(float.status, 422);

  const ceiling = await fetch(`${handle.url}api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "x", max_rounds: 1001 }),
  });
  await ceiling.text();
  assert.equal(ceiling.status, 422);
});

test("control revision rejects lossy numeric forms", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  for (const value of [1.5, true, "1.5", "1e0", ""]) {
    const response = await fetch(`${handle.url}api/runs/run-1/instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "note", expected_revision: value }),
    });
    await response.text();
    assert.equal(response.status, 422, String(value));
  }
});

test("websocket resync gap advances to the retained tail", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const eventsPath = path.join(root, "run-1", "logs", "role_management", "events.jsonl");
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  // Starting from the known first event makes the cursor deterministic.
  const { socket, next } = await openSocket(
    `${handle.url.replace("http://", "ws://")}api/runs/run-1/stream?replay=0&after=run-1%3A000001`,
  );
  try {
    assert.equal((await next()).kind, "snapshot");
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({
        schema_version: 1,
        event_id: "run-1:000003",
        event: "manager_round_done",
        round_index: 1,
      })}\n`,
      "utf-8",
    );
    assert.equal((await next()).kind, "resync_required");
    assert.equal((await next()).kind, "snapshot");

    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({ schema_version: 1, event_id: "run-1:000004", event: "role_harness_done" })}\n`,
      "utf-8",
    );

    const observed: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const message = await next();
      if (message.kind === "event") {
        observed.push(String((message.data as any).event_id));
        if (observed.includes("run-1:000004")) break;
      }
    }
    assert.ok(observed.includes("run-1:000004"));
  } finally {
    socket.close();
  }
});

test("an attached api rejects foreign run paths", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  fs.mkdirSync(path.join(root, "run-2", "logs", "role_management"), { recursive: true });
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const supervisor = new RunSupervisor(root, { workspaceRoot: workspace, attachedOnly: true });
  supervisor.attachRun({ run_id: "run-1", pid: process.pid, workspace });
  const handle = await serve({ state, runsRoot: root, runId: "run-1", supervisor });

  const snapshot = await fetch(`${handle.url}api/runs/run-2/snapshot`);
  await snapshot.text();
  assert.equal(snapshot.status, 404);
  const stop = await fetch(`${handle.url}api/runs/run-2/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await stop.text();
  assert.equal(stop.status, 404);
});

test("the loopback host header rejects DNS rebinding", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const cases: [string | undefined, number][] = [
    [undefined, 200],
    ["127.0.0.1:8799", 200],
    ["localhost", 200],
    ["[::1]:8799", 200],
    ["evil.example", 403],
    ["evil.example:8799", 403],
  ];
  for (const [host, expected] of cases) {
    const response = await rawRequest(`${handle.url}api/meta`, { headers: host ? { Host: host } : {} });
    assert.equal(response.status, expected, String(host));
  }

  const injected = await rawRequest(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "evil.example" },
    body: JSON.stringify({ instructions: "injected" }),
  });
  assert.equal(injected.status, 403);
});

test("control posts require json and a bounded body", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const plain = await fetch(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: '{"instructions":"keep going"}',
  });
  await plain.text();
  assert.equal(plain.status, 415);

  const form = await fetch(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    body: new URLSearchParams({ instructions: "keep going" }),
  });
  await form.text();
  assert.equal(form.status, 415);

  const empty = await fetch(`${handle.url}api/runs/run-1/stop`, { method: "POST", body: "" });
  await empty.text();
  assert.equal(empty.status, 415);

  const accepted = await fetch(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: '{"instructions":"keep going"}',
  });
  await accepted.text();
  assert.equal(accepted.status, 200);

  const oversized = await fetch(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(_MAX_CONTROL_BODY_BYTES + 1),
    },
    body: "x".repeat(_MAX_CONTROL_BODY_BYTES + 1),
  });
  await oversized.text();
  assert.equal(oversized.status, 413);
});

test("bearer and non-loopback host behaviour", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const loopback = await serve({ state, runsRoot: root, runId: "run-1", authToken: "secret" });

  const anonymous = await rawRequest(`${loopback.url}api/meta`);
  assert.equal(anonymous.status, 401);

  const bearer = await rawRequest(`${loopback.url}api/meta`, { headers: { Authorization: "Bearer secret" } });
  assert.equal(bearer.status, 200);

  const rebind = await rawRequest(`${loopback.url}api/meta`, {
    headers: { Authorization: "Bearer secret", Host: "evil.example" },
  });
  assert.equal(rebind.status, 403);

  const exposed = await serve({
    state,
    runsRoot: root,
    runId: "run-1",
    authToken: "secret",
    bindHost: "0.0.0.0",
    host: "127.0.0.1",
  });
  const exposedAnonymous = await rawRequest(`${exposed.url}api/meta`, { headers: { Host: "evil.example" } });
  assert.equal(exposedAnonymous.status, 401);
  const exposedBearer = await rawRequest(`${exposed.url}api/meta`, {
    headers: { Authorization: "Bearer secret", Host: "lan.example:8799" },
  });
  assert.equal(exposedBearer.status, 200);
});

test("the control body limit stops an undeclared chunked stream early", async () => {
  const tmp = tmpDir();
  const { root, state } = runFixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });
  const target = new URL(`${handle.url}api/models/refresh`);

  let settled = false;
  const request = http.request({
    host: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    // No Content-Length: the cap must trip mid-stream, not from the header.
    headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
  });
  const status = await new Promise<number>((resolve, reject) => {
    request.on("response", (response) => {
      response.resume();
      response.on("end", () => {
        settled = true;
        resolve(response.statusCode ?? 0);
      });
    });
    // The server closes the connection once the cap trips; a write that was
    // still in flight then fails with EPIPE/ECONNRESET, which is the point.
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    const chunk = "x".repeat(256 * 1024);
    for (let index = 0; index < 10; index += 1) request.write(chunk);
    request.end();
  });
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(status, 413);
});
