import {
  LOOP_PHASES,
  type Approval,
  type EpisodeIndexEntry,
  type LoopConfig,
  type LoopPhase,
  type LoopSnapshot,
  type Plan,
  type PlanRevisionEntry,
  type ResearchNote,
  type Snapshot,
  type SubtaskView,
} from './types';
import { countStatuses, leaves } from './plan';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const EMPTY_LOOP: LoopSnapshot = {
  phase: null,
  task: '',
  config: null,
  plan: null,
  plan_markdown: '',
  plan_revisions: [],
  status_counts: null,
  briefings: {},
  research: [],
  research_notes: [],
  subtasks: [],
  episodes: [],
  cost_usd: 0,
  composer_episodes: 0,
  decisions: '',
  final_response: '',
};

/**
 * The snapshot's `loop` key is projected from files on disk and is `{}` before
 * the loop has written anything. Normalising once keeps every consumer free of
 * optional-chaining noise and of `undefined` array reads.
 */
export function normalizeLoop(raw: unknown): LoopSnapshot {
  if (!isRecord(raw)) return EMPTY_LOOP;
  const phase = isRecord(raw.phase) ? (raw.phase as unknown as LoopSnapshot['phase']) : null;
  const plan = isRecord(raw.plan) && Array.isArray((raw.plan as Record<string, unknown>).nodes)
    ? (raw.plan as unknown as Plan)
    : null;
  const research = Array.isArray(raw.research) ? raw.research.filter((item): item is string => typeof item === 'string') : [];
  const researchNotes = Array.isArray(raw.research_notes)
    ? (raw.research_notes as unknown[]).filter(isRecord).map((item) => ({
      file: typeof item.file === 'string' ? item.file : '',
      title: typeof item.title === 'string' ? item.title : '',
    })).filter((item): item is ResearchNote => Boolean(item.file))
    // An older server sends only the file names; a note is still listable.
    : research.map((file) => ({ file, title: '' }));
  return {
    phase,
    task: typeof raw.task === 'string' ? raw.task : '',
    config: normalizeConfig(raw.config),
    plan,
    plan_markdown: typeof raw.plan_markdown === 'string' ? raw.plan_markdown : '',
    plan_revisions: Array.isArray(raw.plan_revisions)
      ? (raw.plan_revisions as unknown[]).filter(isRecord).map((item) => ({
        revision: Number(item.revision) || 0,
        note: typeof item.note === 'string' ? item.note : '',
        written_at: Number(item.written_at) || 0,
      })).sort((left, right) => right.revision - left.revision)
      : [],
    status_counts: isRecord(raw.status_counts) ? (raw.status_counts as Record<string, number>) : null,
    briefings: isRecord(raw.briefings) ? (raw.briefings as Record<string, string>) : {},
    research,
    research_notes: researchNotes,
    subtasks: Array.isArray(raw.subtasks) ? (raw.subtasks as SubtaskView[]) : [],
    episodes: Array.isArray(raw.episodes) ? (raw.episodes as EpisodeIndexEntry[]) : [],
    cost_usd: typeof raw.cost_usd === 'number' && Number.isFinite(raw.cost_usd) ? raw.cost_usd : 0,
    composer_episodes: typeof raw.composer_episodes === 'number' && Number.isFinite(raw.composer_episodes) ? Math.trunc(raw.composer_episodes) : 0,
    decisions: typeof raw.decisions === 'string' ? raw.decisions : '',
    final_response: typeof raw.final_response === 'string' ? raw.final_response : '',
  };
}

function normalizeConfig(raw: unknown): LoopConfig | null {
  if (!isRecord(raw)) return null;
  return {
    max_rounds: Number(raw.max_rounds) || 0,
    max_eval_rounds: Number(raw.max_eval_rounds) || 0,
    min_research_agents: Number(raw.min_research_agents) || 0,
    research_model: typeof raw.research_model === 'string' ? raw.research_model : '',
  };
}

/** Sorted newest-first; `plan_revisions` is the summary the tab lists. */
export function planRevisions(loop: LoopSnapshot): PlanRevisionEntry[] {
  return loop.plan_revisions;
}

export function loopOf(snapshot: Snapshot): LoopSnapshot {
  return normalizeLoop(snapshot.loop);
}

