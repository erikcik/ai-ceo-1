// The details drawer: everything that is about the run rather than about one
// plan node — the event log, one episode's trajectory, the tailored briefings,
// the planner's research notes, and the plan's revision history.

import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  PANEL_LABELS,
  PANEL_NAMES,
  dedupeEvents,
  episodeRef,
  episodesNewestFirst,
  eventLine,
  type LoopSnapshot,
  type PanelName,
  type Snapshot,
} from '../../core/src';
import { fetchEpisodeTrajectory, fetchStateFile, listStateDir, type TrajectoryView } from './api';
import {
  MessageText,
  TrajectoryDetail,
  TrajectorySteps,
  compactText,
  formatCost,
  formatDuration,
  formatTime,
  roleTitle,
  trajectoryActivity,
  useBackdropDismiss,
} from './common';

export interface EpisodeTarget {
  role: string;
  seq: number;
}

export interface DetailsDrawerProps {
  runId: string;
  snapshot: Snapshot;
  loop: LoopSnapshot;
  panel: PanelName;
  onPanel: (panel: PanelName) => void;
  episode: EpisodeTarget | null;
  onEpisode: (target: EpisodeTarget | null) => void;
  onClose: () => void;
}

export default function DetailsDrawer({ runId, snapshot, loop, panel, onPanel, episode, onEpisode, onClose }: DetailsDrawerProps) {
  const backdrop = useBackdropDismiss(onClose);
  return <div className="drawer-backdrop" {...backdrop}><aside className="details-drawer" role="dialog" aria-modal="true" aria-label="Run details">
    <div className="drawer-header">
      <div><div className="drawer-eyebrow">RUN DETAILS</div><h2>{PANEL_LABELS[panel]}</h2></div>
      <button className="drawer-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
    </div>
    <div className="details-tabs" role="tablist" aria-label="Detail categories">
      {PANEL_NAMES.map((name) => <button
        key={name}
        id={`details-tab-${name}`}
        role="tab"
        aria-controls={`details-panel-${name}`}
        aria-selected={panel === name}
        tabIndex={panel === name ? 0 : -1}
        className={panel === name ? 'active' : ''}
        onClick={() => onPanel(name)}
      >{PANEL_LABELS[name]}</button>)}
    </div>
    <div className="drawer-content" id={`details-panel-${panel}`} role="tabpanel" aria-labelledby={`details-tab-${panel}`}>
      {panel === 'events' && <EventsTab snapshot={snapshot} />}
      {panel === 'trajectory' && <TrajectoryTab runId={runId} loop={loop} episode={episode} onEpisode={onEpisode} />}
      {panel === 'briefings' && <BriefingsTab loop={loop} />}
      {panel === 'research' && <ResearchTab runId={runId} loop={loop} />}
      {panel === 'revisions' && <RevisionsTab runId={runId} loop={loop} />}
    </div>
  </aside></div>;
}

// ---------------------------------------------------------------------------

function EventsTab({ snapshot }: { snapshot: Snapshot }) {
  const events = useMemo(() => dedupeEvents(snapshot.events).slice(-200).reverse(), [snapshot.events]);
  if (!events.length) return <p className="drawer-muted">No events yet.</p>;
  return <div className="event-list-drawer">
    {events.map((event) => <div key={event.event_id}>
      <time>{formatTime(event.ts)}</time>
      <span>{eventLine(event)}</span>
    </div>)}
  </div>;
}

// ---------------------------------------------------------------------------

