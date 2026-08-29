// The loop. One operator task in, one verified deliverable out:
//
//   intake → prompt tailor → planner (plan tree)
//   for each leaf subtask: rubric → [context → composer → evaluator] × N
//   → final response
//
// Everything durable is on disk under <runDir>/state (see state.ts); this file
// only sequences episodes, applies verdicts to the plan, and talks to the
// operator through the human gate. Read it top to bottom: `run()` is the crash
// boundary, `runImpl()` the schedule, the `phase*` functions the phases.

import fs from "node:fs";
import path from "node:path";

import type { AgentAdapter } from "../adapters/base.js";
import { snapshotWorkspace, workspaceSnapshotDiff } from "../adapters/claude_permissions.js";
import type { Environment } from "../environment/base.js";
import { classifyProviderFailure } from "../provider_errors.js";
import { EpisodeBudget, type EpisodeResult, type HarnessConfig, type RoleName } from "../types.js";
import { pyStrip } from "../utils/pystr.js";
import { renderContextPack, selectComposerContext } from "./context.js";
import {
  allocateEpisodeDir,
  episodeStatus,
  exceptionText,
  isCancellation,
  jsonDumpsIndent2,
  mergeEpisodeLogs,
  monotonic,
  runRoleEpisode,
  saveEpisode,
  visibleOutput,
  workspaceMutationDetected,
} from "./episodes.js";
import { composerHooks, mergeHookSets, operatorControlHooks, readLedger, writeScopeHooks, type HookSet } from "./hooks.js";
import { appendMemoryLog, ensureMemoryDir, memoryIndexText, regenerateMemoryIndex } from "./memory.js";
import { extractJsonBlock, narrativeBeforeJson, parseTailorSections } from "./parse.js";
import {
  type Plan,
  type PlanNode,
  applyPlanChanges,
  countStatuses,
  leaves,
  nextReadyLeaf,
  nodeById,
  parsePlan,
  renderNodeBrief,
  renderPlanMarkdown,
  setLeafStatus,
  stuckLeaves,
} from "./plan.js";
import { ROLE_LABELS, buildRolePrompt, type PromptSection } from "./prompts.js";
import { type Contract, type EvaluationRecord, RunState, parseContract, parseEvaluation, ungradedCriteria } from "./state.js";
import { loopSubagents } from "./subagents.js";

export const LOOP_VARIANT = "eray_plan_tree_loop";
const RESUME_EVALUATE_NOTE = "resume: composer work found, evaluate first";
export const REPORT_SCHEMA_VERSION = 3;

