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
  const logDir = path.join(run, "lh_harness");
  const roleDir = path.join(logDir, "role_orchestration");
  const stateDir = path.join(run, "state");
  const episode = path.join(logDir, "composer_episodes", "ep001");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.mkdirSync(episode, { recursive: true });
  fs.writeFileSync(path.join(logDir, "report.json"), JSON.stringify({ task: "fixture" }), "utf-8");
  fs.writeFileSync(
    path.join(roleDir, "events.jsonl"),
    `${[
      JSON.stringify({ ts: 1, event: "run_started" }),
      JSON.stringify({ ts: 2, event: "episode_started", role: "composer", round: 1 }),
    ].join("\n")}\n`,
    "utf-8",
  );
  writeState(stateDir, "task/TASK.md", "fixture task\n");
  writeState(
    stateDir,
    "phase.json",
    JSON.stringify({
      phase: "executing",
      current_subtask: "build-api",
      current_role: "composer",
      current_round: 1,
      updated_at: 2,
      detail: "",
    }),
  );
  writeState(
    stateDir,
    "plan/plan.json",
    JSON.stringify({
      schema_version: 1,
      title: "Fixture plan",
      nodes: [{ id: "build-api", title: "Build the API", goal: "expose /health", children: [], status: "composing" }],
      revision: 1,
    }),
  );
  writeState(stateDir, "progress/build-api.md", "next_step: execute");
  fs.writeFileSync(path.join(episode, "screenshot.png"), Buffer.from("\x89PNG\r\nfixture-image", "latin1"));
  return { root, state: new DashboardState(logDir, { runsRoot: root, controlEnabled }) };
}