export function subtaskById(loop: LoopSnapshot, id: string | null): SubtaskView | null {
  if (!id) return null;
  return loop.subtasks.find((item) => item.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Phase strip
// ---------------------------------------------------------------------------

export type PhaseState = 'done' | 'active' | 'pending' | 'failed';

export interface PhaseStep {
  phase: LoopPhase;
  label: string;
  state: PhaseState;
}

const PHASE_LABELS: Record<LoopPhase, string> = {
  intake: 'Intake',
  tailoring: 'Tailoring',
  planning: 'Planning',
  executing: 'Executing',
  finalizing: 'Finalizing',
  finished: 'Finished',
};

export function phaseTitle(phase: string | null | undefined): string {
  const key = String(phase || '') as LoopPhase;
  return PHASE_LABELS[key] || (phase ? String(phase) : 'Not started');
}

const TERMINAL_STATUSES = new Set([
  'completed', 'complete', 'success', 'succeeded', 'done', 'finished',
  'failed', 'failure', 'blocked', 'incomplete', 'cancelled', 'canceled', 'stopped', 'aborted',
]);

export function isTerminalStatus(status: unknown): boolean {
  return TERMINAL_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

export function isStoppingStatus(status: unknown): boolean {
  return ['stopping', 'aborting', 'stop_requested', 'abort_requested'].includes(String(status ?? '').trim().toLowerCase());
}

const FAILED_STATUSES = new Set(['failed', 'failure', 'cancelled', 'canceled', 'stopped', 'aborted', 'blocked', 'incomplete']);

/** The six-step strip above the graph, with the run's current phase marked. */
export function phaseStrip(snapshot: Snapshot, loop: LoopSnapshot = loopOf(snapshot)): PhaseStep[] {
  const current = loop.phase?.phase ?? null;
  const runStatus = String(snapshot.run.status || '').trim().toLowerCase();
  const failed = FAILED_STATUSES.has(runStatus);
  const finished = runStatus === 'completed' || runStatus === 'complete' || current === 'finished';
  const currentIndex = current ? LOOP_PHASES.indexOf(current) : -1;
  return LOOP_PHASES.map((phase, index) => {
    let state: PhaseState;
    if (finished) state = 'done';
    else if (currentIndex < 0) state = 'pending';
    else if (index < currentIndex) state = 'done';
    else if (index > currentIndex) state = 'pending';
    else state = failed ? 'failed' : 'active';
    return { phase, label: PHASE_LABELS[phase], state };
  });
}

/** `subtask <id> · <role> · round N`, or an empty string outside execution. */
export function phaseDetailLine(loop: LoopSnapshot): string {
  const phase = loop.phase;
  if (!phase) return '';
  const parts: string[] = [];
  if (phase.current_subtask) parts.push(phase.current_subtask);
  if (phase.current_role) parts.push(phase.current_role.replaceAll('_', ' '));
  if (phase.current_round) parts.push(`round ${phase.current_round}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface EpisodeRef {
  role: string;
  seq: number;
}

/**
 * The `{role, seq}` the trajectory and artifact routes are keyed by.
 *
 * `ep` is authoritative when the backend supplies it. Runs recorded before that
 * field existed fall back to parsing `…/composer_episodes/ep004`, and finally
 * to the global `seq` — which is only correct for single-role runs, but is
 * better than dropping the link.
 */
export function episodeRef(entry: Pick<EpisodeIndexEntry, 'role' | 'dir' | 'seq'> & { ep?: number }): EpisodeRef | null {
  const role = String(entry.role || '').trim();
  if (!role) return null;
  const ep = Number(entry.ep);
  if (Number.isInteger(ep) && ep > 0) return { role, seq: ep };
  const match = /([a-z_]+)_episodes[/\\]ep(\d{3,})$/u.exec(String(entry.dir || ''));
  if (match) return { role: match[1]!, seq: Number.parseInt(match[2]!, 10) };
  const seq = Number(entry.seq);
  return Number.isInteger(seq) && seq > 0 ? { role, seq } : null;
}

/** Newest first, which is the order the trajectory picker offers. */
export function episodesNewestFirst(episodes: readonly EpisodeIndexEntry[]): EpisodeIndexEntry[] {
  return [...episodes].sort((left, right) => right.seq - left.seq);
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

/**
 * Approvals the operator can still act on.
 *
 * A stale pending record can survive a crash or a stop. Keep it in the event
 * history, but never render an actionable gate for a run whose lifecycle has
 * already ended: clicking it cannot resume anything.
 */
export function actionableApprovals(snapshot: Snapshot): Approval[] {
  if (isTerminalStatus(snapshot.run.status)) return [];
  return snapshot.approvals.filter((approval) => approval.status === 'pending');
}

export interface RunOverview {
  task: string;
  title: string;
  summary: string;
  assumptions: string[];
  questions: string[];
  counts: Record<string, number>;
  leafCount: number;
  revision: number;
  costUsd: number | null;
  roundsRun: number | null;
  maxRounds: number | null;
  maxEvalRounds: number | null;
  researchModel: string;
  decisions: string;
  finalResponse: string;
}

/** What the right rail shows when no plan node is selected. */
export function runOverview(snapshot: Snapshot, loop: LoopSnapshot = loopOf(snapshot)): RunOverview {
  const plan = loop.plan;
  const counts = loop.status_counts && Object.keys(loop.status_counts).length
    ? loop.status_counts
    : countStatuses(plan);
  return {
    task: loop.task || snapshot.mission.task || '',
    title: plan?.title || '',
    summary: plan?.summary || '',
    assumptions: plan?.assumptions || [],
    questions: plan?.questions || [],
    counts,
    leafCount: leaves(plan).length,
    revision: plan?.revision ?? 0,
    costUsd: runCost(snapshot, loop),
    roundsRun: composerEpisodes(snapshot, loop),
    maxRounds: loop.config?.max_rounds || (typeof snapshot.run.max_rounds === 'number' ? snapshot.run.max_rounds : null),
    maxEvalRounds: loop.config?.max_eval_rounds || null,
    researchModel: loop.config?.research_model || '',
    decisions: loop.decisions,
    finalResponse: loop.final_response || snapshot.run.final_response || '',
  };
}

/**
 * Spend so far.
 *
 * `report.json` only exists once the run ends, so its total is authoritative
 * when present and the live episode-index sum carries the value until then.
 */
export function runCost(snapshot: Snapshot, loop: LoopSnapshot = loopOf(snapshot)): number | null {
  if (typeof snapshot.run.cost_usd === 'number' && snapshot.run.cost_usd > 0) return snapshot.run.cost_usd;
  return loop.cost_usd > 0 ? loop.cost_usd : (typeof snapshot.run.cost_usd === 'number' ? snapshot.run.cost_usd : null);
}

/** Composer episodes finished so far, from the live index or the final report. */
export function composerEpisodes(snapshot: Snapshot, loop: LoopSnapshot = loopOf(snapshot)): number | null {
  if (loop.composer_episodes > 0) return loop.composer_episodes;
  return typeof snapshot.run.rounds_run === 'number' ? snapshot.run.rounds_run : null;
}