export type ProgressSink = (event: string, payload: Record<string, unknown>) => void;
export type HumanHook = (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type PendingInstructions = () => string[];

export interface RunOptions {
  task: string;
  env: Environment;
  config: HarnessConfig;
  runDir: string;
  agents: Record<RoleName, AgentAdapter>;
  humanHook?: HumanHook | null;
  pendingInstructions?: PendingInstructions | null;
  progress?: ProgressSink | null;
  resume?: boolean;
  signal?: AbortSignal | null;
  /** Harness-owned paths listed in prompts as off limits. */
  hiddenPaths?: readonly string[];
}

type TerminalStatus = "completed" | "blocked" | "incomplete" | "failed" | "cancelled";

class RunAborted extends Error {
  constructor(
    readonly reason: string,
    readonly terminal: TerminalStatus,
    readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "RunAborted";
  }
}

interface LoopContext {
  options: RunOptions;
  state: RunState;
  config: HarnessConfig;
  startedAt: number;
  composerEpisodes: number;
  roundBudget: number;
  consecutiveFailures: number;
  abortReason: string;
  failureReason: string;
  finalResponse: string;
  totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// run() — the crash / cancellation boundary
// ---------------------------------------------------------------------------

export async function run(options: RunOptions): Promise<Record<string, unknown>> {
  const state = new RunState({ runDir: options.runDir, logDir: options.config.log_dir });
  const ctx: LoopContext = {
    options,
    state,
    config: options.config,
    startedAt: monotonic(),
    composerEpisodes: 0,
    roundBudget: Math.max(1, options.config.max_total_episodes),
    consecutiveFailures: 0,
    abortReason: "",
    failureReason: "",
    finalResponse: "",
    totalCostUsd: 0,
  };
  try {
    return await runImpl(ctx);
  } catch (exc) {
    if (exc instanceof RunAborted) {
      ctx.abortReason = exc.reason;
      ctx.failureReason = exc.userMessage;
      return writeTerminal(ctx, exc.terminal, { error: exc.userMessage });
    }
    if (isCancellation(exc) || options.signal?.aborted) {
      ctx.abortReason = "worker_cancelled";
      return writeTerminal(ctx, "cancelled", { error: "worker task was cancelled" });
    }
    ctx.abortReason = "worker_exception";
    ctx.failureReason = `loop crashed: ${exceptionText(exc)}`;
    return writeTerminal(ctx, "failed", {
      error: ctx.failureReason,
      exception_type: exc instanceof Error ? exc.name : typeof exc,
      traceback_tail: exc instanceof Error && exc.stack ? exc.stack.slice(-12_000) : String(exc),
    });
  }
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

async function runImpl(ctx: LoopContext): Promise<Record<string, unknown>> {
  const { state, config, options } = ctx;
  state.ensureLayout();
  state.writeRunConfig({
    max_rounds: config.max_total_episodes,
    max_eval_rounds: config.max_eval_rounds,
    min_research_agents: config.min_research_agents,
    research_model: config.research_model,
  });
  fs.mkdirSync(config.sources_dir, { recursive: true });
  ensureMemoryDir(config.memory_dir);
  regenerateMemoryIndex(config.memory_dir);

  const resumed = Boolean(options.resume) && state.readPlan() !== null;
  if (options.resume) state.archiveTerminalReport();
  state.event("run_started", {
    variant: LOOP_VARIANT,
    task_chars: options.task.length,
    workspace_path: config.workspace_path,
    max_rounds: config.max_total_episodes,
    max_eval_rounds: config.max_eval_rounds,
    resumed,
  });
  progress(ctx, "run_start", { resumed, max_rounds: config.max_total_episodes });

  let plan: Plan;
  if (resumed) {
    plan = state.readPlan() as Plan;
    // Anything that was mid-flight when the worker died is re-run from its rubric.
    for (const leaf of leaves(plan)) {
      if (leaf.status === "evaluating" && fs.existsSync(state.progressPath(leaf.id))) {
        // The composer had finished; only the verdict is missing.
        setLeafStatus(plan, leaf.id, "pending", RESUME_EVALUATE_NOTE);
      } else if (["rubric", "composing", "evaluating"].includes(leaf.status)) {
        setLeafStatus(plan, leaf.id, "pending", "re-opened after resume");
      }
    }
    ctx.composerEpisodes = state.readEpisodeIndex().filter((entry) => entry.role === "composer").length;
    ctx.roundBudget = ctx.composerEpisodes + Math.max(1, config.max_total_episodes);
    state.writePlan(plan, { revisionNote: "resumed" });
    state.event("run_resumed", { composer_episodes: ctx.composerEpisodes, round_budget: ctx.roundBudget });
    progress(ctx, "resumed", { composer_episodes: ctx.composerEpisodes, round_budget: ctx.roundBudget });
  } else {
    await phaseIntake(ctx);
    await phaseTailor(ctx);
    plan = await phasePlan(ctx);
  }

  await phaseExecute(ctx, plan);
  return await phaseFinalize(ctx, plan);
}

// ---------------------------------------------------------------------------
// Phase 0: intake
// ---------------------------------------------------------------------------

async function phaseIntake(ctx: LoopContext): Promise<void> {
  const { state, config, options } = ctx;
  state.setPhase({ phase: "intake", detail: "recording the task and attachments" });
  state.writeTask(options.task, listAttachments(config.workspace_path));
  state.event("phase_started", { phase: "intake" });
}

function listAttachments(workspace: string): string[] {
  try {
    return fs
      .readdirSync(path.join(workspace, "inbox"))
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => `inbox/${name}`);
  } catch {
    return [];
  }
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 3 || out.length > 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Phase 0b: prompt tailoring
// ---------------------------------------------------------------------------

async function phaseTailor(ctx: LoopContext): Promise<void> {
  const { state, config } = ctx;
  state.setPhase({ phase: "tailoring", current_role: "prompt_tailor", detail: "writing task-specific briefings for every role" });
  state.event("phase_started", { phase: "tailoring" });
  const sections = commonSections(ctx);
  sections.push({ title: "Memory index", body: memoryIndexText(config.memory_dir) });
  const prompt = buildRolePrompt({ role: "prompt_tailor", vars: promptVars(ctx), briefing: "", sections });
  const episode = await runEpisode(ctx, "prompt_tailor", prompt, { budget: config.budgets.prompt_tailor });
  const parsed = parseTailorSections(episode.visible);
  let written = 0;
  for (const role of ["planner", "rubric", "composer", "evaluator"] as const) {
    state.writeBriefing(role, parsed[role]);
    if (parsed[role]) written += 1;
  }
  state.event("briefings_written", { roles: written, episode_status: episodeStatus(episode.result) });
  if (!written) {
    // A missing briefing never stops the run: roles fall back to their base prompts.
    state.event("briefings_missing", { reason: episode.result.error ?? "tailor output had no role sections" });
  }
}

// ---------------------------------------------------------------------------
// Phase 1: planning
// ---------------------------------------------------------------------------

async function phasePlan(ctx: LoopContext): Promise<Plan> {
  const { state, config } = ctx;
  state.setPhase({ phase: "planning", current_role: "planner", detail: "researching and writing the plan tree" });
  state.event("phase_started", { phase: "planning" });
  const sections = commonSections(ctx);
  sections.push({ title: "Memory index", body: memoryIndexText(config.memory_dir) });
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptSections = feedback ? [...sections, { title: "Harness feedback on your previous attempt", body: feedback }] : sections;
    const prompt = buildRolePrompt({ role: "planner", vars: promptVars(ctx), briefing: state.readBriefing("planner"), sections: attemptSections });
    const episode = await runEpisode(ctx, "planner", prompt, {
      budget: config.budgets.planner,
      hooks: mergeHookSets(
        operatorControlHooks(config.workspace_path),
        writeScopeHooks(
          {
            roleName: "planner",
            allowed: [state.dir("research"), state.dir("plan"), config.memory_dir, path.join(config.workspace_path, "inbox")],
            denied: [state.planPath, state.dir("contracts"), state.dir("evaluations")],
          },
          config.workspace_path,
        ),
      ),
      agents: loopSubagents(subagentContext(ctx)),
    });
    const block = extractJsonBlock(episode.visible);
    if (block) {
      try {
        const plan = parsePlan(block, { addedBy: "planner" });
        state.writePlan(plan, { revisionNote: "planner" });
        state.event("plan_written", { node_count: countNodes(plan), leaf_count: leaves(plan).length, questions: plan.questions.length, attempt });
        progress(ctx, "plan_written", { leaves: leaves(plan).length, questions: plan.questions.length });
        if (plan.questions.length) await gatePlanQuestions(ctx, plan);
        return plan;
      } catch (exc) {
        feedback = `Your JSON plan could not be used: ${exceptionText(exc)}. Return the complete plan again as one fenced json block matching the schema.`;
      }
    } else {
      feedback = episode.result.status === "done"
        ? "Your final message contained no fenced ```json plan block. Return the complete plan as one fenced json block matching the schema."
        : `The planning session ended with status ${episode.result.status}${episode.result.error ? ` (${episode.result.error})` : ""}. Produce the plan more directly this time: fewer research agents if needed, then the fenced json block.`;
    }
    state.event("plan_rejected", { attempt, reason: feedback });
  }
  throw new RunAborted("planner_failed", "failed", "the planner produced no usable plan in two attempts");
}

function countNodes(plan: Plan): number {
  let count = 0;
  const walk = (node: PlanNode) => {
    count += 1;
    node.children.forEach(walk);
  };
  plan.nodes.forEach(walk);
  return count;
}

/** Plan questions become one operator gate; answers land in the decisions ledger. */
async function gatePlanQuestions(ctx: LoopContext, plan: Plan): Promise<void> {
  const answer = await humanGate(ctx, {
    phase: "after_planning",
    outcome: "ask",
    question: plan.questions.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    answers: [],
    plan_summary: plan.summary,
  });
  if (answer.action === "stop") throw new RunAborted("human_abort", "cancelled", "operator stopped the run after planning");
  if (answer.instructions) appendDecision(ctx, "answers to the planner's questions", answer.instructions);
}

// ---------------------------------------------------------------------------
// Phase 2: execute the leaves
// ---------------------------------------------------------------------------

async function phaseExecute(ctx: LoopContext, plan: Plan): Promise<void> {
  const { state, config } = ctx;
  state.setPhase({ phase: "executing", detail: "working through the plan's subtasks" });
  state.event("phase_started", { phase: "executing" });
  for (;;) {
    drainInstructions(ctx);
    let leaf = nextReadyLeaf(plan);
    if (!leaf) {
      const stuck = stuckLeaves(plan);
      for (const item of stuck) setLeafStatus(plan, item.id, "blocked", "cannot start: a dependency is blocked or skipped");
      if (stuck.length) state.writePlan(plan);
      break;
    }
    if (ctx.composerEpisodes >= ctx.roundBudget) {
      const answer = await humanGate(ctx, {
        phase: "budget",
        outcome: "progress",
        reached_max: true,
        subtask_id: leaf.id,
        pending_leaves: leaves(plan).filter((item) => item.status === "pending").length,
      });
      if (answer.action === "stop") {
        ctx.abortReason = "max_rounds_exhausted";
        break;
      }
      ctx.roundBudget += Math.max(1, answer.extra_rounds || config.max_total_episodes);
      if (answer.instructions) appendDecision(ctx, "operator instructions when extending the budget", answer.instructions);
      state.event("budget_extended", { round_budget: ctx.roundBudget });
      continue;
    }
    await runSubtask(ctx, plan, leaf);
    leaf = nodeById(plan, leaf.id) ?? leaf;
    const outcome = leaf.status === "done" ? "subtask_done" : leaf.status === "blocked" ? "blocked" : "progress";
    const answer = await humanGate(ctx, {
      phase: "after_subtask",
      outcome,
      subtask_id: leaf.id,
      subtask_title: leaf.title,
      verdict: leaf.last_verdict,
      note: leaf.note,
      consecutive_failures: ctx.consecutiveFailures,
      status_counts: countStatuses(plan),
    });
    if (answer.action === "stop") {
      ctx.abortReason = leaf.status === "blocked" ? "subtask_blocked" : "human_abort";
      break;
    }
    if (answer.instructions) {
      appendDecision(ctx, `operator instructions after subtask ${leaf.id}`, answer.instructions);
      if (leaf.status === "blocked") {
        // The operator answered: give the leaf a fresh set of rounds.
        leaf.rounds = 0;
        setLeafStatus(plan, leaf.id, "pending", "re-opened by the operator");
        state.writePlan(plan, { revisionNote: "operator re-opened a blocked subtask" });
        state.event("subtask_reopened", { subtask_id: leaf.id });
      }
    }
    if (answer.extra_rounds) ctx.roundBudget += answer.extra_rounds;
  }
}

async function runSubtask(ctx: LoopContext, plan: Plan, leaf: PlanNode): Promise<void> {
  const { state, config } = ctx;
  state.event("subtask_started", { subtask_id: leaf.id, title: leaf.title });
  progress(ctx, "subtask_start", { subtask_id: leaf.id, title: leaf.title });

  // Rubric → contract (kept across resumes and operator re-opens).
  let contract = state.readContract(leaf.id);
  if (!contract) {
    setLeafStatus(plan, leaf.id, "rubric");
    state.writePlan(plan);
    contract = await phaseRubric(ctx, plan, leaf);
  }

  // `leaf` is the live plan node: `rounds` counts every composer↔evaluator
  // round ever spent on it (an operator re-open resets it to 0).
  const startRound = leaf.rounds + 1;
  // After a resume that found the composer's work but no verdict, grade first.
  let skipComposeOnce = leaf.note === RESUME_EVALUATE_NOTE && fs.existsSync(state.progressPath(leaf.id));
  for (let round = startRound; round < startRound + config.max_eval_rounds; round += 1) {
    if (skipComposeOnce) {
      skipComposeOnce = false;
      state.event("composer_skipped", { subtask_id: leaf.id, round, reason: "resumed with the composer's work already on disk" });
    } else {
      if (ctx.composerEpisodes >= ctx.roundBudget) {
        setLeafStatus(plan, leaf.id, "pending", "waiting: composer budget exhausted");
        state.writePlan(plan);
        return;
      }
      // Composer
      setLeafStatus(plan, leaf.id, "composing");
      state.writePlan(plan);
      state.setPhase({ phase: "executing", current_subtask: leaf.id, current_role: "composer", current_round: round, detail: leaf.title });
      const composerResult = await phaseCompose(ctx, plan, leaf, contract, round);
      ctx.composerEpisodes += 1;
      if (composerResult.status === "cancelled") throw new RunAborted("user_cancelled", "cancelled", "operator cancelled during the composer episode");
      if (composerResult.status !== "done") {
        ctx.consecutiveFailures += 1;
      }
    }

    // Evaluator
    setLeafStatus(plan, leaf.id, "evaluating");
    state.writePlan(plan);
    state.setPhase({ phase: "executing", current_subtask: leaf.id, current_role: "evaluator", current_round: round, detail: leaf.title });
    const evaluation = await phaseEvaluate(ctx, plan, leaf, contract, round);
    const node = nodeById(plan, leaf.id) as PlanNode;
    node.rounds = round;
    node.last_verdict = evaluation.verdict;
    // Contract rows reflect the latest verified state (default-FAIL → evaluator flips).
    contract.criteria = contract.criteria.map((criterion) => {
      const graded = evaluation.criteria.find((item) => item.id === criterion.id);
      return graded ? { ...criterion, passes: graded.passes, score: graded.score, finding: graded.finding } : criterion;
    });
    state.writeContract(contract);
    if (evaluation.verdict === "PASS") {
      ctx.consecutiveFailures = 0;
      setLeafStatus(plan, leaf.id, "done", `passed in round ${round}`);
      applyEvaluatorPlanChanges(ctx, plan, leaf, evaluation);
      state.writePlan(plan);
      state.event("subtask_done", { subtask_id: leaf.id, rounds: round });
      progress(ctx, "subtask_done", { subtask_id: leaf.id, rounds: round });
      return;
    }
    applyEvaluatorPlanChanges(ctx, plan, leaf, evaluation);
    if (evaluation.claimed_verdict === "invalid") ctx.consecutiveFailures += 1;
    if (ctx.consecutiveFailures >= 3) {
      const answer = await humanGate(ctx, {
        phase: "repeated_failure",
        outcome: "progress",
        subtask_id: leaf.id,
        consecutive_failures: ctx.consecutiveFailures,
        detail: `${ctx.consecutiveFailures} consecutive episode failures (timeouts, errors or unreadable verdicts) on ${leaf.id}`,
      });
      ctx.consecutiveFailures = 0;
      if (answer.action === "stop") throw new RunAborted("repeated_failure", "blocked", `repeated failures on ${leaf.id}; operator stopped the run`);
      if (answer.instructions) appendDecision(ctx, `operator instructions after repeated failures on ${leaf.id}`, answer.instructions);
    }
    state.writePlan(plan);
  }
  setLeafStatus(plan, leaf.id, "blocked", `no PASS after ${config.max_eval_rounds} composer/evaluator rounds`);
  state.writePlan(plan);
  state.event("subtask_blocked", { subtask_id: leaf.id, rounds: (nodeById(plan, leaf.id) as PlanNode).rounds });
  progress(ctx, "subtask_blocked", { subtask_id: leaf.id });
}

function applyEvaluatorPlanChanges(ctx: LoopContext, plan: Plan, leaf: PlanNode, evaluation: EvaluationRecord): void {
  if (!evaluation.plan_changes.length) return;
  const result = applyPlanChanges(plan, evaluation.plan_changes, `evaluator:${leaf.id}`);
  ctx.state.event("plan_revised", {
    revision: plan.revision,
    by: `evaluator:${leaf.id}`,
    applied: result.applied.map((item) => ({ op: item.change.op, node_id: item.node_id, reason: item.change.reason ?? "" })),
    rejected: result.rejected.map((item) => ({ op: item.change.op, reason: item.reason })),
  });
  if (result.applied.length) {
    ctx.state.writePlan(plan, { revisionNote: `evaluator:${leaf.id}` });
    progress(ctx, "plan_revised", { revision: plan.revision, applied: result.applied.length, rejected: result.rejected.length });
  }
}

// ---------------------------------------------------------------------------
// Rubric
// ---------------------------------------------------------------------------

async function phaseRubric(ctx: LoopContext, plan: Plan, leaf: PlanNode): Promise<Contract> {
  const { state, config } = ctx;
  state.setPhase({ phase: "executing", current_subtask: leaf.id, current_role: "rubric", detail: leaf.title });
  const sections = commonSections(ctx);
  sections.push(
    { title: "Plan (with status)", body: renderPlanMarkdown(plan, { withStatus: true, highlight: leaf.id }) },
    { title: "The subtask this rubric is for", body: renderNodeBrief(plan, leaf.id) },
    { title: "Planner research notes available", body: listFiles(state.dir("research")).join("\n") || "(none)" },
    {
      title: "Rubrics already written for other subtasks (reuse what applies; research only what differs)",
      body: listFiles(state.dir("rubrics")).filter((file) => file.endsWith(".md")).join("\n") || "(none yet)",
    },
    { title: "Memory index", body: memoryIndexText(config.memory_dir) },
  );
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptSections = feedback ? [...sections, { title: "Harness feedback on your previous attempt", body: feedback }] : sections;
    const prompt = buildRolePrompt({
      role: "rubric",
      vars: { ...promptVars(ctx, "rubric"), subtask_id: leaf.id },
      briefing: state.readBriefing("rubric"),
      sections: attemptSections,
    });
    const episode = await runEpisode(ctx, "rubric", prompt, {
      subtaskId: leaf.id,
      budget: config.budgets.rubric,
      hooks: mergeHookSets(
        operatorControlHooks(config.workspace_path),
        writeScopeHooks({ roleName: "rubric agent", allowed: [state.dir("rubrics"), config.memory_dir], denied: [state.dir("contracts"), state.dir("evaluations"), state.dir("plan")] }, config.workspace_path),
      ),
      agents: loopSubagents(subagentContext(ctx)),
    });
    const block = extractJsonBlock(episode.visible);
    if (block) {
      try {
        const contract = parseContract(block, leaf.id);
        contract.criteria = contract.criteria.map((item) => ({ ...item, passes: false, score: null, finding: "" }));
        state.writeContract(contract);
        if (!fs.existsSync(state.rubricPath(leaf.id))) {
          state.writeJson(`${state.rubricPath(leaf.id)}.missing`, { note: "the rubric agent did not write the markdown rubric; the contract is the rubric" });
          fs.writeFileSync(state.rubricPath(leaf.id), renderContractMarkdown(contract), "utf-8");
        }
        state.event("rubric_written", { subtask_id: leaf.id, criteria: contract.criteria.length, mandatory: contract.criteria.filter((item) => item.mandatory).length, attempt });
        progress(ctx, "rubric_written", { subtask_id: leaf.id, criteria: contract.criteria.length });
        return contract;
      } catch (exc) {
        feedback = `Your contract JSON could not be used: ${exceptionText(exc)}.`;
      }
    } else {
      feedback = "Your final message contained no fenced ```json contract block.";
    }
    state.event("rubric_rejected", { subtask_id: leaf.id, attempt, reason: feedback });
  }
  // Fallback: the planner's acceptance statements become the contract so the
  // subtask can still be worked and graded.
  const fallback = parseContract(
    {
      criteria: (leaf.acceptance.length ? leaf.acceptance : [leaf.goal || leaf.title]).map((statement, index) => ({
        id: `a${index + 1}`,
        statement,
        verify: "inspect the deliverables named in the plan",
        evidence: "files, screenshots or tool output showing the statement holds",
        mandatory: true,
        weight: 1,
        passes: false,
      })),
      scoring: { scale: "pass/fail", pass_rule: "all criteria pass" },
    },
    leaf.id,
  );
  state.writeContract(fallback);
  fs.writeFileSync(state.rubricPath(leaf.id), `# Rubric for ${leaf.id} (fallback)\n\nThe rubric agent produced no usable contract; the planner's acceptance statements are the contract.\n\n${renderContractMarkdown(fallback)}`, "utf-8");
  state.event("rubric_fallback", { subtask_id: leaf.id, criteria: fallback.criteria.length });
  return fallback;
}

function renderContractMarkdown(contract: Contract): string {
  const lines = ["| id | criterion | verify | evidence | mandatory | weight |", "|---|---|---|---|---|---|"];
  for (const item of contract.criteria) {
    lines.push(`| ${item.id} | ${item.statement} | ${item.verify} | ${item.evidence} | ${item.mandatory ? "yes" : "no"} | ${item.weight} |`);
  }
  lines.push("", `Pass rule: ${contract.scoring.pass_rule}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

async function phaseCompose(ctx: LoopContext, plan: Plan, leaf: PlanNode, contract: Contract, round: number): Promise<EpisodeResult> {
  const { state, config } = ctx;
  const pack = selectComposerContext({
    stateDir: state.stateDir,
    workspace: config.workspace_path,
    memoryDir: config.memory_dir,
    plan,
    subtaskId: leaf.id,
    round,
  });
  const rendered = renderContextPack(pack);
  state.writeContextPack(leaf.id, round, { ...pack, sections: pack.sections.map((section) => ({ ...section, text: undefined })) }, rendered);
  state.event("context_selected", {
    subtask_id: leaf.id,
    round,
    sections: pack.sections.map((section) => ({ title: section.title, kind: section.kind, chars: section.chars, reason: section.reason })),
    selector: pack.selector,
    error: pack.error ?? null,
  });
  fs.mkdirSync(state.evidenceDir(leaf.id), { recursive: true });
  const sections = commonSections(ctx);
  sections.push(
    { title: "Plan (with status)", body: renderPlanMarkdown(plan, { withStatus: true, highlight: leaf.id }) },
    { title: `Your subtask (round ${round} of at most ${config.max_eval_rounds})`, body: renderNodeBrief(plan, leaf.id) },
    { title: "Contract (default-FAIL; the evaluator flips rows, you satisfy them)", body: "```json\n" + jsonDumpsIndent2(contract) + "\n```\n\nRubric: " + state.rubricPath(leaf.id) },
    { title: "Context pack selected for this round", body: rendered },
    {
      title: "Paths for this subtask",
      body: [
        `Progress note (required): ${state.progressPath(leaf.id)}`,
        `Evidence folder: ${state.evidenceDir(leaf.id)}`,
        `Evidence ledger (hook-written): ${state.ledgerPath(leaf.id)}`,
      ].join("\n"),
    },
  );
  const prompt = buildRolePrompt({
    role: "composer",
    vars: { ...promptVars(ctx, "composer"), subtask_id: leaf.id },
    briefing: state.readBriefing("composer"),
    sections,
  });
  const guardPaths = [...config.guard_exclude_paths, path.join(config.workspace_path, ".lh-harness"), config.memory_dir];
  const before = snapshotWorkspace(config.workspace_path, guardPaths);
  const episode = await runEpisode(ctx, "composer", prompt, {
    subtaskId: leaf.id,
    round,
    budget: config.budgets.composer,
    hooks: mergeHookSets(
      operatorControlHooks(config.workspace_path),
      composerHooks({
        workspace: config.workspace_path,
        subtaskId: leaf.id,
        round,
        ledgerPath: state.ledgerPath(leaf.id),
        progressPath: state.progressPath(leaf.id),
        criteriaIds: contract.criteria.map((item) => item.id),
        denied: [state.dir("contracts"), state.dir("evaluations"), state.dir("plan"), state.dir("prompts"), state.dir("context")],
      }),
    ),
    agents: loopSubagents(subagentContext(ctx)),
  });
  const after = snapshotWorkspace(config.workspace_path, guardPaths);
  const diff = workspaceSnapshotDiff(before, after);
  state.writeJson(path.join(state.evidenceDir(leaf.id), `changes-r${round}.json`), {
    round,
    ...(diff.verifier_workspace_mutations as Record<string, unknown>),
  });
  state.event("composer_finished", {
    subtask_id: leaf.id,
    round,
    episode_status: episodeStatus(episode.result),
    progress_note: fs.existsSync(state.progressPath(leaf.id)),
    ledger_entries: readLedger(state.ledgerPath(leaf.id)).length,
    workspace_changes: diff.verifier_workspace_mutation_counts,
  });
  return episode.result;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

async function phaseEvaluate(ctx: LoopContext, plan: Plan, leaf: PlanNode, contract: Contract, round: number): Promise<EvaluationRecord> {
  const { state, config } = ctx;
  const ledger = readLedger(state.ledgerPath(leaf.id));
  const ledgerSummary = ledger.length
    ? ledger
        .slice(-200)
        .map((entry) => (entry.kind === "write" ? `${entry.tool} ${entry.path} (${entry.sha256_before ? "modified" : "created"}, ${entry.bytes ?? "?"} bytes)` : `Bash: ${entry.command}`))
        .join("\n")
    : "(the ledger is empty: the composer wrote nothing through Write/Edit and ran no shell commands)";
  const previous = state.readEvaluations(leaf.id);
  const sections = commonSections(ctx);
  sections.push(
    { title: "Plan (with status)", body: renderPlanMarkdown(plan, { withStatus: true, highlight: leaf.id }) },
    { title: `The subtask under evaluation (round ${round})`, body: renderNodeBrief(plan, leaf.id) },
    { title: "Contract", body: "```json\n" + jsonDumpsIndent2(contract) + "\n```\n\nRubric: " + state.rubricPath(leaf.id) },
    { title: "Composer progress note (a claim, not evidence)", body: state.readProgress(leaf.id) || "(no progress note was written)" },
    { title: "Evidence ledger (hook-written, trustworthy about what changed)", body: ledgerSummary },
    { title: "Evidence folder", body: `${state.evidenceDir(leaf.id)}\n${listFiles(state.evidenceDir(leaf.id)).join("\n") || "(empty)"}` },
  );
  if (previous.length) {
    sections.push({
      title: "Your earlier verdicts on this subtask",
      body: previous.map((item) => `round ${item.round}: ${item.verdict} — ${item.summary}${item.findings.length ? `\n  findings: ${item.findings.join("; ")}` : ""}`).join("\n"),
    });
  }
  const prompt = buildRolePrompt({
    role: "evaluator",
    vars: { ...promptVars(ctx, "evaluator"), subtask_id: leaf.id },
    briefing: state.readBriefing("evaluator"),
    sections,
  });
  const episode = await runEpisode(ctx, "evaluator", prompt, {
    subtaskId: leaf.id,
    round,
    budget: config.budgets.evaluator,
    hooks: mergeHookSets(
      operatorControlHooks(config.workspace_path),
      writeScopeHooks({ roleName: "evaluator", allowed: [config.memory_dir], denied: [] }, config.workspace_path),
    ),
    agents: loopSubagents(subagentContext(ctx)),
  });
  let block = extractJsonBlock(episode.visible);
  let record = parseEvaluation(block, {
    subtaskId: leaf.id,
    round,
    contract,
    narrative: narrativeBeforeJson(episode.visible),
    episodeDir: episode.episodeDir,
  });
  // A PASS that skipped rows is usually an omission, not a judgement. One
  // short follow-up grades exactly the missing rows before the verdict is
  // settled; that is far cheaper than a whole composer round.
  const missing = ungradedCriteria(record);
  if (record.claimed_verdict === "PASS" && missing.length && episode.result.status === "done") {
    state.event("evaluation_incomplete", { subtask_id: leaf.id, round, ungraded: missing });
    const followUp = await runEpisode(ctx, "evaluator", buildRolePrompt({
      role: "evaluator",
      vars: { ...promptVars(ctx, "evaluator"), subtask_id: leaf.id, min_research_agents: 0 },
      briefing: "",
      sections: [
        { title: "Follow-up: grade only the criteria you left out", body: `Your previous verdict for this subtask graded every criterion except: ${missing.join(", ")}. Verify exactly those criteria now (contract below), with the same rigour, and return the same JSON shape containing ONLY those criteria plus verdict/summary/findings. Do not spawn research subagents.` },
        { title: "Contract", body: "```json\n" + jsonDumpsIndent2({ ...contract, criteria: contract.criteria.filter((item) => missing.includes(item.id)) }) + "\n```" },
        { title: "Your previous narrative", body: record.narrative.slice(0, 20_000) },
      ],
    }), { subtaskId: leaf.id, round, budget: new EpisodeBudget(Math.min(900, config.budgets.evaluator.max_duration_seconds)), hooks: writeScopeHooks({ roleName: "evaluator", allowed: [config.memory_dir], denied: [] }, config.workspace_path) });
    const extra = extractJsonBlock(followUp.visible);
    if (extra && Array.isArray(extra.criteria) && block) {
      const merged = { ...block, criteria: [...(block.criteria as unknown[]), ...extra.criteria] };
      block = merged;
      record = parseEvaluation(block, { subtaskId: leaf.id, round, contract, narrative: `${record.narrative}\n\n## Follow-up on ${missing.join(", ")}\n\n${narrativeBeforeJson(followUp.visible)}`, episodeDir: episode.episodeDir });
      record.harness_note = `${record.harness_note ? `${record.harness_note}; ` : ""}criteria ${missing.join(", ")} graded in a follow-up episode`;
    }
  }
  if (episode.result.status !== "done") {
    record.verdict = "NEEDS_WORK";
    record.harness_note = `${record.harness_note ? `${record.harness_note}; ` : ""}evaluator episode ended with status ${episode.result.status}${episode.result.error ? ` (${episode.result.error})` : ""}`;
  }
  if (workspaceMutationDetected(episode.result)) {
    const mutations = (episode.result.metadata as Record<string, unknown>)["verifier_workspace_mutations"];
    record.harness_note = `${record.harness_note ? `${record.harness_note}; ` : ""}the evaluator modified the workspace (${JSON.stringify(mutations).slice(0, 400)}); its verdict is recorded but flagged`;
    state.event("evaluator_mutation", { subtask_id: leaf.id, round, mutations });
  }
  state.writeEvaluation(record);
  state.event("evaluation", {
    subtask_id: leaf.id,
    round,
    verdict: record.verdict,
    claimed_verdict: record.claimed_verdict,
    passes: record.criteria.filter((item) => item.passes).length,
    criteria: record.criteria.length,
    findings: record.findings.length,
    plan_changes: record.plan_changes.length,
    harness_note: record.harness_note,
    episode_status: episodeStatus(episode.result),
  });
  progress(ctx, "evaluation", { subtask_id: leaf.id, round, verdict: record.verdict, passes: record.criteria.filter((item) => item.passes).length, criteria: record.criteria.length });
  return record;
}

