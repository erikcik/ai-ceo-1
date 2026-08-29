import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderContextPack, selectComposerContext } from "../../src/loop/context.js";
import { parsePlan } from "../../src/loop/plan.js";
import { RunState } from "../../src/loop/state.js";

test("the python selector picks previous notes, evaluations, dependency notes and matching memory pages with reasons", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ctx-"));
  const workspace = path.join(runDir, "ws");
  const memoryDir = path.join(workspace, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const state = new RunState({ runDir, logDir: path.join(runDir, "lh_harness") });
  state.ensureLayout();
  const plan = parsePlan({
    title: "T",
    nodes: [
      { id: "assets", title: "Collect product photos", goal: "photos", backing: ["r"], status: "done" },
      { id: "render", title: "Render vertical video ad", goal: "ffmpeg 1080x1920 mp4", backing: ["r"], depends_on: ["assets"] },
      { id: "other", title: "Unrelated copywriting", goal: "text", backing: ["r"], status: "done" },
    ],
  });
  fs.writeFileSync(state.progressPath("assets"), "Status: done\nphotos live in assets/\n");
  fs.writeFileSync(state.progressPath("other"), "Status: done\ncopy written\n");
  fs.writeFileSync(state.progressPath("render"), "Status: partial\nfirst attempt\n");
  fs.mkdirSync(state.evaluationDir("render"), { recursive: true });
  fs.writeFileSync(path.join(state.evaluationDir("render"), "r1.md"), "Verdict: NEEDS_WORK\n- wrong aspect ratio\n");
  fs.writeFileSync(path.join(memoryDir, "ffmpeg-render-notes.md"), "---\nname: ffmpeg-render-notes\ndescription: how to render 1080x1920 mp4 video with ffmpeg\ntags: ffmpeg, video\n---\nuse scale+crop\n");
  fs.writeFileSync(path.join(memoryDir, "unrelated.md"), "---\nname: gardening\ndescription: roses\n---\nprune in spring\n");
  fs.writeFileSync(path.join(state.dir("research"), "meta-video-specs.md"), "# Meta video ad specs\n9:16 mp4 under 4GB\n");

  const pack = selectComposerContext({ stateDir: state.stateDir, workspace, memoryDir, plan, subtaskId: "render", round: 2 });
  assert.equal(pack.selector, "python", pack.error ?? "selector fell back");
  const titles = pack.sections.map((section) => section.title);
  assert.ok(titles[0]!.startsWith("Your previous progress note"), titles.join(" | "));
  assert.ok(titles[1]!.startsWith("Latest evaluation"), titles.join(" | "));
  assert.ok(titles.some((title) => title.includes("dependency `assets`")));
  assert.ok(titles.some((title) => title.includes("Memory page ffmpeg-render-notes.md")));
  assert.ok(!titles.some((title) => title.includes("unrelated.md")));
  assert.ok(titles.some((title) => title.includes("meta-video-specs.md")));
  assert.ok(pack.sections.every((section) => section.reason.length > 0));
  const rendered = renderContextPack(pack);
  assert.match(rendered, /wrong aspect ratio/);
  assert.match(rendered, /why: /);
});

test("without python the fallback still supplies the previous note and evaluation", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ctx-"));
  const state = new RunState({ runDir, logDir: path.join(runDir, "lh_harness") });
  state.ensureLayout();
  const plan = parsePlan({ title: "T", nodes: [{ id: "s", title: "S", goal: "g", backing: ["r"] }] });
  fs.writeFileSync(state.progressPath("s"), "Status: partial\n");
  const pack = selectComposerContext({ stateDir: state.stateDir, workspace: runDir, memoryDir: path.join(runDir, "memory"), plan, subtaskId: "s", round: 2, python: "/definitely/not/python" });
  assert.equal(pack.selector, "fallback");
  assert.match(String(pack.error), /failed/);
  assert.equal(pack.sections.length, 1);
});
