// Ported 1:1 from LongHorizon-Harness tests/webapi/test_webapi.py

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { DashboardState } from "../../src/dashboard/state.js";
import { ControlBus } from "../../src/supervisor/control_bus.js";
import { EventTailer, normalizeEvent } from "../../src/webapi/events.js";
import { startWebServer, type WebServerHandle } from "../../src/webapi/server.js";
import { buildSnapshot } from "../../src/webapi/snapshot.js";

const tempRoots: string[] = [];
const servers: WebServerHandle[] = [];

function tmpDir(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "lh-webapi-"));
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

function fixture(tmp: string, controlEnabled = true): { root: string; state: DashboardState } {
  const root = path.join(tmp, "runs");
  const run = path.join(root, "run-1");
  const roleDir = path.join(run, "logs", "role_management");
  const roundDir = path.join(roleDir, "rounds", "round_001");
  fs.mkdirSync(roundDir, { recursive: true });
  fs.writeFileSync(path.join(run, "logs", "report.json"), JSON.stringify({ task: "fixture" }), "utf-8");
  fs.writeFileSync(
    path.join(roleDir, "events.jsonl"),
    `${[
      JSON.stringify({ ts: 1, event: "role_harness_start" }),
      JSON.stringify({ ts: 2, event: "manager_round_start", round_index: 1 }),
    ].join("\n")}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(roundDir, "manager_plan.txt"), "next_step: execute", "utf-8");
  fs.writeFileSync(path.join(roundDir, "task_state.txt"), "fixture state", "utf-8");
  fs.writeFileSync(path.join(roundDir, "screenshot.png"), Buffer.from("\x89PNG\r\nfixture-image", "latin1"));
  return { root, state: new DashboardState(path.join(run, "logs"), { runsRoot: root, controlEnabled }) };
}

type TestSocket = { socket: WebSocket; next(timeoutMs?: number): Promise<Record<string, unknown>> };

/** Buffer frames from construction: `ws` can emit them in the same tick as `open`. */
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
    socket.once("open", () => resolve({ socket, next }));
    socket.once("error", reject);
  });
}

test("event normalization and partial tail", () => {
  const event = normalizeEvent({ ts: 1, event: "manager_round_start", round_index: 3 }, {
    run_id: "run-1",
    sequence: 7,
  });
  assert.equal(event.event_id, "run-1:000007");
  assert.equal(event.type, "round.manager.started");
  assert.equal(event.round, 3);
  assert.equal(event.status, "running");

  const reply = normalizeEvent({ ts: 2, event: "final_response_done", round: 3 }, { run_id: "run-1", sequence: 8 });
  assert.equal(reply.type, "round.final_response.completed");
  assert.equal(reply.role, "final_response");
  assert.equal(reply.status, "completed");

  const legacyEpisodeStatus = { status: "done", duration_ms: 42, exit_code: 0 };
  const legacyDone = normalizeEvent(
    { ts: 3, event: "manager_round_done", round: 3, status: legacyEpisodeStatus },
    { run_id: "run-1", sequence: 9 },
  );
  assert.equal(legacyDone.status, "completed");
  assert.deepEqual(legacyDone.payload.episode_status, legacyEpisodeStatus);

  const target = path.join(tmpDir(), "events.jsonl");
  fs.writeFileSync(
    target,
    `${JSON.stringify({ ts: 1, event: "role_harness_start" })}\n${JSON.stringify({
      ts: 2,
      event: "manager_round_start",
    })}`,
    "utf-8",
  );
  const tailer = new EventTailer(target, { run_id: "run-1" });
  assert.deepEqual(tailer.read().map((item) => item.event_id), ["run-1:000001"]);
  fs.appendFileSync(target, "\n", "utf-8");
  assert.deepEqual(tailer.read().map((item) => item.event_id), ["run-1:000001", "run-1:000002"]);
});

test("api resolves normalized screenshot file reference", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const roundDir = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001");
  fs.writeFileSync(path.join(roundDir, "executor_raw_trajectory.jsonl"), "{}\n", "utf-8");
  fs.writeFileSync(path.join(roundDir, "executor_step_0001_01.png"), Buffer.from("\x89PNG\r\nnormalized", "latin1"));
  fs.writeFileSync(
    path.join(roundDir, "executor_trajectory.jsonl"),
    `${JSON.stringify({
      step_num: 1,
      kind: "tool_result",
      text: "[image]",
      has_image: true,
      screenshot_file: "executor_step_0001_01.png",
    })}\n`,
    "utf-8",
  );
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const response = await fetch(`${handle.url}api/runs/run-1/rounds/1/trajectory/executor`);
  const text = await response.text();

  assert.equal(response.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.trajectory_source, "normalized");
  assert.deepEqual(body.steps[0].images, ["/api/runs/run-1/rounds/1/artifacts/executor_step_0001_01.png/raw"]);
  assert.ok(!text.includes("data:image"));
});

test("completed snapshot clears active round and exposes completion evidence", () => {
  const tmp = tmpDir();
  const root = path.join(tmp, "runs");
  const run = path.join(root, "run-1");
  const roleDir = path.join(run, "logs", "role_management");
  const roundDir = path.join(roleDir, "rounds", "round_001");
  fs.mkdirSync(roundDir, { recursive: true });
  const report = {
    status: "complete",
    task: "fixture complete",
    completion_satisfied: true,
    completion_authority: "manager_with_role_auditors",
    exit_code: 0,
    final_response: "The requested change is complete.",
  };
  fs.writeFileSync(path.join(run, "logs", "report.json"), JSON.stringify(report), "utf-8");
  fs.writeFileSync(
    path.join(roleDir, "events.jsonl"),
    `${JSON.stringify({ event: "manager_round_start", round_index: 1, active_role: "manager" })}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(roundDir, "manager_plan.txt"), "next_step: done", "utf-8");
  fs.writeFileSync(path.join(roundDir, "final_response.txt"), "The requested change is complete.", "utf-8");
  const state = new DashboardState(path.join(run, "logs"), { runsRoot: root, controlEnabled: false });

  const snapshot = buildSnapshot(state, { run_id: "run-1" }) as Record<string, any>;

  assert.equal(snapshot.run.status, "completed");
  assert.equal(snapshot.run.completion_satisfied, true);
  assert.equal(snapshot.run.completion_authority, "manager_with_role_auditors");
  assert.equal(snapshot.run.exit_code, 0);
  assert.equal(snapshot.run.final_response, "The requested change is complete.");
  assert.equal(snapshot.rounds[0].final_response, "The requested change is complete.");
  assert.equal(snapshot.active_round, null);
  assert.equal(snapshot.active_role, null);
});

