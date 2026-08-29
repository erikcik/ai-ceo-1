import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRunFeedState,
  reduceRunFeed,
  type RunFeedState,
} from '../src/runFeed';
import type { EventEnvelope, LoopSnapshot, Plan, PlanNode, Snapshot } from '../src/types';
import { availableCommands, commandHelp, normaliseMaxRounds, parseCommand, parseNewRunArgs } from '../src/commands';
import { DEFAULT_PANEL_STATE, reducePanelState } from '../src/panels';
import { phaseLabel, eventLine } from '../src/events';
import { allNodes, ancestors, countStatuses, layoutPlan, leaves, nodeById, nodePath } from '../src/plan';
import {
  EMPTY_LOOP,
  actionableApprovals,
  composerEpisodes,
  episodeRef,
  loopOf,
  normalizeLoop,
  phaseDetailLine,
  phaseStrip,
  runCost,
  runOverview,
  subtaskById,
} from '../src/loopView';
import { isTrajectoryNoise, projectTrajectoryView } from '../src/trajectoryView';
import { projectArtifactView } from '../src/artifactView';

function event(
  eventId: string,
  ts: number,
  runId = 'run-a',
  type = 'subtask.started',
): EventEnvelope {
  return {
    schema_version: 1,
    event_id: eventId,
    type,
    ts,
    run_id: runId,
    round: 1,
    role: 'composer',
    status: 'running',
    payload: {},
    legacy: {},
  };
}

function snapshot(runId = 'run-a', events: EventEnvelope[] = []): Snapshot {
  return {
    schema_version: 2,
    run: { id: runId, status: 'running', log_dir: `/tmp/${runId}` },
    mission: { task: `task for ${runId}`, plan_path: 'plan/plan.json', report_path: 'report.json' },
    loop: EMPTY_LOOP,
    active_subtask: null,
    active_role: null,
    events,
    approvals: [],
    controls: { can_inject: true, can_abort: true, can_resume: false },
    diagnostics: {
      last_event_id: events.at(-1)?.event_id || null,
      event_count: events.length,
      warnings: [],
    },
  };
}

function node(id: string, extra: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    title: id,
    goal: '',
    rationale: '',
    backing: [],
    constraints: [],
    deliverables: [],
    acceptance: [],
    depends_on: [],
    children: [],
    status: 'pending',
    rounds: 0,
    last_verdict: null,
    added_by: 'planner',
    note: '',
    ...extra,
  };
}

function plan(nodes: PlanNode[], extra: Partial<Plan> = {}): Plan {
  return {
    schema_version: 1,
    title: 'Plan',
    summary: '',
    assumptions: [],
    questions: [],
    nodes,
    revision: 0,
    created_at: 0,
    updated_at: 0,
    ...extra,
  };
}

function loop(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return { ...EMPTY_LOOP, ...overrides };
}

function reduce(state: RunFeedState, ...actions: Parameters<typeof reduceRunFeed> extends [RunFeedState, infer A] ? A[] : never): RunFeedState {
  return actions.reduce(reduceRunFeed, state);
}

test('creates an isolated feed with a normalized bounded size', () => {
  assert.equal(createRunFeedState().connection, 'closed');
  assert.equal(createRunFeedState('run-a', 2.9).maxEvents, 2);
  assert.equal(createRunFeedState('run-a', 0).maxEvents, 1);
  assert.equal(createRunFeedState('run-a', Number.NaN).maxEvents, 400);
});

test('same-cursor snapshots retain durable operator messages and delivery updates', () => {
  const base = snapshot('run-a');
  const queued: Snapshot = {
    ...base,
    operator_messages: [{ id: 'msg-1', text: 'Use the Chinese title.', created_at: 10, status: 'queued' }],
  };
  const applied: Snapshot = {
    ...base,
    operator_messages: [
      { id: 'msg-1', text: 'Use the Chinese title.', created_at: 10, status: 'applied' },
      { id: 'msg-2', text: 'Add sources.', created_at: 20, status: 'queued' },
    ],
  };
  const state = reduce(createRunFeedState('run-a'), { type: 'snapshot', snapshot: queued }, { type: 'snapshot', snapshot: applied });

  assert.deepEqual(state.snapshot?.operator_messages, applied.operator_messages);
});

test('operator messages render optimistically and reconcile without duplication', () => {
  const message = { id: 'instruction-live', text: 'Use the new title.', created_at: 10, status: 'queued' as const };
  let state = reduce(createRunFeedState('run-a'), { type: 'seed', snapshot: snapshot('run-a') });
  state = reduceRunFeed(state, { type: 'operator_message', runId: 'run-a', message });
  assert.deepEqual(state.snapshot?.operator_messages, [message]);

  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: {
      ...snapshot('run-a'),
      operator_messages: [{ ...message, created_at: 11, status: 'applied' }],
    },
  });
  assert.equal(state.snapshot?.operator_messages?.length, 1);
  assert.equal(state.snapshot?.operator_messages?.[0]?.status, 'applied');
  assert.equal(state.snapshot?.operator_messages?.[0]?.created_at, 11);
});

test('operator message actions ignore late updates from another run', () => {
  const state = reduce(createRunFeedState('run-a'), { type: 'seed', snapshot: snapshot('run-a') });
  const unchanged = reduceRunFeed(state, {
    type: 'operator_message',
    runId: 'run-b',
    message: { id: 'foreign', text: 'Wrong run', created_at: 10, status: 'queued' },
  });
  assert.equal(unchanged, state);
});

test('a newer role-event snapshot cannot erase an optimistic operator message', () => {
  const first = event('event-1', 10);
  const second = event('event-2', 20);
  let state = reduce(createRunFeedState('run-a'), { type: 'seed', snapshot: snapshot('run-a', [first]) });
  state = reduceRunFeed(state, {
    type: 'operator_message',
    runId: 'run-a',
    message: { id: 'instruction-race', text: 'Keep this visible.', created_at: 15, status: 'queued' },
  });
  state = reduceRunFeed(state, { type: 'snapshot', snapshot: snapshot('run-a', [first, second]) });
  assert.equal(state.snapshot?.operator_messages?.[0]?.id, 'instruction-race');
});

