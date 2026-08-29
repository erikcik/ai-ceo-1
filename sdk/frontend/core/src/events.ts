import type { EventEnvelope, Snapshot } from './types';

export function eventKey(event: EventEnvelope): string {
  return (typeof event?.event_id === 'string' && event.event_id)
    || `${String(event?.run_id || '')}:${String(event?.ts || 0)}:${String(event?.type || '')}`;
}

export function dedupeEvents(events: EventEnvelope[]): EventEnvelope[] {
  const seen = new Set<string>();
  return events
    .filter((event): event is EventEnvelope => Boolean(event && typeof event === 'object'))
    .filter((event) => {
      const key = eventKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const aTs = typeof a.ts === 'number' && Number.isFinite(a.ts) ? a.ts : 0;
      const bTs = typeof b.ts === 'number' && Number.isFinite(b.ts) ? b.ts : 0;
      return (aTs - bTs) || eventKey(a).localeCompare(eventKey(b));
    });
}

export function mergeEvent(snapshot: Snapshot, event: EventEnvelope): Snapshot {
  const events = dedupeEvents([...snapshot.events, event]);
  return {
    ...snapshot,
    events,
    diagnostics: {
      ...snapshot.diagnostics,
      last_event_id: event.event_id,
      event_count: events.length,
    },
  };
}

/**
 * Operator-facing names for the loop's public event types.
 *
 * The keys mirror the values of `EVENT_TYPE_MAP` in
 * `sdk/src/webapi/events.ts`; anything unmapped degrades to its dotted name.
 */
const EVENT_LABELS: Record<string, string> = {
  'run.started': 'Run started',
  'run.resumed': 'Run resumed',
  'run.completed': 'Run completed',
  'run.cancelled': 'Run cancelled',
  'run.failed': 'Run failed',
  'phase.started': 'Phase started',
  'tailor.completed': 'Briefings written',
  'plan.written': 'Plan written',
  'plan.rejected': 'Plan rejected',
  'plan.revised': 'Plan revised',
  'episode.started': 'Episode started',
  'episode.completed': 'Episode finished',
  'episode.failed': 'Episode failed',
  'subtask.started': 'Subtask started',
  'subtask.completed': 'Subtask done',
  'subtask.blocked': 'Subtask blocked',
  'subtask.reopened': 'Subtask reopened',
  'rubric.written': 'Rubric written',
  'rubric.fallback': 'Rubric fallback used',
  'context.selected': 'Context selected',
  'composer.completed': 'Composer finished',
  'evaluation.recorded': 'Evaluation recorded',
  'operator.gate.opened': 'Human gate opened',
  'operator.gate.resolved': 'Human gate resolved',
  'operator.decision': 'Operator decision',
  'operator.approval.pending': 'Approval requested',
  'operator.approval.resolved': 'Approval resolved',
  'operator.instruction.queued': 'Instruction queued',
  'operator.instruction.applied': 'Instruction applied',
};

export function phaseLabel(type: string): string {
  const safeType = typeof type === 'string' ? type : 'unknown event';
  return EVENT_LABELS[safeType] || safeType.replaceAll('.', ' ');
}

/** A one-line description of an event for the Events tab. */
export function eventLine(event: EventEnvelope): string {
  const label = phaseLabel(event.type);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const subtask = typeof payload.subtask_id === 'string' ? payload.subtask_id : '';
  const role = event.role || (typeof payload.role === 'string' ? payload.role : '');
  const round = typeof payload.round === 'number' ? payload.round : event.round;
  const parts = [label];
  if (subtask) parts.push(subtask);
  if (role) parts.push(String(role).replaceAll('_', ' '));
  if (typeof round === 'number' && round > 0) parts.push(`r${round}`);
  return parts.join(' · ');
}