test("active snapshot uses supervisor owner task before the first report", () => {
  const tmp = tmpDir();
  const root = path.join(tmp, "runs");
  const run = path.join(root, "run-1");
  const roleDir = path.join(run, "logs", "role_management");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(
    path.join(roleDir, "events.jsonl"),
    `${JSON.stringify({ event: "role_harness_start" })}\n`,
    "utf-8",
  );
  new ControlBus(run).writeOwner({ run_id: "run-1", task: "owner task while active" });
  const state = new DashboardState(path.join(run, "logs"), { runsRoot: root, controlEnabled: true });

  const snapshot = buildSnapshot(state, { run_id: "run-1" }) as Record<string, any>;

  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.mission.task, "owner task while active");
});

test("svg artifacts are text attachments, not image documents", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const svg = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001", "proof.svg");
  fs.writeFileSync(svg, "<svg><script>window.pwned=true</script></svg>", "utf-8");
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const raw = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/proof.svg/raw`);
  await raw.text();

  assert.equal(raw.status, 200);
  assert.ok((raw.headers.get("content-type") || "").startsWith("text/plain"));
  assert.ok((raw.headers.get("content-disposition") || "").startsWith("attachment;"));
});

test("legacy static dashboard routes are not registered", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  for (const legacy of ["api/state", "api/round/1", "api/round/1/manager_plan.txt"]) {
    const response = await fetch(`${handle.url}${legacy}`);
    await response.text();
    assert.equal(response.status, 404, legacy);
  }
  const inject = await fetch(`${handle.url}api/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await inject.text();
  assert.equal(inject.status, 404);
});

test("dashboard javascript asset keeps a valid MIME type", async () => {
  const tmp = tmpDir();
  const staticDir = path.join(tmp, "dist");
  fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(staticDir, "assets", "index.js"), "document.body.dataset.loaded = 'yes';", "utf-8");
  fs.writeFileSync(path.join(staticDir, "index.html"), '<div id="root"></div>', "utf-8");
  const handle = await serve({ logDir: path.join(tmp, "logs"), staticDir });

  const response = await fetch(`${handle.url}assets/index.js`);
  await response.text();

  assert.equal(response.status, 200);
  assert.equal((response.headers.get("content-type") || "").split(";", 1)[0], "application/javascript");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const page = await fetch(handle.url);
  assert.ok((await page.text()).includes('<div id="root"></div>'));
});