test('approval responses render optimistically and survive stale snapshots', () => {
  const approval = {
    approval_id: 'approval-1', title: 'The planner has questions', message: 'Choose.', options: [], answers: [],
    allow_input: true, input_label: '', context: { trigger: 'needs_input' }, round_index: 1, status: 'pending', action: '', reason: '',
    user_input: '', created_at: 10, resolved_at: null,
  };
  const first = event('approval-event-1', 10);
  const second = event('approval-event-2', 20);
  let state = reduce(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: { ...snapshot('run-a', [first]), approvals: [approval] },
  });
  state = reduceRunFeed(state, {
    type: 'approval_response',
    runId: 'run-a',
    approvalId: 'approval-1',
    action: 'continue',
    userInput: 'Use account B.',
    resolvedAt: 15,
  });
  assert.equal(state.snapshot?.approvals[0]?.status, 'resolved');
  assert.equal(state.snapshot?.approvals[0]?.user_input, 'Use account B.');

  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: { ...snapshot('run-a', [first, second]), approvals: [approval] },
  });
  assert.equal(state.snapshot?.approvals[0]?.status, 'resolved');
  assert.equal(state.snapshot?.approvals[0]?.user_input, 'Use account B.');
  assert.equal(state.snapshot?.approvals[0]?.resolved_at, 15);
});

test('a resumed run replaces its own terminal state without a reload', () => {
  // Every monotonic guard assumes a terminal frame is final. Resuming in place
  // is the one case where it is not, so without the generation counter the UI
  // kept showing the ended run (and an empty graph) until a reload.
  const ended = event('resume-ev-1', 10);
  let state = reduce(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: {
      ...snapshot('run-a', [ended]),
      run: { id: 'run-a', status: 'incomplete', log_dir: '/tmp/run-a', finished_at: 20, exit_code: 1, failure_reason: 'stopped' },
    },
  });
  assert.equal(state.snapshot?.run.status, 'incomplete');

  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: {
      ...snapshot('run-a', [ended]),
      run: { id: 'run-a', status: 'starting', log_dir: '/tmp/run-a', resume_epoch: 1 },
    },
  });
  assert.equal(state.snapshot?.run.status, 'starting');
  assert.equal(state.snapshot?.run.resume_epoch, 1);
  assert.equal(state.snapshot?.run.finished_at, undefined, 'the previous outcome must not be carried over');
  assert.equal(state.snapshot?.run.exit_code, undefined);
  assert.equal(state.snapshot?.run.failure_reason, undefined);
});

test('a stale frame from the previous generation is ignored', () => {
  const ev = event('resume-ev-2', 10);
  let state = reduce(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: { ...snapshot('run-a', [ev]), run: { id: 'run-a', status: 'running', log_dir: '/tmp/run-a', resume_epoch: 2 } },
  });

  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: { ...snapshot('run-a', [ev]), run: { id: 'run-a', status: 'cancelled', log_dir: '/tmp/run-a', finished_at: 5, resume_epoch: 1 } },
  });

  assert.equal(state.snapshot?.run.status, 'running', 'an older generation must not end the current one');
  assert.equal(state.snapshot?.run.resume_epoch, 2);
});

test('terminality still wins inside one generation', () => {
  const ev = event('resume-ev-3', 10);
  let state = reduce(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: { ...snapshot('run-a', [ev]), run: { id: 'run-a', status: 'completed', log_dir: '/tmp/run-a', resume_epoch: 1 } },
  });

  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: { ...snapshot('run-a', [ev]), run: { id: 'run-a', status: 'running', log_dir: '/tmp/run-a', resume_epoch: 1 } },
  });

  assert.equal(state.snapshot?.run.status, 'completed');
});

test('keeps an operator round grant when a stale pending frame arrives', () => {
  const base = {
    approval_id: 'approval-rounds', title: 'Composer budget exhausted', message: '', options: [], answers: [],
    allow_input: true, input_label: '', allow_extra_rounds: true, context: { trigger: 'max_rounds' },
    round_index: 5, status: 'pending', action: '', reason: '', user_input: '', created_at: 10, resolved_at: null,
  };
  const first = event('rounds-event-1', 10);
  const second = event('rounds-event-2', 20);
  let state = reduce(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: { ...snapshot('run-a', [first]), approvals: [{ ...base, status: 'resolved', action: 'continue', extra_rounds: 7, resolved_at: 15 }] },
  });
  assert.equal(state.snapshot?.approvals[0]?.extra_rounds, 7);

  // A stale frame (or an older server that omits the field) must not erase it.
  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: { ...snapshot('run-a', [first, second]), approvals: [base] },
  });
  assert.equal(state.snapshot?.approvals[0]?.extra_rounds, 7);
  assert.equal(state.snapshot?.approvals[0]?.allow_extra_rounds, true);
  assert.equal(state.snapshot?.approvals[0]?.status, 'resolved');
});

test('normalizes the composer-episode limit without changing a typed ten to one', () => {
  assert.equal(normaliseMaxRounds('10'), 10);
  assert.equal(normaliseMaxRounds('0010'), 10);
  assert.equal(normaliseMaxRounds(''), 25);
  assert.equal(normaliseMaxRounds('not-a-number'), 25);
  assert.equal(normaliseMaxRounds('0'), 1);
  assert.equal(normaliseMaxRounds('1001'), 1000);
});

test('seeds a snapshot, filters foreign events, and keeps diagnostics coherent', () => {
  const state = createRunFeedState('run-a', 10);
  const seeded = reduceRunFeed(state, {
    type: 'seed',
    snapshot: snapshot('run-a', [event('a-1', 1), event('foreign', 2, 'run-b'), event('a-2', 3)]),
  });

  assert.deepEqual(seeded.events.map((item) => item.event_id), ['a-1', 'a-2']);
  assert.equal(seeded.snapshot?.mission.task, 'task for run-a');
  assert.equal(seeded.snapshot?.diagnostics.event_count, 2);
  assert.equal(seeded.snapshot?.diagnostics.last_event_id, 'a-2');
  assert.equal(seeded.lastEventId, 'a-2');
});

test('merges REST replay and WebSocket replay without duplicate rows', () => {
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: snapshot('run-a', [event('a-1', 1), event('a-2', 2)]),
  });

  state = reduceRunFeed(state, {
    type: 'replay',
    events: [event('a-2', 2), event('a-3', 3), event('other', 4, 'run-b')],
  });
  state = reduceRunFeed(state, { type: 'event', event: event('a-3', 3) });

  assert.deepEqual(state.events.map((item) => item.event_id), ['a-1', 'a-2', 'a-3']);
  assert.equal(state.lastEventId, 'a-3');
  assert.equal(state.snapshot?.diagnostics.event_count, 3);
});