// ---------------------------------------------------------------------------
// Phase 3: final response + report
// ---------------------------------------------------------------------------

async function phaseFinalize(ctx: LoopContext, plan: Plan): Promise<Record<string, unknown>> {
  const { state, config } = ctx;
  state.setPhase({ phase: "finalizing", current_role: "final_response", detail: "writing the closing message" });
  state.event("phase_started", { phase: "finalizing" });
  const counts = countStatuses(plan);
  const allLeaves = leaves(plan);
  const completion = allLeaves.length > 0 && counts.done > 0 && counts.pending + counts.blocked + counts.rubric + counts.composing + counts.evaluating === 0;
  const sections = commonSections(ctx);
  sections.push(
    { title: "Final plan status", body: renderPlanMarkdown(plan, { withStatus: true }) },
    {
      title: "Per-subtask outcome",
      body: allLeaves
        .map((leaf) => {
          const evaluations = state.readEvaluations(leaf.id);
          const last = evaluations[evaluations.length - 1];
          return `- ${leaf.id} (${leaf.title}): ${leaf.status}${last ? ` — last verdict ${last.verdict}: ${last.summary}${last.findings.length ? `; open findings: ${last.findings.join("; ")}` : ""}` : ""}${leaf.deliverables.length ? `\n  deliverables: ${leaf.deliverables.join(", ")}` : ""}`;
        })
        .join("\n"),
    },
    { title: "Run outcome", body: ctx.abortReason ? `The run stopped early: ${ctx.abortReason}${ctx.failureReason ? ` — ${ctx.failureReason}` : ""}` : completion ? "Every subtask passed its evaluation." : "Not every subtask passed." },
  );
  const prompt = buildRolePrompt({ role: "final_response", vars: promptVars(ctx), briefing: "", sections });
  try {
    const episode = await runEpisode(ctx, "final_response", prompt, { budget: config.budgets.final_response });
    ctx.finalResponse = pyStrip(episode.visible);
  } catch (exc) {
    if (isCancellation(exc)) throw exc;
    ctx.finalResponse = "";
  }
  if (!ctx.finalResponse) {
    ctx.finalResponse = `Run ended with ${counts.done} of ${allLeaves.length} subtasks passed${ctx.abortReason ? ` (stopped: ${ctx.abortReason})` : ""}. See the plan and evaluations under ${state.stateDir}.`;
  }
  state.writeFinalResponse(ctx.finalResponse);
  const terminal: TerminalStatus = completion
    ? "completed"
    : ctx.abortReason === "user_cancelled" || ctx.abortReason === "human_abort"
      ? "cancelled"
      : ctx.abortReason === "max_rounds_exhausted"
        ? "incomplete"
        : counts.blocked > 0
          ? "blocked"
          : "incomplete";
  if (completion && ctx.options.humanHook) {
    const answer = await humanGate(ctx, { phase: "completed", outcome: "completed", final_response: ctx.finalResponse, status_counts: counts });
    if (answer.action === "continue" && answer.instructions) {
      appendDecision(ctx, "follow-up after completion", answer.instructions);
      const amended = await amendPlan(ctx, plan, answer.instructions);
      if (amended) {
        ctx.roundBudget = ctx.composerEpisodes + Math.max(1, answer.extra_rounds || config.max_total_episodes);
        await phaseExecute(ctx, plan);
        return await phaseFinalize(ctx, plan);
      }
    }
  }
  return writeTerminal(ctx, terminal, {});
}