function TrajectoryTab({ runId, loop, episode, onEpisode }: { runId: string; loop: LoopSnapshot; episode: EpisodeTarget | null; onEpisode: (target: EpisodeTarget | null) => void }) {
  const episodes = useMemo(() => episodesNewestFirst(loop.episodes), [loop.episodes]);
  const [data, setData] = useState<TrajectoryView | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [raw, setRaw] = useState(false);
  const request = useRef(0);

  // Default to the newest episode so the tab is useful without a pick.
  useEffect(() => {
    if (episode || !episodes.length) return;
    const ref = episodeRef(episodes[0]);
    if (ref) onEpisode(ref);
  }, [episode, episodes, onEpisode]);

  useEffect(() => {
    if (!runId || !episode) { setData(null); return undefined; }
    const id = ++request.current;
    setData(null);
    setError('');
    void fetchEpisodeTrajectory(runId, episode.role, episode.seq)
      .then((value) => { if (id === request.current) setData(value); })
      .catch((reason) => { if (id === request.current) setError(String(reason)); });
    return () => { request.current += 1; };
  }, [runId, episode?.role, episode?.seq, reload]);

  const activity = useMemo(() => trajectoryActivity(data, true), [data]);

  return <>
    <div className="drawer-rounds episode-picker">
      <span>Episode</span>
      {episodes.length === 0 && <span className="drawer-muted">none yet</span>}
      {episodes.slice(0, 60).map((entry) => {
        const ref = episodeRef(entry);
        if (!ref) return null;
        const selected = episode?.role === ref.role && episode?.seq === ref.seq;
        return <button
          key={`${entry.role}-${entry.seq}`}
          className={selected ? 'active' : ''}
          title={`${roleTitle(entry.role)} · ${entry.subtask_id || 'run'} · ${entry.status}`}
          onClick={() => onEpisode(ref)}
        >{roleTitle(entry.role)} ep{ref.seq}</button>;
      })}
    </div>
    {episode && <EpisodeSummary loop={loop} episode={episode} />}
    <div className="drawer-rounds role-picker">
      <span>View</span>
      <button className={raw ? '' : 'active'} onClick={() => setRaw(false)}>Steps</button>
      <button className={raw ? 'active' : ''} onClick={() => setRaw(true)}>Raw</button>
      <button onClick={() => setReload((value) => value + 1)}>Refresh</button>
    </div>
    {raw
      ? <TrajectoryDetail data={data} error={error} onRetry={() => setReload((value) => value + 1)} />
      : error
        ? <div className="drawer-error-state"><span className="drawer-error">Failed to load trajectory: {compactText(error, 240)}</span><button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></div>
        : !data
          ? <p className="drawer-muted">{episode ? 'Loading trajectory…' : 'Select an episode.'}</p>
          : activity.length
            ? <TrajectorySteps steps={activity} />
            : <p className="drawer-muted">This episode produced no readable steps. Switch to Raw to see the record.</p>}
  </>;
}

function EpisodeSummary({ loop, episode }: { loop: LoopSnapshot; episode: EpisodeTarget }) {
  const entry = loop.episodes.find((item) => {
    const ref = episodeRef(item);
    return ref?.role === episode.role && ref?.seq === episode.seq;
  });
  if (!entry) return null;
  return <p className="episode-summary">
    <strong>{roleTitle(entry.role)}</strong>
    <span>{entry.subtask_id ? `subtask ${entry.subtask_id}` : 'run-level'}</span>
    {entry.round ? <span>round {entry.round}</span> : null}
    <span>{entry.status}</span>
    {formatDuration(entry.duration_ms) ? <span>{formatDuration(entry.duration_ms)}</span> : null}
    {formatCost(entry.cost_usd) ? <span>{formatCost(entry.cost_usd)}</span> : null}
  </p>;
}

// ---------------------------------------------------------------------------

const BRIEFING_ROLES = ['planner', 'rubric', 'composer', 'evaluator'] as const;

function BriefingsTab({ loop }: { loop: LoopSnapshot }) {
  const roles = [...new Set([...BRIEFING_ROLES, ...Object.keys(loop.briefings)])].filter((role) => loop.briefings[role]);
  const [selected, setSelected] = useState<string>(roles[0] || '');
  const active = roles.includes(selected) ? selected : roles[0] || '';
  if (!roles.length) return <p className="drawer-muted">The prompt tailor has not written any briefings yet. They appear in <code>state/prompts/&lt;role&gt;.md</code>.</p>;
  return <>
    <div className="drawer-rounds role-picker">
      <span>Role</span>
      {roles.map((role) => <button key={role} className={role === active ? 'active' : ''} onClick={() => setSelected(role)}>{roleTitle(role)}</button>)}
    </div>
    <div className="drawer-prose"><MessageText text={loop.briefings[active] || ''} /></div>
  </>;
}

// ---------------------------------------------------------------------------