test('keeps the cursor monotonic when an old event arrives after reconnect', () => {
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'replay',
    events: [event('a-2', 20), event('a-3', 30)],
  });
  state = reduceRunFeed(state, { type: 'event', event: event('a-1', 10) });

  assert.deepEqual(state.events.map((item) => item.event_id), ['a-1', 'a-2', 'a-3']);
  assert.equal(state.lastEventId, 'a-3');
});

test('enforces a bounded event buffer while retaining the newest events', () => {
  let state = createRunFeedState('run-a', 3);
  for (let index = 1; index <= 5; index += 1) {
    state = reduceRunFeed(state, { type: 'event', event: event(`a-${index}`, index) });
  }

  assert.deepEqual(state.events.map((item) => item.event_id), ['a-3', 'a-4', 'a-5']);
  assert.equal(state.snapshot, null);
  assert.equal(state.lastEventId, 'a-5');
});

test('ignores stale events and snapshots after switching runs', () => {
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: snapshot('run-a', [event('a-1', 1)]),
  });
  state = reduceRunFeed(state, { type: 'reset', runId: 'run-b' });
  const unchanged = reduce(state,
    { type: 'event', event: event('a-late', 9, 'run-a') },
    { type: 'replay', events: [event('a-late-2', 10, 'run-a')] },
    { type: 'snapshot', snapshot: snapshot('run-a', [event('a-late-3', 11, 'run-a')]) },
  );

  assert.equal(unchanged.runId, 'run-b');
  assert.equal(unchanged.snapshot, null);
  assert.deepEqual(unchanged.events, []);
});

test('guards connection updates from an old run', () => {
  const state = createRunFeedState('run-b');
  const unchanged = reduceRunFeed(state, { type: 'connection', runId: 'run-a', status: 'connected' });
  assert.equal(unchanged.connection, 'idle');
  const connected = reduceRunFeed(state, { type: 'connection', runId: 'run-b', status: 'connected' });
  assert.equal(connected.connection, 'connected');
});

test('snapshot updates replace durable state but preserve already received events', () => {
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'event',
    event: event('a-live', 5),
  });
  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: {
      ...snapshot('run-a', [event('a-1', 1)]),
      run: { id: 'run-a', status: 'completed', log_dir: '/tmp/run-a' },
    },
  });

  assert.equal(state.snapshot?.run.status, 'completed');
  assert.deepEqual(state.events.map((item) => item.event_id), ['a-1', 'a-live']);
  assert.equal(state.snapshot?.diagnostics.last_event_id, 'a-live');
});

test('terminal lifecycle wins over a newer-looking running snapshot without events', () => {
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'snapshot',
    snapshot: snapshot('run-a', [event('a-1', 100)]),
  });
  const terminalSnapshot = {
    ...snapshot('run-a', []),
    run: { ...snapshot('run-a').run, status: 'completed', completion_satisfied: true },
    diagnostics: { ...snapshot('run-a').diagnostics, last_event_id: null, event_count: 0 },
  };
  state = reduceRunFeed(state, { type: 'snapshot', snapshot: terminalSnapshot });
  assert.equal(state.snapshot?.run.status, 'completed');
  assert.equal(state.snapshot?.run.completion_satisfied, true);
});

test('accepts a fresh server snapshot when its retained tail is shorter than the client buffer', () => {
  const retained = Array.from({ length: 400 }, (_, index) => event(`a-${index + 1}`, index + 1));
  let state = reduceRunFeed(createRunFeedState('run-a', 400), {
    type: 'seed',
    snapshot: snapshot('run-a', retained),
  });
  const serverTail = retained.slice(-200);
  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: {
      ...snapshot('run-a', serverTail),
      run: { ...snapshot('run-a', serverTail).run, status: 'waiting_approval' },
      loop: loop({ plan: plan([node('write-copy', { status: 'composing' })]) }),
      approvals: [{
        approval_id: 'approval-7', title: 'Review', message: '', options: [], answers: [],
        allow_input: false, input_label: '', context: {}, round_index: 7, status: 'pending',
        action: '', reason: '', user_input: '', created_at: 1, resolved_at: null,
      }],
    },
  });

  assert.equal(state.snapshot?.run.status, 'waiting_approval');
  assert.equal(state.snapshot?.loop.plan?.nodes[0]?.id, 'write-copy');
  assert.equal(state.snapshot?.approvals[0]?.approval_id, 'approval-7');
  assert.equal(state.events.length, 400);
  assert.equal(state.lastEventId, 'a-400');
});

test('the loop projection replaces wholesale but is never blanked by an empty frame', () => {
  // The loop view is rebuilt from disk on every snapshot, so it is replaced
  // rather than merged. The one thing that must not happen is a frame written
  // before `plan.json` was read wiping the graph the operator is looking at.
  const cursor = event('same-cursor', 10);
  const withPlan = loop({
    plan: plan([node('root', { children: [node('leaf-a', { status: 'done' })] })], { revision: 3 }),
    subtasks: [{
      id: 'leaf-a', title: 'leaf-a', status: 'done', rounds: 2, last_verdict: 'PASS', contract: null,
      rubric: '', progress: 'done', evidence_files: [], evidence_meta: [], ledger_count: 0, ledger: [],
      evaluations: [], context: [], episodes: [],
    }],
  });
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: {
      ...snapshot('run-a', [cursor]),
      run: { ...snapshot('run-a').run, agent: 'codex', model: 'gpt-5.6-sol', cost_usd: 1.25, rounds_run: 4 },
      loop: withPlan,
      active_subtask: 'leaf-a',
      active_role: 'composer',
    },
  });
  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: {
      ...snapshot('run-a', [cursor]),
      run: { ...snapshot('run-a').run, agent: 'codex', model: null },
      loop: EMPTY_LOOP,
      active_subtask: null,
      active_role: null,
    },
  });

  assert.equal(state.snapshot?.loop.plan?.revision, 3);
  assert.equal(state.snapshot?.loop.subtasks[0]?.id, 'leaf-a');
  assert.equal(state.snapshot?.active_subtask, 'leaf-a');
  assert.equal(state.snapshot?.run.model, 'gpt-5.6-sol');
  assert.equal(state.snapshot?.run.cost_usd, 1.25);
  assert.equal(state.snapshot?.run.rounds_run, 4);

  // A frame that does carry a plan wins outright, including node removals.
  const revised = loop({ plan: plan([node('root-2')], { revision: 4 }) });
  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: { ...snapshot('run-a', [cursor]), loop: revised },
  });
  assert.equal(state.snapshot?.loop.plan?.revision, 4);
  assert.deepEqual(state.snapshot?.loop.plan?.nodes.map((item) => item.id), ['root-2']);
});

