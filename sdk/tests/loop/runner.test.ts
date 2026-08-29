import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AgentAdapter } from "../../src/adapters/base.js";
import type { Environment } from "../../src/environment/base.js";
import { run } from "../../src/loop/runner.js";
import { RunState } from "../../src/loop/state.js";
import { EpisodeBudget, harnessConfig, type EpisodeResult, type RoleName } from "../../src/types.js";

const env: Environment = {
  async exec() {
    return { stdout: "", stderr: "", exit_code: 0, duration_ms: 0 };
  },
  async screenshot() {
    return Buffer.alloc(0);
  },
  async upload() {},
  async download() {},
};

const PLAN = {
  title: "Two-step plan",
  summary: "Do A then B.",
  questions: [],
  nodes: [
    {
      id: "group",
      title: "Group",
      goal: "both",
      backing: [{ kind: "reasoning", ref: "obvious" }],
      children: [
        { id: "step-a", title: "Step A", goal: "write a.txt", backing: [{ kind: "web", ref: "https://x" }], deliverables: ["a.txt"], acceptance: ["a.txt exists"] },
        { id: "step-b", title: "Step B", goal: "write b.txt", backing: [{ kind: "reasoning", ref: "r" }], depends_on: ["step-a"], deliverables: ["b.txt"], acceptance: ["b.txt exists"] },
      ],
    },
  ],
};

type Script = (role: RoleName, prompt: string, calls: Record<string, number>) => string | { text: string; status?: EpisodeResult["status"]; error?: string };

/** An adapter that answers from a script and, as the composer, writes the note/evidence like an agent would. */
function scriptedAgents(script: Script, workspace: string): { agents: Record<RoleName, AgentAdapter>; calls: Record<string, number>; prompts: Record<string, string[]> } {
  const calls: Record<string, number> = {};
  const prompts: Record<string, string[]> = {};
  const make = (role: RoleName): AgentAdapter => ({
    async runEpisode(prompt: string): Promise<EpisodeResult> {
      calls[role] = (calls[role] ?? 0) + 1;
      (prompts[role] ??= []).push(prompt);
      const out = script(role, prompt, calls);
      const spec = typeof out === "string" ? { text: out } : out;
      if (role === "composer") {
        const note = /Progress note \(required\): (.+)/.exec(prompt)?.[1]?.trim();
        const evidence = /Evidence folder: (.+)/.exec(prompt)?.[1]?.trim();
        const subtask = /Subtask id: (\S+)/.exec(prompt)?.[1] ?? "unknown";
        const criteria = [...prompt.matchAll(/"id": "(c\d+)"/g)].map((match) => match[1]);
        fs.writeFileSync(path.join(workspace, `${subtask}.txt`), `done by composer ${calls[role]}`);
        if (evidence) {
          fs.mkdirSync(evidence, { recursive: true });
          fs.writeFileSync(path.join(evidence, "proof.txt"), "proof");
        }
        if (note) {
          fs.mkdirSync(path.dirname(note), { recursive: true });
          fs.writeFileSync(note, `# ${subtask}\nStatus: done\n\n## Done\nwrote file\n## Evidence\n${criteria.map((id) => `- ${id} → proof.txt`).join("\n")}\n## How to verify\ncat\n`);
        }
      }
      return {
        status: spec.status ?? "done",
        actions_log: "",
        error: spec.error ?? null,
        duration_ms: 5,
        metadata: { assistant_visible_output: spec.text, total_cost_usd: 0.01, num_turns: 1 },
      };
    },
  });
  const agents = Object.fromEntries(
    (["prompt_tailor", "planner", "rubric", "composer", "evaluator", "final_response"] as RoleName[]).map((role) => [role, make(role)]),
  ) as Record<RoleName, AgentAdapter>;
  return { agents, calls, prompts };
}

function setup(): { workspace: string; runDir: string; logDir: string; config: ReturnType<typeof harnessConfig> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-runner-"));
  const workspace = path.join(root, "ws");
  const runDir = path.join(workspace, ".lh-harness", "runs", "run-1");
  const logDir = path.join(runDir, "lh_harness");
  fs.mkdirSync(path.join(workspace, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "inbox", "brief.txt"), "brief");
  const budget = new EpisodeBudget(30);
  const config = harnessConfig({
    max_total_episodes: 10,
    workspace_path: workspace,
    log_dir: logDir,
    harness_dir: path.join(runDir, "harness"),
    max_eval_rounds: 2,
    min_research_agents: 0,
    budgets: { prompt_tailor: budget, planner: budget, rubric: budget, composer: budget, evaluator: budget, final_response: budget },
  });
  return { workspace, runDir, logDir, config };
}

