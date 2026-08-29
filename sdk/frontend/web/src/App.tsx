// The workbench shell.
//
// Three columns: the run list, the plan, and the selected node. The plan graph
// is the centre of gravity — every piece of state the loop produces is reached
// by clicking a node — while this file owns the run lifecycle, the operator
// composer, and the drawers.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ellipsis,
  FolderOpen,
  KeyRound,
  PanelRight,
  PanelTop,
  Paperclip,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  DEFAULT_PANEL_STATE,
  actionableApprovals,
  availableCommands,
  commandHelp,
  composerEpisodes,
  isStoppingStatus,
  isTerminalStatus,
  loopOf,
  normaliseMaxRounds,
  parseCommand,
  parseNewRunArgs,
  phaseDetailLine,
  phaseStrip,
  reducePanelState,
  runCost,
  type LoopRole,
  type PanelName,
  type RunSummary,
  type Snapshot,
} from '../../core/src';
import {
  abortRun,
  createRun,
  fetchMeta,
  fetchRuns,
  idempotencyKey,
  isConflict,
  isUnauthorized,
  postInstruction,
  refreshModels,
  reloadService,
  resolveApproval,
  resumeRun,
  setStoredAuthToken,
  stopRun,
  storedAuthToken,
  uploadFile,
  type RoleRuntimeConfig,
  type WebMeta,
} from './api';
import { useRunFeed } from './useRunFeed';
import { useUiLanguage } from './i18n';
import {
  ApprovalCard,
  MessageText,
  compactText,
  formatBytesShort,
  formatCost,
  statusClass,
  statusLabel,
  useBackdropDismiss,
} from './common';
import PlanGraph, { type PlanGraphMode } from './PlanGraph';
import NodePanel from './NodePanel';
import DetailsDrawer, { type EpisodeTarget } from './DetailsDrawer';
import CreateTask from './CreateTask';
import { DEMO_RUNS, DEMO_SNAPSHOT, isDemoMode } from './__fixtures__/snapshot.sample';

/** How long a graceful stop may run before a force-kill is offered. */
const STOP_GRACE_MS = 3_000;

function readRunId(): string {
  try {
    return window.localStorage.getItem('lh-run-id') || '';
  } catch {
    return '';
  }
}

function rememberRunId(value: string): void {
  try {
    if (value) window.localStorage.setItem('lh-run-id', value);
    else window.localStorage.removeItem('lh-run-id');
  } catch {
    // A disabled storage backend should not make the workbench unusable.
  }
}