test('a resolved gate lets the run go back to running without a reload', () => {
  // A run toggles waiting_approval -> running at every gate, so this is normal
  // progress, not a stale frame. Treating it as a regression froze the UI on the
  // answered approval until the page was reloaded.
  const cursor = event('waiting-cursor', 11);
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: {
      ...snapshot('run-a', [cursor]),
      run: { ...snapshot('run-a').run, status: 'waiting_approval' },
    },
  });
  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: {
      ...snapshot('run-a', [cursor]),
      run: { ...snapshot('run-a').run, status: 'running' },
    },
  });
  assert.equal(state.snapshot?.run.status, 'running');
});

test('a terminal status still outranks an active one on the same cursor', () => {
  const cursor = event('terminal-cursor', 12);
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: {
      ...snapshot('run-a', [cursor]),
      run: { ...snapshot('run-a').run, status: 'completed' },
    },
  });
  state = reduceRunFeed(state, {
    type: 'snapshot',
    snapshot: {
      ...snapshot('run-a', [cursor]),
      run: { ...snapshot('run-a').run, status: 'waiting_approval' },
    },
  });
  assert.equal(state.snapshot?.run.status, 'completed');
});

test('resync snapshots start a new event epoch and discard the old buffer', () => {
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: snapshot('run-a', [event('old-1', 1), event('old-2', 2)]),
  });

  const resyncSnapshot = {
    ...snapshot('run-a', [event('new-1', 10)]),
    diagnostics: {
      ...snapshot('run-a', [event('new-1', 10)]).diagnostics,
      cursor_gap: true,
      resync_required: true,
    },
  };
  state = reduceRunFeed(state, { type: 'snapshot', snapshot: resyncSnapshot });

  assert.deepEqual(state.events.map((item) => item.event_id), ['new-1']);
  assert.equal(state.lastEventId, 'new-1');
  assert.equal(state.snapshot?.diagnostics.cursor_gap, true);
  assert.equal(state.snapshot?.diagnostics.event_count, 1);
});

test('a gap replay is never merged by the reducer after the feed is reset', () => {
  let state = reduceRunFeed(createRunFeedState('run-a'), {
    type: 'seed',
    snapshot: snapshot('run-a', [event('old-1', 1)]),
  });

  // This models the Web hook's gap branch: reset first, then wait for the
  // authoritative snapshot instead of dispatching the non-contiguous replay.
  state = reduceRunFeed(state, { type: 'reset', runId: 'run-a' });
  state = reduceRunFeed(state, { type: 'snapshot', snapshot: snapshot('run-a', [event('new-1', 10)]) });

  assert.deepEqual(state.events.map((item) => item.event_id), ['new-1']);
  assert.equal(state.events.some((item) => item.event_id === 'old-1'), false);
});

test('parses the shared command catalog and gates only explicit capabilities', () => {
  assert.deepEqual(parseCommand('/attach run-a extra'), { name: 'attach', args: ['run-a', 'extra'], raw: '/attach run-a extra' });
  assert.deepEqual(parseCommand('/new inspect screenshots --agent codex --model gpt-5.6-sol --rounds 4'), {
    name: 'new',
    args: ['inspect', 'screenshots', '--agent', 'codex', '--model', 'gpt-5.6-sol', '--rounds', '4'],
    raw: '/new inspect screenshots --agent codex --model gpt-5.6-sol --rounds 4',
  });
  assert.equal(parseCommand('plain text'), null);
  const commands = availableCommands({}, snapshot('run-a'), true);
  assert.equal(commands.some((item) => item.name === 'inject'), true);
  assert.equal(commands.some((item) => item.name === 'briefings'), true);
  assert.equal(availableCommands({ injections: false }, snapshot('run-a'), true).some((item) => item.name === 'inject'), false);
  assert.match(commandHelp({}, snapshot('run-a'), true), /\/trajectory/);
});

test('keeps /abort typable while a stop is in flight', () => {
  const base = snapshot('run-a');
  // `can_abort` is false once the run is stopping, but escalating an ignored
  // SIGTERM is exactly what the operator needs at that point.
  const stopping = {
    ...base,
    run: { ...base.run, status: 'stopping' },
    controls: { can_inject: false, can_abort: false, can_resume: false },
  };
  assert.equal(availableCommands({}, stopping, true).some((item) => item.name === 'abort'), true);
  assert.equal(availableCommands({}, stopping, true).some((item) => item.name === 'stop'), false);

  const terminal = {
    ...base,
    run: { ...base.run, status: 'cancelled' },
    controls: { can_inject: false, can_abort: false, can_resume: true },
  };
  assert.equal(availableCommands({}, terminal, true).some((item) => item.name === 'abort'), false);
  assert.equal(availableCommands({ abort: false }, stopping, true).some((item) => item.name === 'abort'), false);
});

test('parses /new options consistently and rejects malformed flags', () => {
  assert.deepEqual(parseNewRunArgs([
    'inspect', 'screenshots', '--agent', 'claude_code', '--model=gpt-test',
    '--workspace', '/tmp/work', '--rounds=4', '--language', 'en',
  ]), {
    task: 'inspect screenshots',
    agent: 'claude_code',
    model: 'gpt-test',
    workspace: '/tmp/work',
    maxRounds: 4,
    promptLanguage: 'en',
  });
  assert.deepEqual(parseNewRunArgs(['do', '--', '--model', 'as task text']), {
    task: 'do --model as task text',
  });
  assert.deepEqual(parseNewRunArgs([
    'mixed', '--planner-agent', 'codex', '--planner-model=gpt-planner',
    '--composer-agent=claude_code', '--composer-model', 'sonnet',
    '--evaluator-agent', 'codex', '--evaluator-model', 'gpt-evaluator',
  ]), {
    task: 'mixed',
    roles: {
      planner: { agent: 'codex', model: 'gpt-planner' },
      composer: { agent: 'claude_code', model: 'sonnet' },
      evaluator: { agent: 'codex', model: 'gpt-evaluator' },
    },
  });
  assert.match(parseNewRunArgs(['task', '--model']).error || '', /requires a value/);
  assert.match(parseNewRunArgs(['task', '--rounds', '0']).error || '', /1 and 1000/);
  assert.match(parseNewRunArgs(['task', '--rounds=1.5']).error || '', /integer/);
  assert.match(parseNewRunArgs(['task', '--language', 'fr']).error || '', /must be en/);
});