/** Follow-up after completion: the planner turns operator instructions into plan changes. */
async function amendPlan(ctx: LoopContext, plan: Plan, instructions: string): Promise<boolean> {
  const { state, config } = ctx;
  state.setPhase({ phase: "planning", current_role: "planner", detail: "amending the plan with the operator's follow-up" });
  const sections = commonSections(ctx);
  sections.push(
    { title: "Current plan (with status)", body: renderPlanMarkdown(plan, { withStatus: true }) },
    { title: "Operator follow-up", body: instructions },
    {
      title: "Amendment mode",
      body:
        "The run already completed. Do NOT return a whole new plan. Return one fenced json block of the form {\"plan_changes\": [ {op: add|remove|modify, parent_id?, node_id?, node?, reason} ]} that adds the new leaves (or modifies pending ones) needed for the follow-up. Research only if the follow-up needs it.",
    },
  );
  const prompt = buildRolePrompt({ role: "planner", vars: promptVars(ctx), briefing: state.readBriefing("planner"), sections });
  const episode = await runEpisode(ctx, "planner", prompt, {
    budget: config.budgets.planner,
    hooks: mergeHookSets(
      operatorControlHooks(config.workspace_path),
      writeScopeHooks({ roleName: "planner", allowed: [state.dir("research"), config.memory_dir], denied: [state.planPath, state.dir("contracts"), state.dir("evaluations")] }, config.workspace_path),
    ),
    agents: loopSubagents(subagentContext(ctx)),
  });
  const block = extractJsonBlock(episode.visible);
  const changes = block && Array.isArray(block.plan_changes) ? block.plan_changes : null;
  if (!changes) {
    state.event("plan_amend_rejected", { reason: "no plan_changes block" });
    return false;
  }
  const result = applyPlanChanges(plan, changes, "planner:follow-up");
  state.event("plan_revised", {
    revision: plan.revision,
    by: "planner:follow-up",
    applied: result.applied.map((item) => ({ op: item.change.op, node_id: item.node_id, reason: item.change.reason ?? "" })),
    rejected: result.rejected.map((item) => ({ op: item.change.op, reason: item.reason })),
  });
  if (result.applied.length) state.writePlan(plan, { revisionNote: "operator follow-up" });
  return result.applied.length > 0 && nextReadyLeaf(plan) !== null;
}