test("api snapshot, replay, artifacts, instructions and approvals round-trip", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const approval = state.createApproval({ title: "Continue fixture", message: "Proceed?" });

  const meta = await fetch(`${handle.url}api/meta`);
  const metaBody = await meta.json();
  assert.equal(meta.status, 200);
  assert.equal(metaBody.protocol_version, "1");

  const snapshot = await (await fetch(`${handle.url}api/runs/run-1/snapshot`)).json();
  assert.equal(snapshot.run.status, "waiting_approval");
  assert.equal(snapshot.active_round, 1);
  assert.deepEqual(snapshot.controls, { can_inject: true, can_abort: false, can_resume: false });

  const events = (await (await fetch(`${handle.url}api/runs/run-1/events?limit=20`)).json()).events;
  assert.deepEqual(events.map((item: any) => item.type), ["run.started", "round.manager.started"]);
  const replay = (
    await (await fetch(`${handle.url}api/runs/run-1/events?after=${encodeURIComponent(events[0].event_id)}`)).json()
  ).events;
  assert.deepEqual(replay.map((item: any) => item.event_id), [events[1].event_id]);

  const artifact = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/manager_plan.txt`);
  assert.equal(artifact.status, 200);
  assert.ok((await artifact.text()).includes("execute"));

  const image = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/screenshot.png/raw`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Buffer.from(await image.arrayBuffer()),
    Buffer.from("\x89PNG\r\nfixture-image", "latin1"),
  );

  const traversalRaw = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/%2E%2E/screenshot.png/raw`);
  await traversalRaw.text();
  assert.ok([404, 422].includes(traversalRaw.status));
  const traversalText = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/%2E%2E`);
  await traversalText.text();
  assert.ok([404, 422].includes(traversalText.status));

  const queued = await fetch(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instructions: "keep going" }),
  });
  await queued.text();
  assert.equal(queued.status, 200);
  assert.deepEqual(state.listInjections(), ["keep going"]);

  const queuedSnapshot = await (await fetch(`${handle.url}api/runs/run-1/snapshot`)).json();
  assert.equal(queuedSnapshot.operator_messages[0].text, "keep going");
  assert.equal(queuedSnapshot.operator_messages[0].status, "queued");

  state.drainInjections();
  const appliedSnapshot = await (await fetch(`${handle.url}api/runs/run-1/snapshot`)).json();
  assert.equal(appliedSnapshot.operator_messages[0].text, "keep going");
  assert.equal(appliedSnapshot.operator_messages[0].status, "applied");

  const resolved = await fetch(`${handle.url}api/runs/run-1/approvals/${approval.approval_id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "continue" }),
  });
  await resolved.text();
  assert.equal(resolved.status, 200);
  assert.equal(state.getApproval(approval.approval_id)?.status, "resolved");
});

test("api serves binary artifacts inline", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const screenshot = Buffer.from("\x89PNG\r\n\x1a\n\x00binary-screenshot", "latin1");
  const roundDir = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001");
  fs.writeFileSync(path.join(roundDir, "screenshot.png"), screenshot);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const artifact = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/screenshot.png/raw`);

  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("content-type"), "image/png");
  assert.ok((artifact.headers.get("content-disposition") || "").startsWith("inline;"));
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), screenshot);

  const traversal = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/%2E%2E/raw`);
  await traversal.text();
  assert.equal(traversal.status, 404);
});

test("api does not execute html artifacts", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const html = path.join(root, "run-1", "logs", "role_management", "rounds", "round_001", "result.html");
  fs.writeFileSync(html, "<script>window.pwned = true</script>", "utf-8");
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const raw = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/result.html/raw`);
  await raw.text();
  const text = await fetch(`${handle.url}api/runs/run-1/rounds/1/artifacts/result.html`);
  await text.text();

  assert.equal(raw.status, 200);
  assert.ok((raw.headers.get("content-type") || "").startsWith("text/plain"));
  assert.ok((raw.headers.get("content-disposition") || "").startsWith("attachment;"));
  assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
  assert.ok((raw.headers.get("content-security-policy") || "").includes("sandbox"));
  assert.ok((text.headers.get("content-type") || "").startsWith("text/plain"));
  assert.equal(text.headers.get("x-content-type-options"), "nosniff");
});

test("an approval cannot be queued twice", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });
  const approval = state.createApproval({ title: "Continue fixture" });

  const first = await fetch(`${handle.url}api/runs/run-1/approvals/${approval.approval_id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "approval-1" },
    body: JSON.stringify({ action: "continue" }),
  });
  await first.text();
  const second = await fetch(`${handle.url}api/runs/run-1/approvals/${approval.approval_id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "approval-2" },
    body: JSON.stringify({ action: "continue" }),
  });
  await second.text();

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(state.control_bus.commands().length, 1);
});

