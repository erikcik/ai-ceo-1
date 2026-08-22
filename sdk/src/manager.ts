// Ported 1:1 from LongHorizon-Harness src/lh_harness/manager.py
//
// The four-role management loop (manager -> executor -> auditor -> gate) plus
// every artifact it owns: the per-round directory, the append-only round ledger,
// the event stream, the OSWorld-style episode records, the terminal report, and
// the crash boundary that guarantees a durable terminal record even when the
// loop dies.
//
// On-disk formats keep the Python key names verbatim, so a run directory
// written here is byte-compatible with the original harness.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentAdapter } from "./adapters/base.js";
import {
  assistantTexts as decodeAgentAssistantTexts,
  visibleOutput as decodeAgentVisibleOutput,
} from "./agent_logs.js";
import {
  VISIBLE_OUTPUT_KEYS,
  auditReportFromEpisodeResult,
  auditorReportTextFromEpisodeResult,
  hasValidAuditorControlHeader,
  parseAuditReport,
} from "./auditor_agent.js";
import type { Environment } from "./environment/base.js";
import { ensureRemoteDir, writeRemoteText } from "./environment/remote_files.js";
// Agent B's provider classifier. Expected shape:
//   classifyProviderFailure(result: EpisodeResult): AgentRuntimeFailure | null
//   AgentRuntimeFailure = { kind, abort_reason, message, user_message }
import { classifyProviderFailure } from "./provider_errors.js";
import {
  MANAGER_NEXT_ASK,
  MANAGER_NEXT_BLOCKED,
  MANAGER_NEXT_CLI,
  MANAGER_NEXT_DONE,
  MANAGER_NEXT_GUI,
  MANAGER_NEXT_INVALID,
  buildRoleAuditorFormatRepairPrompt,
  buildRoleAuditorPrompt,
  buildRoleExecutorPrompt,
  buildRoleFinalResponsePrompt,
  buildRoleManagerPrompt,
  extractRelatedReportRefs,
  extractRoleManagerAnswerChoices,
  extractRoleManagerPlanText,
  extractRoleManagerQuestion,
  extractRoleTaskContract,
  extractRoleTaskState,
  formatManagementHistory,
  formatRelatedAuditorReports,
  parseRoleManagerNextStep,
} from "./role_prompts.js";
import { hardSignalLabels } from "./runtime_signals.js";
// Agent E's no-follow filesystem boundary. Expected shapes:
//   ensureDirNofollow(dir: string, mode?: number): void        // creates/validates the chain
//   atomicBytesWrite(file: string, payload: Uint8Array): void  // temp file + rename below an anchored parent
//   appendJsonl(file: string, record: object): void            // sort_keys JSON line, exclusive lock
//   openNofollow(p: string, options?: { directory?: boolean }): number
// Each throws rather than following a symlinked component.
import {
  appendJsonl as appendJsonlNofollow,
  atomicBytesWrite,
  ensureDirNofollow,
  openNofollow,
} from "./supervisor/control_bus.js";
import { persistTrajectoryArtifacts } from "./trajectory_artifacts.js";
import {
  EpisodeBudget,
  MAX_ROUNDS,
  episodeResult,
  managedRound,
  type EpisodeResult,
  type HarnessConfig,
  type ManagedRound,
  type RoleNextStep,
} from "./types.js";
import { pyRstrip, pyStrip } from "./utils/pystr.js";

export const ROLE_VARIANT = "lh_harness_role_managed";

const MAX_SAVED_TRAJECTORY_BYTES = 16 * 1024 * 1024;
const MAX_FAILURE_REPORT_BYTES = 1 * 1024 * 1024;
const MAX_FAILURE_EVENTS_BYTES = 4 * 1024 * 1024;
const MAX_FAILURE_EVENT_RECORDS = 50_000;
const MAX_ROUNDS_LEDGER_BYTES = 64 * 1024 * 1024;

const ROUTE_VALUES: ReadonlySet<string> = new Set([
  MANAGER_NEXT_GUI,
  MANAGER_NEXT_CLI,
  MANAGER_NEXT_DONE,
  MANAGER_NEXT_BLOCKED,
  MANAGER_NEXT_INVALID,
  MANAGER_NEXT_ASK,
]);

/** Python's module logger: WARNING and above reach stderr, DEBUG is dropped. */
const logger = {
  warning(message: string): void {
    process.stderr.write(`WARNING:lh_harness.manager:${message}\n`);
  },
  debug(_message: string): void {
    /* Python's default handler drops DEBUG. */
  },
};

// ---------------------------------------------------------------------------
// Harness-synthesized manager feedback
// ---------------------------------------------------------------------------

function invalidCompletionFeedback(_language: string): string {
  return (
    "Status: incomplete\n" +
    "Integrity: suspect\n" +
    "Contract audit: unknown\n" +
    "Audit facts: the manager requested completion, but the latest auditor report did not confirm every original requirement as complete with clean integrity and an aligned contract.\n" +
    "Gap: schedule an auditable GUI/CLI subtask or obtain an explicit auditor confirmation.\n" +
    "Next step: manage again; do not emit `Next: done` without complete/clean/aligned evidence."
  );
}

function invalidPlanFeedback(_language: string): string {
  return (
    "Status: incomplete\n" +
    "Integrity: suspect\n" +
    "Contract audit: unknown\n" +
    "Audit facts: the manager output did not contain a valid route, so no GUI or CLI executor can be assigned.\n" +
    "Gap: emit one dominant GUI/CLI subtask or an explicit ask/done/blocked route.\n" +
    "Next step: manage again using exactly `Next: gui`, `Next: cli`, `Next: ask`, `Next: done`, or `Next: blocked`."
  );
}

// ---------------------------------------------------------------------------
// Public option / result types
// ---------------------------------------------------------------------------

