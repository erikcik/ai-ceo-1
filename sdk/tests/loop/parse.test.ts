import assert from "node:assert/strict";
import { test } from "node:test";

import { extractJsonBlock, narrativeBeforeJson, parseTailorSections } from "../../src/loop/parse.js";

test("the last fenced json block wins and trailing commas are tolerated", () => {
  const text = 'first\n```json\n{"a": 1}\n```\nthen\n```json\n{"verdict": "PASS", "criteria": [{"id": "c1", "passes": true,},],}\n```\nbye';
  assert.deepEqual(extractJsonBlock(text), { verdict: "PASS", criteria: [{ id: "c1", passes: true }] });
  assert.equal(narrativeBeforeJson(text), "first\n```json\n{\"a\": 1}\n```\nthen");
});

test("an unfenced trailing object is found as a fallback", () => {
  const text = 'Here is the contract: {"subtask_id": "x", "criteria": [{"id": "c1", "statement": "s {braces} \\"q\\""}]}';
  const block = extractJsonBlock(text);
  assert.equal(block?.subtask_id, "x");
});

test("no object means null", () => {
  assert.equal(extractJsonBlock("nothing here"), null);
  assert.equal(extractJsonBlock("```json\n[1,2]\n```"), null);
});

test("tailor sections are split on === ROLE === markers, case-insensitively", () => {
  const text = "intro\n=== PLANNER ===\nplan this\n=== Rubric ===\nrubric that\n=== COMPOSER ===\n\n=== EVALUATOR ===\neval\n";
  const sections = parseTailorSections(text);
  assert.equal(sections.planner, "plan this");
  assert.equal(sections.rubric, "rubric that");
  assert.equal(sections.composer, "");
  assert.equal(sections.evaluator, "eval");
});