function ResearchTab({ runId, loop }: { runId: string; loop: LoopSnapshot }) {
  const notes = loop.research_notes.length
    ? loop.research_notes
    : loop.research.map((file) => ({ file, title: '' }));
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const request = useRef(0);
  const active = notes.some((note) => note.file === selected) ? selected : notes[0]?.file || '';

  useEffect(() => {
    if (!runId || !active) { setText(''); return undefined; }
    const id = ++request.current;
    setText('');
    setError('');
    void fetchStateFile(runId, `research/${active}`)
      .then((value) => { if (id === request.current) setText(value); })
      .catch((reason) => { if (id === request.current) setError(String(reason)); });
    return () => { request.current += 1; };
  }, [runId, active]);

  if (!notes.length) return <p className="drawer-muted">The planner filed no research notes. They would appear in <code>state/research/</code>.</p>;
  return <>
    <div className="drawer-rounds role-picker">
      <span>Note</span>
      {notes.map((note) => <button key={note.file} className={note.file === active ? 'active' : ''} title={note.file} onClick={() => setSelected(note.file)}>{note.title || note.file.replace(/\.md$/u, '')}</button>)}
    </div>
    {error && <div className="drawer-error-state"><span className="drawer-error">{compactText(error, 240)}</span></div>}
    <div className="drawer-prose">{text
      ? <MessageText text={text} />
      : !error && <p className="drawer-muted">{runId ? `Loading ${active}…` : 'Note contents need a backend connection.'}</p>}</div>
  </>;
}

// ---------------------------------------------------------------------------

function RevisionsTab({ runId, loop }: { runId: string; loop: LoopSnapshot }) {
  const [fallback, setFallback] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const summaries = loop.plan_revisions;

  // Older servers do not project the revision summary; list the directory then.
  useEffect(() => {
    if (summaries.length || !runId) { setFallback(summaries.length ? [] : fallback); return undefined; }
    let cancelled = false;
    setFallback(null);
    void listStateDir(runId, 'plan/revisions')
      .then((listing) => { if (!cancelled) setFallback(listing.entries.filter((name) => name.endsWith('.json'))); })
      .catch((reason) => { if (!cancelled) { setFallback([]); setError(String(reason)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, summaries.length]);

  const rows = summaries.length
    ? summaries.map((item) => ({ revision: item.revision, note: item.note, writtenAt: item.written_at, file: `r${String(item.revision).padStart(3, '0')}.json` }))
    : (fallback || []).map((name) => ({ revision: Number(/r(\d+)\.json$/u.exec(name)?.[1] ?? 0), note: '', writtenAt: 0, file: name }))
      .sort((left, right) => right.revision - left.revision);

  if (!summaries.length && fallback === null) return <p className="drawer-muted">Loading revisions…</p>;
  if (!rows.length) return <>
    <p className="drawer-muted">No plan revision has been recorded yet. Each accepted plan change writes <code>state/plan/revisions/rNNN.json</code>.</p>
    {error && <div className="drawer-error-state"><span className="drawer-error">{compactText(error, 240)}</span></div>}
  </>;
  return <ol className="revision-timeline">
    {rows.map((row) => <RevisionRow key={row.file} runId={runId} revision={row.revision} note={row.note} writtenAt={row.writtenAt} file={row.file} />)}
  </ol>;
}

/** One revision in the timeline. The plan JSON is fetched only when expanded. */
function RevisionRow({ runId, revision, note, writtenAt, file }: { runId: string; revision: number; note: string; writtenAt: number; file: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !runId || text || error) return undefined;
    let cancelled = false;
    void fetchStateFile(runId, `plan/revisions/${file}`)
      .then((value) => { if (!cancelled) setText(value); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [open, runId, file, text, error]);
  return <li className="revision-row">
    <button type="button" className="revision-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="revision-mark">r{revision}</span>
      <span className="revision-note">{note || 'No note recorded'}</span>
      {writtenAt ? <time>{formatTime(writtenAt)}</time> : null}
    </button>
    {open && (error
      ? <div className="drawer-error-state"><span className="drawer-error">{compactText(error, 240)}</span></div>
      : <pre className="drawer-pre">{text || (runId ? 'Loading…' : 'Not available without a backend.')}</pre>)}
  </li>;
}