export type ProgressSink = (event: string, payload: Record<string, unknown>) => void;
export type HumanHook = (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type PendingInstructions = () => string[];

export interface RunOptions {
  task: string;
  env: Environment;
  config: HarnessConfig;
  agent?: AgentAdapter | null;
  auditorAgent?: AgentAdapter | null;
  managerAgent?: AgentAdapter | null;
  guiExecutorAgent?: AgentAdapter | null;
  cliExecutorAgent?: AgentAdapter | null;
  guiAuditorAgent?: AgentAdapter | null;
  cliAuditorAgent?: AgentAdapter | null;
  auditorFormatRepairAgent?: AgentAdapter | null;
  finalResponseAgent?: AgentAdapter | null;
  humanHook?: HumanHook | null;
  pendingInstructions?: PendingInstructions | null;
  progress?: ProgressSink | null;
  resume?: boolean;
  /** Cooperative cancellation; the Python uses asyncio task cancellation. */
  signal?: AbortSignal | null;
}

/** Mutable state retained by the worker boundary if the loop crashes. */
interface RunProgress {
  rounds: ManagedRound[];
  gate: GateContext | null;
  startedAt: number | null;
}

// ---------------------------------------------------------------------------
// run() — the crash/cancellation boundary
// ---------------------------------------------------------------------------

/**
 * Run the management loop and always leave a durable terminal record.
 *
 * The historical implementation only wrote `report.json` on the happy path. An
 * adapter, environment, or filesystem exception therefore left a worker with no
 * terminal event; the supervisor had no evidence and could incorrectly describe
 * it as completed. Keep the execution kernel in `runImpl` and make this boundary
 * the single crash/cancellation guard.
 */
export async function run(options: RunOptions): Promise<Record<string, unknown>> {
  const task = String(options?.task ?? "");
  const config = options?.config;
  const runProgress: RunProgress = { rounds: [], gate: null, startedAt: null };
  try {
    return await runImpl(options, runProgress);
  } catch (exc) {
    if (isCancellation(exc)) {
      return writeTerminalFailure(config, task, {
        status: "cancelled",
        reason: "worker task was cancelled",
        exc,
        abortReason: "worker_cancelled",
        progress: runProgress,
      });
    }
    // A thrown non-Error is intentionally converted to a failed artifact here;
    // the CLI process still exits through its normal return path afterwards.
    return writeTerminalFailure(config, task, {
      status: "failed",
      reason: `management loop crashed: ${exceptionText(exc)}`,
      exc,
      abortReason: "worker_exception",
      progress: runProgress,
    });
  }
}

/**
 * Run the generic LongHorizon-Harness four-role management loop.
 *
 * The default `agent` can back every role. Callers with stronger role controls
 * can pass distinct adapters for manager, GUI task, CLI task, GUI auditor, and
 * CLI auditor.
 *
 * `humanHook` is a single optional human-in-the-loop callback (used by the
 * dashboard for approval / instruction injection). It runs at the END of every
 * round with `context` describing that round's outcome; it returns
 * `{action, instructions, extra_rounds}`.
 *
 * `progress` is an optional synchronous `(event, payload)` sink for
 * operator-facing status lines (the CLI prints them to the console).
 */
async function runImpl(options: RunOptions, runProgress: RunProgress | null): Promise<Record<string, unknown>> {
  const { task, env, config } = options;
  const progress = options.progress ?? null;
  const humanHook = options.humanHook ?? null;
  const pendingInstructions = options.pendingInstructions ?? null;
  const resume = Boolean(options.resume);
  const signal = options.signal ?? null;

  const emit = (event: string, payload: Record<string, unknown>): void => {
    if (progress === null) return;
    try {
      progress(event, payload);
    } catch {
      // progress reporting must never break a run
      logger.debug(`progress callback failed for ${event}`);
    }
  };

  // Role binding is resolved once at startup so the main loop can stay focused
  // on state transitions instead of adapter fallback logic.
  const agent = options.agent ?? null;
  const managerAgent = options.managerAgent ?? agent;
  const guiExecutorAgent = options.guiExecutorAgent ?? agent;
  const cliExecutorAgent = options.cliExecutorAgent ?? agent;
  const guiAuditorAgent = options.guiAuditorAgent ?? options.auditorAgent ?? agent;
  const cliAuditorAgent = options.cliAuditorAgent ?? options.auditorAgent ?? agent;
  if (
    managerAgent === null ||
    guiExecutorAgent === null ||
    cliExecutorAgent === null ||
    guiAuditorAgent === null ||
    cliAuditorAgent === null
  ) {
    throw new Error("Every role needs an agent, or a default agent must be provided");
  }

  // Every role reads one explicit budget. Keeping the resolved budgets in the
  // config avoids the previous episode/auditor alias chain, where duplicate
  // fields made it unclear which timeout values actually won.
  const managerBudget = config.manager_budget;
  const guiExecutorBudget = config.gui_executor_budget;
  const cliExecutorBudget = config.cli_executor_budget;
  const auditorBudget = config.auditor_budget;

  // Keep every local ledger path canonical before deriving event ids or opening
  // anchored descriptors. A relative `--log-dir` is valid for the standalone
  // CLI, but deriving the event id from a relative path would make it depend on
  // the current working directory (and could collide across runs).
  const logDir = resolveNonStrict(config.log_dir);
  const roleDir = path.join(logDir, "role_orchestration");
  const roundsDir = path.join(roleDir, "rounds");
  ensureDirNofollow(roundsDir);
  const eventsPath = path.join(roleDir, "events.jsonl");
  const started = monotonic();

  await ensureRemoteLayout(env, config);

  const rounds: ManagedRound[] = [];
  let lastPlan = "";
  let currentTaskState = "";
  let currentTaskContract = "";
  let roundIndex = 0;

  if (resume) {
    // A resumed worker reopens the same ledger, so the loop continues from the
    // recorded rounds instead of restarting at 1. The Manager prompt is rebuilt
    // entirely from task + rounds + task state + contract, so replaying the
    // ledger restores the full planning context.
    rounds.push(...recordedRounds(roleDir));
    if (rounds.length) {
      const latest = rounds[rounds.length - 1]!;
      roundIndex = latest.round_index;
      lastPlan = latest.plan_text;
      currentTaskState = latest.task_state;
      currentTaskContract = latest.task_contract;
    }
  }

  // After a resume `max_total_episodes` is the *additional* budget, so the
  // effective ceiling continues from the restored rounds.
  const roundBudget = roundIndex + Math.max(1, config.max_total_episodes);
  appendEvent(eventsPath, "role_harness_start", {
    variant: ROLE_VARIANT,
    task_chars: task.length,
    workspace_path: config.workspace_path,
    harness_dir: config.harness_dir,
    max_rounds: roundBudget,
    manager_budget: budgetToDict(managerBudget),
    gui_executor_budget: budgetToDict(guiExecutorBudget),
    cli_executor_budget: budgetToDict(cliExecutorBudget),
    auditor_budget: budgetToDict(auditorBudget),
    resumed: Boolean(resume),
    resumed_rounds: rounds.length,
  });
  if (resume) {
    appendEvent(eventsPath, "role_harness_resumed", {
      restored_rounds: rounds.length,
      resume_from_round: roundIndex,
      round_budget: roundBudget,
      task_state_chars: currentTaskState.length,
      task_contract_chars: currentTaskContract.length,
    });
    emit("resumed", {
      restored_rounds: rounds.length,
      from_round: roundIndex,
      round_budget: roundBudget,
    });
  }

  // The gate context bundles run-scoped dependencies with the loop state the
  // end-of-round human gate updates (round budget, completion, abort reason,
  // carryover instructions). The loop calls one module-level gate function
  // directly and reads the results straight back from `gate`.
  const gate = createGateContext({
    humanHook,
    task,
    rounds,
    logDir,
    config,
    eventsPath,
    roundBudget,
    env,
    roleDir,
    responseAgent: options.finalResponseAgent ?? managerAgent,
    emit,
    signal,
  });
  if (runProgress !== null) {
    // The list and gate are mutated in place, so the outer crash boundary
    // always sees the latest completed rounds without checkpoint rewrites.
    runProgress.rounds = rounds;
    runProgress.gate = gate;
    runProgress.startedAt = started;
  }

  while (roundIndex < gate.roundBudget) {
    roundIndex += 1;
    const roundDir = path.join(roundsDir, `round_${pad3(roundIndex)}`);
    ensureDirNofollow(roundDir);
    emit("round_start", { round: roundIndex, round_budget: gate.roundBudget });

    // The manager sees the original task, its maintained task state, and
    // auditor reports. It never receives raw trajectories or previous full
    // prompts.
    let managerPrompt = buildRoleManagerPrompt({
      task,
      rounds,
      roundIndex,
      taskState: currentTaskState,
      taskContract: currentTaskContract,
      roundBudget: gate.roundBudget,
      language: config.prompt_language,
      maxHistoryChars: config.role_history_chars,
    });

    // Messages sent while the round was already running (or while the run was
    // stopped) only reach the gate at the end of a round, so a resumed worker
    // would replan a whole round before reading them. Claim them here so the
    // round they precede is the round that acts on them.
    if (pendingInstructions !== null) {
      const queued = pendingInstructions()
        .map((item) => pyStrip(item))
        .filter((item) => item);
      if (queued.length) {
        gate.carryoverInstructions = [gate.carryoverInstructions, ...queued].filter((part) => part).join("\n");
        gate.operatorInstructions.push(...queued);
      }
    }

    // Instructions carried over from the end-of-round human gate (queued
    // operator notes and/or an approval's free-form input) are injected into
    // this round's manager prompt.
    if (gate.carryoverInstructions) {
      const instructionHeading =
        "Operator instructions injected through the dashboard (high priority; incorporate them this round):";
      managerPrompt += `\n\n${instructionHeading}\n${gate.carryoverInstructions}\n`;
      writeLocal(path.join(roundDir, "human_instructions.txt"), gate.carryoverInstructions);
      appendEvent(eventsPath, "human_instructions_injected", {
        round: roundIndex,
        chars: gate.carryoverInstructions.length,
      });
      gate.carryoverInstructions = "";
    }

    writeLocal(path.join(roundDir, "manager_input.txt"), managerPrompt);
    await writeRemoteRoundText(env, config, roundIndex, "manager_input.txt", managerPrompt);
    appendEvent(eventsPath, "manager_round_start", { round: roundIndex, prompt_chars: managerPrompt.length });
    emit("role_start", { round: roundIndex, role: "manager" });

    const managerResult = await runRoleEpisode(managerAgent, managerPrompt, env, managerBudget, {
      liveTrajectoryPath: path.join(roundDir, "manager_raw_trajectory.jsonl"),
      signal,
    });
    saveRoleResult(roundDir, "manager", managerResult, {
      episodeRoot: path.join(logDir, "manager_episodes"),
    });
    if (managerResult.status === "cancelled") {
      gate.abortReason = "user_cancelled";
      appendEvent(eventsPath, "role_harness_cancelled", {
        round: roundIndex,
        phase: "manager",
        ...episodeEventFields(managerResult, { eventStatus: "cancelled" }),
      });
      break;
    }
    const managerFailure = classifyProviderFailure(managerResult);
    if (managerFailure !== null && managerFailure !== undefined) {
      const recoverableTimeout = managerFailure.kind === "timeout";
      const planText =
        (recoverableTimeout ? "Next: invalid\n\nReason:\n" : "Next: blocked\n\nReason:\n") +
        managerFailure.user_message;
      const record = managedRound({
        round_index: roundIndex,
        next_step: recoverableTimeout ? MANAGER_NEXT_INVALID : MANAGER_NEXT_BLOCKED,
        plan_text: planText,
        harness_feedback: managerFailure.user_message,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        manager_status: failedEpisodeStatus(managerResult, managerFailure.user_message),
        auditor_status: recoverableTimeout ? { invalid_plan: true } : {},
      });
      writeLocal(path.join(roundDir, "manager_plan.txt"), planText);
      writeLocal(path.join(roundDir, "harness_feedback.txt"), managerFailure.user_message);
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      appendEvent(eventsPath, "agent_runtime_failed", {
        round: roundIndex,
        phase: "manager",
        kind: managerFailure.kind,
        message: managerFailure.message,
        ...episodeEventFields(managerResult, {
          eventStatus: "failed",
          errorMessage: managerFailure.user_message,
        }),
      });
      emit("role_done", {
        round: roundIndex,
        role: "manager",
        status: "failed",
        duration_ms: managerResult.duration_ms,
        error: managerFailure.user_message,
      });
      if (recoverableTimeout) {
        if (await humanGate(gate, "progress", roundIndex, currentTaskState)) break;
        continue;
      }
      gate.abortReason = managerFailure.abort_reason;
      gate.failureReason = managerFailure.user_message;
      break;
    }
    let planText = pyStrip(extractRoleManagerPlanText(visibleOutput(managerResult)));
    if (!planText) {
      planText = "Next: blocked\n\nReason:\nThe manager produced no readable natural-language output.";
    }
    currentTaskState = extractRoleTaskState(planText, { fallback: currentTaskState });
    currentTaskContract = extractRoleTaskContract(planText, { fallback: currentTaskContract });
    const relatedReportRefs = extractRelatedReportRefs(planText);
    writeLocal(path.join(roundDir, "manager_plan.txt"), planText);
    writeLocal(path.join(roundDir, "task_state.txt"), currentTaskState);
    writeLocal(path.join(roundDir, "task_contract.txt"), currentTaskContract);
    await writeRemoteRoundText(env, config, roundIndex, "manager_plan.txt", planText);
    await writeRemoteRoundText(env, config, roundIndex, "task_state.txt", currentTaskState);
    await writeRemoteRoundText(env, config, roundIndex, "task_contract.txt", currentTaskContract);

    const nextStep = parseRoleManagerNextStep(planText) as RoleNextStep;
    lastPlan = planText;
    appendEvent(eventsPath, "manager_round_done", {
      round: roundIndex,
      next_step: nextStep,
      plan_chars: planText.length,
      task_state_chars: currentTaskState.length,
      task_contract_chars: currentTaskContract.length,
      related_report_refs: relatedReportRefs,
      ...episodeEventFields(managerResult, { eventStatus: "completed" }),
    });
    emit("role_done", {
      round: roundIndex,
      role: "manager",
      status: managerResult.status,
      duration_ms: managerResult.duration_ms,
      next_step: nextStep,
    });

    if (nextStep === MANAGER_NEXT_DONE) {
      if (latestAuditorIsCleanComplete(rounds, { language: config.prompt_language })) {
        gate.completionSatisfied = true;
        rounds.push(
          managedRound({
            round_index: roundIndex,
            next_step: nextStep,
            plan_text: planText,
            task_state: currentTaskState,
            task_contract: currentTaskContract,
            related_report_refs: relatedReportRefs,
          }),
        );
        await recordRound(env, config, roleDir, eventsPath, rounds[rounds.length - 1]!);
        if (await humanGate(gate, "completed", roundIndex, currentTaskState)) break;
        continue;
      }

      // Completion is not accepted unless it is grounded in a previous clean
      // auditor report. The synthetic audit gets fed back into the next manager
      // turn as a repair signal.
      const repairReport = invalidCompletionFeedback(config.prompt_language);
      const record = managedRound({
        round_index: roundIndex,
        next_step: MANAGER_NEXT_INVALID,
        plan_text: planText,
        harness_feedback: repairReport,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        related_report_refs: relatedReportRefs,
        auditor_status: { invalid_completion: true },
      });
      writeLocal(path.join(roundDir, "harness_feedback.txt"), repairReport);
      await writeRemoteRoundText(env, config, roundIndex, "harness_feedback.txt", repairReport);
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      if (await humanGate(gate, "progress", roundIndex, currentTaskState)) break;
      continue;
    }

    if (nextStep === MANAGER_NEXT_BLOCKED) {
      rounds.push(
        managedRound({
          round_index: roundIndex,
          next_step: nextStep,
          plan_text: planText,
          task_state: currentTaskState,
          task_contract: currentTaskContract,
          related_report_refs: relatedReportRefs,
        }),
      );
      await recordRound(env, config, roleDir, eventsPath, rounds[rounds.length - 1]!);
      if (await humanGate(gate, "blocked", roundIndex, currentTaskState)) break;
      continue;
    }

    if (nextStep === MANAGER_NEXT_ASK) {
      // The manager needs a human decision/input to proceed (e.g. the task says
      // "ask me next step"). This is a harness-level gate, not a subtask: record
      // the round and raise a human dialog with the manager's question; the
      // answer is injected into the next round.
      const question = extractRoleManagerQuestion(planText);
      const answers = extractRoleManagerAnswerChoices(planText);
      rounds.push(
        managedRound({
          round_index: roundIndex,
          next_step: nextStep,
          plan_text: planText,
          task_state: currentTaskState,
          task_contract: currentTaskContract,
          related_report_refs: relatedReportRefs,
        }),
      );
      await recordRound(env, config, roleDir, eventsPath, rounds[rounds.length - 1]!);
      if (await humanGate(gate, "ask", roundIndex, currentTaskState, { question, answers })) break;
      continue;
    }

    if (nextStep === MANAGER_NEXT_INVALID) {
      // Bad route output is treated like a auditor finding so the next manager
      // turn has an explicit, auditable correction signal.
      const repairReport = invalidPlanFeedback(config.prompt_language);
      const record = managedRound({
        round_index: roundIndex,
        next_step: MANAGER_NEXT_INVALID,
        plan_text: planText,
        harness_feedback: repairReport,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        related_report_refs: relatedReportRefs,
        auditor_status: { invalid_plan: true },
      });
      writeLocal(path.join(roundDir, "harness_feedback.txt"), repairReport);
      await writeRemoteRoundText(env, config, roundIndex, "harness_feedback.txt", repairReport);
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      if (await humanGate(gate, "progress", roundIndex, currentTaskState)) break;
      continue;
    }

    const executorAgent = nextStep === MANAGER_NEXT_GUI ? guiExecutorAgent : cliExecutorAgent;
    const executorBudget = nextStep === MANAGER_NEXT_GUI ? guiExecutorBudget : cliExecutorBudget;
    const auditorForStep = nextStep === MANAGER_NEXT_GUI ? guiAuditorAgent : cliAuditorAgent;
    const relatedAuditorReports = formatRelatedAuditorReports(rounds, relatedReportRefs, {
      maxChars: config.role_verified_context_chars,
      language: config.prompt_language,
    });

    // Task prompts receive the manager-maintained state plus only the auditor
    // reports explicitly referenced by the current subtask contract.
    const executorPrompt = buildRoleExecutorPrompt({
      task,
      planText,
      nextStep,
      taskState: currentTaskState,
      taskContract: currentTaskContract,
      relatedAuditorReports,
      workspacePath: config.workspace_path,
      language: config.prompt_language,
    });
    writeLocal(path.join(roundDir, "executor_prompt.txt"), executorPrompt);
    await writeRemoteRoundText(env, config, roundIndex, "executor_prompt.txt", executorPrompt);
    appendEvent(eventsPath, "executor_role_start", {
      round: roundIndex,
      role: nextStep,
      prompt_chars: executorPrompt.length,
      budget: budgetToDict(executorBudget),
    });
    emit("role_start", { round: roundIndex, role: `${nextStep}_executor` });

    const executorResult = await runRoleEpisode(executorAgent, executorPrompt, env, executorBudget, {
      liveTrajectoryPath: path.join(roundDir, "executor_raw_trajectory.jsonl"),
      signal,
    });
    const executorEpisodeRoot = path.join(
      logDir,
      nextStep === MANAGER_NEXT_GUI ? "gui_executor_episodes" : "cli_executor_episodes",
    );
    const executorFinalScreenshot =
      nextStep === MANAGER_NEXT_GUI ? await captureEnvironmentScreenshot(env) : null;
    saveRoleResult(roundDir, "executor", executorResult, {
      episodeRoot: executorEpisodeRoot,
      finalScreenshot: executorFinalScreenshot,
    });
    const executorOutput =
      pyStrip(visibleOutput(executorResult)) || "(executor agent produced no readable natural-language output)";
    writeLocal(path.join(roundDir, "executor_output.txt"), executorOutput);
    if (executorResult.status === "cancelled") {
      const record = managedRound({
        round_index: roundIndex,
        next_step: nextStep,
        plan_text: planText,
        executor_output: executorOutput,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        related_report_refs: relatedReportRefs,
        executor_status: episodeStatus(executorResult),
      });
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      gate.abortReason = "user_cancelled";
      appendEvent(eventsPath, "role_harness_cancelled", {
        round: roundIndex,
        phase: "executor",
        ...episodeEventFields(executorResult, { eventStatus: "cancelled" }),
      });
      break;
    }
    const executorFailure = classifyProviderFailure(executorResult);
    if (executorFailure !== null && executorFailure !== undefined) {
      const recoverableTimeout = executorFailure.kind === "timeout";
      const record = managedRound({
        round_index: roundIndex,
        next_step: nextStep,
        plan_text: planText,
        executor_output: recoverableTimeout ? executorOutput : "",
        harness_feedback: executorFailure.user_message,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        related_report_refs: relatedReportRefs,
        manager_status: episodeStatus(managerResult),
        executor_status: failedEpisodeStatus(executorResult, executorFailure.user_message),
      });
      writeLocal(path.join(roundDir, "harness_feedback.txt"), executorFailure.user_message);
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      appendEvent(eventsPath, "agent_runtime_failed", {
        round: roundIndex,
        phase: "executor",
        kind: executorFailure.kind,
        message: executorFailure.message,
        ...episodeEventFields(executorResult, {
          eventStatus: "failed",
          errorMessage: executorFailure.user_message,
        }),
      });
      emit("role_done", {
        round: roundIndex,
        role: `${nextStep}_executor`,
        status: "failed",
        duration_ms: executorResult.duration_ms,
        error: executorFailure.user_message,
      });
      if (recoverableTimeout) {
        if (await humanGate(gate, "progress", roundIndex, currentTaskState)) break;
        continue;
      }
      gate.abortReason = executorFailure.abort_reason;
      gate.failureReason = executorFailure.user_message;
      break;
    }
    await writeRemoteRoundText(env, config, roundIndex, "executor_output.txt", executorOutput);
    appendEvent(eventsPath, "executor_role_done", {
      round: roundIndex,
      role: nextStep,
      output_chars: executorOutput.length,
      ...episodeEventFields(executorResult, { eventStatus: "completed" }),
    });
    emit("role_done", {
      round: roundIndex,
      role: `${nextStep}_executor`,
      status: executorResult.status,
      duration_ms: executorResult.duration_ms,
    });

    // The auditor audits only the just-finished subtask. Its natural language
    // report becomes the trusted intermediate state for later rounds.
    const auditorPrompt = buildRoleAuditorPrompt({
      task,
      planText,
      executorOutput,
      nextStep,
      taskState: currentTaskState,
      taskContract: currentTaskContract,
      relatedAuditorReports,
      workspacePath: config.workspace_path,
      maxExecutorOutputChars: config.auditor_output_chars,
      language: config.prompt_language,
    });
    writeLocal(path.join(roundDir, "auditor_input.txt"), auditorPrompt);
    await writeRemoteRoundText(env, config, roundIndex, "auditor_input.txt", auditorPrompt);
    appendEvent(eventsPath, "auditor_role_start", {
      round: roundIndex,
      role: nextStep,
      prompt_chars: auditorPrompt.length,
      budget: budgetToDict(auditorBudget),
    });
    emit("role_start", { round: roundIndex, role: `${nextStep}_auditor` });

    const auditorResult = await runRoleEpisode(auditorForStep, auditorPrompt, env, auditorBudget, {
      liveTrajectoryPath: path.join(roundDir, "auditor_raw_trajectory.jsonl"),
      signal,
    });
    const auditorEpisodeRoot = path.join(
      logDir,
      nextStep === MANAGER_NEXT_GUI ? "gui_auditor_episodes" : "cli_auditor_episodes",
    );
    const auditorFinalScreenshot =
      nextStep === MANAGER_NEXT_GUI ? await captureEnvironmentScreenshot(env) : null;
    saveRoleResult(roundDir, "auditor", auditorResult, {
      episodeRoot: auditorEpisodeRoot,
      finalScreenshot: auditorFinalScreenshot,
    });
    if (auditorResult.status === "cancelled") {
      const record = managedRound({
        round_index: roundIndex,
        next_step: nextStep,
        plan_text: planText,
        executor_output: executorOutput,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        related_report_refs: relatedReportRefs,
        executor_status: episodeStatus(executorResult),
        auditor_status: episodeStatus(auditorResult),
      });
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      gate.abortReason = "user_cancelled";
      appendEvent(eventsPath, "role_harness_cancelled", {
        round: roundIndex,
        phase: "auditor",
        ...episodeEventFields(auditorResult, { eventStatus: "cancelled" }),
      });
      break;
    }
    const auditorFailure = classifyProviderFailure(auditorResult);
    if (auditorFailure !== null && auditorFailure !== undefined) {
      const recoverableTimeout = auditorFailure.kind === "timeout";
      const record = managedRound({
        round_index: roundIndex,
        next_step: nextStep,
        plan_text: planText,
        executor_output: executorOutput,
        harness_feedback: auditorFailure.user_message,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        related_report_refs: relatedReportRefs,
        manager_status: episodeStatus(managerResult),
        executor_status: episodeStatus(executorResult),
        auditor_status: failedEpisodeStatus(auditorResult, auditorFailure.user_message),
      });
      writeLocal(path.join(roundDir, "harness_feedback.txt"), auditorFailure.user_message);
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      appendEvent(eventsPath, "agent_runtime_failed", {
        round: roundIndex,
        phase: "auditor",
        kind: auditorFailure.kind,
        message: auditorFailure.message,
        ...episodeEventFields(auditorResult, {
          eventStatus: "failed",
          errorMessage: auditorFailure.user_message,
        }),
      });
      emit("role_done", {
        round: roundIndex,
        role: `${nextStep}_auditor`,
        status: "failed",
        duration_ms: auditorResult.duration_ms,
        error: auditorFailure.user_message,
      });
      if (recoverableTimeout) {
        if (await humanGate(gate, "progress", roundIndex, currentTaskState)) break;
        continue;
      }
      gate.abortReason = auditorFailure.abort_reason;
      gate.failureReason = auditorFailure.user_message;
      break;
    }
    const [auditorReportText, auditorStatus] = await auditorReportWithFormatRepair({
      env,
      config,
      roundDir,
      eventsPath,
      // By default, repair uses the same concrete GUI/CLI auditor that produced
      // the report. Callers may still provide an explicit override for
      // compatibility or backend specialization.
      formatRepairAgent: options.auditorFormatRepairAgent ?? auditorForStep,
      auditorBudget,
      primaryResult: auditorResult,
      roundIndex,
      episodeRoot: auditorEpisodeRoot,
      signal,
    });
    const repairStatus = auditorStatus["format_repair_status"];
    if (isPlainObject(repairStatus) && repairStatus["status"] === "cancelled") {
      const record = managedRound({
        round_index: roundIndex,
        next_step: nextStep,
        plan_text: planText,
        executor_output: executorOutput,
        task_state: currentTaskState,
        task_contract: currentTaskContract,
        related_report_refs: relatedReportRefs,
        executor_status: episodeStatus(executorResult),
        auditor_status: auditorStatus,
      });
      rounds.push(record);
      await recordRound(env, config, roleDir, eventsPath, record);
      gate.abortReason = "user_cancelled";
      appendEvent(eventsPath, "role_harness_cancelled", {
        round: roundIndex,
        phase: "auditor_format_repair",
        status: "cancelled",
        episode_status: repairStatus,
      });
      break;
    }
    writeLocal(path.join(roundDir, "auditor_report.txt"), auditorReportText);
    await writeRemoteRoundText(env, config, roundIndex, "auditor_report.txt", auditorReportText);

    const record = managedRound({
      round_index: roundIndex,
      next_step: nextStep,
      plan_text: planText,
      executor_output: executorOutput,
      auditor_report: auditorReportText,
      task_state: currentTaskState,
      task_contract: currentTaskContract,
      related_report_refs: relatedReportRefs,
      executor_status: episodeStatus(executorResult),
      auditor_status: auditorStatus,
    });
    rounds.push(record);
    await recordRound(env, config, roleDir, eventsPath, record);
    appendEvent(eventsPath, "auditor_role_done", {
      round: roundIndex,
      role: nextStep,
      report_chars: auditorReportText.length,
      ...episodeEventFields(auditorResult, { eventStatus: "completed" }),
    });
    const audit = parseAuditReport(auditorReportText, roundIndex, { language: config.prompt_language });
    emit("role_done", {
      round: roundIndex,
      role: `${nextStep}_auditor`,
      status: auditorResult.status,
      duration_ms: auditorResult.duration_ms,
      audit_status: audit.status,
      integrity_status: audit.integrity_status,
      contract_audit_status: audit.contract_audit_status,
    });
    if (await humanGate(gate, "progress", roundIndex, currentTaskState)) break;
  }

  const elapsed = monotonic() - started;
  const final = finalReport({
    task,
    rounds,
    completionSatisfied: gate.completionSatisfied,
    abortReason: gate.abortReason,
    lastPlan,
    taskState: currentTaskState,
    taskContract: currentTaskContract,
    // Report the live budget, not the configured increment: after a resume (or
    // an operator granting extra rounds) they differ, and the ratio rendered
    // next to `rounds_run` must use the same denominator the loop enforced.
    maxRounds: Math.max(1, gate.roundBudget),
    elapsedSeconds: elapsed,
    finalResponse: gate.finalResponse,
    failureReason: gate.failureReason,
  });
  writeLocal(path.join(roleDir, "report.json"), jsonDumpsIndent2(final) + "\n");
  writeLocal(path.join(logDir, "report.json"), jsonDumpsIndent2(final) + "\n");
  const transcript = formatManagementHistory(rounds, { includeEmpty: true, maxChars: 200_000 });
  writeLocal(path.join(roleDir, "orchestration_transcript.txt"), transcript);
  mergeEpisodeLogs(logDir);
  const harnessDir = rstripChars(config.harness_dir, "/");
  await writeRemoteTextBestEffort(env, `${harnessDir}/report.json`, jsonDumpsIndent2(final));
  await writeRemoteTextBestEffort(env, `${harnessDir}/orchestration/report.json`, jsonDumpsIndent2(final));
  await writeRemoteTextBestEffort(env, `${harnessDir}/orchestration/orchestration_transcript.txt`, transcript);
  appendEvent(eventsPath, "role_harness_done", final);
  emit("run_done", {
    status: final["status"],
    completion_satisfied: final["completion_satisfied"],
    abort_reason: final["abort_reason"],
    rounds_run: final["rounds_run"],
    elapsed_seconds: final["elapsed_seconds"],
    report_path: path.join(logDir, "report.json"),
  });
  return final;
}

// ---------------------------------------------------------------------------
// Human-in-the-loop gate
// ---------------------------------------------------------------------------

/** Default `emit` for gate contexts built without a progress sink. */
function discardProgress(_event: string, _payload: Record<string, unknown>): void {}

/**
 * Record an operator cancellation raised while the reply was being written.
 *
 * Completion is cleared too: `finalReport` ranks it above the abort reason, so a
 * cancelled run would otherwise still be reported as complete.
 */
function markCancelled(ctx: GateContext): void {
  ctx.abortReason = "user_cancelled";
  ctx.completionSatisfied = false;
}

/**
 * Context + evolving state for the end-of-round human gate.
 *
 * Bundles the run-scoped dependencies (hook, task, rounds, paths, config) with
 * the loop state the gate updates (round budget, completion, abort reason,
 * carryover instructions). The gate is thus a single module-level function the
 * run loop calls directly, reading results straight back from this object.
 */
export interface GateContext {
  humanHook: HumanHook | null;
  task: string;
  rounds: ManagedRound[];
  logDir: string;
  config: HarnessConfig;
  eventsPath: string;
  roundBudget: number;
  // The gate writes the user-facing reply before asking the operator to decide,
  // so it needs the pieces an episode requires.
  env: Environment | null;
  roleDir: string | null;
  responseAgent: AgentAdapter | null;
  emit: ProgressSink;
  completionSatisfied: boolean;
  abortReason: string;
  carryoverInstructions: string;
  // Dashboard follow-ups are authoritative user input. `carryover` is consumed
  // by the next Manager round, while this history remains available to the
  // final-response role so reply-specific requirements are not lost.
  operatorInstructions: string[];
  // Round that already attempted a reply, so one gate cannot write a round's
  // reply artifacts twice (which would corrupt the saved trajectory metadata).
  responseRound: number;
  finalResponse: string;
  // A terminal agent/provider failure is not a task-planning decision. Keep its
  // actionable cause separate from `abortReason` so Supervisor/Web can show the
  // provider's real message instead of a generic round-limit gate.
  failureReason: string;
  signal: AbortSignal | null;
}

export type GateContextInit = Partial<GateContext> &
  Pick<GateContext, "task" | "rounds" | "logDir" | "config" | "eventsPath" | "roundBudget">;

export function createGateContext(init: GateContextInit): GateContext {
  return {
    humanHook: init.humanHook ?? null,
    task: init.task,
    rounds: init.rounds,
    logDir: init.logDir,
    config: init.config,
    eventsPath: init.eventsPath,
    roundBudget: init.roundBudget,
    env: init.env ?? null,
    roleDir: init.roleDir ?? null,
    responseAgent: init.responseAgent ?? null,
    emit: init.emit ?? discardProgress,
    completionSatisfied: init.completionSatisfied ?? false,
    abortReason: init.abortReason ?? "",
    carryoverInstructions: init.carryoverInstructions ?? "",
    operatorInstructions: init.operatorInstructions ?? [],
    responseRound: init.responseRound ?? 0,
    finalResponse: init.finalResponse ?? "",
    failureReason: init.failureReason ?? "",
    signal: init.signal ?? null,
  };
}

/**
 * End-of-round human-in-the-loop gate; mutates `ctx`, returns true to stop.
 *
 * `outcome` is this round's result (`completed` / `blocked` / `ask` /
 * `progress`). With a hook, the dashboard decides whether to raise a gate
 * (completion, max rounds, blocked, manager asking the user, or repeated
 * failures) and whether to continue or stop. `ask` always needs a human, so
 * without a hook the run stops (no channel to answer). On "continue" the gate
 * reopens / extends the budget and stores any injected instructions (including
 * the human's answer to an `ask`) on `ctx`.
 */
export async function humanGate(
  ctx: GateContext,
  outcome: string,
  roundIndex: number,
  taskState: string,
  options: { question?: string; answers?: string[] | null } = {},
): Promise<boolean> {
  const question = options.question ?? "";
  const answers = options.answers ?? null;
  const reachedMax = !ctx.completionSatisfied && roundIndex >= ctx.roundBudget;
  // `ctx.abortReason` is only assigned below, so the reason is derived here to
  // keep "ran out of rounds" distinguishable from "blocked" in the reply. `ask`
  // is excluded: the manager is asking a mid-task question, so the run is not
  // ending and a reply written here would be discarded on the answer.
  const ending: string | null = ctx.completionSatisfied
    ? ""
    : outcome === "blocked"
      ? "manager_blocked"
      : reachedMax
        ? "max_rounds_exhausted"
        : null;

  // Written before the operator is asked anything, so the decision to accept the
  // result or push the run further is made against the actual answer.
  if (ending !== null && (await writeFinalResponse(ctx, roundIndex, taskState, ending))) {
    markCancelled(ctx);
    return true;
  }

  if (ctx.humanHook === null) {
    if (ctx.completionSatisfied) return true;
    if (outcome === "blocked") {
      ctx.abortReason = "manager_blocked";
      return true;
    }
    if (outcome === "ask") {
      // Nothing can answer the question, so this ending is only known here.
      ctx.abortReason = "needs_human_input";
      if (await writeFinalResponse(ctx, roundIndex, taskState, ctx.abortReason)) markCancelled(ctx);
      return true;
    }
    if (reachedMax) {
      ctx.abortReason = "max_rounds_exhausted";
      return true;
    }
    return false;
  }

  const raw = await ctx.humanHook({
    phase: "end_of_round",
    outcome,
    reached_max: reachedMax,
    round_index: roundIndex,
    task: ctx.task,
    task_state: taskState,
    question,
    answers: [...(answers ?? [])],
    final_response: ctx.finalResponse,
    rounds: ctx.rounds.map((item) => ({ ...item })),
    log_dir: ctx.logDir,
  });
  const decision = isPlainObject(raw) ? raw : {};
  const instructions = pyStrip(String(decision["instructions"] || ""));
  if (instructions) {
    ctx.carryoverInstructions = instructions;
    ctx.operatorInstructions.push(instructions);
  }
  const action = String(decision["action"] || "continue");

  if (action === "stop") {
    if (reachedMax) ctx.abortReason = "max_rounds_exhausted";
    else if (outcome === "blocked") ctx.abortReason = "manager_blocked";
    else if (outcome === "ask") ctx.abortReason = "human_abort";
    else if (!ctx.completionSatisfied) ctx.abortReason = "human_abort";
    // The operator can stop on a round the harness did not treat as an ending
    // (an `ask` or repeated-failure gate), which leaves no reply written yet.
    if (await writeFinalResponse(ctx, roundIndex, taskState, ctx.abortReason)) markCancelled(ctx);
    return true;
  }

  // continue: reopen / extend the budget when we were about to finish. The reply
  // just shown describes a run that is no longer over, so it is discarded and
  // rewritten at whatever ending comes next.
  if (ctx.finalResponse) {
    ctx.finalResponse = "";
    await discardFinalResponse(ctx);
  }
  if (outcome === "completed") ctx.completionSatisfied = false;
  if (reachedMax || outcome === "completed" || outcome === "blocked") {
    // The hook is an injected callback (dashboard, tests, embedders), so its
    // value is validated rather than coerced: a non-numeric or out-of-range
    // answer falls back to the configured budget instead of raising inside the
    // loop or granting an unbounded number of rounds.
    const extra = extraRounds(decision["extra_rounds"]) || Math.max(1, ctx.config.max_total_episodes || 1);
    // Always grant at least one more round: clamping to MAX_ROUNDS must not
    // produce a budget below the current round, which would end the run
    // immediately after the operator asked to continue.
    ctx.roundBudget = Math.max(roundIndex + 1, Math.min(roundIndex + extra, MAX_ROUNDS));
    appendEvent(ctx.eventsPath, "human_continue_after_finish", {
      round: roundIndex,
      outcome,
      extra_rounds: extra,
      round_budget: ctx.roundBudget,
    });
  }
  return false;
}

/** Return a validated extra-round grant, or 0 when unusable. */
export function extraRounds(value: unknown): number {
  if (value === null || value === undefined || typeof value === "boolean") return 0;
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    const text = pyStrip(parsed);
    if (!/^[+-]?\d+$/.test(text)) return 0;
    parsed = Number.parseInt(text, 10);
  }
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_ROUNDS);
}

