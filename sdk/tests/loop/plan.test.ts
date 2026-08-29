import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPlanChanges,
  countStatuses,
  leaves,
  nextReadyLeaf,
  nodeById,
  parsePlan,
  renderPlanMarkdown,
  setLeafStatus,
  stuckLeaves,
} from "../../src/loop/plan.js";

const RAW = {
  title: "Six ad videos",
  summary: "Make six Meta ads.",
  nodes: [
    {
      id: "research",
      title: "Research",
      goal: "know the brand",
      backing: [{ kind: "web", ref: "https://example.com", note: "site" }],
      children: [
        { id: "brand-notes", title: "Brand notes", goal: "notes", backing: ["obvious"], deliverables: ["docs/brand.md"], acceptance: ["file exists"] },
        { id: "asset-pull", title: "Pull assets", goal: "images", backing: [{ kind: "source", ref: "inbox/x.zip" }], depends_on: ["brand-notes"] },
      ],
    },
    { id: "Render Ad 1", title: "Render ad 1", goal: "mp4", backing: [{ kind: "reasoning", ref: "needed" }], depends_on: ["asset-pull"] },
    { title: "Render ad 1", goal: "duplicate id is renamed", backing: [{ kind: "reasoning", ref: "x" }] },
  ],
};

test("a planner block parses into a tree with unique slug ids and pending leaves", () => {
  const plan = parsePlan(RAW);
  assert.equal(plan.title, "Six ad videos");
  const ids = leaves(plan).map((leaf) => leaf.id);
  assert.deepEqual(ids, ["brand-notes", "asset-pull", "render-ad-1", "render-ad-1-2"]);
  assert.ok(leaves(plan).every((leaf) => leaf.status === "pending"));
  assert.equal(nodeById(plan, "research")?.backing[0]?.kind, "web");
  assert.equal(nodeById(plan, "brand-notes")?.backing[0]?.kind, "reasoning");
});

test("leaves become ready in document order once their dependencies are done", () => {
  const plan = parsePlan(RAW);
  assert.equal(nextReadyLeaf(plan)?.id, "brand-notes");
  setLeafStatus(plan, "brand-notes", "composing");
  // asset-pull depends on brand-notes; render-ad-1 depends on asset-pull; the
  // duplicate leaf has no deps.
  assert.equal(nextReadyLeaf(plan)?.id, "render-ad-1-2");
  setLeafStatus(plan, "brand-notes", "done");
  setLeafStatus(plan, "render-ad-1-2", "done");
  assert.equal(nextReadyLeaf(plan)?.id, "asset-pull");
  setLeafStatus(plan, "asset-pull", "blocked");
  assert.equal(nextReadyLeaf(plan), null);
  assert.deepEqual(stuckLeaves(plan).map((leaf) => leaf.id), ["render-ad-1"]);
  assert.equal(nodeById(plan, "research")?.status, "blocked");
});

test("evaluator plan changes add, modify and remove pending nodes but never finished ones", () => {
  const plan = parsePlan(RAW);
  setLeafStatus(plan, "brand-notes", "done");
  const result = applyPlanChanges(
    plan,
    [
      { op: "add", parent_id: "research", node: { title: "Competitor scan", goal: "see rivals", backing: [{ kind: "reasoning", ref: "x" }] }, reason: "missing" },
      { op: "remove", node_id: "brand-notes", reason: "done already" },
      { op: "modify", node_id: "render-ad-1", node: { goal: "a 9:16 mp4" }, reason: "spec" },
      { op: "remove", node_id: "render-ad-1-2", reason: "duplicate" },
      { op: "add", parent_id: "missing", node: { title: "x" } },
    ],
    "evaluator:brand-notes",
  );
  assert.equal(result.applied.length, 3);
  assert.equal(result.rejected.length, 2);
  assert.equal(plan.revision, 1);
  assert.equal(nodeById(plan, "competitor-scan")?.added_by, "evaluator:brand-notes");
  assert.equal(nodeById(plan, "render-ad-1")?.goal, "a 9:16 mp4");
  assert.equal(nodeById(plan, "render-ad-1-2")?.status, "skipped");
  assert.equal(nodeById(plan, "brand-notes")?.status, "done");
  assert.deepEqual(countStatuses(plan), { pending: 3, rubric: 0, composing: 0, evaluating: 0, done: 1, blocked: 0, skipped: 1 });
});

test("the markdown outline lists every node with its backing and status marks", () => {
  const plan = parsePlan(RAW);
  setLeafStatus(plan, "brand-notes", "done");
  const text = renderPlanMarkdown(plan, { withStatus: true, highlight: "asset-pull" });
  assert.match(text, /\[x\] \*\*Brand notes\*\* \(`brand-notes`\)/);
  assert.match(text, /backed by source: inbox\/x.zip/);
  assert.match(text, /<-- this subtask/);
});

test("an empty or leafless plan is rejected", () => {
  assert.throws(() => parsePlan({ nodes: [] }), /no nodes/);
  assert.throws(() => parsePlan("nope"), /object/);
});
