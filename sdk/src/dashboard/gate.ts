// Single human-in-the-loop hook, called by the loop at its decision points:
// after planning (open questions), after every subtask (done / blocked),
// when the composer budget runs out, on repeated episode failures, and on
// completion. The hook classifies the moment, raises a blocking approval the
// workbench renders, and returns the operator's answer.
//
// Adding a trigger = one `Trigger` in `TRIGGERS` and one clause in `classify`.

import { Approval, ApprovalOption, DashboardState } from "./state.js";
import { pyStrip } from "../utils/pystr.js";

export type HumanHook = (context: Record<string, unknown>) => Promise<Record<string, unknown>>;

// Dialog text is authored in English and persisted that way in approvals.jsonl.
// The dashboard localizes each dialog from its `trigger` key, so these strings
// are the fallback for clients that do not (older records, API consumers).
const CONTINUE = new ApprovalOption("continue", "Continue run", "primary");
const STOP_FINISH = new ApprovalOption("stop", "End run", "danger");
const STOP_ABORT = new ApprovalOption("stop", "Stop run", "danger");

/** A dialog template for one gate condition (data-driven, easy to extend). */
interface Trigger {
  title: string;
  message: string;
  options: ApprovalOption[];
  input_label: string;
  // Gates raised because the run ran out of budget (or is looping) let the
  // operator say how many more rounds to grant before continuing.
  allow_extra_rounds: boolean;
}

const DEFAULT_INPUT_LABEL = "Optional: instructions for the next subtask (recorded in the decisions ledger)";

function trigger(
  title: string,
  message: string,
  options: ApprovalOption[],
  extra: { input_label?: string; allow_extra_rounds?: boolean } = {},
): Trigger {
  return {
    title,
    message,
    options,
    input_label: extra.input_label ?? DEFAULT_INPUT_LABEL,
    allow_extra_rounds: extra.allow_extra_rounds ?? false,
  };
}

export const TRIGGERS: Record<string, Trigger> = {
  completed: trigger(
    "Every subtask passed. Continue with a follow-up?",
    "All plan leaves passed their evaluation and the reply is written. Add a follow-up and continue (the planner amends the plan), or end this run.",
    [CONTINUE, STOP_FINISH],
    { allow_extra_rounds: true, input_label: "Optional follow-up instructions (turned into new subtasks)" },
  ),
  max_rounds: trigger(
    "Composer budget exhausted. Continue the run?",
    "The configured number of composer episodes is used up before every subtask passed. Grant more episodes and continue, or end this run.",
    [CONTINUE, STOP_FINISH],
    { allow_extra_rounds: true },
  ),
  needs_input: trigger(
    "The planner has questions for you",
    "Answer below and continue; the answers go into the decisions ledger every role reads. Or stop this run.",
    [CONTINUE, STOP_ABORT],
    { input_label: "Your answers (numbered like the questions)" },
  ),
  needs_human: trigger(
    "A subtask is blocked",
    "The composer and evaluator could not reach PASS within the round budget. Add instructions and continue (the subtask is re-opened with fresh rounds), continue without instructions to move on, or stop this run.",
    [CONTINUE, STOP_ABORT],
    { input_label: "Instructions for re-opening this subtask (leave empty to skip it)" },
  ),
  repeated_failure: trigger(
    "Repeated episode failures",
    "Several agent episodes in a row ended in errors, timeouts or unreadable verdicts. Add instructions and continue, or stop this run.",
    [CONTINUE, STOP_ABORT],
    { allow_extra_rounds: true },
  ),
};

/** Return ``[triggerKind, extraMessage]`` when a gate is needed, else null. */
export function classify(context: Record<string, unknown>): [string, string] | null {
  const outcome = String(context.outcome || "progress");
  const phase = String(context.phase || "");
  if (outcome === "completed") return ["completed", ""];
  if (outcome === "ask") return ["needs_input", ""];
  if (context.reached_max) return ["max_rounds", ""];
  if (outcome === "blocked") return ["needs_human", String(context.note || "")];
  if (phase === "repeated_failure") return ["repeated_failure", String(context.detail || "")];
  return null;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    // Deliberately NOT unref()'d. While the hook waits for the operator this
    // timer can be the supervised worker's only live handle; asyncio.sleep keeps
    // the Python loop alive, whereas an unref'd timer let Node exit with code 0
    // mid-gate (supervisor: "worker exited without a valid final report").
    void timer;
  });
}

export interface MakeHumanHookOptions {
  pollInterval?: number;
  defaultExtraRounds?: number;
}

/** Build the unified end-of-round human-in-the-loop hook for the dashboard. */
export function makeHumanHook(state: DashboardState, options: MakeHumanHookOptions = {}): HumanHook {
  const pollInterval = options.pollInterval ?? 0.5;
  const defaultExtraRounds = options.defaultExtraRounds ?? 0;

  async function waitResolved(approvalId: string): Promise<Approval> {
    for (;;) {
      const current = state.getApproval(approvalId);
      if (current !== null && current.status === "resolved") return current;
      await sleep(pollInterval);
    }
  }

  return async function hook(context: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Free-form operator notes queued from the UI are always carried forward.
    const injections = state.drainInjections().filter((text) => pyStrip(text));
    const classified = classify(context);
    if (classified === null) {
      return { action: "continue", instructions: injections.join("\n") };
    }
    const [kind, extraMessage] = classified;
    const spec = TRIGGERS[kind];
    const question = pyStrip(String(context.question || ""));
    const rawAnswers = kind === "needs_input" ? context.answers : null;
    const answers = Array.isArray(rawAnswers) ? rawAnswers.map((item) => String(item)) : [];
    const subtask = context.subtask_id ? `${context.subtask_id}${context.subtask_title ? ` — ${context.subtask_title}` : ""}` : "";
    let message = spec.message;
    if (kind === "needs_input" && question) message = `${spec.message}\n\nQuestions:\n${question}`;
    else if (extraMessage) message = `${spec.message}\n\n${extraMessage}`;
    if (subtask) message = `${message}\n\nSubtask: ${subtask}`;
    const roundIndexValue = context.round_index;
    const roundIndex =
      typeof roundIndexValue === "number" ? Math.trunc(roundIndexValue) : Number.parseInt(String(roundIndexValue ?? 0), 10) || 0;
    const approval = state.createApproval({
      title: spec.title,
      message,
      options: [...spec.options],
      answers,
      input_label: spec.input_label,
      allow_extra_rounds: spec.allow_extra_rounds,
      context: {
        phase: String(context.phase || ""),
        trigger: kind,
        outcome: String(context.outcome || ""),
        round_index: roundIndex,
        subtask_id: context.subtask_id ?? null,
        subtask_title: context.subtask_title ?? null,
        question,
        detail: extraMessage,
        task: context.task ?? "",
        final_response: context.final_response ?? "",
        plan_status: context.plan_status ?? null,
      },
    });
    const resolved = await waitResolved(approval.approval_id);
    const parts = [...injections];
    if (pyStrip(resolved.user_input)) parts.push(pyStrip(resolved.user_input));
    return {
      action: resolved.action,
      instructions: parts.join("\n"),
      extra_rounds: resolved.extra_rounds || defaultExtraRounds,
      reason: resolved.reason,
    };
  };
}