// ---------------------------------------------------------------------------
// Episode invocation
// ---------------------------------------------------------------------------

/** Normalize cooperative cancellation for every adapter implementation. */
async function runRoleEpisode(
  agent: AgentAdapter,
  prompt: string,
  env: Environment,
  budget: EpisodeBudget,
  options: { liveTrajectoryPath?: string | null; signal?: AbortSignal | null } = {},
): Promise<EpisodeResult> {
  const started = monotonic();
  try {
    if (options.signal?.aborted) throw cancellationError();
    return await agent.runEpisode(prompt, env, budget, options.liveTrajectoryPath ?? null);
  } catch (exc) {
    if (isCancellation(exc)) {
      return episodeResult({
        status: "cancelled",
        error: "Execution cancelled by operator",
        duration_ms: Math.trunc((monotonic() - started) * 1000),
        metadata: { cancelled: true },
      });
    }
    throw exc;
  }
}

// ---------------------------------------------------------------------------
// Auditor format repair
// ---------------------------------------------------------------------------

async function auditorReportWithFormatRepair(options: {
  env: Environment;
  config: HarnessConfig;
  roundDir: string;
  eventsPath: string;
  formatRepairAgent: AgentAdapter;
  auditorBudget: EpisodeBudget;
  primaryResult: EpisodeResult;
  roundIndex: number;
  episodeRoot: string;
  signal?: AbortSignal | null;
}): Promise<[string, Record<string, unknown>]> {
  const { env, config, roundDir, eventsPath, primaryResult, roundIndex, episodeRoot } = options;
  let status: Record<string, unknown> = episodeStatus(primaryResult);
  const rawReport = auditorReportTextFromEpisodeResult(primaryResult);
  if (!shouldRepairAuditorFormat(primaryResult, rawReport)) {
    return [auditorReportText(primaryResult, roundIndex, { language: config.prompt_language }), status];
  }

  const repairPrompt = buildRoleAuditorFormatRepairPrompt({
    reportText: rawReport,
    language: config.prompt_language,
  });
  writeLocal(path.join(roundDir, "auditor_format_repair_input.txt"), repairPrompt);
  await writeRemoteRoundText(env, config, roundIndex, "auditor_format_repair_input.txt", repairPrompt);
  const repairBudget = formatRepairBudget(options.auditorBudget);
  appendEvent(eventsPath, "auditor_format_repair_start", {
    round: roundIndex,
    prompt_chars: repairPrompt.length,
    budget: budgetToDict(repairBudget),
  });
  const repairResult = await runRoleEpisode(options.formatRepairAgent, repairPrompt, env, repairBudget, {
    liveTrajectoryPath: path.join(roundDir, "auditor_format_repair_raw_trajectory.jsonl"),
    signal: options.signal ?? null,
  });
  saveRoleResult(roundDir, "auditor_format_repair", repairResult, { episodeRoot });
  const repairRawReport = auditorReportTextFromEpisodeResult(repairResult);
  const repairValid = shouldAcceptAuditorFormatRepair(repairResult, repairRawReport);
  status = {
    ...status,
    format_repair_attempted: true,
    format_repair_accepted: repairValid,
    format_repair_status: episodeStatus(repairResult),
  };
  appendEvent(eventsPath, "auditor_format_repair_done", {
    round: roundIndex,
    accepted: repairValid,
    report_chars: repairRawReport.length,
    ...episodeEventFields(repairResult, { eventStatus: "completed" }),
  });
  if (repairValid) {
    const corrected = episodeResult({
      status: primaryResult.status,
      actions_log: repairRawReport,
      error: primaryResult.error,
      duration_ms: primaryResult.duration_ms + repairResult.duration_ms,
      metadata: primaryResult.metadata,
    });
    return [auditorReportText(corrected, roundIndex, { language: config.prompt_language }), status];
  }
  return [auditorReportText(repairResult, roundIndex, { language: config.prompt_language }), status];
}