test('/new applies a global reasoning effort to every role and allows per-role overrides', () => {
  assert.deepEqual(parseNewRunArgs(['task', '--effort', 'high']), {
    task: 'task',
    roles: {
      planner: { reasoning_effort: 'high' },
      composer: { reasoning_effort: 'high' },
      evaluator: { reasoning_effort: 'high' },
    },
  });
  assert.deepEqual(parseNewRunArgs([
    'task', '--effort=medium', '--planner-effort', 'ultra',
  ]), {
    task: 'task',
    roles: {
      planner: { reasoning_effort: 'ultra' },
      composer: { reasoning_effort: 'medium' },
      evaluator: { reasoning_effort: 'medium' },
    },
  });
});

test('/new rejects effort values that could break out of a TOML string or argv', () => {
  // The value reaches Codex as inline TOML and the other backends as argv.
  for (const bad of ['a"b', "a'b", 'high low', 'x'.repeat(65), '$(id)']) {
    assert.match(parseNewRunArgs(['task', `--effort=${bad}`]).error || '', /may only contain/, bad);
  }
  // An unknown tier is not rejected: the accepted set differs per backend and
  // per model, and a newer tier must not need a harness release.
  assert.equal(parseNewRunArgs(['task', '--effort=ultra']).error, undefined);
  assert.equal(parseNewRunArgs(['task', '--effort=a.b_c:d-1']).error, undefined);
});

test('keeps Web panel transitions deterministic', () => {
  let state = DEFAULT_PANEL_STATE;
  state = reducePanelState(state, { type: 'open', panel: 'events' });
  assert.deepEqual(state, { open: true, panel: 'events' });
  state = reducePanelState(state, { type: 'toggle', panel: 'events' });
  assert.equal(state.open, false);
  state = reducePanelState(state, { type: 'toggle', panel: 'trajectory' });
  assert.deepEqual(state, { open: true, panel: 'trajectory' });
});

test('labels the loop event vocabulary and degrades unknown types', () => {
  assert.equal(phaseLabel('plan.written'), 'Plan written');
  assert.equal(phaseLabel('evaluation.recorded'), 'Evaluation recorded');
  assert.equal(phaseLabel('operator.gate.opened'), 'Human gate opened');
  assert.equal(phaseLabel('something.new.here'), 'something new here');
  assert.equal(
    eventLine({ ...event('e', 1, 'run-a', 'composer.completed'), role: 'composer', payload: { subtask_id: 'draft-copy', round: 2 } }),
    'Composer finished · draft-copy · composer · r2',
  );
});

// ---------------------------------------------------------------------------
// Plan tree + layout
// ---------------------------------------------------------------------------

function samplePlan(): Plan {
  return plan([
    node('research', {
      title: 'Research',
      children: [
        node('read-docs', { title: 'Read docs', status: 'done' }),
        node('interview', { title: 'Interview', status: 'skipped' }),
      ],
    }),
    node('build', {
      title: 'Build',
      children: [
        node('write-copy', { title: 'Write copy', status: 'composing', depends_on: ['read-docs'] }),
      ],
    }),
  ]);
}

test('walks the plan tree in document order', () => {
  const tree = samplePlan();
  assert.deepEqual(allNodes(tree).map((item) => item.id), ['research', 'read-docs', 'interview', 'build', 'write-copy']);
  assert.deepEqual(leaves(tree).map((item) => item.id), ['read-docs', 'interview', 'write-copy']);
  assert.equal(nodeById(tree, 'write-copy')?.title, 'Write copy');
  assert.equal(nodeById(tree, 'missing'), null);
  assert.deepEqual(ancestors(tree, 'write-copy').map((item) => item.id), ['build']);
  assert.deepEqual(nodePath(tree, 'write-copy'), ['Build', 'Write copy']);
  assert.deepEqual(allNodes(null), []);
});

test('counts only leaf statuses', () => {
  const counts = countStatuses(samplePlan());
  assert.equal(counts.done, 1);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.composing, 1);
  assert.equal(counts.pending, 0);
});

test('lays the tree out top-down with parents centred over their children', () => {
  const layout = layoutPlan(samplePlan(), { nodeWidth: 100, nodeHeight: 50, columnGap: 20, rowGap: 50 });
  const research = layout.byId['research'];
  const readDocs = layout.byId['read-docs'];
  const interview = layout.byId['interview'];
  const writeCopy = layout.byId['write-copy'];

  assert.equal(readDocs.depth, 1);
  assert.equal(readDocs.y, 100, 'depth 1 sits one row below the root');
  assert.equal(research.y, 0);
  assert.equal(research.cx, (readDocs.cx + interview.cx) / 2, 'a parent is centred over its children');
  assert.equal(interview.x - (readDocs.x + readDocs.width), 20, 'siblings keep the column gap');
  assert.equal(writeCopy.leaf, true);
  assert.equal(layout.byId['build'].leaf, false);

  const treeEdges = layout.edges.filter((edge) => edge.kind === 'tree');
  assert.equal(treeEdges.length, 3);
  const dependency = layout.edges.find((edge) => edge.kind === 'dependency');
  assert.deepEqual([dependency?.from, dependency?.to], ['read-docs', 'write-copy']);

  assert.equal(layout.height, writeCopy.y + writeCopy.height);
  assert.ok(layout.width >= research.x + research.width);
});

test('an empty plan lays out to nothing rather than throwing', () => {
  const layout = layoutPlan(null);
  assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.edges, []);
  assert.equal(layout.width, 0);
  assert.equal(layout.height, 0);
});

test('a dangling dependency is dropped instead of drawing an edge to nowhere', () => {
  const layout = layoutPlan(plan([node('only', { depends_on: ['gone'] })]));
  assert.equal(layout.edges.length, 0);
});

