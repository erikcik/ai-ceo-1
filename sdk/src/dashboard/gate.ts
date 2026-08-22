// Ported 1:1 from LongHorizon-Harness src/lh_harness/dashboard/gate.py
//
// Single human-in-the-loop hook, evaluated at the END of every round.
//
// The manager calls one hook per round with the round's ``outcome`` and
// ``reached_max``. The hook classifies whether a human gate is needed and, if so,
// raises a blocking approval dialog. Trigger conditions (see ``TRIGGERS``):
//
// 1. ``completed`` / ``max_rounds``: the run finished or hit the round budget.
// 2. ``needs_human``: the round's output explicitly requires human intervention
//    (manager reported blocked).
// 3. ``repeated_failure``, a special condition: too many failing rounds in a row.
//
// Adding a new trigger = add one ``Trigger`` to ``TRIGGERS`` and one clause in
// ``classify``; nothing else changes.

import { ApprovalRules } from "./rules.js";
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

const DEFAULT_INPUT_LABEL = "Optional: add instructions for the next manager round";

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
    "Task complete. Continue the run?",
    "The manager confirmed task completion. Continue to add rounds and inject instructions, or end this run.",
    [CONTINUE, STOP_FINISH],
    { allow_extra_rounds: true },
  ),
  max_rounds: trigger(
    "Round limit reached. Continue the run?",
    "The configured round budget is exhausted before completion. Continue to add rounds, or end this run.",
    [CONTINUE, STOP_FINISH],
    { allow_extra_rounds: true },
  ),
  needs_input: trigger(
    "Manager needs your decision",
    "The manager needs your decision or input before it can continue. Answer below and continue, or stop this run.",
    [CONTINUE, STOP_ABORT],
    { input_label: "Your answer, injected into the next manager round" },
  ),
  needs_human: trigger(
    "Task blocked; operator input required",
    "The manager reported that it cannot proceed automatically. Add instructions and continue, or stop this run.",
    [CONTINUE, STOP_ABORT],
  ),
  repeated_failure: trigger(
    "Repeated failures require operator input",
    "The manager produced invalid routes or rejected completions over several rounds and may be looping. Add instructions and continue, or stop this run.",
    [CONTINUE, STOP_ABORT],
    { allow_extra_rounds: true },
  ),
};

/** Return ``[triggerKind, extraMessage]`` when a gate is needed, else null. */
export function classify(
  outcome: string,
  reachedMax: boolean,
  roundIndex: number,
  rounds: Record<string, unknown>[],
  rules: ApprovalRules,
): [string, string] | null {
  if (outcome === "completed") return ["completed", ""];
  if (outcome === "ask") return ["needs_input", ""]; // extra_message filled from the manager question
  // The hard round limit takes precedence over a generic blocked/failure
  // outcome on the same final round, so the operator is explicitly told that
  // the configured budget was exhausted and can decide whether to extend it.
  if (reachedMax) return ["max_rounds", ""];
  if (outcome === "blocked") return ["needs_human", ""];
  const reason = rules.evaluate(roundIndex, rounds); // repeated-failure streak, etc.
  if (reason) return ["repeated_failure", reason];
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
  rules?: ApprovalRules | null;
  pollInterval?: number;
  defaultExtraRounds?: number;
}

/** Build the unified end-of-round human-in-the-loop hook for the dashboard. */
export function makeHumanHook(state: DashboardState, options: MakeHumanHookOptions = {}): HumanHook {
  const rules = options.rules ?? new ApprovalRules();
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

    const outcome = String(context.outcome || "progress");
    const reachedMax = Boolean(context.reached_max);
    const roundIndexValue = context.round_index;
    const roundIndex =
      typeof roundIndexValue === "number" ? Math.trunc(roundIndexValue) : Number.parseInt(String(roundIndexValue ?? 0), 10) || 0;
    const rounds = (Array.isArray(context.rounds) ? context.rounds : []) as Record<string, unknown>[];

    const classified = classify(outcome, reachedMax, roundIndex, rounds, rules);
    if (classified === null) {
      // No blocking gate this round; just pass queued injections forward.
      return { action: "continue", instructions: injections.join("\n") };
    }

    const [kind, extraMessage] = classified;
    const spec = TRIGGERS[kind];
    // For an "ask" gate, show the manager's actual question prominently and
    // offer its quick-answer choices (e.g. Yes/No) as one-click buttons.
    const question = pyStrip(String(context.question || ""));
    const rawAnswers = kind === "needs_input" ? context.answers : null;
    const answers = Array.isArray(rawAnswers) ? rawAnswers.map((item) => String(item)) : [];
    const message =
      kind === "needs_input" && question
        ? `${spec.message}\n\nManager question:\n${question}`
        : extraMessage || spec.message;
    const approval = state.createApproval({
      title: spec.title,
      message,
      options: [...spec.options],
      answers,
      input_label: spec.input_label,
      allow_extra_rounds: spec.allow_extra_rounds,
      context: {
        phase: "end_of_round",
        trigger: kind,
        outcome,
        round_index: roundIndex,
        question,
        // Kept separate from `message`: clients localize the dialog from
        // `trigger`, which would otherwise discard this rule detail.
        detail: extraMessage,
        task: context.task ?? "",
        task_state: context.task_state ?? "",
        // The reply is written before this gate so the operator decides
        // against the actual answer; report.json does not exist yet.
        final_response: context.final_response ?? "",
        round_count: rounds.length,
      },
    });
    const resolved = await waitResolved(approval.approval_id);
    const parts = [...injections];
    if (pyStrip(resolved.user_input)) parts.push(pyStrip(resolved.user_input));
    return {
      action: resolved.action, // "continue" | "stop"
      instructions: parts.join("\n"),
      // The operator's own choice wins; 0 falls back to the caller's default,
      // which in turn falls back to the manager's configured budget.  Without
      // this the dialog's round input was ignored.
      extra_rounds: resolved.extra_rounds || defaultExtraRounds,
      reason: resolved.reason,
    };
  };
}