function shouldRepairAuditorFormat(result: EpisodeResult, reportText: string): boolean {
  if (result.status !== "done") return false;
  if (hardRuntimeSignalLabels(result).length) return false;
  return !hasValidAuditorControlHeader(reportText);
}

function shouldAcceptAuditorFormatRepair(result: EpisodeResult, reportText: string): boolean {
  if (result.status !== "done") return false;
  if (hardRuntimeSignalLabels(result).length) return false;
  if (workspaceMutationDetected(result)) return false;
  return hasValidAuditorControlHeader(reportText);
}

function formatRepairBudget(budget: EpisodeBudget): EpisodeBudget {
  return new EpisodeBudget(Math.max(30, Math.min(budget.max_duration_seconds, 120)));
}

// ---------------------------------------------------------------------------
// Final response role
// ---------------------------------------------------------------------------

/**
 * Answer the original request in the user's terms, storing it on `ctx`.
 *
 * Every other role writes for the next role, so without this the operator only
 * sees audit protocol text. Failure must never cost the run its report, so any
 * problem degrades to an empty reply. Returns true when the operator cancelled
 * during generation, which the caller turns into a run-level abort.
 */
async function writeFinalResponse(
  ctx: GateContext,
  roundIndex: number,
  taskState: string,
  ending: string,
): Promise<boolean> {
  if (ctx.finalResponse || ctx.rounds.length === 0) return false;
  if (ctx.env === null || ctx.roleDir === null || ctx.responseAgent === null) return false;
  if (ending === "user_cancelled" || ctx.responseRound === roundIndex) return false;
  ctx.responseRound = roundIndex;

  const status = ctx.completionSatisfied ? "complete" : ending === "manager_blocked" ? "blocked" : "incomplete";
  const prompt = buildRoleFinalResponsePrompt({
    task: ctx.task,
    rounds: ctx.rounds,
    status,
    abortReason: ending,
    taskState,
    operatorInstructions: ctx.operatorInstructions.join("\n\n"),
    language: ctx.config.prompt_language,
  });
  const budget = finalResponseBudget(ctx.config.manager_budget);
  // Stored per round, like the other roles, so a discarded reply keeps its own
  // artifacts and the dashboard's round trajectory viewer can reach them.
  const roundDir = path.join(ctx.roleDir, "rounds", `round_${pad3(roundIndex)}`);
  fs.mkdirSync(roundDir, { recursive: true });
  writeLocal(path.join(roundDir, "final_response_input.txt"), prompt);
  appendEvent(ctx.eventsPath, "final_response_start", {
    round: roundIndex,
    prompt_chars: prompt.length,
    budget: budgetToDict(budget),
  });
  ctx.emit("role_start", { round: roundIndex, role: "final_response" });

  let result: EpisodeResult;
  try {
    result = await runRoleEpisode(ctx.responseAgent, prompt, ctx.env, budget, {
      liveTrajectoryPath: path.join(roundDir, "final_response_raw_trajectory.jsonl"),
      signal: ctx.signal,
    });
  } catch {
    logger.warning("final response episode failed");
    appendEvent(ctx.eventsPath, "final_response_done", {
      round: roundIndex,
      accepted: false,
      error: "episode_failed",
      status: "failed",
    });
    ctx.emit("role_done", { round: roundIndex, role: "final_response", status: "error" });
    return false;
  }

  saveRoleResult(roundDir, "final_response", result, {
    episodeRoot: path.join(ctx.logDir, "final_response_episodes"),
  });
  const response = result.status === "done" ? pyStrip(visibleOutput(result)) : "";
  if (response) {
    ctx.finalResponse = response;
    writeLocal(path.join(roundDir, "final_response.txt"), response);
    writeLocal(path.join(ctx.roleDir, "final_response.txt"), response);
    await writeRemoteTextBestEffort(
      ctx.env,
      `${rstripChars(ctx.config.harness_dir, "/")}/orchestration/final_response.txt`,
      response,
    );
  }
  appendEvent(ctx.eventsPath, "final_response_done", {
    round: roundIndex,
    accepted: Boolean(response),
    response_chars: response.length,
    ...episodeEventFields(result, { eventStatus: "completed" }),
  });
  ctx.emit("role_done", {
    round: roundIndex,
    role: "final_response",
    status: result.status,
    duration_ms: result.duration_ms,
  });
  // Cancellation is normalized into a result by `runRoleEpisode`, so without
  // this the operator's Ctrl+C would be silently absorbed here.
  return result.status === "cancelled";
}