const tailorText = "=== PLANNER ===\nplan briefing\n=== RUBRIC ===\nrubric briefing\n=== COMPOSER ===\ncompose briefing\n=== EVALUATOR ===\neval briefing\n";
const contractText = (subtask: string) =>
  `rubric prose\n\`\`\`json\n{"subtask_id": "${subtask}", "criteria": [{"id": "c1", "statement": "file exists", "verify": "ls", "evidence": "proof", "mandatory": true, "weight": 1, "passes": false}, {"id": "c2", "statement": "looks good", "mandatory": false, "weight": 1, "passes": false}], "scoring": {"pass_rule": "all mandatory pass and mean >= 3.5"}}\n\`\`\``;
const passText = (subtask: string) =>
  `Checked.\n\`\`\`json\n{"subtask_id": "${subtask}", "verdict": "PASS", "summary": "all good", "criteria": [{"id": "c1", "passes": true, "score": 5, "checked": ["ls"], "finding": ""}, {"id": "c2", "passes": true, "score": 4, "checked": ["eyes"], "finding": ""}], "findings": [], "plan_changes": []}\n\`\`\``;
const needsWorkText = (subtask: string, changes = "[]") =>
  `Not yet.\n\`\`\`json\n{"subtask_id": "${subtask}", "verdict": "NEEDS_WORK", "summary": "c2 weak", "criteria": [{"id": "c1", "passes": true, "score": 5, "checked": ["ls"]}, {"id": "c2", "passes": false, "score": 2, "checked": ["eyes"], "finding": "generic"}], "findings": ["make it less generic"], "plan_changes": ${changes}}\n\`\`\``;