function writeTerminal(ctx: LoopContext, status: TerminalStatus, extra: Record<string, unknown>): Record<string, unknown> {
  const { state, config } = ctx;
  const existing = state.readReport();
  if (existing && ["completed", "failed", "cancelled", "blocked", "incomplete"].includes(String(existing.status))) {
    return existing;
  }
  const plan = state.readPlan();
  const counts = plan ? countStatuses(plan) : null;
  const elapsed = Math.round((monotonic() - ctx.startedAt) * 1000) / 1000;
  const episodes = state.readEpisodeIndex();
  const cost = episodes.reduce((sum, entry) => sum + (entry.cost_usd ?? 0), 0);
  const report: Record<string, unknown> = {
    schema_version: REPORT_SCHEMA_VERSION,
    variant: LOOP_VARIANT,
    mode: "plan_tree",
    status,
    task: ctx.options.task,
    completion_satisfied: status === "completed",
    completion_authority: "evaluator_contracts",
    rounds_run: ctx.composerEpisodes,
    max_rounds: ctx.roundBudget,
    abort_reason: ctx.abortReason,
    failure_reason: ctx.failureReason,
    error: extra.error ?? null,
    plan_title: plan?.title ?? "",
    plan_summary: plan?.summary ?? "",
    status_counts: counts,
    subtasks: plan ? leaves(plan).map((leaf) => ({ id: leaf.id, title: leaf.title, status: leaf.status, rounds: leaf.rounds, last_verdict: leaf.last_verdict, deliverables: leaf.deliverables })) : [],
    final_response: ctx.finalResponse,
    elapsed_seconds: elapsed,
    started_at: Date.now() / 1000 - elapsed,
    finished_at: Date.now() / 1000,
    cost_usd: Math.round(cost * 10000) / 10000,
    episodes: episodes.length,
    workspace: config.workspace_path,
    state_dir: state.stateDir,
    ...extra,
  };
  state.writeReport(report);
  state.setPhase({ phase: "finished", detail: status });
  try {
    mergeEpisodeLogs(config.log_dir);
    regenerateMemoryIndex(config.memory_dir);
  } catch {
    /* best effort */
  }
  const eventName = status === "cancelled" ? "run_cancelled" : status === "failed" ? "run_failed" : "run_finished";
  state.event(eventName, { status, completion_satisfied: status === "completed", abort_reason: ctx.abortReason, reason: ctx.failureReason, cost_usd: report.cost_usd, elapsed_seconds: elapsed });
  progress(ctx, "run_done", { status, completion_satisfied: status === "completed", abort_reason: ctx.abortReason, rounds_run: ctx.composerEpisodes, elapsed_seconds: elapsed, report_path: path.join(config.log_dir, "report.json"), cost_usd: report.cost_usd });
  return report;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

interface EpisodeOutcome {
  result: EpisodeResult;
  visible: string;
  episodeDir: string;
}

/** Provider failures that no retry can fix: the operator has to act. */
const FATAL_PROVIDER_KINDS = new Set(["authentication", "quota", "model_unavailable"]);
/** Transient failures worth one retry after a pause (seconds). */
const RETRYABLE_PROVIDER_KINDS = new Set(["network", "rate_limit", "provider_error"]);
const PROVIDER_RETRY_PAUSE_SECONDS = process.env.LH_HARNESS_TEST_FAST_RETRY ? 0 : 45;

async function runEpisode(
  ctx: LoopContext,
  role: RoleName,
  prompt: string,
  options: { budget: EpisodeBudget; subtaskId?: string; round?: number; hooks?: HookSet; agents?: unknown; attempt?: number },
): Promise<EpisodeOutcome> {
  const { state, config } = ctx;
  if (ctx.options.signal?.aborted) throw new RunAborted("user_cancelled", "cancelled", "operator cancelled the run");
  const agent = ctx.options.agents[role];
  if (!agent) throw new Error(`no agent configured for role ${role}`);
  const episodeDir = allocateEpisodeDir(config.log_dir, role);
  const ep = Number.parseInt(path.basename(episodeDir).slice(2), 10) || 0;
  const seq = state.nextEpisodeSeq();
  const startedAt = Date.now() / 1000;
  state.appendEpisodeIndex({ seq, ep, role, subtask_id: options.subtaskId ?? null, round: options.round ?? null, dir: episodeDir, status: "running", started_at: startedAt, finished_at: null, duration_ms: null, cost_usd: null, error: null });
  state.event("episode_started", { role, subtask_id: options.subtaskId ?? null, round: options.round ?? null, seq, prompt_chars: prompt.length, budget_seconds: options.budget.max_duration_seconds });
  progress(ctx, "role_start", { role, subtask_id: options.subtaskId ?? null, round: options.round ?? null });
  fs.writeFileSync(path.join(episodeDir, "prompt.md"), prompt, "utf-8");
  const result = await runRoleEpisode(agent, prompt, ctx.options.env, options.budget, {
    liveTrajectoryPath: path.join(episodeDir, `${role}_raw_trajectory.jsonl`),
    signal: ctx.options.signal ?? undefined,
    hooks: options.hooks,
    agents: options.agents,
    maxBudgetUsd: config.episode_budget_usd > 0 ? config.episode_budget_usd : undefined,
  });
  let artifacts: Record<string, unknown> = {};
  try {
    artifacts = saveEpisode({ episodeDir, roleName: role, prompt, result });
  } catch (exc) {
    state.event("episode_record_failed", { role, seq, reason: exceptionText(exc) });
  }
  const status = episodeStatus(result);
  const cost = typeof status.cost_usd === "number" ? status.cost_usd : null;
  if (cost) ctx.totalCostUsd += cost;
  state.appendEpisodeIndex({
    seq,
    ep,
    role,
    subtask_id: options.subtaskId ?? null,
    round: options.round ?? null,
    dir: episodeDir,
    status: result.status,
    started_at: startedAt,
    finished_at: Date.now() / 1000,
    duration_ms: result.duration_ms,
    cost_usd: cost,
    error: result.error ?? null,
  });
  state.event("episode_finished", { role, subtask_id: options.subtaskId ?? null, round: options.round ?? null, seq, status: result.status, episode_status: status, screenshots: artifacts.screenshot_count ?? 0 });
  progress(ctx, "role_done", { role, subtask_id: options.subtaskId ?? null, round: options.round ?? null, status: result.status, duration_ms: result.duration_ms, cost_usd: cost, error: result.error ?? null });
  regenerateMemoryIndex(config.memory_dir);
  if (result.status === "cancelled") throw new RunAborted("user_cancelled", "cancelled", "operator cancelled the run");
  const failure = classifyProviderFailure(result);
  if (failure) {
    const attempt = options.attempt ?? 1;
    const fatal = FATAL_PROVIDER_KINDS.has(failure.kind);
    const retry = !fatal && RETRYABLE_PROVIDER_KINDS.has(failure.kind) && attempt === 1;
    state.event("agent_runtime_failed", { role, kind: failure.kind, message: failure.message, attempt, fatal, retry });
    // Only credentials/quota/model problems end the run. A dropped connection,
    // a rate limit or an unexplained provider error gets one retry after a
    // pause; a timeout (or a failed retry) is a failed round that the caller
    // records — the repeated-failure gate covers loops.
    if (fatal) throw new RunAborted(failure.abort_reason, "failed", failure.user_message);
    if (retry) {
      progress(ctx, "role_retry", { role, subtask_id: options.subtaskId ?? null, round: options.round ?? null, kind: failure.kind, pause_seconds: PROVIDER_RETRY_PAUSE_SECONDS });
      await pause(PROVIDER_RETRY_PAUSE_SECONDS, ctx.options.signal ?? undefined);
      return runEpisode(ctx, role, prompt, { ...options, attempt: attempt + 1 });
    }
  }
  return { result, visible: pyStrip(visibleOutput(result)), episodeDir };
}

// ---------------------------------------------------------------------------
// Prompt plumbing
// ---------------------------------------------------------------------------

/** Research fan-out per role: the planner gets the full budget; per-subtask roles a third (at least 3). */
export function researchAgentsFor(role: RoleName, minResearchAgents: number): number {
  if (minResearchAgents <= 0) return 0;
  if (role === "planner") return minResearchAgents;
  return Math.max(3, Math.ceil(minResearchAgents / 3));
}

function promptVars(ctx: LoopContext, role: RoleName = "planner"): Record<string, string | number> {
  const { config, state } = ctx;
  return {
    workspace: config.workspace_path,
    sources_dir: config.sources_dir,
    state_dir: state.stateDir,
    memory_dir: config.memory_dir,
    hidden_paths: (ctx.options.hiddenPaths ?? []).join(", ") || "(none)",
    capability_note: config.capability_note,
    min_research_agents: researchAgentsFor(role, config.min_research_agents),
  };
}

function commonSections(ctx: LoopContext): PromptSection[] {
  const { state, config } = ctx;
  const sections: PromptSection[] = [{ title: "Operator task", body: state.readTask() || ctx.options.task }];
  const sources = listSources(config.sources_dir);
  if (sources.length) sections.push({ title: "Operator-provided sources", body: sources.map((item) => `- ${path.join(config.sources_dir, item)}`).join("\n") });
  const decisions = readDecisions(ctx);
  if (decisions) sections.push({ title: "Operator decisions and answers (standing; they outrank the plan)", body: decisions });
  return sections;
}

function subagentContext(ctx: LoopContext) {
  return { memoryDir: ctx.config.memory_dir, sourcesDir: ctx.config.sources_dir, stateDir: ctx.state.stateDir, researchModel: ctx.config.research_model };
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith(".")).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Operator channel: decisions ledger + human gate
// ---------------------------------------------------------------------------

function decisionsPath(ctx: LoopContext): string {
  return path.join(ctx.state.dir("task"), "DECISIONS.md");
}

function readDecisions(ctx: LoopContext): string {
  try {
    return fs.readFileSync(decisionsPath(ctx), "utf-8").trim();
  } catch {
    return "";
  }
}

function appendDecision(ctx: LoopContext, heading: string, text: string): void {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  fs.appendFileSync(decisionsPath(ctx), `\n## ${stamp} — ${heading}\n\n${text.trim()}\n`, "utf-8");
  ctx.state.event("operator_decision", { heading, chars: text.length });
  appendMemoryLog(ctx.config.memory_dir, `operator decision recorded (${heading})`);
}

function drainInstructions(ctx: LoopContext): void {
  const pending = ctx.options.pendingInstructions?.() ?? [];
  const text = pending.map((item) => item.trim()).filter((item) => item).join("\n");
  if (text) appendDecision(ctx, "operator instruction", text);
}

interface GateAnswer {
  action: "continue" | "stop";
  instructions: string;
  extra_rounds: number;
}

async function humanGate(ctx: LoopContext, context: Record<string, unknown>): Promise<GateAnswer> {
  const hook = ctx.options.humanHook;
  if (!hook) return { action: "continue", instructions: "", extra_rounds: 0 };
  const plan = ctx.state.readPlan();
  ctx.state.event("human_gate", { phase: context.phase, outcome: context.outcome, subtask_id: context.subtask_id ?? null });
  const raw = await hook({
    ...context,
    task: ctx.options.task,
    composer_episodes: ctx.composerEpisodes,
    round_budget: ctx.roundBudget,
    round_index: ctx.composerEpisodes,
    plan_status: plan ? countStatuses(plan) : null,
    log_dir: ctx.config.log_dir,
  });
  const action = raw.action === "stop" ? "stop" : "continue";
  const instructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
  const extra = Number(raw.extra_rounds);
  ctx.state.event("human_gate_resolved", { phase: context.phase, action, instructions_chars: instructions.length, extra_rounds: Number.isFinite(extra) ? extra : 0 });
  return { action, instructions, extra_rounds: Number.isFinite(extra) && extra > 0 ? Math.trunc(extra) : 0 };
}

function pause(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function progress(ctx: LoopContext, event: string, payload: Record<string, unknown>): void {
  try {
    ctx.options.progress?.(event, payload);
  } catch {
    /* console sinks never take the loop down */
  }
}