// ---------------------------------------------------------------------------
// Loop projection
// ---------------------------------------------------------------------------

test('normalizes a loop projection that the backend has not written yet', () => {
  assert.deepEqual(normalizeLoop(undefined), EMPTY_LOOP);
  assert.deepEqual(normalizeLoop({}), EMPTY_LOOP);
  assert.equal(normalizeLoop({ plan: { title: 'no nodes' } }).plan, null, 'a plan without nodes is not a plan');
  const normalized = normalizeLoop({ task: 'do it', research: ['a.md', 7], plan: { nodes: [] } });
  assert.equal(normalized.task, 'do it');
  assert.deepEqual(normalized.research, ['a.md']);
  assert.deepEqual(normalized.plan?.nodes, []);
  assert.deepEqual(loopOf(snapshot('run-a')), EMPTY_LOOP);
});

test('marks the phase strip from the loop phase record', () => {
  const executing = phaseStrip({
    ...snapshot('run-a'),
    loop: loop({ phase: { phase: 'executing', current_subtask: 'write-copy', current_role: 'composer', current_round: 2, updated_at: 0, detail: 'composing' } }),
  });
  assert.deepEqual(executing.map((step) => step.state), ['done', 'done', 'done', 'active', 'pending', 'pending']);

  const failed = phaseStrip({
    ...snapshot('run-a'),
    run: { ...snapshot('run-a').run, status: 'failed' },
    loop: loop({ phase: { phase: 'planning', current_subtask: null, current_role: null, current_round: null, updated_at: 0, detail: '' } }),
  });
  assert.equal(failed[2].state, 'failed');

  const completed = phaseStrip({
    ...snapshot('run-a'),
    run: { ...snapshot('run-a').run, status: 'completed' },
    loop: loop({ phase: { phase: 'finished', current_subtask: null, current_role: null, current_round: null, updated_at: 0, detail: '' } }),
  });
  assert.equal(completed.every((step) => step.state === 'done'), true);

  assert.deepEqual(phaseStrip(snapshot('run-a')).map((step) => step.state), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
});

test('summarises the executing phase as subtask, role and round', () => {
  assert.equal(
    phaseDetailLine(loop({ phase: { phase: 'executing', current_subtask: 'write-copy', current_role: 'composer', current_round: 2, updated_at: 0, detail: '' } })),
    'write-copy · composer · round 2',
  );
  assert.equal(phaseDetailLine(EMPTY_LOOP), '');
});

test('keys an episode by its per-role number, falling back to the directory', () => {
  // `ep` is authoritative: the global `seq` counts every role's episodes.
  assert.deepEqual(episodeRef({ role: 'composer', seq: 9, ep: 4, dir: '/runs/x/composer_episodes/ep004' }), { role: 'composer', seq: 4 });
  // An older run has no `ep`; the directory still carries the number.
  assert.deepEqual(episodeRef({ role: 'prompt_tailor', seq: 1, dir: '/runs/x/prompt_tailor_episodes/ep012' }), { role: 'prompt_tailor', seq: 12 });
  // With neither, the index entry itself is the last resort.
  assert.deepEqual(episodeRef({ role: 'planner', seq: 2, dir: '' }), { role: 'planner', seq: 2 });
  assert.equal(episodeRef({ role: '', seq: 0, dir: '' }), null);
});

test('normalizes the run config, revision list and research titles', () => {
  const normalized = normalizeLoop({
    config: { max_rounds: '25', max_eval_rounds: 3, min_research_agents: 2, research_model: 'claude-opus-5' },
    plan_revisions: [
      { revision: 1, note: 'evaluator added a node', written_at: 20 },
      { revision: 3, note: '', written_at: 40 },
      'nonsense',
    ],
    research_notes: [{ file: 'vendors.md', title: 'Vendor matrix' }, { title: 'no file' }],
    cost_usd: 4.26,
    composer_episodes: 3,
    decisions: '- answered the planner',
  });
  assert.deepEqual(normalized.config, { max_rounds: 25, max_eval_rounds: 3, min_research_agents: 2, research_model: 'claude-opus-5' });
  assert.deepEqual(normalized.plan_revisions.map((item) => item.revision), [3, 1], 'newest revision first');
  assert.deepEqual(normalized.research_notes, [{ file: 'vendors.md', title: 'Vendor matrix' }]);
  assert.equal(normalized.cost_usd, 4.26);
  assert.equal(normalized.composer_episodes, 3);
  assert.equal(normalized.decisions, '- answered the planner');

  // An older server sends only file names; the tab must still list them.
  assert.deepEqual(normalizeLoop({ research: ['a.md'] }).research_notes, [{ file: 'a.md', title: '' }]);
  assert.equal(normalizeLoop({ config: 'nope' }).config, null);
});

test('prefers the live episode totals until the report exists', () => {
  const live = { ...snapshot('run-a'), loop: loop({ cost_usd: 2.5, composer_episodes: 3 }) };
  assert.equal(runCost(live), 2.5);
  assert.equal(composerEpisodes(live), 3);

  // The report is authoritative once written.
  const ended = {
    ...snapshot('run-a'),
    run: { ...snapshot('run-a').run, cost_usd: 4.1, rounds_run: 5 },
    loop: loop({ cost_usd: 3.9, composer_episodes: 4 }),
  };
  assert.equal(runCost(ended), 4.1);

  const empty = snapshot('run-a');
  assert.equal(runCost(empty), null);
  assert.equal(composerEpisodes(empty), null);
});

test('hides stale pending gates once the run is terminal', () => {
  const pending = {
    approval_id: 'gate-1', title: 'A subtask is blocked', message: '', options: [], answers: [],
    allow_input: true, input_label: '', context: { trigger: 'needs_human', subtask_id: 'write-copy' },
    round_index: 1, status: 'pending', action: '', reason: '', user_input: '', created_at: 1, resolved_at: null,
  };
  const live = { ...snapshot('run-a'), approvals: [pending] };
  assert.deepEqual(actionableApprovals(live).map((item) => item.approval_id), ['gate-1']);
  assert.deepEqual(actionableApprovals({ ...live, run: { ...live.run, status: 'cancelled' } }), []);
});

test('projects a run overview for the empty-selection rail', () => {
  const tree = samplePlan();
  const view = runOverview({
    ...snapshot('run-a'),
    run: { ...snapshot('run-a').run, cost_usd: 2.5, rounds_run: 3, max_rounds: 25 },
    loop: loop({
      task: 'ship it',
      plan: { ...tree, summary: 'two phases', questions: ['which brand?'] },
      config: { max_rounds: 25, max_eval_rounds: 3, min_research_agents: 2, research_model: 'claude-opus-5' },
      decisions: '- keep the tone neutral',
      final_response: 'done',
    }),
  });
  assert.equal(view.task, 'ship it');
  assert.equal(view.summary, 'two phases');
  assert.deepEqual(view.questions, ['which brand?']);
  assert.equal(view.leafCount, 3);
  assert.equal(view.counts.done, 1);
  assert.equal(view.costUsd, 2.5);
  assert.equal(view.roundsRun, 3);
  assert.equal(view.maxRounds, 25);
  assert.equal(view.maxEvalRounds, 3);
  assert.equal(view.researchModel, 'claude-opus-5');
  assert.equal(view.decisions, '- keep the tone neutral');
  assert.equal(view.finalResponse, 'done');
});

test('finds a subtask projection by id', () => {
  const subtask = {
    id: 'write-copy', title: 'Write copy', status: 'composing', rounds: 1, last_verdict: null, contract: null,
    rubric: '', progress: '', evidence_files: [], evidence_meta: [], ledger_count: 0, ledger: [],
    evaluations: [], context: [], episodes: [],
  };
  const projected = loop({ subtasks: [subtask] });
  assert.equal(subtaskById(projected, 'write-copy'), subtask);
  assert.equal(subtaskById(projected, 'missing'), null);
  assert.equal(subtaskById(projected, null), null);
});

test('projects trajectory text, images, errors, filters, and bounds', () => {
  const view = projectTrajectoryView({
    run_id: 'run-a', episode: 3, role: 'composer', steps: [
      { kind: 'session', text: 'ignore me' },
      { kind: 'tool_use', input: { command: 'ls -la' } },
      { kind: 'tool_result', text: 'x'.repeat(20), images: ['a.png', 'a.png'] },
      { kind: 'error', text: 'failed' },
    ],
  }, { maxSteps: 2, maxTextChars: 8, includeKinds: ['tool_result', 'error'] });

  assert.equal(view.truncated, false);
  assert.equal(view.totalSteps, 2);
  assert.equal(view.episode, 3);
  assert.deepEqual(view.items.map((item) => item.kind), ['tool_result', 'error']);
  assert.equal(view.items[0].text, 'xxxxxxx…');
  assert.deepEqual(view.items[0].images, ['a.png']);
  assert.equal(view.items[1].isError, true);
  assert.equal(view.items[0].searchText.includes('tool_result'), true);
});

test('classifies provider reconnect/deprecation chatter as non-work noise', () => {
  assert.equal(isTrajectoryNoise('[features].codex_hooks is deprecated. Use [features].hooks instead.'), true);
  assert.equal(isTrajectoryNoise('Reconnecting...'), true);
  assert.equal(isTrajectoryNoise('Reconnecting... 1/5 (stream disconnected before completion)'), true);
  assert.equal(isTrajectoryNoise('RECONNECTING… retrying transport'), true);
  assert.equal(isTrajectoryNoise('`[features].codex_hooks` is deprecated. Use `[features].hooks` instead.'), true);
  assert.equal(isTrajectoryNoise('pytest: 3 passed'), false);
});

test('normalizes all supported single-image trajectory fields', () => {
  const view = projectTrajectoryView({
    episode: 1,
    role: 'composer',
    steps: [
      { kind: 'tool_result', image: 'data:image/png;base64,a' },
      { kind: 'tool_result', image_url: 'https://example.test/shot.png' },
      { kind: 'tool_result', imageUrl: '/api/shot.png' },
    ],
  });

  assert.deepEqual(view.items.map((item) => item.images), [
    ['data:image/png;base64,a'],
    ['https://example.test/shot.png'],
    ['/api/shot.png'],
  ]);
  assert.equal(view.items.every((item) => item.hasImage), true);
});

test('marks non-zero command exits as failed even when the adapter omitted is_error', () => {
  const view = projectTrajectoryView({
    episode: 1,
    role: 'composer',
    steps: [
      { kind: 'tool_result', text: 'command output\n[exit_code=2]' },
      { kind: 'tool_result', exit_code: 1, text: 'failed command' },
      { kind: 'tool_result', exit_code: 0, text: 'ok' },
    ],
  });
  assert.equal(view.items[0].isError, true);
  assert.equal(view.items[1].isError, true);
  assert.equal(view.items[2].isError, false);
});

test('projects structured agent file changes and enriches matching paths with exact numstat', () => {
  const view = projectArtifactView({
    run_id: 'run-a', episode: 1, role: 'composer', steps: [
      {
        kind: 'tool_use', id: 'patch-1', name: 'apply_patch', input: {
          changes: [
            { path: 'frontend/core/src/artifactView.ts', kind: 'add' },
            { path: 'frontend/core/src/index.ts', kind: 'update' },
          ],
        },
      },
      { kind: 'tool_result', tool_use_id: 'patch-1', text: 'Done', is_error: false },
      { kind: 'tool_use', id: 'diff-1', name: 'shell', input: { command: 'git diff --numstat' } },
      {
        kind: 'tool_result', tool_use_id: 'diff-1', is_error: false,
        text: '140\t0\tfrontend/core/src/artifactView.ts\n1\t0\tfrontend/core/src/index.ts\n99\t2\tunrelated-user-file.ts\n[exit_code=0]',
      },
    ],
  });

  assert.equal(view.files.scope, 'agent');
  assert.equal(view.files.totalFiles, 2);
  assert.equal(view.files.additions, 141);
  assert.equal(view.files.deletions, 0);
  assert.equal(view.files.lineCountCoverage, 'complete');
  assert.deepEqual(view.files.items.map((item) => [item.path, item.kind, item.extension]), [
    ['frontend/core/src/artifactView.ts', 'added', 'ts'],
    ['frontend/core/src/index.ts', 'modified', 'ts'],
  ]);
});

test('does not present an unmatched workspace diff as exact agent line totals', () => {
  const view = projectArtifactView({
    episode: 1, role: 'composer', steps: [
      { kind: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'src/main.py' } },
      { kind: 'tool_result', tool_use_id: 'edit-1', text: 'updated' },
      { kind: 'tool_use', id: 'stat-1', name: 'Bash', input: { command: 'git diff --stat' } },
      {
        kind: 'tool_result', tool_use_id: 'stat-1',
        text: ' src/main.py | 4 ++++\n old-user-change.txt | 2 ++\n 2 files changed, 6 insertions(+)',
      },
    ],
  });

  assert.equal(view.files.scope, 'agent');
  assert.equal(view.files.totalFiles, 1);
  assert.equal(view.files.additions, null);
  assert.equal(view.files.lineCountCoverage, 'partial');
});