test("an invalid durable approval command is rejected without crashing", () => {
  const tmp = tmpDir();
  const { state } = fixture(tmp);
  const approval = state.createApproval({ title: "Continue fixture" });
  state.control_bus.append(
    "resolve_approval",
    { approval_id: approval.approval_id, action: "not-an-option" },
    { createdBy: "operator", commandId: "invalid-approval" },
  );

  const current = state.getApproval(approval.approval_id);

  assert.ok(current !== null);
  assert.equal(current?.status, "pending");
  const receipt = state.control_bus.receiptFor("invalid-approval");
  assert.ok(receipt !== null);
  assert.equal(receipt?.status, "rejected");
  assert.equal(receipt?.message, "invalid approval response");
});

test("an instruction idempotency key conflict is not silently replayed", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const first = await fetch(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "instruction-1" },
    body: JSON.stringify({ instructions: "first" }),
  });
  await first.text();
  const conflicting = await fetch(`${handle.url}api/runs/run-1/instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "instruction-1" },
    body: JSON.stringify({ instructions: "different" }),
  });
  await conflicting.text();

  assert.equal(first.status, 200);
  assert.equal(conflicting.status, 409);
  assert.deepEqual(state.listInjections(), ["first"]);
});

test("websocket starts with a snapshot and replay", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });
  const { socket, next } = await openSocket(`${handle.url.replace("http://", "ws://")}api/runs/run-1/stream?replay=2`);
  try {
    assert.equal((await next()).kind, "snapshot");
    const first = await next();
    const second = await next();
    assert.equal(first.kind, "event");
    assert.equal(second.kind, "event");
    assert.notEqual((first.data as any).event_id, (second.data as any).event_id);

    const eventsPath = path.join(root, "run-1", "logs", "role_management", "events.jsonl");
    setTimeout(() => {
      fs.appendFileSync(
        eventsPath,
        `${JSON.stringify({ ts: 3, event: "manager_round_done", round_index: 1 })}\n`,
        "utf-8",
      );
    }, 100);
    const liveEvent = await next();
    const liveSnapshot = await next();
    assert.equal(liveEvent.kind, "event");
    assert.equal((liveEvent.data as any).type, "round.manager.completed");
    assert.equal(liveSnapshot.kind, "snapshot");
  } finally {
    socket.close();
  }
});

test("websocket publishes operator messages without role events", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });
  const { socket, next } = await openSocket(`${handle.url.replace("http://", "ws://")}api/runs/run-1/stream?replay=0`);
  try {
    assert.equal((await next()).kind, "snapshot");
    setTimeout(() => {
      state.addInjection("Show this immediately", { command_id: "instruction-live" });
    }, 100);
    const update = await next();
    assert.equal(update.kind, "snapshot");
    const messages = (update.data as any).operator_messages;
    assert.equal(messages[0].id, "instruction-live");
    assert.equal(messages[0].text, "Show this immediately");
    assert.equal(messages[0].status, "queued");
  } finally {
    socket.close();
  }
});

test("websocket publishes a resolved approval answer without role events", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const approval = state.createApproval({ title: "Choose an account", message: "A or B?" });
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });
  const { socket, next } = await openSocket(`${handle.url.replace("http://", "ws://")}api/runs/run-1/stream?replay=0`);
  try {
    assert.equal((await next()).kind, "snapshot");
    setTimeout(() => {
      assert.ok(
        state.resolveApproval(approval.approval_id, {
          action: "continue",
          user_input: "Account B",
          command_id: "approval-answer-live",
        }),
      );
      // Reading the approval applies the durable command, exactly like the
      // Python test's second `get_approval` call.
      state.getApproval(approval.approval_id);
    }, 100);
    const update = await next();
    assert.equal(update.kind, "snapshot");
    const resolved = (update.data as any).approvals.find(
      (item: any) => item.approval_id === approval.approval_id,
    );
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.action, "continue");
    assert.equal(resolved.user_input, "Account B");
  } finally {
    socket.close();
  }
});

test("the built web bundle is served at the root when present", async (t) => {
  const dist = fileURLToPath(new URL("../../frontend/web/dist/", import.meta.url));
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    t.skip("web bundle not built; run `npm run build --prefix frontend/web`");
    return;
  }
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1", staticDir: dist });

  const page = await fetch(handle.url);
  const text = await page.text();

  assert.equal(page.status, 200);
  assert.ok(text.includes('<div id="root"></div>'));
});