/**
 * Drop the published reply once the operator reopens the run.
 *
 * Auditing keeps the round's prompt, metadata, and trajectory; only the three
 * published copies go. `rounds/round_NNN/final_response.txt` is one of them: the
 * dashboard reads it as the round's current reply, so leaving it behind kept a
 * withdrawn answer on screen (and dated it from the wrong round).
 */
async function discardFinalResponse(ctx: GateContext): Promise<void> {
  if (ctx.roleDir !== null) {
    unlinkQuietly(path.join(ctx.roleDir, "final_response.txt"));
    if (ctx.responseRound > 0) {
      const roundDir = path.join(ctx.roleDir, "rounds", `round_${pad3(ctx.responseRound)}`);
      unlinkQuietly(path.join(roundDir, "final_response.txt"));
    }
  }
  if (ctx.env !== null) {
    await writeRemoteTextBestEffort(
      ctx.env,
      `${rstripChars(ctx.config.harness_dir, "/")}/orchestration/final_response.txt`,
      "",
    );
  }
  appendEvent(ctx.eventsPath, "final_response_discarded", { round: ctx.responseRound });
}

function finalResponseBudget(budget: EpisodeBudget): EpisodeBudget {
  return new EpisodeBudget(Math.max(60, Math.min(budget.max_duration_seconds, 180)));
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

function auditorReportText(
  result: EpisodeResult,
  roundIndex: number,
  options: { language?: string } = {},
): string {
  const language = options.language ?? "en";
  const report = auditReportFromEpisodeResult(result, roundIndex, { language });
  if (pyStrip(report.report_text)) return pyStrip(report.report_text);
  let visible = pyStrip(visibleOutput(result));
  [visible] = boundedTextTail(visible, MAX_SAVED_TRAJECTORY_BYTES);
  if (visible) return visible;
  return (
    "Status: blocked\n" +
    "Integrity: suspect\n" +
    "Contract audit: unknown\n" +
    "Audit facts: the auditor produced no readable natural-language report.\n" +
    "Next step: retry the audit or schedule a smaller subtask of the same type."
  );
}

export function latestAuditorIsCleanComplete(
  rounds: ManagedRound[],
  options: { language?: string } = {},
): boolean {
  const language = options.language ?? "en";
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const item = rounds[index]!;
    if (item.auditor_status["invalid_completion"] || item.auditor_status["invalid_plan"]) continue;
    if (!pyStrip(item.auditor_report)) continue;
    const report = parseAuditReport(item.auditor_report, item.round_index, { language });
    return (
      report.status === "complete" &&
      report.integrity_status === "clean" &&
      report.contract_audit_status === "aligned"
    );
  }
  return false;
}