/** `<run>/state/<relative>` — the loop's own state tree. */
function writeState(stateDir: string, relative: string, body: string): void {
  const target = path.join(stateDir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf-8");
}

/** The composer episode directory the fixture pre-creates. */
function episodeDir(root: string): string {
  return path.join(root, "run-1", "lh_harness", "composer_episodes", "ep001");
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
  const event = normalizeEvent({ ts: 1, event: "episode_started", role: "composer", round: 3 }, {
    run_id: "run-1",
    sequence: 7,
  });
  assert.equal(event.event_id, "run-1:000007");
  assert.equal(event.type, "episode.started");
  assert.equal(event.role, "composer");
  assert.equal(event.round, 3);
  assert.equal(event.status, "running");

  // An unmapped name still normalises through the `_start`/`_done` suffix rule.
  const reply = normalizeEvent({ ts: 2, event: "final_response_done", round: 3 }, { run_id: "run-1", sequence: 8 });
  assert.equal(reply.type, "final.response.completed");
  assert.equal(reply.status, "completed");

  const subtask = normalizeEvent({ ts: 3, event: "subtask_done", subtask_id: "build-api" }, {
    run_id: "run-1",
    sequence: 9,
  });
  assert.equal(subtask.type, "subtask.completed");
  assert.equal(subtask.payload.subtask_id, "build-api");

  const legacyEpisodeStatus = { status: "done", duration_ms: 42, exit_code: 0 };
  const legacyDone = normalizeEvent(
    { ts: 4, event: "episode_finished", role: "composer", round: 3, status: legacyEpisodeStatus },
    { run_id: "run-1", sequence: 10 },
  );
  assert.equal(legacyDone.status, "completed");
  assert.deepEqual(legacyDone.payload.episode_status, legacyEpisodeStatus);

  const target = path.join(tmpDir(), "events.jsonl");
  fs.writeFileSync(
    target,
    `${JSON.stringify({ ts: 1, event: "run_started" })}\n${JSON.stringify({
      ts: 2,
      event: "episode_started",
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
  const episode = episodeDir(root);
  fs.writeFileSync(path.join(episode, "composer_raw_trajectory.jsonl"), "{}\n", "utf-8");
  fs.writeFileSync(path.join(episode, "composer_step_0001_01.png"), Buffer.from("\x89PNG\r\nnormalized", "latin1"));
  fs.writeFileSync(
    path.join(episode, "composer_trajectory.jsonl"),
    `${JSON.stringify({
      step_num: 1,
      kind: "tool_result",
      text: "[image]",
      has_image: true,
      screenshot_file: "composer_step_0001_01.png",
    })}\n`,
    "utf-8",
  );
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const response = await fetch(`${handle.url}api/runs/run-1/episodes/composer/1/trajectory`);
  const text = await response.text();

  assert.equal(response.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.trajectory_source, "normalized");
  assert.deepEqual(body.steps[0].images, [
    "/api/runs/run-1/episodes/composer/1/artifacts/composer_step_0001_01.png/raw",
  ]);
  assert.ok(!text.includes("data:image"));
});

test("a completed snapshot clears the active subtask and exposes completion evidence", () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const logDir = path.join(root, "run-1", "lh_harness");
  const report = {
    schema_version: 3,
    status: "completed",
    task: "fixture complete",
    completion_satisfied: true,
    completion_authority: "evaluator_contracts",
    rounds_run: 2,
    max_rounds: 25,
    cost_usd: 1.25,
    exit_code: 0,
    final_response: "The requested change is complete.",
  };
  fs.writeFileSync(path.join(logDir, "report.json"), JSON.stringify(report), "utf-8");

  const snapshot = buildSnapshot(state, { run_id: "run-1" }) as Record<string, any>;

  assert.equal(snapshot.run.status, "completed");
  assert.equal(snapshot.run.completion_satisfied, true);
  assert.equal(snapshot.run.completion_authority, "evaluator_contracts");
  assert.equal(snapshot.run.report_status, "completed");
  assert.equal(snapshot.run.exit_code, 0);
  assert.equal(snapshot.run.rounds_run, 2);
  assert.equal(snapshot.run.cost_usd, 1.25);
  assert.equal(snapshot.run.final_response, "The requested change is complete.");
  // A terminal run has nothing in flight, whatever phase.json still says.
  assert.equal(snapshot.active_subtask, null);
  assert.equal(snapshot.active_role, null);
  // The loop projection is still published so the plan tree stays browsable.
  assert.equal(snapshot.loop.plan.title, "Fixture plan");
  assert.equal(snapshot.mission.plan_path, "plan/plan.json");
});

test("an active snapshot names the subtask and role in flight", () => {
  const tmp = tmpDir();
  const { state } = fixture(tmp);

  const snapshot = buildSnapshot(state, { run_id: "run-1" }) as Record<string, any>;

  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.active_subtask, "build-api");
  assert.equal(snapshot.active_role, "composer");
  assert.equal(snapshot.loop.phase.phase, "executing");
});

test("active snapshot uses supervisor owner task before the first report", () => {
  const tmp = tmpDir();
  const root = path.join(tmp, "runs");
  const run = path.join(root, "run-1");
  const roleDir = path.join(run, "lh_harness", "role_orchestration");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(
    path.join(roleDir, "events.jsonl"),
    `${JSON.stringify({ event: "run_started" })}\n`,
    "utf-8",
  );
  new ControlBus(run).writeOwner({ run_id: "run-1", task: "owner task while active" });
  const state = new DashboardState(path.join(run, "lh_harness"), { runsRoot: root, controlEnabled: true });

  const snapshot = buildSnapshot(state, { run_id: "run-1" }) as Record<string, any>;

  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.mission.task, "owner task while active");
});

test("svg artifacts are text attachments, not image documents", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  fs.writeFileSync(path.join(episodeDir(root), "proof.svg"), "<svg><script>window.pwned=true</script></svg>", "utf-8");
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const raw = await fetch(`${handle.url}api/runs/run-1/episodes/composer/1/artifacts/proof.svg/raw`);
  await raw.text();

  assert.equal(raw.status, 200);
  assert.ok((raw.headers.get("content-type") || "").startsWith("text/plain"));
  assert.ok((raw.headers.get("content-disposition") || "").startsWith("attachment;"));
});

test("legacy static dashboard routes are not registered", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  for (const legacy of [
    "api/state",
    "api/round/1",
    "api/round/1/manager_plan.txt",
    "api/runs/run-1/rounds/1/artifacts/manager_plan.txt",
    "api/runs/run-1/rounds/1/trajectory/composer",
  ]) {
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
  assert.equal(snapshot.active_subtask, "build-api");
  assert.equal(snapshot.active_role, "composer");
  assert.deepEqual(snapshot.controls, { can_inject: true, can_abort: false, can_resume: false });

  const events = (await (await fetch(`${handle.url}api/runs/run-1/events?limit=20`)).json()).events;
  assert.deepEqual(events.map((item: any) => item.type), ["run.started", "episode.started"]);
  const replay = (
    await (await fetch(`${handle.url}api/runs/run-1/events?after=${encodeURIComponent(events[0].event_id)}`)).json()
  ).events;
  assert.deepEqual(replay.map((item: any) => item.event_id), [events[1].event_id]);

  const stateFile = await fetch(`${handle.url}api/runs/run-1/state/progress/build-api.md`);
  assert.equal(stateFile.status, 200);
  assert.ok((await stateFile.text()).includes("execute"));

  const listing = await (await fetch(`${handle.url}api/runs/run-1/state/plan?list=1`)).json();
  assert.deepEqual(listing.entries, ["plan.json"]);

  const artifacts = await (await fetch(`${handle.url}api/runs/run-1/episodes/composer/1/artifacts`)).json();
  assert.deepEqual(artifacts.artifacts, ["screenshot.png"]);

  const image = await fetch(`${handle.url}api/runs/run-1/episodes/composer/1/artifacts/screenshot.png/raw`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Buffer.from(await image.arrayBuffer()),
    Buffer.from("\x89PNG\r\nfixture-image", "latin1"),
  );

  const traversalRaw = await fetch(
    `${handle.url}api/runs/run-1/episodes/composer/1/artifacts/%2E%2E/screenshot.png/raw`,
  );
  await traversalRaw.text();
  assert.ok([404, 422].includes(traversalRaw.status));
  const traversalState = await fetch(`${handle.url}api/runs/run-1/state/%2E%2E/lh_harness/report.json`);
  await traversalState.text();
  assert.ok([404, 422].includes(traversalState.status));

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
  fs.writeFileSync(path.join(episodeDir(root), "screenshot.png"), screenshot);
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const artifact = await fetch(`${handle.url}api/runs/run-1/episodes/composer/1/artifacts/screenshot.png/raw`);

  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("content-type"), "image/png");
  assert.ok((artifact.headers.get("content-disposition") || "").startsWith("inline;"));
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), screenshot);

  const traversal = await fetch(`${handle.url}api/runs/run-1/episodes/composer/1/artifacts/%2E%2E/raw`);
  await traversal.text();
  assert.equal(traversal.status, 404);
});

test("api does not execute html artifacts", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  fs.writeFileSync(path.join(episodeDir(root), "result.html"), "<script>window.pwned = true</script>", "utf-8");
  writeState(path.join(root, "run-1", "state"), "evidence/build-api/result.html", "<script>window.pwned = true</script>");
  const handle = await serve({ state, runsRoot: root, runId: "run-1" });

  const raw = await fetch(`${handle.url}api/runs/run-1/episodes/composer/1/artifacts/result.html/raw`);
  await raw.text();
  const text = await fetch(`${handle.url}api/runs/run-1/state/evidence/build-api/result.html`);
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

    const eventsPath = path.join(root, "run-1", "lh_harness", "role_orchestration", "events.jsonl");
    setTimeout(() => {
      fs.appendFileSync(
        eventsPath,
        `${JSON.stringify({ ts: 3, event: "episode_finished", role: "composer", round: 1 })}\n`,
        "utf-8",
      );
    }, 100);
    const liveEvent = await next();
    const liveSnapshot = await next();
    assert.equal(liveEvent.kind, "event");
    assert.equal((liveEvent.data as any).type, "episode.completed");
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

test("POST /api/service/reload requires the capability and fires the callback", async () => {
  const tmp = tmpDir();
  const { root, state } = fixture(tmp);
  const closedHandle = await serve({ state, runsRoot: root, runId: "run-1" });
  const denied = await fetch(`${closedHandle.url}api/service/reload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 501);
  assert.equal(((await denied.json()) as { detail: string }).detail, "reload is not enabled for this deployment");
  const meta = (await (await fetch(`${closedHandle.url}api/meta`)).json()) as { capabilities: Record<string, boolean> };
  assert.equal(meta.capabilities.reload, false);
  await closedHandle.close();

  let fired = 0;
  const handle = await serve({ state, runsRoot: root, runId: "run-1", onReload: () => { fired += 1; } });
  const metaOn = (await (await fetch(`${handle.url}api/meta`)).json()) as { capabilities: Record<string, boolean> };
  assert.equal(metaOn.capabilities.reload, true);
  const accepted = await fetch(`${handle.url}api/service/reload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(accepted.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fired, 1);
  await handle.close();
});