test('falls back to a bounded workspace diff when no structured file event exists', () => {
  const view = projectArtifactView({
    episode: 2, role: 'composer', steps: [
      { kind: 'tool_use', id: 'stat-1', name: 'shell', input: { command: "/bin/zsh -lc 'git diff --stat'" } },
      {
        kind: 'tool_result', tool_use_id: 'stat-1',
        text: ' frontend/core/src/a.ts | 3 ++-\n frontend/web/src/App.tsx | 9 ++++++---\n 2 files changed, 8 insertions(+), 4 deletions(-)',
      },
    ],
  }, { maxFiles: 1 });

  assert.equal(view.files.scope, 'workspace');
  assert.equal(view.files.totalFiles, 2);
  assert.equal(view.files.shownFiles, 1);
  assert.equal(view.files.hiddenFiles, 1);
  assert.equal(view.files.additions, 8);
  assert.equal(view.files.deletions, 4);
});

test('projects paired tests, builds, compound checks, failures, and live validation state', () => {
  const view = projectArtifactView({
    run_id: 'run-a', episode: 3, role: 'composer', steps: [
      { kind: 'tool_use', id: 'py', name: 'shell', input: { command: 'python -m pytest -q' } },
      { kind: 'tool_result', tool_use_id: 'py', text: '............ [100%]\n12 passed, 1 skipped in 0.62s\n[exit_code=0]' },
      { kind: 'tool_use', id: 'web', name: 'shell', input: { command: 'npm --prefix frontend/web run build' } },
      { kind: 'tool_result', tool_use_id: 'web', text: '✓ 40 modules transformed.\n[exit_code=0]' },
      { kind: 'tool_use', id: 'checks', name: 'Bash', input: { command: 'cd frontend/web && npm run typecheck && npm run build' } },
      { kind: 'tool_result', tool_use_id: 'checks', text: '{"output":"built successfully","exit_code":0,"error":null}' },
      { kind: 'tool_use', id: 'bad', name: 'shell', input: { command: 'npm --prefix frontend/core test' } },
      { kind: 'tool_result', tool_use_id: 'bad', text: '# tests 10\n# pass 8\n# fail 2\n[exit_code=1]', is_error: true },
      { kind: 'tool_use', id: 'live', name: 'shell', input: { command: 'git diff --check' } },
      { kind: 'tool_use', id: 'search', name: 'shell', input: { command: "rg -n 'pytest|passed|typecheck' src" } },
      { kind: 'tool_result', tool_use_id: 'search', text: 'src/example.py:1: pytest' },
    ],
  });

  assert.equal(view.validations.total, 5);
  assert.deepEqual(view.validations.items.map((item) => [item.label, item.operations, item.status]), [
    ['Python', ['test'], 'passed'],
    ['Web', ['build'], 'passed'],
    ['Web', ['typecheck', 'build'], 'passed'],
    ['Core', ['test'], 'failed'],
    ['Git', ['diff-check'], 'running'],
  ]);
  assert.equal(view.validations.items[0].passedCount, 12);
  assert.equal(view.validations.items[0].skippedCount, 1);
  assert.equal(view.validations.items[1].moduleCount, 40);
  assert.equal(view.validations.items[3].failedCount, 2);
  assert.deepEqual(
    { passed: view.validations.passed, failed: view.validations.failed, running: view.validations.running },
    { passed: 3, failed: 1, running: 1 },
  );
});