function finalReport(options: {
  task: string;
  rounds: ManagedRound[];
  completionSatisfied: boolean;
  abortReason: string;
  lastPlan: string;
  taskState: string;
  taskContract: string;
  maxRounds: number;
  elapsedSeconds: number;
  finalResponse?: string;
  failureReason?: string;
}): Record<string, unknown> {
  const finalResponse = options.finalResponse ?? "";
  const failureReason = options.failureReason ?? "";
  // Final status is a harness-level decision, not the last executor agent's self
  // claim. The auditor artifact remains the natural-language audit report.
  const latestReportText = latestAuditorReportText(options.rounds);
  const status = options.completionSatisfied
    ? "complete"
    : options.abortReason === "user_cancelled"
      ? "cancelled"
      : options.abortReason.startsWith("provider_")
        ? "failed"
        : options.abortReason === "manager_blocked"
          ? "blocked"
          : "incomplete";
  return {
    schema_version: 2,
    variant: ROLE_VARIANT,
    mode: "role_orchestration",
    status,
    task: options.task,
    completion_satisfied: options.completionSatisfied,
    completion_authority: "manager_with_role_auditors",
    rounds_run: options.rounds.length,
    max_rounds: options.maxRounds,
    abort_reason: options.abortReason,
    failure_reason: failureReason,
    error: failureReason || null,
    last_plan: options.lastPlan,
    current_task_state: options.taskState,
    current_task_contract: options.taskContract,
    latest_auditor_report: latestReportText,
    final_response: finalResponse,
    rounds: options.rounds.map((item) => ({ ...item })),
    elapsed_seconds: roundTo(options.elapsedSeconds, 3),
  };
}