test("a full run: tailor → plan → per-subtask rubric/compose/evaluate → completed report", async () => {
  const { workspace, runDir, logDir, config } = setup();
  const gates: Record<string, unknown>[] = [];
  const events: string[] = [];
  const { agents, calls, prompts } = scriptedAgents((role, prompt, counts) => {
    if (role === "prompt_tailor") return tailorText;
    if (role === "planner") return `notes\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``;
    if (role === "rubric") return contractText(/Subtask id: (\S+)/.exec(prompt)?.[1] ?? "x");
    if (role === "composer") return "did it";
    if (role === "evaluator") {
      const subtask = /Subtask id: (\S+)/.exec(prompt)?.[1] ?? "x";
      // step-b needs one revision round and adds a follow-up leaf that is then skipped.
      if (subtask === "step-b" && counts.evaluator === 2) {
        return needsWorkText(subtask, '[{"op": "add", "parent_id": "group", "node": {"id": "step-c", "title": "Step C", "goal": "write c.txt", "backing": [{"kind": "reasoning", "ref": "found while evaluating"}], "acceptance": ["c.txt exists"]}, "reason": "b needs c"}]');
      }
      return passText(subtask);
    }
    return "All delivered: a.txt, b.txt, c.txt.";
  }, workspace);
  const report = await run({
    task: "make files",
    env,
    config,
    runDir,
    agents,
    humanHook: async (context) => {
      gates.push(context);
      return { action: "continue", instructions: "", extra_rounds: 0 };
    },
    progress: (event) => events.push(event),
    hiddenPaths: [path.join(runDir, "tmp")],
  });
  assert.equal(report.status, "completed", JSON.stringify(report));
  assert.equal(report.completion_satisfied, true);
  assert.equal(report.completion_authority, "evaluator_contracts");
  assert.deepEqual(report.status_counts, { pending: 0, rubric: 0, composing: 0, evaluating: 0, done: 3, blocked: 0, skipped: 0 });
  // step-a: 1 round; step-b: 2 rounds; step-c (added by the evaluator): 1 round.
  assert.equal(calls.composer, 4);
  assert.equal(calls.rubric, 3);
  assert.equal(calls.evaluator, 4);
  assert.equal(report.rounds_run, 4);
  assert.ok((report.cost_usd as number) > 0);

  const state = new RunState({ runDir, logDir });
  const plan = state.readPlan()!;
  assert.equal(plan.revision, 1);
  assert.equal(plan.nodes[0]!.children.length, 3);
  assert.equal(state.readBriefing("composer"), "compose briefing\n");
  assert.equal(state.readContract("step-b")!.criteria.every((item) => item.passes), true);
  assert.equal(state.readEvaluations("step-b").length, 2);
  assert.equal(state.readEvaluations("step-b")[0]!.verdict, "NEEDS_WORK");
  assert.ok(fs.existsSync(path.join(state.dir("context"), "step-b-r2.json")));
  // Round 2 of step-b saw the evaluator's findings.
  assert.match(prompts.composer![2]!, /make it less generic/);
  // Every composer prompt carried the tailored briefing, the plan, the contract and the paths.
  assert.match(prompts.composer![0]!, /compose briefing/);
  assert.match(prompts.composer![0]!, /"id": "c1"/);
  assert.match(prompts.composer![0]!, /Progress note \(required\)/);
  assert.match(prompts.planner![0]!, /plan briefing/);
  assert.match(prompts.evaluator![0]!, /Evidence ledger/);
  assert.match(prompts.prompt_tailor![0]!, /inbox\/brief.txt/);
  assert.ok(fs.existsSync(path.join(config.memory_dir, "index.md")));
  assert.ok(fs.existsSync(path.join(logDir, "composer_episodes", "ep004", "metadata.json")));
  assert.equal(state.readEpisodeIndex().length, 1 + 1 + 3 + 4 + 4 + 1);
  assert.deepEqual(gates.map((gate) => gate.outcome), ["subtask_done", "subtask_done", "subtask_done", "completed"]);
  assert.ok(events.includes("plan_written") && events.includes("run_done"));
  const eventNames = fs
    .readFileSync(path.join(logDir, "role_orchestration", "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { event: string }).event);
  assert.equal(eventNames[0], "run_started");
  assert.equal(eventNames[eventNames.length - 1], "run_finished");
  assert.ok(eventNames.includes("plan_revised"));
  assert.match(String(report.final_response), /All delivered/);
});

test("a subtask that never passes is blocked after max_eval_rounds; the operator can stop the run", async () => {
  const { workspace, runDir, logDir, config } = setup();
  const gates: Record<string, unknown>[] = [];
  const { agents, calls } = scriptedAgents((role, prompt) => {
    if (role === "prompt_tailor") return "no sections here";
    if (role === "planner") return `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``;
    if (role === "rubric") return contractText(/Subtask id: (\S+)/.exec(prompt)?.[1] ?? "x");
    if (role === "composer") return "tried";
    if (role === "evaluator") return needsWorkText(/Subtask id: (\S+)/.exec(prompt)?.[1] ?? "x");
    return "stopped";
  }, workspace);
  const report = await run({
    task: "make files",
    env,
    config,
    runDir,
    agents,
    humanHook: async (context) => {
      gates.push(context);
      return { action: context.outcome === "blocked" ? "stop" : "continue", instructions: "", extra_rounds: 0 };
    },
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.completion_satisfied, false);
  assert.equal(calls.composer, 2);
  assert.equal(gates[0]!.outcome, "blocked");
  const state = new RunState({ runDir, logDir });
  assert.equal(state.readPlan()!.nodes[0]!.children[0]!.status, "blocked");
  assert.equal(state.readBriefing("planner"), "");
});

test("a planner that never returns a plan fails the run with a terminal report", async () => {
  const { workspace, runDir, logDir, config } = setup();
  const { agents, calls } = scriptedAgents((role) => (role === "planner" ? "I have no plan." : tailorText), workspace);
  const report = await run({ task: "x", env, config, runDir, agents });
  assert.equal(report.status, "failed");
  assert.equal(calls.planner, 2);
  assert.match(String(report.error), /no usable plan/);
  assert.ok(fs.existsSync(path.join(logDir, "report.json")));
});

test("a run resumes from its plan and re-opens the leaf that was mid-flight", async () => {
  const { workspace, runDir, logDir, config } = setup();
  const state = new RunState({ runDir, logDir });
  state.ensureLayout();
  const { agents, calls } = scriptedAgents((role, prompt) => {
    if (role === "rubric") return contractText(/Subtask id: (\S+)/.exec(prompt)?.[1] ?? "x");
    if (role === "evaluator") return passText(/Subtask id: (\S+)/.exec(prompt)?.[1] ?? "x");
    if (role === "composer") return "ok";
    return "reply";
  }, workspace);
  const { parsePlan, setLeafStatus } = await import("../../src/loop/plan.js");
  const plan = parsePlan(PLAN);
  setLeafStatus(plan, "step-a", "done");
  setLeafStatus(plan, "step-b", "composing");
  state.writePlan(plan);
  const report = await run({ task: "x", env, config, runDir, agents, resume: true });
  assert.equal(report.status, "completed");
  assert.equal(calls.planner ?? 0, 0);
  assert.equal(calls.prompt_tailor ?? 0, 0);
  assert.equal(calls.composer, 1);
});

test("an evaluator timeout is a failed round, not a dead run; a resumed leaf with composer work is graded first", async () => {
  const { workspace, runDir, logDir, config } = setup();
  let evaluatorCalls = 0;
  const { agents, calls } = scriptedAgents((role, prompt) => {
    if (role === "prompt_tailor") return tailorText;
    if (role === "planner") return `\`\`\`json\n${JSON.stringify({ ...PLAN, nodes: [PLAN.nodes[0]!.children[0]] })}\n\`\`\``;
    if (role === "rubric") return contractText("step-a");
    if (role === "composer") return "did it";
    if (role === "evaluator") {
      evaluatorCalls += 1;
      if (evaluatorCalls === 1) return { text: "", status: "timeout", error: "Episode timed out after 1s." };
      return passText("step-a");
    }
    return "reply";
  }, workspace);
  const report = await run({ task: "x", env, config, runDir, agents });
  assert.equal(report.status, "completed", JSON.stringify(report));
  // Round 1: composer + timed-out evaluator (NEEDS_WORK); round 2: composer + PASS.
  assert.equal(calls.composer, 2);
  assert.equal(calls.evaluator, 2);
  const state = new RunState({ runDir, logDir });
  const evaluations = state.readEvaluations("step-a");
  assert.equal(evaluations[0]!.verdict, "NEEDS_WORK");
  assert.match(evaluations[0]!.harness_note, /timeout/);

  // Resume scenario: the leaf was mid-evaluation with a progress note on disk.
  const { setLeafStatus } = await import("../../src/loop/plan.js");
  const plan = state.readPlan()!;
  plan.nodes[0]!.rounds = 0;
  setLeafStatus(plan, "step-a", "evaluating");
  state.writePlan(plan);
  const before = { ...calls };
  const resumed = await run({ task: "x", env, config, runDir, agents, resume: true });
  assert.equal(resumed.status, "completed");
  assert.equal(calls.composer, before.composer, "the composer is not re-run when its work is already on disk");
  assert.equal(calls.evaluator, before.evaluator + 1);
});

test("a PASS that skipped a criterion triggers one follow-up evaluation instead of a composer round", async () => {
  const { workspace, runDir, config } = setup();
  let evaluatorCalls = 0;
  const { agents, calls, prompts } = scriptedAgents((role, prompt) => {
    if (role === "prompt_tailor") return tailorText;
    if (role === "planner") return `\`\`\`json\n${JSON.stringify({ ...PLAN, nodes: [PLAN.nodes[0]!.children[0]] })}\n\`\`\``;
    if (role === "rubric") return contractText("step-a");
    if (role === "composer") return "did it";
    if (role === "evaluator") {
      evaluatorCalls += 1;
      if (evaluatorCalls === 1) return 'ok\n```json\n{"subtask_id": "step-a", "verdict": "PASS", "summary": "fine", "criteria": [{"id": "c1", "passes": true, "score": 5}], "findings": []}\n```';
      assert.match(prompt, /grade only the criteria you left out/);
      return 'follow-up\n```json\n{"subtask_id": "step-a", "verdict": "PASS", "summary": "c2 also fine", "criteria": [{"id": "c2", "passes": true, "score": 4}], "findings": []}\n```';
    }
    return "reply";
  }, workspace);
  const report = await run({ task: "x", env, config, runDir, agents });
  assert.equal(report.status, "completed", JSON.stringify(report));
  assert.equal(calls.composer, 1);
  assert.equal(calls.evaluator, 2);
  assert.ok(prompts.evaluator![1]!.includes('"id": "c2"'));
});

test("a transient provider error is retried once; only credential/quota failures end the run", async () => {
  process.env.LH_HARNESS_TEST_FAST_RETRY = "1";
  const { workspace, runDir, config } = setup();
  let rubricCalls = 0;
  const { agents, calls } = scriptedAgents((role, prompt) => {
    if (role === "prompt_tailor") return tailorText;
    if (role === "planner") return `\`\`\`json\n${JSON.stringify({ ...PLAN, nodes: [PLAN.nodes[0]!.children[0]] })}\n\`\`\``;
    if (role === "rubric") {
      rubricCalls += 1;
      if (rubricCalls === 1) return { text: "", status: "error", error: "API Error: Connection lost mid-response. The response above may be incomplete." };
      return contractText("step-a");
    }
    if (role === "composer") return "did it";
    if (role === "evaluator") return passText("step-a");
    return "reply";
  }, workspace);
  const report = await run({ task: "x", env, config, runDir, agents });
  assert.equal(report.status, "completed", JSON.stringify(report));
  assert.equal(calls.rubric, 2);

  const fatal = scriptedAgents((role) => (role === "prompt_tailor" ? { text: "", status: "error", error: "401 unauthorized: invalid api key" } : tailorText), workspace);
  const second = setup();
  const failed = await run({ task: "x", env, config: second.config, runDir: second.runDir, agents: fatal.agents });
  assert.equal(failed.status, "failed");
  assert.equal(failed.abort_reason, "provider_authentication");
  assert.equal(fatal.calls.prompt_tailor, 1);
});