export default function App() {
  const { text } = useUiLanguage();
  const demo = useMemo(isDemoMode, []);
  const [runs, setRuns] = useState<RunSummary[]>(demo ? DEMO_RUNS : []);
  const [runId, setRunId] = useState(demo ? 'demo-run' : readRunId);
  const [error, setError] = useState('');
  const [dismissedFeedError, setDismissedFeedError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [composerUploading, setComposerUploading] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approvalInputs, setApprovalInputs] = useState<Record<string, string>>({});
  // Kept as raw text so a half-typed value is not silently coerced to a number.
  const [approvalRounds, setApprovalRounds] = useState<Record<string, string>>({});
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  const [meta, setMeta] = useState<WebMeta | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [stopIgnored, setStopIgnored] = useState(false);
  const [search, setSearch] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [panelState, dispatchPanel] = useReducer(reducePanelState, DEFAULT_PANEL_STATE);
  const [episodeTarget, setEpisodeTarget] = useState<EpisodeTarget | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphMode, setGraphMode] = useState<PlanGraphMode>('graph');
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const composerFileInput = useRef<HTMLInputElement | null>(null);
  const operationKeys = useRef(new Map<string, string>());
  const runListGeneration = useRef(0);

  const feed = useRunFeed(demo ? '' : runId, authRevision);
  const snapshot: Snapshot = demo ? DEMO_SNAPSHOT : feed.snapshot;
  const connection = demo ? 'connected' : feed.connection;
  const loop = useMemo(() => loopOf(snapshot), [snapshot]);
  const phases = useMemo(() => phaseStrip(snapshot, loop), [snapshot, loop]);
  const phaseDetail = phaseDetailLine(loop);
  // The report only exists at the end of a run, so the live episode-index
  // totals carry the budget and spend counters until then.
  const episodesRun = composerEpisodes(snapshot, loop);
  const episodeBudget = loop.config?.max_rounds || snapshot.run.max_rounds || 0;
  const costUsd = runCost(snapshot, loop);
  const pendingApprovals = useMemo(() => actionableApprovals(snapshot), [snapshot]);

  const currentRun = runs.find((run) => run.id === runId);
  const filteredRuns = runs.filter((run) => `${run.id} ${run.task}`.toLowerCase().includes(search.toLowerCase()));
  const commandOptions = availableCommands(capabilities, snapshot, Boolean(runId));
  const visibleError = error || (feed.error && feed.error !== dismissedFeedError ? feed.error : '');
  const typedCommand = parseCommand(instruction);
  const canCreateRun = meta !== null && capabilities.create_run !== false;
  const canStopRun = capabilities.stop !== false && snapshot.controls.can_abort
    && !isTerminalStatus(snapshot.run.status) && !isStoppingStatus(snapshot.run.status);
  // Force-kill is offered only while a stop is still visibly stuck: SIGKILL
  // costs the run its final report, so it must not be a same-click alternative
  // to a graceful stop, and it must disappear as soon as the worker does.
  const canAbortRun = capabilities.abort !== false && stopIgnored && isStoppingStatus(snapshot.run.status);
  const canResumeRun = capabilities.resume !== false && snapshot.controls.can_resume;
  // A resumable run accepts typing too: sending reopens the run and delivers the
  // text as the first instruction, so the operator does not have to continue
  // first and then race the worker to type.
  const composerResumes = Boolean(runId) && !snapshot.controls.can_inject && canResumeRun;
  const composerInteractive = !demo && (Boolean(runId && snapshot.controls.can_inject) || composerResumes);
  const composerCanSend = composerInteractive && Boolean(instruction.trim())
    && (!typedCommand || commandOptions.some((item) => item.name === typedCommand.name));
  const composerBusy = busy || (composerResumes && controlBusy);
  const composerPlaceholder = demo
    ? text('Demo mode — no backend is attached')
    : composerResumes
      ? text('Type an instruction and send to continue the run with it')
      : composerInteractive
        ? text('Enter a follow-up instruction, or a /command')
        : !runId
          ? text('Click “New run” in the sidebar to begin')
          : pendingApprovals.length > 0
            ? text('Resolve the gate above first')
            : isStoppingStatus(snapshot.run.status)
              ? text('Stopping the run…')
              : isTerminalStatus(snapshot.run.status)
                ? text('Run ended')
                : text('Input is unavailable during the current stage');
  const composerFooter = composerResumes
    ? text('Sending continues the run')
    : composerInteractive
      ? text('Command')
      : pendingApprovals.length > 0
        ? text('Waiting for your decision')
        : text('Input disabled');
  const connectionLabel = !runId
    ? text('Idle')
    : connection === 'connected' ? text('Connected')
      : connection === 'loading' ? text('Connecting')
        : connection === 'reconnecting' ? text('Reconnecting')
          : connection === 'closed' ? text('Disconnected')
            : text('Connection error');

  function operationKey(scope: string, fingerprint: string): { id: string; key: string } {
    const id = `${scope} ${fingerprint}`;
    const existing = operationKeys.current.get(id);
    if (existing) return { id, key: existing };
    const key = idempotencyKey(scope);
    operationKeys.current.set(id, key);
    return { id, key };
  }

  function clearOperationKey(id: string): void {
    operationKeys.current.delete(id);
  }

  function openDetails(panel: PanelName): void {
    if (!runId) return;
    setCreatingNew(false);
    dispatchPanel({ type: 'open', panel });
    setDetailsOpen(true);
  }

  function openTrajectory(role: string, seq: number): void {
    setEpisodeTarget({ role, seq });
    openDetails('trajectory');
  }

  async function reloadHarness() {
    if (reloading) return;
    setReloading(true);
    try {
      await reloadService();
      // The listener goes away and comes back on fresh source; wait for it.
      const deadline = Date.now() + 90_000;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      while (Date.now() < deadline) {
        try {
          const probe = await fetch('/api/meta', { headers: {} });
          if (probe.status > 0) break;
        } catch { /* still restarting */ }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      window.location.reload();
    } catch (reason) {
      setError(compactText(String(reason instanceof Error ? reason.message : reason), 240));
      setReloading(false);
    }
  }

  async function attachToInstruction(list: FileList | null) {
    if (!list?.length) return;
    setComposerUploading(true);
    const lines: string[] = [];
    try {
      for (const file of Array.from(list)) {
        const stored = await uploadFile(file, snapshot.run.workspace || undefined);
        lines.push(`- ${stored.path} (${formatBytesShort(stored.bytes)})`);
      }
      setInstruction((current) => `${current.trim()}${current.trim() ? '\n\n' : ''}Attached files (uploaded to the workspace's \`inbox/\` folder; use these workspace-relative paths):\n${lines.join('\n')}`);
    } catch (reason) {
      setError(compactText(String(reason instanceof Error ? reason.message : reason), 240));
    } finally {
      setComposerUploading(false);
    }
  }

  useEffect(() => {
    const onRunNotFound = () => setRunId('');
    window.addEventListener('lh-run-not-found', onRunNotFound);
    return () => window.removeEventListener('lh-run-not-found', onRunNotFound);
  }, []);

  useEffect(() => {
    if (demo) return undefined;
    const onFailure = (reason: unknown) => {
      if (isUnauthorized(reason)) setAuthOpen(true);
      setError(isUnauthorized(reason) ? text('This Web service requires an access token. Enter it in Connection settings.') : String(reason));
    };
    void fetchMeta().then((next) => {
      setMeta(next);
      setCapabilities(next.capabilities);
      setAuthOpen(false);
    }).catch(onFailure);
    runListGeneration.current += 1;
    const refresh = () => {
      const requestGeneration = ++runListGeneration.current;
      return fetchRuns().then((items) => {
        if (requestGeneration !== runListGeneration.current) return;
        setRuns(items);
        // A selected run is stronger than a potentially stale list response.
        // Immediately after /new (or /attach), the supervisor can have created
        // the run while this poll still sees the previous list. Keep an explicit
        // selection until the run-scoped feed receives its authoritative 404;
        // only choose a default when there is no selection at all.
        if (!runId && items.length) {
          setRunId(items[0].id);
          setError('');
        }
      }).catch(onFailure);
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      window.clearInterval(timer);
      runListGeneration.current += 1;
    };
  }, [demo, runId, authRevision, text]);

  useEffect(() => {
    if (demo) return;
    rememberRunId(runId);
    setSelectedNodeId(null);
    setEpisodeTarget(null);
  }, [demo, runId]);

  useEffect(() => {
    if (!feed.error || !/\b401\b/u.test(feed.error)) return;
    setAuthOpen(true);
    setError(text('This Web service requires an access token. Enter it in Connection settings.'));
  }, [feed.error, text]);

  // Measure how long the run stays in `stopping` locally rather than comparing
  // `stop_requested_at` against the browser clock, which may be skewed from the
  // server's. An abort already requested needs no second escalation offer.
  useEffect(() => {
    const stopping = isStoppingStatus(snapshot.run.status);
    const alreadyAborting = String(snapshot.run.requested_action || '') === 'abort';
    if (!stopping || alreadyAborting) {
      setStopIgnored(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setStopIgnored(true), STOP_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [runId, snapshot.run.status, snapshot.run.requested_action, snapshot.run.stop_requested_at]);

  useEffect(() => {
    if (!mobilePanelOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobilePanelOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobilePanelOpen]);

  useEffect(() => {
    if (!detailsOpen && !authOpen && !creatingNew) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (authOpen) setAuthOpen(false);
      else {
        dispatchPanel({ type: 'close' });
        setDetailsOpen(false);
        setCreatingNew(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailsOpen, authOpen, creatingNew]);

  async function submitOperatorInstruction(messageText: string) {
    const requestKey = idempotencyKey('instruction');
    const createdAt = Date.now() / 1000;
    setBusy(true);
    setError('');
    setInstruction('');
    feed.appendOperatorMessage({ id: requestKey, text: messageText, created_at: createdAt, status: 'queued' });
    try {
      await postInstruction(runId, messageText, requestKey);
    } catch (reason) {
      feed.appendOperatorMessage({ id: requestKey, text: messageText, created_at: createdAt, status: 'failed' });
      setError(String(reason));
      setBusy(false);
      return;
    }
    try {
      await feed.refresh();
    } catch (reason) {
      // The command was accepted, so keep the optimistic queued message. The
      // live feed will reconcile it even if this one REST refresh failed.
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function sendInstruction() {
    const inputText = instruction.trim();
    if (!inputText) return;
    const command = parseCommand(inputText);
    if (command) {
      if (!commandOptions.some((item) => item.name === command.name)) { setError(text(`Command unavailable: /${command.name}`)); setInstruction(''); return; }
      if (command.name === 'help') { setError(commandHelp(capabilities, snapshot, Boolean(runId))); setInstruction(''); return; }
      if (['details', 'events', 'trajectory', 'briefings', 'research', 'revisions'].includes(command.name)) {
        openDetails(command.name === 'details' ? 'events' : command.name as PanelName);
        setInstruction('');
        return;
      }
      if (command.name === 'runs') { setError(runs.map((run) => `${run.id} · ${run.task || 'Untitled run'}`).join('\n') || text('No runs yet')); setInstruction(''); return; }
      if (command.name === 'attach') {
        if (!command.args[0]) setError(text('Usage: /attach <run_id>'));
        else setRunId(command.args[0]);
        setInstruction('');
        return;
      }
      if (command.name === 'new') {
        const parsed = parseNewRunArgs(command.args);
        if (parsed.error || !parsed.task) {
          setError(parsed.error || text('Usage: /new <task> [--effort level] [--planner-agent id] [--planner-model id] [--composer-agent id] [--composer-model id] [--evaluator-agent id] [--evaluator-model id] [--workspace path] [--rounds n]'));
          setInstruction('');
          return;
        }
        setControlBusy(true); setError('');
        const selectedAgent = parsed.agent || meta?.defaults?.agent || meta?.agents?.find((item) => item.available !== false)?.id || 'claude_code';
        const payload = {
          task: parsed.task,
          agent: selectedAgent,
          model: parsed.model || (parsed.agent ? undefined : meta?.defaults?.model),
          roles: parsed.roles,
          workspace: parsed.workspace,
          max_rounds: parsed.maxRounds || 25,
          prompt_language: 'en' as const,
        };
        const request = operationKey('create', JSON.stringify(payload));
        try {
          const created = await createRun(payload, request.key);
          setRunId(created.id);
          clearOperationKey(request.id);
          setInstruction('');
        } catch (reason) { setError(String(reason)); }
        finally { setControlBusy(false); }
        return;
      }
      if (command.name === 'approve') {
        if (command.args.length < 2) setError(text('Usage: /approve <approval_id> <action>'));
        else void approve(command.args[0], command.args[1]);
        setInstruction('');
        return;
      }
      if (command.name === 'inject') {
        const injected = command.args.join(' ').trim();
        if (!runId || !injected) { setError(text('Usage: /inject <text>')); setInstruction(''); return; }
        await submitOperatorInstruction(injected);
        return;
      }
      if (command.name === 'stop' || command.name === 'abort' || command.name === 'resume') { void lifecycle(command.name); setInstruction(''); return; }
    }
    if (!runId) return;
    if (!snapshot.controls.can_inject) {
      if (composerResumes) {
        setInstruction('');
        await lifecycle('resume', inputText);
        return;
      }
      setError(text('This run has ended or cannot accept input. Use /new, /attach or /resume.'));
      setInstruction('');
      return;
    }
    await submitOperatorInstruction(inputText);
  }

  async function approve(approvalId: string, action: string, inputOverride?: string, extraRounds?: number) {
    const submittedInput = inputOverride ?? (approvalInputs[approvalId] || '');
    setBusy(true); setError('');
    try {
      await resolveApproval(runId, approvalId, action, submittedInput, undefined, extraRounds);
      feed.recordApprovalResponse(approvalId, action, submittedInput.trim(), Date.now() / 1000);
      setApprovalInputs((current) => {
        const next = { ...current };
        delete next[approvalId];
        return next;
      });
      setApprovalRounds((current) => {
        const next = { ...current };
        delete next[approvalId];
        return next;
      });
      await feed.refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  /** Deliver a resume instruction once the reopened worker accepts injections. */
  async function queueResumeInstruction(targetRunId: string, messageText: string) {
    const requestKey = idempotencyKey('instruction');
    const createdAt = Date.now() / 1000;
    feed.appendOperatorMessage({ id: requestKey, text: messageText, created_at: createdAt, status: 'queued' });
    // The worker is forked asynchronously, so `can_control` stays false for a
    // moment and the API answers 409. Bounded retries keep a genuine rejection
    // (revoked capability, run replaced) from looping forever.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await postInstruction(targetRunId, messageText, requestKey);
        await feed.refresh();
        return;
      } catch (reason) {
        if (!isConflict(reason) || attempt === 19) {
          feed.appendOperatorMessage({ id: requestKey, text: messageText, created_at: createdAt, status: 'failed' });
          setError(text('The follow-up instruction could not be delivered. Send it again once the run is going.'));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async function lifecycle(action: 'stop' | 'abort' | 'resume' | 'restart', resumeInstruction = '') {
    setControlBusy(true); setError('');
    const request = operationKey(action, runId);
    try {
      if (action === 'stop') await stopRun(runId, request.key);
      if (action === 'abort') await abortRun(runId, request.key);
      if (action === 'resume' || action === 'restart') {
        const mode = action === 'resume' ? 'continue' : 'retry';
        const created = await resumeRun(runId, request.key, { mode });
        // The instruction cannot be queued before this call: injection requires
        // a live worker, so a terminal run rejects it with 409.
        if (resumeInstruction) void queueResumeInstruction(created.id, resumeInstruction);
        // "continue" reuses the same id, so the feed must still be refreshed to
        // pick up the reopened lifecycle status.
        if (created.id === runId) await feed.refresh();
        else setRunId(created.id);
      } else {
        // Stop/Abort changes supervisor control state without appending a loop
        // event. Refresh immediately so the header switches to "stopping".
        await feed.refresh();
      }
      clearOperationKey(request.id);
    } catch (reason) {
      // A force-kill races the worker's own exit, so "no longer running" means
      // the goal is already met: reconcile instead of showing a dead-end error.
      if (action === 'abort' && isConflict(reason)) {
        clearOperationKey(request.id);
        await feed.refresh().catch(() => undefined);
      } else setError(String(reason));
    }
    finally { setControlBusy(false); }
  }

  async function submitNewRun(
    task: string,
    roles: Record<LoopRole, RoleRuntimeConfig>,
    workspace: string,
    maxRounds: string,
    grantedCapabilities: string[],
  ) {
    setControlBusy(true); setError('');
    const payload = {
      task,
      agent: roles.composer.agent,
      model: roles.composer.model || undefined,
      roles,
      workspace: workspace || undefined,
      max_rounds: normaliseMaxRounds(maxRounds),
      prompt_language: 'en' as const,
      capabilities: grantedCapabilities,
    };
    const request = operationKey('create', JSON.stringify(payload));
    try {
      const created = await createRun(payload, request.key);
      setRunId(created.id);
      setCreatingNew(false);
      clearOperationKey(request.id);
    } catch (reason) { setError(String(reason)); }
    finally { setControlBusy(false); }
  }

  async function refreshModelCatalogue() {
    const next = await refreshModels();
    setMeta(next);
    setCapabilities(next.capabilities);
  }

  const finalResponse = loop.final_response || snapshot.run.final_response || '';
  const attention = (pendingApprovals.length > 0 || finalResponse) ? <div className="attention-area">
    {pendingApprovals.map((approval) => <ApprovalCard
      key={approval.approval_id}
      approval={approval}
      busy={busy || demo}
      userInput={approvalInputs[approval.approval_id] || ''}
      onUserInput={(value) => setApprovalInputs((current) => ({ ...current, [approval.approval_id]: value }))}
      extraRounds={approvalRounds[approval.approval_id] || ''}
      onExtraRounds={(value) => setApprovalRounds((current) => ({ ...current, [approval.approval_id]: value }))}
      onApprove={approve}
      onFocusSubtask={(subtaskId) => { setSelectedNodeId(subtaskId); setMobilePanelOpen(true); }}
    />)}
    {finalResponse && <article className="final-response-card">
      <header><Sparkles size={13} /><strong>{text('Final response')}</strong>{snapshot.run.cost_usd ? <span>{formatCost(snapshot.run.cost_usd)}</span> : null}</header>
      <MessageText text={finalResponse} />
    </article>}
  </div> : null;

  const header = <div className="phase-strip" role="status" aria-live="polite">
    <ol className="phase-steps">
      {phases.map((step) => <li key={step.phase} className={`phase-step phase-${step.state}`}>
        <span className="phase-dot" aria-hidden="true" />
        <span className="phase-label">{step.label}</span>
      </li>)}
    </ol>
    <div className="phase-detail">
      {loop.phase?.detail && <span className="phase-detail-text">{compactText(loop.phase.detail, 180)}</span>}
      {phaseDetail && <span className="phase-detail-active">{phaseDetail}</span>}
      {!loop.phase && <span className="phase-detail-text">{text('Waiting for the loop to report a phase.')}</span>}
    </div>
  </div>;

  return (
    <div className="codex-shell codex-workbench">
      <aside className="codex-sidebar">
        <div className="codex-brand"><span className="codex-mark"><Sparkles size={14} /></span><span>lh-harness</span></div>
        <button className="new-task-button" onClick={() => setCreatingNew(true)} disabled={!canCreateRun}><Plus size={14} />{text('New run')}</button>
        <label className="session-search"><span><Search size={13} /></span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={text('Search runs')} /></label>
        <div className="session-label">{text('Runs')} <span>{runs.length}</span></div>
        <div className="session-list">
          {filteredRuns.map((run) => <button key={run.id} className={`session-item ${run.id === runId ? 'selected' : ''}`} onClick={() => setRunId(run.id)}><span className={statusClass(run.status)} /><span className="session-copy"><strong>{run.task || 'Untitled run'}</strong><small>{run.id}</small></span></button>)}
          {!filteredRuns.length && <div className="sidebar-empty">{text('No runs yet')}</div>}
        </div>
        <div className="sidebar-footer">
          <span className="connection-state" title={connectionLabel}><span className={`connection-dot connection-${runId ? connection : 'idle'}`} /><span className="connection-copy"><span className="connection-phase">{connectionLabel}</span></span></span>
          <span className="connection-actions">
            <button type="button" className="connection-settings" onClick={() => setAuthOpen(true)} title={text('Connection settings')} aria-label={text('Connection settings')}><KeyRound size={13} /></button>
            {meta?.capabilities?.reload && <button type="button" className="connection-settings" disabled={reloading} onClick={() => void reloadHarness()} title={text('Reload the harness (restart on current source)')} aria-label={text('Reload the harness')}><RotateCw size={13} className={reloading ? 'reload-spin' : ''} /></button>}
          </span>
        </div>
      </aside>

      <main className="codex-main">
        <header className="codex-header">
          <div className="header-context">
            <span className="header-folder"><PanelTop size={16} /></span>
            <strong className="header-title">{loop.task || currentRun?.task || snapshot.mission.task || runId || text('New run')}</strong>
            <span className="header-more"><Ellipsis size={16} /></span>
          </div>
          <div className="header-actions">
            <span className={statusClass(snapshot.run.status)} />
            <span className="header-status">{statusLabel(snapshot.run.status)}</span>
            {episodesRun !== null && <span className="header-status" title={text('Composer episodes spent')}>{episodesRun}{episodeBudget ? `/${episodeBudget}` : ''} ep</span>}
            {formatCost(costUsd) && <span className="header-status" title={text('Spend so far')}>{formatCost(costUsd)}</span>}
            <button className="mobile-status-button" onClick={() => setMobilePanelOpen((open) => !open)} aria-label={text('Open the node panel')} title={text('Node panel')}><PanelRight size={14} /><span>{text('Node')}</span></button>
            {canStopRun && <button onClick={() => void lifecycle('stop')} disabled={controlBusy} title={text('Let the worker finish up and write its report')}>{text('Stop')}</button>}
            {canAbortRun && <button className="danger-text" onClick={() => void lifecycle('abort')} disabled={controlBusy} title={text('The stop did not take effect. Force-kill the process; this run will not write a report')}>{text('Force stop')}</button>}
            {canResumeRun && <button onClick={() => void lifecycle('resume')} disabled={controlBusy} title={text('Continue from the plan already recorded instead of starting over')}>{text('Continue')}</button>}
            {canResumeRun && <button onClick={() => void lifecycle('restart')} disabled={controlBusy} title={text('Start again from a fresh plan with the same task and configuration')}>{text('Restart')}</button>}
            <button className="details-button" disabled={!runId} onClick={() => openDetails(panelState.panel)} aria-label={text('View details')} title={runId ? text('Details') : text('Select a run to view details')}><FolderOpen size={14} /><span>{text('Details')}</span></button>
          </div>
        </header>

        {!runId
          ? <div className="welcome">
            <div className="welcome-mark"><Sparkles size={20} /></div>
            <h1>{text('What should the harness build?')}</h1>
            <p>{text('The planner turns your task into a plan tree. Every leaf gets a contract, a composer and an evaluator; the graph below shows that happening.')}</p>
            {meta && !canCreateRun && <p className="welcome-note">{text('This connection is read-only. Start ')}<code>lh-harness-eray web</code>{text(' to create runs.')}</p>}
            {!meta && !demo && <p className="welcome-note">{text('Connecting to the Web service…')}</p>}
            <button className="welcome-button" disabled={!canCreateRun} onClick={() => setCreatingNew(true)}><Plus size={15} />{text('Start a run')}</button>
          </div>
          : <PlanGraph
            plan={loop.plan}
            selectedId={selectedNodeId}
            activeId={snapshot.active_subtask}
            onSelect={(id) => { setSelectedNodeId(id); if (id) setMobilePanelOpen(true); }}
            mode={graphMode}
            onModeChange={setGraphMode}
            maxEvalRounds={loop.config?.max_eval_rounds ?? null}
            header={header}
            attention={attention}
          />}

        {visibleError && <div className="error-line" role="alert" aria-live="assertive"><span><AlertTriangle size={14} /></span>{visibleError}<button onClick={() => { setError(''); setDismissedFeedError(feed.error); }}>{text('Dismiss')}</button></div>}
        <div className={`composer-wrap ${composerInteractive ? '' : 'composer-disabled'}`}>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void sendInstruction(); } }}
            placeholder={composerPlaceholder}
            disabled={composerBusy || !composerInteractive}
          />
          <div className="composer-footer">
            <span>{composerFooter}{composerInteractive && <> · <kbd>⌘</kbd><kbd>↵</kbd> {text('Send')}</>}</span>
            <span className="composer-actions">
              <button type="button" className="composer-attach" title={text('Attach files to this message')} aria-label={text('Attach files to this message')} disabled={composerBusy || !composerInteractive || composerUploading} onClick={() => composerFileInput.current?.click()}><Paperclip size={13} />{composerUploading ? text('Uploading…') : text('Attach')}</button>
              <input ref={composerFileInput} type="file" multiple hidden onChange={(event) => { void attachToInstruction(event.target.files); event.target.value = ''; }} />
              <button onClick={() => void sendInstruction()} disabled={composerBusy || !composerCanSend || composerUploading}>{text('Send')}</button>
            </span>
          </div>
        </div>
      </main>

      {mobilePanelOpen && <button type="button" className="status-mobile-backdrop" onClick={() => setMobilePanelOpen(false)} aria-label={text('Close the node panel')} />}
      <NodePanel
        runId={demo ? '' : runId}
        snapshot={snapshot}
        loop={loop}
        selectedId={selectedNodeId}
        onSelect={setSelectedNodeId}
        onOpenTrajectory={openTrajectory}
        mobileOpen={mobilePanelOpen}
        onMobileClose={() => setMobilePanelOpen(false)}
        connectionLabel={connectionLabel}
      />

      {detailsOpen && <DetailsDrawer
        runId={demo ? '' : runId}
        snapshot={snapshot}
        loop={loop}
        panel={panelState.panel}
        onPanel={(panel) => dispatchPanel({ type: 'open', panel })}
        episode={episodeTarget}
        onEpisode={setEpisodeTarget}
        onClose={() => { dispatchPanel({ type: 'close' }); setDetailsOpen(false); }}
      />}
      {creatingNew && <CreateTask
        meta={meta}
        controlBusy={controlBusy}
        onClose={() => setCreatingNew(false)}
        onCreate={submitNewRun}
        onRefreshModels={refreshModelCatalogue}
      />}
      {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onSaved={() => { setAuthOpen(false); setAuthRevision((value) => value + 1); setError(''); setDismissedFeedError(''); }} />}
    </div>
  );
}

function AuthDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { text } = useUiLanguage();
  const backdrop = useBackdropDismiss(onClose);
  const [token, setToken] = useState(storedAuthToken);
  const save = () => {
    setStoredAuthToken(token.trim());
    onSaved();
  };
  return <div className="auth-backdrop" {...backdrop}>
    <form className="auth-dialog" role="dialog" aria-modal="true" aria-label={text('Connection settings')} onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="auth-dialog-head"><span className="auth-dialog-icon"><KeyRound size={16} /></span><div><span className="drawer-eyebrow">CONNECTION</span><h2>{text('Connection settings')}</h2></div><button type="button" className="drawer-close" onClick={onClose} aria-label={text('Close')}><X size={18} /></button></div>
      <p className="auth-dialog-copy">{text('If the Web service uses ')}<code>LH_HARNESS_WEB_TOKEN</code>{text(', enter the Bearer token here. The token is stored only in the current browser tab.')}</p>
      <label className="drawer-field"><span>{text('Access token')}</span><input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={text('Paste the Web service token')} autoComplete="off" /></label>
      <div className="auth-dialog-actions"><button type="button" onClick={() => { setToken(''); setStoredAuthToken(''); onSaved(); }}>{text('Clear token')}</button><span /><button type="button" onClick={onClose}>{text('Cancel')}</button><button type="submit" className="primary-action">{text('Save and reconnect')}</button></div>
    </form>
  </div>;
}