function latestAuditorReportText(rounds: ManagedRound[]): string {
  // Round state intentionally stores auditor reports as natural language. The
  // parser is only a transient stop-condition check.
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const item = rounds[index]!;
    if (item.auditor_status["invalid_completion"] || item.auditor_status["invalid_plan"]) continue;
    if (pyStrip(item.auditor_report)) return pyStrip(item.auditor_report);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Crash boundary report
// ---------------------------------------------------------------------------

/**
 * Best-effort local crash report and terminal event for the worker.
 *
 * This function is deliberately synchronous: it is called while the loop is
 * already unwinding, and a small local write is more reliable than scheduling
 * another coroutine that may never run. The report is bounded so an enormous
 * traceback cannot become a second DoS vector.
 */
export function writeTerminalFailure(
  config: { log_dir?: string; max_total_episodes?: number } | null | undefined,
  task: string,
  options: {
    status: string;
    reason: string;
    exc: unknown;
    abortReason: string;
    progress?: RunProgress | null;
  },
): Record<string, unknown> {
  const logDir = String(config?.log_dir ?? "./lh_harness");
  const roleDir = path.join(logDir, "role_orchestration");
  const reportPath = path.join(logDir, "report.json");
  const roleReportPath = path.join(roleDir, "report.json");
  let existing: Record<string, unknown> = {};
  const existingText = readLocalBounded(reportPath, MAX_FAILURE_REPORT_BYTES);
  if (existingText !== null) {
    try {
      const parsed: unknown = JSON.parse(existingText);
      if (isPlainObject(parsed)) existing = parsed;
    } catch {
      /* not valid JSON */
    }
  }
  if (
    ["complete", "completed", "cancelled", "failed", "blocked", "incomplete"].includes(
      String(existing["status"]),
    )
  ) {
    // A failure during a post-report remote sync must not erase a valid local
    // authority. The supervisor can still use the existing report.
    return existing;
  }

  const trace = formatException(options.exc);
  const report: Record<string, unknown> = {
    schema_version: 2,
    variant: ROLE_VARIANT,
    mode: "role_orchestration",
    status: options.status,
    task,
    completion_satisfied: false,
    completion_authority: "manager_with_role_auditors",
    rounds_run: 0,
    max_rounds: Math.trunc(Number(config?.max_total_episodes ?? 0) || 0),
    abort_reason: options.abortReason,
    failure_reason: options.reason,
    error: options.reason,
    last_plan: "",
    current_task_state: "",
    current_task_contract: "",
    latest_auditor_report: "",
    final_response: "",
    rounds: [],
    elapsed_seconds: 0.0,
    exception_type: exceptionType(options.exc),
    traceback_tail: trace.slice(Math.max(0, trace.length - 12000)),
    supervisor_generated: false,
  };
  const progress = options.progress ?? null;
  if (progress !== null) {
    const rounds = [...progress.rounds];
    const latest = rounds.length ? rounds[rounds.length - 1]! : null;
    const gate = progress.gate;
    Object.assign(report, {
      completion_satisfied: Boolean(gate && gate.completionSatisfied),
      rounds_run: rounds.length,
      max_rounds:
        gate !== null ? gate.roundBudget : Math.trunc(Number(config?.max_total_episodes ?? 0) || 0),
      last_plan: latest !== null ? latest.plan_text : "",
      current_task_state: latest !== null ? latest.task_state : "",
      current_task_contract: latest !== null ? latest.task_contract : "",
      latest_auditor_report: latestAuditorReportText(rounds),
      final_response: gate !== null ? gate.finalResponse : "",
      rounds: rounds.map((item) => ({ ...item })),
      elapsed_seconds:
        progress.startedAt !== null ? roundTo(Math.max(0, monotonic() - progress.startedAt), 3) : 0.0,
    });
  }
  const encoded = Buffer.from(jsonDumpsIndent2(report) + "\n", "utf-8");
  for (const target of [reportPath, roleReportPath]) {
    try {
      atomicBytesWrite(target, encoded);
    } catch {
      /* OSError suppressed per target */
    }
  }
  try {
    const eventsPath = path.join(roleDir, "events.jsonl");
    if (!readJsonlLocal(eventsPath).some((item) => item["event"] === "role_harness_failed")) {
      appendEvent(eventsPath, options.status === "cancelled" ? "role_harness_cancelled" : "role_harness_failed", {
        status: options.status,
        reason: options.reason,
        exception_type: exceptionType(options.exc),
        traceback_tail: trace.slice(Math.max(0, trace.length - 4000)),
      });
    }
  } catch {
    /* OSError suppressed */
  }
  return report;
}

function readJsonlLocal(filePath: string): Record<string, unknown>[] {
  const raw = readLocalBounded(filePath, MAX_FAILURE_EVENTS_BYTES, { tail: true });
  if (raw === null) return [];
  const result: Record<string, unknown>[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index >= MAX_FAILURE_EVENT_RECORDS) break;
    let value: unknown;
    try {
      value = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    if (isPlainObject(value)) result.push(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Episode status helpers
// ---------------------------------------------------------------------------

function visibleOutput(result: EpisodeResult): string {
  // Adapters can expose a clean assistant-visible output in metadata. Falling
  // back to actions_log keeps simple command adapters usable.
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  for (const key of VISIBLE_OUTPUT_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && pyStrip(value)) return value;
  }
  if (metadata["actions_log_diagnostics_only"]) return "";
  const raw = result.actions_log || "";
  // Decode the final assistant-visible text from Claude or Codex JSONL while
  // keeping the complete machine trajectory in actions_log for diagnostics.
  const decoded = decodeAgentVisibleOutput(raw);
  return decoded ? decoded : raw;
}

function episodeStatus(result: EpisodeResult): Record<string, unknown> {
  // Keep status compact in round records; full raw output is stored separately.
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  return {
    status: result.status,
    error: result.error ?? null,
    duration_ms: result.duration_ms,
    agent_done: metadata["agent_done"] ?? null,
    exit_code: metadata["exit_code"] ?? null,
    runtime_signals: metadata["runtime_signals"] ?? null,
  };
}

function failedEpisodeStatus(result: EpisodeResult, userMessage: string): Record<string, unknown> {
  const status = episodeStatus(result);
  status["status"] = result.status === "timeout" ? "timeout" : "error";
  status["error"] = userMessage;
  return status;
}

/** Separate public event lifecycle state from episode diagnostics. */
function episodeEventFields(
  result: EpisodeResult,
  options: { eventStatus: string; errorMessage?: string | null },
): Record<string, unknown> {
  const errorMessage = options.errorMessage ?? null;
  const status = errorMessage !== null ? failedEpisodeStatus(result, errorMessage) : episodeStatus(result);
  return { status: options.eventStatus, episode_status: status };
}

function hardRuntimeSignalLabels(result: EpisodeResult): string[] {
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  return hardSignalLabels(metadata["runtime_signals"]);
}

function workspaceMutationDetected(result: EpisodeResult): boolean {
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  return Boolean(metadata["verifier_workspace_mutation_detected"]);
}

// ---------------------------------------------------------------------------
// Role artifacts
// ---------------------------------------------------------------------------

export function saveRoleResult(
  roundDir: string,
  roleName: string,
  result: EpisodeResult,
  options: { episodeRoot?: string | null; finalScreenshot?: Buffer | null } = {},
): Record<string, unknown> {
  // Raw trajectories are stored locally for audit/debugging, while prompt
  // construction only consumes visible output and auditor reports. Claude Code
  // emits one JSON object per line (stream-json), so the trajectory is saved as
  // .jsonl to reflect its real format and make downstream parsing explicit.
  const trajectoryPath = path.join(roundDir, `${roleName}_raw_trajectory.jsonl`);
  let preservedLiveTrajectory = false;
  let liveTrajectory = "";
  let liveTrajectoryTruncated = false;
  if (fs.existsSync(trajectoryPath)) {
    [liveTrajectory, liveTrajectoryTruncated] = readLocalTextTail(trajectoryPath, MAX_SAVED_TRAJECTORY_BYTES);
  }
  let [finalTrajectory, finalTrajectoryTruncated] = boundedTextTail(
    result.actions_log || "",
    MAX_SAVED_TRAJECTORY_BYTES,
  );
  if (
    liveTrajectory &&
    (!finalTrajectory ||
      (!liveTrajectoryTruncated &&
        liveTrajectory.startsWith(finalTrajectory) &&
        liveTrajectory.length > finalTrajectory.length))
  ) {
    // Timeout/cancellation used to return empty stdout and erase the JSONL that
    // the live tee had already flushed. It also remains authoritative if an
    // interrupted final read captured only a shorter prefix.
    preservedLiveTrajectory = true;
  }
  if (!preservedLiveTrajectory || liveTrajectoryTruncated) {
    if (preservedLiveTrajectory) finalTrajectory = liveTrajectory;
    writeLocal(trajectoryPath, finalTrajectory);
  }
  const artifactSource = preservedLiveTrajectory ? liveTrajectory : finalTrajectory;
  let trajectoryArtifacts: Record<string, unknown>;
  try {
    trajectoryArtifacts = persistTrajectoryArtifacts(artifactSource, {
      roundDir,
      roleName,
    }) as Record<string, unknown>;
  } catch (exc) {
    logger.warning(`trajectory screenshot persistence failed for ${roleName}: ${exceptionText(exc)}`);
    trajectoryArtifacts = {
      normalized_trajectory: "",
      screenshot_manifest: "",
      screenshot_count: 0,
      total_screenshot_bytes: 0,
      screenshots: [],
      persistence_error: exceptionText(exc),
    };
  }
  const finalScreenshotName = persistFinalScreenshot({
    roundDir,
    roleName,
    payload: options.finalScreenshot ?? null,
    trajectoryArtifacts,
  });
  if (options.episodeRoot !== null && options.episodeRoot !== undefined) {
    try {
      trajectoryArtifacts["episode_dir"] = writeEpisodeRecord({
        episodeRoot: options.episodeRoot,
        roundDir,
        roleName,
        result,
        trajectoryArtifacts,
        finalScreenshotName,
      });
    } catch (exc) {
      logger.warning(`episode record persistence failed for ${roleName}: ${exceptionText(exc)}`);
      trajectoryArtifacts["episode_persistence_error"] = exceptionText(exc);
    }
  }
  const metadata = {
    status: result.status,
    error: result.error ?? null,
    duration_ms: result.duration_ms,
    metadata: result.metadata,
    live_trajectory_preserved: preservedLiveTrajectory,
    trajectory_truncated: Boolean(liveTrajectoryTruncated || finalTrajectoryTruncated),
    trajectory_artifacts: trajectoryArtifacts,
  };
  const metadataText = jsonDumpsIndent2(jsonSafe(metadata));
  writeLocal(path.join(roundDir, `${roleName}_metadata.json`), metadataText);
  return trajectoryArtifacts;
}

/** Write the role episode tree used by the OSWorld-V2 CUA-Harness runner. */
function writeEpisodeRecord(options: {
  episodeRoot: string;
  roundDir: string;
  roleName: string;
  result: EpisodeResult;
  trajectoryArtifacts: Record<string, unknown>;
  finalScreenshotName: string;
}): string {
  const { episodeRoot, roundDir, roleName, result, trajectoryArtifacts, finalScreenshotName } = options;
  const episodeDir = nextEpisodeDir(episodeRoot);
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  const visible = pyStrip(visibleOutput(result));
  const stderrTail = pyStrip(String(metadata["stderr_tail"] || ""));
  const agentLogParts = [`role=${roleName}`, `status=${result.status}`, `duration_ms=${result.duration_ms}`];
  if (result.error) agentLogParts.push("", `error: ${result.error}`);
  if (stderrTail) agentLogParts.push("", "stderr:", stderrTail);
  if (visible) agentLogParts.push("", "assistant output:", visible);
  writeLocal(path.join(episodeDir, "agent.log"), pyRstrip(agentLogParts.join("\n")) + "\n");
  const rawName = `${roleName}_raw_trajectory.jsonl`;
  const raw = readLocalBounded(path.join(roundDir, rawName), MAX_SAVED_TRAJECTORY_BYTES) ?? "";
  const commandValue = metadata["command"];
  const command = Array.isArray(commandValue)
    ? commandValue.map((part) => String(part)).join(" ")
    : String(commandValue || "");
  const lowered = command.toLowerCase();
  const streamName = lowered.includes("claude")
    ? "claude_stream.jsonl"
    : lowered.includes("codex")
      ? "codex_stream.jsonl"
      : "provider_stream.jsonl";
  writeLocal(path.join(episodeDir, streamName), raw);
  writeLocal(path.join(episodeDir, "chat.jsonl"), episodeChatJsonl(result));
  const episodeMetadata = {
    status: result.status,
    error: result.error ?? null,
    duration_ms: result.duration_ms,
    role: roleName,
    source_round: path.basename(roundDir),
    metadata,
  };
  writeLocal(path.join(episodeDir, "metadata.json"), jsonDumpsIndent2(jsonSafe(episodeMetadata)) + "\n");

  const screenshots = trajectoryArtifacts["screenshots"];
  if (Array.isArray(screenshots)) {
    for (const item of screenshots) {
      if (!isPlainObject(item)) continue;
      const name = String(item["screenshot_file"] || "");
      if (!name) continue;
      const payload = readLocalBytes(path.join(roundDir, name), 8 * 1024 * 1024);
      if (payload !== null) atomicBytesWrite(path.join(episodeDir, name), payload);
    }
    for (let index = screenshots.length - 1; index >= 0; index -= 1) {
      const item = screenshots[index];
      if (!isPlainObject(item)) continue;
      const name = String(item["screenshot_file"] || "");
      const payload = name ? readLocalBytes(path.join(roundDir, name), 8 * 1024 * 1024) : null;
      if (payload === null) continue;
      const suffix = path.extname(name).toLowerCase() || ".png";
      atomicBytesWrite(path.join(episodeDir, `final_screenshot${suffix}`), payload);
      break;
    }
  }
  if (finalScreenshotName) {
    const payload = readLocalBytes(path.join(roundDir, finalScreenshotName), 8 * 1024 * 1024);
    if (payload !== null) {
      const suffix = path.extname(finalScreenshotName).toLowerCase() || ".png";
      atomicBytesWrite(path.join(episodeDir, `final_screenshot${suffix}`), payload);
    }
  }
  return episodeDir;
}

/** Capture the final GUI state for a GUI role, as OSWorld does per episode. */
async function captureEnvironmentScreenshot(env: Environment): Promise<Buffer | null> {
  let payload: Buffer;
  try {
    payload = await env.screenshot();
  } catch (exc) {
    logger.warning(`final GUI screenshot capture failed: ${exceptionText(exc)}`);
    return null;
  }
  if (!payload || payload.length === 0 || payload.length > 8 * 1024 * 1024 || imageSuffix(payload) === null) {
    return null;
  }
  return payload;
}

function persistFinalScreenshot(options: {
  roundDir: string;
  roleName: string;
  payload: Buffer | null;
  trajectoryArtifacts: Record<string, unknown>;
}): string {
  const { roundDir, roleName, payload, trajectoryArtifacts } = options;
  if (!payload || payload.length === 0) return "";
  const suffix = imageSuffix(payload);
  if (suffix === null || payload.length > 8 * 1024 * 1024) return "";
  const name = `${roleName}_final_screenshot${suffix}`;
  atomicBytesWrite(path.join(roundDir, name), payload);
  const mediaTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const item = {
    step_num: null,
    image_index: 1,
    screenshot_file: name,
    media_type: mediaTypes[suffix]!,
    bytes: payload.length,
    sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    kind: "final_environment_screenshot",
  };
  let screenshots = trajectoryArtifacts["screenshots"];
  if (!Array.isArray(screenshots)) {
    screenshots = [];
    trajectoryArtifacts["screenshots"] = screenshots;
  }
  (screenshots as unknown[]).push(item);
  trajectoryArtifacts["screenshot_count"] = (screenshots as unknown[]).length;
  trajectoryArtifacts["total_screenshot_bytes"] =
    Math.trunc(Number(trajectoryArtifacts["total_screenshot_bytes"] ?? 0) || 0) + payload.length;
  const manifestName = String(trajectoryArtifacts["screenshot_manifest"] || "");
  if (manifestName) {
    const manifest = {
      schema_version: 1,
      role: roleName,
      trajectory_file: String(trajectoryArtifacts["normalized_trajectory"] || ""),
      live: false,
      screenshot_count: trajectoryArtifacts["screenshot_count"],
      total_screenshot_bytes: trajectoryArtifacts["total_screenshot_bytes"],
      screenshots,
    };
    writeLocal(path.join(roundDir, manifestName), jsonDumpsIndent2(manifest) + "\n");
  }
  return name;
}

function imageSuffix(payload: Buffer): string | null {
  if (payload.length >= 8 && payload.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (payload.length >= 3 && payload[0] === 0xff && payload[1] === 0xd8 && payload[2] === 0xff) return ".jpg";
  if (
    payload.length >= 12 &&
    payload.subarray(0, 4).toString("latin1") === "RIFF" &&
    payload.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return ".webp";
  }
  const headSix = payload.subarray(0, 6).toString("latin1");
  if (headSix === "GIF87a" || headSix === "GIF89a") return ".gif";
  return null;
}

/** Materialize a provider-neutral OpenClaw-v3-style visible chat ledger. */
function episodeChatJsonl(result: EpisodeResult): string {
  const metadata = isPlainObject(result.metadata) ? result.metadata : {};
  const raw = result.actions_log || "";
  let texts = decodeAgentAssistantTexts(raw);
  if (!texts.length) {
    const visible = pyStrip(visibleOutput(result));
    if (visible) texts = [visible];
  }
  const records: Record<string, unknown>[] = [
    {
      type: "session",
      version: 3,
      id: "chat",
      timestamp: isoMilliseconds(new Date()),
      cwd: String(metadata["workspace"] || ""),
    },
  ];
  for (const text of texts) {
    records.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  }
  return records.map((record) => pyJsonDumps(record)).join("\n") + "\n";
}

function nextEpisodeDir(episodeRoot: string): string {
  ensureDirNofollow(episodeRoot);
  let highest = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(episodeRoot);
  } catch (exc) {
    throw new Error(`cannot scan episode root: ${episodeRoot}`, { cause: exc });
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (index >= 10_000) throw new Error(`too many episode entries: ${episodeRoot}`);
    const name = entries[index]!;
    if (name.length === 5 && name.startsWith("ep") && /^\d+$/.test(name.slice(2))) {
      highest = Math.max(highest, Number.parseInt(name.slice(2), 10));
    }
  }
  const episodeDir = path.join(episodeRoot, `ep${pad3(highest + 1)}`);
  if (lstatOrNull(episodeDir) !== null) throw new Error(`episode path already exists: ${episodeDir}`);
  ensureDirNofollow(episodeDir);
  return episodeDir;
}

/** Create OSWorld-style task-level `agent.log` and `chat.jsonl` files. */
export function mergeEpisodeLogs(logDir: string): void {
  const episodeRoots = [
    "manager_episodes",
    "gui_executor_episodes",
    "cli_executor_episodes",
    "gui_auditor_episodes",
    "cli_auditor_episodes",
    "final_response_episodes",
  ];
  const agentSections: string[] = [];
  const chatLines: string[] = [];
  let totalChars = 0;
  let totalChatChars = 0;
  const maxChars = 64 * 1024 * 1024;
  for (const rootName of episodeRoots) {
    const root = path.join(logDir, rootName);
    const rootStat = lstatOrNull(root);
    if (rootStat === null || !rootStat.isDirectory()) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(root).slice(0, 1_000);
    } catch {
      continue;
    }
    entries.sort();
    for (const entryName of entries) {
      const episodeDir = path.join(root, entryName);
      const entryStat = lstatOrNull(episodeDir);
      if (entryStat === null || !entryStat.isDirectory()) continue;
      const agentText = readLocalBounded(path.join(episodeDir, "agent.log"), MAX_SAVED_TRAJECTORY_BYTES) ?? "";
      const section = `\n===== ${rootName}/${entryName} agent.log =====\n${agentText}\n`;
      if (totalChars + section.length > maxChars) break;
      agentSections.push(section);
      totalChars += section.length;
      const chatText = readLocalBounded(path.join(episodeDir, "chat.jsonl"), MAX_SAVED_TRAJECTORY_BYTES) ?? "";
      for (const line of chatText.split("\n")) {
        if (!pyStrip(line)) continue;
        if (totalChatChars + line.length + 1 > maxChars) break;
        chatLines.push(line);
        totalChatChars += line.length + 1;
      }
    }
  }
  const resultDir = path.dirname(logDir);
  writeLocal(path.join(resultDir, "agent.log"), agentSections.join(""));
  writeLocal(path.join(resultDir, "chat.jsonl"), chatLines.length ? chatLines.join("\n") + "\n" : "");
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Rebuild the finished rounds of an interrupted run from its own ledger.
 *
 * `rounds.jsonl` is append-only and a round may be recorded more than once (the
 * loop re-records the last entry after a late gate decision), so the latest
 * entry for an index wins. Unreadable or malformed lines are skipped: a
 * partially written tail must not prevent a resume.
 */
export function recordedRounds(roleDir: string): ManagedRound[] {
  const ledgerPath = path.join(roleDir, "rounds.jsonl");
  let raw: string;
  try {
    const stat = fs.statSync(ledgerPath);
    if (!stat.isFile() || stat.size > MAX_ROUNDS_LEDGER_BYTES) return [];
    raw = fs.readFileSync(ledgerPath).toString("utf-8");
  } catch {
    return [];
  }
  const byIndex = new Map<number, ManagedRound>();
  for (const line of raw.split("\n")) {
    const stripped = pyStrip(line);
    if (!stripped) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(stripped);
    } catch {
      continue;
    }
    if (!isPlainObject(payload)) continue;
    const index = payload["round_index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > MAX_ROUNDS) continue;
    try {
      byIndex.set(index, managedRoundFromDict(payload));
    } catch {
      continue;
    }
  }
  return [...byIndex.keys()].sort((a, b) => a - b).map((index) => byIndex.get(index)!);
}

export function managedRoundFromDict(payload: Record<string, unknown>): ManagedRound {
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const status = (key: string): Record<string, unknown> =>
    isPlainObject(payload[key]) ? (payload[key] as Record<string, unknown>) : {};
  const nextStep = payload["next_step"];
  const refs = payload["related_report_refs"];
  return managedRound({
    round_index: Math.trunc(Number(payload["round_index"])),
    next_step: (typeof nextStep === "string" && ROUTE_VALUES.has(nextStep)
      ? nextStep
      : MANAGER_NEXT_INVALID) as RoleNextStep,
    plan_text: text("plan_text"),
    executor_output: text("executor_output"),
    auditor_report: text("auditor_report"),
    harness_feedback: text("harness_feedback"),
    task_state: text("task_state"),
    task_contract: text("task_contract"),
    related_report_refs: Array.isArray(refs) ? refs.filter((item): item is string => typeof item === "string") : [],
    manager_status: status("manager_status"),
    executor_status: status("executor_status"),
    auditor_status: status("auditor_status"),
  });
}

async function recordRound(
  env: Environment,
  config: HarnessConfig,
  roleDir: string,
  eventsPath: string,
  record: ManagedRound,
): Promise<void> {
  // rounds.jsonl is the append-only local ledger; round.json mirrors the same
  // state into the task VM for later inspection.
  const payload = jsonDumpsIndent2({ ...record });
  const roundsJsonl = path.join(roleDir, "rounds.jsonl");
  appendJsonlNofollow(roundsJsonl, { ...record });
  await writeRemoteRoundText(env, config, record.round_index, "round.json", payload);
  appendEvent(eventsPath, "managed_round_recorded", { ...record });
}

// ---------------------------------------------------------------------------
// Remote mirror (best effort)
// ---------------------------------------------------------------------------

async function ensureRemoteLayout(env: Environment, config: HarnessConfig): Promise<void> {
  // The remote layout is intentionally small: final report plus per-round role
  // artifacts under `.harness/orchestration`.
  const harnessDir = rstripChars(config.harness_dir, "/");
  for (const target of [harnessDir, `${harnessDir}/orchestration`, `${harnessDir}/orchestration/rounds`]) {
    try {
      await ensureRemoteDir(env, target);
    } catch (exc) {
      logger.warning(`remote trace directory setup skipped for ${target}: ${exceptionText(exc)}`);
    }
  }
}

async function writeRemoteRoundText(
  env: Environment,
  config: HarnessConfig,
  roundIndex: number,
  name: string,
  text: string,
): Promise<void> {
  const remoteDir = `${rstripChars(config.harness_dir, "/")}/orchestration/rounds/round_${pad3(roundIndex)}`;
  try {
    await ensureRemoteDir(env, remoteDir);
    await writeRemoteText(env, `${remoteDir}/${name}`, text);
  } catch (exc) {
    logger.warning(`remote trace write skipped for round_${pad3(roundIndex)}/${name}: ${exceptionText(exc)}`);
  }
}

async function writeRemoteTextBestEffort(env: Environment, remotePath: string, text: string): Promise<void> {
  try {
    await writeRemoteText(env, remotePath, text);
  } catch (exc) {
    logger.warning(`remote trace write skipped for ${remotePath}: ${exceptionText(exc)}`);
  }
}

// ---------------------------------------------------------------------------
// Bounded no-follow local reads / writes
// ---------------------------------------------------------------------------

function writeLocal(filePath: string, text: string): void {
  atomicBytesWrite(filePath, Buffer.from(text, "utf-8"));
}

function budgetToDict(budget: EpisodeBudget): Record<string, number> {
  return { max_duration_seconds: budget.max_duration_seconds };
}

/** Read a worker-owned diagnostic file through a bounded no-follow fd. */
function readLocalBounded(
  filePath: string,
  maxBytes: number,
  options: { tail?: boolean } = {},
): string | null {
  const tail = options.tail ?? false;
  let fd: number | null = null;
  try {
    // `O_NOFOLLOW` on only the final component is insufficient because the
    // worker can also replace `lh_harness`/`role_orchestration` with a symlink.
    // `openNofollow` walks every component from an anchored root descriptor.
    fd = openNofollow(filePath);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) return null;
    const size = Number(metadata.size);
    const start = tail ? Math.max(0, size - maxBytes) : 0;
    const chunks: Buffer[] = [];
    let remaining = maxBytes + 1;
    let position = start;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(remaining, 1024 * 1024));
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      chunks.push(buffer.subarray(0, read));
      position += read;
      remaining -= read;
    }
    let raw = Buffer.concat(chunks).subarray(0, maxBytes);
    if (tail && start) {
      // Do not feed a partial JSONL record to the crash detector.
      const firstNewline = raw.indexOf(0x0a);
      raw = firstNewline >= 0 ? raw.subarray(firstNewline + 1) : Buffer.alloc(0);
    }
    return raw.toString("utf-8");
  } catch {
    return null;
  } finally {
    closeQuietly(fd);
  }
}

