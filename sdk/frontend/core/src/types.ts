export type RunStatus = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | string;

/** Must stay aligned with the server-side ingress ceiling. */
export const MAX_ROUNDS = 1000;

/** The three roles an operator configures when creating a run. */
export type LoopRole = 'planner' | 'composer' | 'evaluator';
export const LOOP_ROLES: readonly LoopRole[] = ['planner', 'composer', 'evaluator'];

/** Every role that owns an episode directory (`<role>_episodes/epNNN`). */
export type EpisodeRole = 'prompt_tailor' | 'planner' | 'rubric' | 'composer' | 'evaluator' | 'final_response';
export const EPISODE_ROLES: readonly EpisodeRole[] = [
  'prompt_tailor', 'planner', 'rubric', 'composer', 'evaluator', 'final_response',
];

export interface EventEnvelope {
  schema_version: number;
  event_id: string;
  type: string;
  ts: number;
  run_id: string;
  round: number | null;
  role: string | null;
  status: string | null;
  payload: Record<string, unknown>;
  legacy: Record<string, unknown>;
  offset?: number;
}

export interface ApprovalOption {
  value: string;
  label: string;
  style?: string;
}

export interface Approval {
  approval_id: string;
  title: string;
  message: string;
  options: ApprovalOption[];
  answers: string[];
  allow_input: boolean;
  input_label: string;
  /** Budget gates let the operator grant a specific number of extra rounds. */
  allow_extra_rounds?: boolean;
  /** `trigger` is one of completed | max_rounds | needs_input | needs_human | repeated_failure. */
  context: Record<string, unknown>;
  round_index: number;
  status: 'pending' | 'resolved' | string;
  action: string;
  reason: string;
  user_input: string;
  extra_rounds?: number;
  created_at: number;
  resolved_at: number | null;
}

export interface OperatorMessage {
  id: string;
  text: string;
  created_at: number;
  status: 'queued' | 'applied' | 'rejected' | 'failed' | 'cancelled' | string;
}

// ---------------------------------------------------------------------------
// The plan tree — a copy of the shapes in `sdk/src/loop/plan.ts`.
// `core` cannot import from the harness sources, so the contract is duplicated
// here and must be kept in step with that file.
// ---------------------------------------------------------------------------

export type BackingKind = 'reasoning' | 'web' | 'source' | 'memory';

export interface Backing {
  kind: BackingKind;
  ref: string;
  note: string;
}

export type NodeStatus =
  | 'pending'
  | 'rubric'
  | 'composing'
  | 'evaluating'
  | 'done'
  | 'blocked'
  | 'skipped';

export const NODE_STATUSES: readonly NodeStatus[] = [
  'pending', 'rubric', 'composing', 'evaluating', 'done', 'blocked', 'skipped',
];

/** Statuses that mean a role is currently holding the node. */
export const ACTIVE_NODE_STATUSES: readonly NodeStatus[] = ['rubric', 'composing', 'evaluating'];

export interface PlanNode {
  id: string;
  title: string;
  goal: string;
  rationale: string;
  backing: Backing[];
  constraints: string[];
  deliverables: string[];
  acceptance: string[];
  depends_on: string[];
  children: PlanNode[];
  status: NodeStatus;
  /** Composer↔evaluator rounds spent on this leaf. */
  rounds: number;
  last_verdict: 'PASS' | 'NEEDS_WORK' | null;
  /** Who created the node: `planner`, `evaluator:<subtask>` or `operator`. */
  added_by: string;
  note: string;
}

