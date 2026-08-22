// Ported 1:1 from LongHorizon-Harness src/lh_harness/dashboard/rules.py
//
// Rule engine for the "repeated failure" human-review trigger.
//
// Completion and max-rounds are decided by the manager directly; these rules
// only cover the *special* condition, too many failing rounds in a row. Each rule
// inspects the current round index plus recorded rounds and returns a
// human-readable reason when human review should be requested, or ``null``.

// A rule takes (round_index, rounds) and returns a reason or null.
export type Rule = (roundIndex: number, rounds: Record<string, unknown>[]) => string | null;

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  // ``int(os.getenv(name, str(default)))``: only a plain base-10 integer wins.
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) return defaultValue;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : defaultValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Ask for review after several consecutive failing rounds.
 *
 * A round counts as failing when the manager route was invalid, a
 * completion request was rejected, or the task episode errored.
 */
export function ruleRepeatedFailure(limit: number): Rule {
  return (_roundIndex: number, rounds: Record<string, unknown>[]): string | null => {
    let streak = 0;
    for (let index = rounds.length - 1; index >= 0; index -= 1) {
      const item = rounds[index];
      const auditorStatus = asRecord(item.auditor_status);
      const executorStatus = asRecord(item.executor_status);
      const repairStatus = asRecord(auditorStatus.format_repair_status);
      const failed = Boolean(
        auditorStatus.invalid_plan ||
          auditorStatus.invalid_completion ||
          executorStatus.status === "error" ||
          executorStatus.status === "timeout" ||
          auditorStatus.status === "error" ||
          auditorStatus.status === "timeout" ||
          repairStatus.status === "error" ||
          repairStatus.status === "timeout",
      );
      if (failed) {
        streak += 1;
      } else {
        break;
      }
    }
    if (streak >= limit) {
      return (
        `${streak} consecutive rounds failed (invalid route / rejected completion / ` +
        `episode error; threshold ${limit}). The run may be looping; operator input is requested.`
      );
    }
    return null;
  };
}

/** Aggregates the active rules and evaluates them for a round. */
export class ApprovalRules {
  private readonly rules: Rule[];

  constructor(rules: Rule[] | null = null) {
    this.rules = rules ?? defaultRules();
  }

  evaluate(roundIndex: number, rounds: Record<string, unknown>[]): string | null {
    for (const rule of this.rules) {
      const reason = rule(roundIndex, rounds);
      if (reason) return reason;
    }
    return null;
  }
}

export function defaultRules(): Rule[] {
  const failureLimit = Math.max(1, envInt("LH_HARNESS_DASHBOARD_FAILURE_LIMIT", 3));
  return [ruleRepeatedFailure(failureLimit)];
}