function readLocalBytes(filePath: string, maxBytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openNofollow(filePath);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || Number(metadata.size) > maxBytes) return null;
    const chunks: Buffer[] = [];
    let remaining = Number(metadata.size);
    let position = 0;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(remaining, 1024 * 1024));
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      chunks.push(buffer.subarray(0, read));
      position += read;
      remaining -= read;
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    closeQuietly(fd);
  }
}

/** Read at most the latest `maxBytes` from a live role trajectory. */
function readLocalTextTail(filePath: string, maxBytes: number): [string, boolean] {
  let fd: number | null = null;
  try {
    fd = openNofollow(filePath);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) return ["", false];
    const size = Number(metadata.size);
    const truncated = size > maxBytes;
    const start = truncated ? size - maxBytes : 0;
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, size - start));
    let read = 0;
    while (read < buffer.length) {
      const chunk = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
      if (chunk === 0) break;
      read += chunk;
    }
    return [buffer.subarray(0, read).toString("utf-8"), truncated];
  } catch {
    return ["", false];
  } finally {
    closeQuietly(fd);
  }
}

function boundedTextTail(text: string, maxBytes: number): [string, boolean] {
  const raw = Buffer.from(text, "utf-8");
  if (raw.length <= maxBytes) return [text, false];
  return [raw.subarray(raw.length - maxBytes).toString("utf-8"), true];
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

function appendEvent(eventsPath: string, event: string, payload: Record<string, unknown>): void {
  ensureDirNofollow(path.dirname(eventsPath));
  // Event ids are assigned while holding the file open exclusively, so the same
  // absolute id survives snapshot truncation, REST replay, and a reconnect
  // after an API restart. The legacy `event` field remains for old readers.
  const nofollow = (fs.constants as unknown as Record<string, number>)["O_NOFOLLOW"];
  if (!nofollow) throw new Error("secure event append requires O_NOFOLLOW");
  let parentFd: number | null = null;
  let fd: number | null = null;
  try {
    parentFd = openNofollow(path.dirname(eventsPath), { directory: true });
    fd = fs.openSync(
      eventsPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | nofollow,
      0o600,
    );
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("event log is not a private regular file");
    }
    const size = Number(metadata.size);
    let existing = "";
    if (size > 0) {
      const buffer = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const chunk = fs.readSync(fd, buffer, read, size - read, read);
        if (chunk === 0) break;
        read += chunk;
      }
      existing = buffer.subarray(0, read).toString("utf-8");
    }
    let sequence = 1;
    for (const line of existing.split("\n")) if (pyStrip(line)) sequence += 1;
    const parents = pathParents(eventsPath);
    const runId = parents.length > 2 ? path.basename(parents[2]!) : "local";
    const record = {
      schema_version: 1,
      event_id: `${runId}:${String(sequence).padStart(6, "0")}`,
      ts: Date.now() / 1000,
      event,
      ...(jsonSafe(payload) as Record<string, unknown>),
    };
    fs.writeSync(fd, pyJsonDumps(record, { sortKeys: true }) + "\n");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync is best effort */
    }
  } finally {
    closeQuietly(fd);
    closeQuietly(parentFd);
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[String(key)] = jsonSafe(item);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

/** `json.dumps(value, ensure_ascii=False[, sort_keys=True])` — `, ` / `: ` separators. */
function pyJsonDumps(value: unknown, options: { sortKeys?: boolean } = {}): string {
  const sortKeys = options.sortKeys ?? false;
  const encode = (item: unknown): string => {
    if (item === null || item === undefined) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") return Number.isFinite(item) ? String(item) : Number.isNaN(item) ? "NaN" : item > 0 ? "Infinity" : "-Infinity";
    if (Array.isArray(item)) return "[" + item.map(encode).join(", ") + "]";
    if (typeof item === "object") {
      let keys = Object.keys(item as Record<string, unknown>);
      if (sortKeys) keys = keys.sort();
      return "{" + keys.map((key) => `${JSON.stringify(key)}: ${encode((item as Record<string, unknown>)[key])}`).join(", ") + "}";
    }
    return JSON.stringify(String(item));
  };
  return encode(value);
}

/** `json.dumps(value, ensure_ascii=False, indent=2)`; `undefined` becomes `null`. */
function jsonDumpsIndent2(value: unknown): string {
  return JSON.stringify(jsonSafe(value), null, 2);
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function rstripChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function pathParents(target: string): string[] {
  const out: string[] = [];
  let current = path.dirname(target);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
}

function unlinkQuietly(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    /* missing_ok=True plus suppressed OSError */
  }
}

function monotonic(): number {
  return performance.now() / 1000;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isoMilliseconds(value: Date): string {
  // Python: datetime.now(timezone.utc).isoformat(timespec="milliseconds")
  return value.toISOString().replace(/Z$/, "+00:00");
}

function expandUser(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) return path.join(os.homedir(), target.slice(2));
  return target;
}

/** `Path(p).expanduser().resolve(strict=False)`. */
function resolveNonStrict(target: string): string {
  const absolute = path.resolve(expandUser(target));
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      /* component does not exist yet */
    }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    current = parent;
  }
}

function cancellationError(): Error {
  const error = new Error("Execution cancelled by operator");
  error.name = "AbortError";
  return error;
}

function isCancellation(exc: unknown): boolean {
  if (exc === null || typeof exc !== "object") return false;
  const name = (exc as { name?: unknown }).name;
  return name === "AbortError" || name === "CancelledError";
}

function exceptionText(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

function exceptionType(exc: unknown): string {
  if (exc !== null && typeof exc === "object") {
    const ctor = (exc as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) return ctor.name;
  }
  return typeof exc;
}

function formatException(exc: unknown): string {
  if (exc instanceof Error && typeof exc.stack === "string") return exc.stack;
  return String(exc);
}