test('uses the final aggregate test line instead of summing nested runner summaries', () => {
  const view = projectArtifactView({
    episode: 4,
    role: 'composer',
    steps: [
      { kind: 'tool_use', id: 'pytest', name: 'shell', input: { command: 'python -m pytest -q' } },
      {
        kind: 'tool_result',
        tool_use_id: 'pytest',
        text: 'tests/unit/test_a.py ........ 2 passed\ntests/unit/test_b.py .. 2 passed\n4 passed, 1 skipped in 0.31s\n[exit_code=0]',
      },
    ],
  });
  const result = view.validations.items[0];
  assert.equal(result.status, 'passed');
  assert.equal(result.passedCount, 4);
  assert.equal(result.skippedCount, 1);
});

test('does not claim success from stdout counts when the exit status is unavailable', () => {
  const view = projectArtifactView({
    episode: 5,
    role: 'composer',
    steps: [
      { kind: 'tool_use', id: 'pytest', name: 'shell', input: { command: 'python -m pytest -q' } },
      { kind: 'tool_result', tool_use_id: 'pytest', text: '12 passed, 1 skipped in 0.62s' },
    ],
  });
  const result = view.validations.items[0];
  assert.equal(result.status, 'unknown');
  assert.equal(result.passedCount, 12);
  assert.equal(view.validations.unknown, 1);
});

test('accepts an explicit protocol success status even without an exit code', () => {
  const view = projectArtifactView({
    episode: 6,
    role: 'composer',
    steps: [
      { kind: 'tool_use', id: 'build', name: 'shell', input: { command: 'npm run build' } },
      { kind: 'tool_result', tool_use_id: 'build', status: 'completed', text: 'build finished' },
    ],
  });
  assert.equal(view.validations.items[0].status, 'passed');
});

test('coalesces labelled TAP/Bun counters without dropping pass counts', () => {
  const view = projectArtifactView({
    episode: 7,
    role: 'composer',
    steps: [
      { kind: 'tool_use', id: 'node', name: 'shell', input: { command: 'npm test' } },
      {
        kind: 'tool_result',
        tool_use_id: 'node',
        text: 'ℹ tests 33\nℹ suites 0\nℹ pass 31\nℹ fail 2\nℹ skipped 0\n[exit_code=1]',
      },
    ],
  });
  const result = view.validations.items[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.passedCount, 31);
  assert.equal(result.failedCount, 2);
});