export interface Plan {
  schema_version: number;
  title: string;
  summary: string;
  assumptions: string[];
  questions: string[];
  nodes: PlanNode[];
  revision: number;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Loop state — a copy of the shapes in `sdk/src/loop/state.ts`.
// ---------------------------------------------------------------------------

export type LoopPhase = 'intake' | 'tailoring' | 'planning' | 'executing' | 'finalizing' | 'finished';

export const LOOP_PHASES: readonly LoopPhase[] = [
  'intake', 'tailoring', 'planning', 'executing', 'finalizing', 'finished',
];

export interface PhaseRecord {
  phase: LoopPhase;
  current_subtask: string | null;
  current_role: string | null;
  current_round: number | null;
  updated_at: number;
  detail: string;
}

export interface ContractCriterion {
  id: string;
  statement: string;
  verify: string;
  evidence: string;
  mandatory: boolean;
  weight: number;
  passes: boolean;
  score: number | null;
  finding: string;
}

export interface Contract {
  subtask_id: string;
  criteria: ContractCriterion[];
  scoring: { scale: string; pass_rule: string };
  created_at: number;
  updated_at: number;
}

export interface EvaluationCriterion {
  id: string;
  passes: boolean;
  score: number | null;
  checked: string[];
  finding: string;
}

export interface EvaluationRecord {
  subtask_id: string;
  round: number;
  verdict: 'PASS' | 'NEEDS_WORK';
  /** What the evaluator said before the harness applied the contract's pass rule. */
  claimed_verdict: 'PASS' | 'NEEDS_WORK' | 'invalid';
  summary: string;
  criteria: EvaluationCriterion[];
  findings: string[];
  plan_changes: unknown[];
  memory_notes: string[];
  narrative: string;
  harness_note: string;
  episode_dir: string;
  created_at: number;
}

export interface EpisodeIndexEntry {
  seq: number;
  /**
   * Per-role episode number: the NNN of `<role>_episodes/epNNN`, and the key
   * the trajectory/artifact routes take. Optional because runs recorded before
   * the field existed only carry `dir`, which `episodeRef` falls back to.
   */
  ep?: number;
  role: string;
  subtask_id: string | null;
  round: number | null;
  dir: string;
  status: 'running' | 'done' | 'error' | 'timeout' | 'cancelled' | string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  error: string | null;
}

/** One hook-written evidence-ledger record (`state/evidence/<id>/ledger.jsonl`). */
export interface LedgerEntry {
  ts: number;
  subtask?: string;
  round?: number;
  kind: 'write' | 'bash' | string;
  tool: string;
  path?: string;
  /** Absent/null for a file the composer created rather than modified. */
  sha256_before?: string | null;
  sha256_after?: string | null;
  bytes?: number | null;
  command?: string;
}

export interface EvidenceFile {
  name: string;
  bytes: number;
}

/** The limits the loop was started with (`state/config.json`). */
export interface LoopConfig {
  /** Ceiling on composer episodes for the whole run. */
  max_rounds: number;
  /** Ceiling on composer↔evaluator rounds for one leaf. */
  max_eval_rounds: number;
  min_research_agents: number;
  research_model: string;
}

export interface PlanRevisionEntry {
  revision: number;
  note: string;
  written_at: number;
}

export interface ResearchNote {
  file: string;
  title: string;
}

export interface ContextSection {
  title: string;
  kind: string;
  path: string;
  reason: string;
  chars: number;
}

export interface ContextPack {
  round: number;
  sections: ContextSection[];
  selector: string;
}

export interface SubtaskView {
  id: string;
  title: string;
  status: string;
  rounds: number;
  last_verdict: string | null;
  contract: Contract | null;
  rubric: string;
  progress: string;
  evidence_files: string[];
  /** Evidence files with sizes, so the panel can warn before fetching media. */
  evidence_meta: EvidenceFile[];
  ledger_count: number;
  /** The newest hook-written ledger entries (bounded to 200 by the backend). */
  ledger: LedgerEntry[];
  evaluations: EvaluationRecord[];
  context: ContextPack[];
  episodes: EpisodeIndexEntry[];
}

export interface LoopSnapshot {
  phase: PhaseRecord | null;
  task: string;
  config: LoopConfig | null;
  plan: Plan | null;
  plan_markdown: string;
  plan_revisions: PlanRevisionEntry[];
  status_counts: Record<string, number> | null;
  /** Tailored briefings keyed by role (planner, rubric, composer, evaluator). */
  briefings: Record<string, string>;
  /** File names under `state/research/`. */
  research: string[];
  research_notes: ResearchNote[];
  subtasks: SubtaskView[];
  episodes: EpisodeIndexEntry[];
  /** Running totals from the episode index; `report.json` only exists at the end. */
  cost_usd: number;
  composer_episodes: number;
  /** The operator decisions ledger (`state/task/DECISIONS.md`), as markdown. */
  decisions: string;
  final_response: string;
}

export interface RoleConfig {
  agent: string;
  model: string;
  reasoning_effort?: string;
}

export interface RunSummary {
  id: string;
  task: string;
  status: RunStatus;
  updated_at: number;
  log_dir: string;
  agent?: string;
  model?: string | null;
  role_configs?: Record<LoopRole, RoleConfig>;
  workspace?: string;
  max_rounds?: number;
  prompt_language?: 'en';
}

export interface Snapshot {
  schema_version: number;
  run: {
    id: string;
    status: RunStatus;
    started_at?: number | null;
    finished_at?: number | null;
    log_dir: string;
    completion_satisfied?: boolean | null;
    completion_authority?: string | null;
    report_status?: string | null;
    exit_code?: number | null;
    failure_reason?: string | null;
    /** Durable user-facing reply written by the `final_response` role. */
    final_response?: string;
    /** Accumulated cost across every episode, when the report carries one. */
    cost_usd?: number | null;
    /** Composer episodes spent so far. */
    rounds_run?: number | null;
    agent?: string;
    model?: string | null;
    role_configs?: Record<LoopRole, RoleConfig>;
    workspace?: string;
    /** Configured ceiling on composer episodes. */
    max_rounds?: number;
    prompt_language?: 'en';
    /** Generation counter: bumped each time a terminal run is resumed in place. */
    resume_epoch?: number;
    /** Lifecycle action the operator asked for: 'stop' or 'abort'. */
    requested_action?: string;
    stop_requested_at?: number;
  };
  mission: { task: string; plan_path: string; report_path: string };
  loop: LoopSnapshot;
  active_subtask: string | null;
  active_role: string | null;
  events: EventEnvelope[];
  approvals: Approval[];
  operator_messages?: OperatorMessage[];
  controls: { can_inject: boolean; can_abort: boolean; can_resume: boolean };
  diagnostics: {
    last_event_id: string | null;
    event_count: number;
    warnings: string[];
    cursor_gap?: boolean;
    resync_required?: boolean;
  };
  legacy?: Record<string, unknown>;
}

/** `GET /api/runs/{id}/episodes/{role}/{seq}/artifacts`. */
export interface EpisodeArtifactList {
  run_id: string;
  role: string;
  episode: number;
  artifacts: string[];
}

/** `GET /api/runs/{id}/state/{path}?list=1`. */
export interface StateDirListing {
  path: string;
  entries: string[];
}
