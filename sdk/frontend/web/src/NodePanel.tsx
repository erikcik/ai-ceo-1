// The right rail: everything the loop knows about one plan node.
//
// Selecting a node in the graph must be enough to answer "why does this exist,
// what is it judged against, what did the composer see and do, what backs the
// verdict" — so every artefact the loop writes for a subtask is reachable from
// here, either inline or as a link into the run's `state/` folder.

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Check,
  ExternalLink,
  FilePenLine,
  FileText,
  Play,
  Terminal,
  X,
} from 'lucide-react';
import {
  ancestors,
  episodeRef,
  isLeaf,
  nodeById,
  runOverview,
  subtaskById,
  type Contract,
  type EpisodeIndexEntry,
  type EvaluationRecord,
  type LedgerEntry,
  type LoopSnapshot,
  type NodeStatus,
  type PlanNode,
  type Snapshot,
  type SubtaskView,
} from '../../core/src';
import { fetchStateFile, stateFileUrl } from './api';
import {
  CopyPath,
  DownloadLink,
  EmptyNote,
  Field,
  ImageGallery,
  MessageText,
  Section,
  VideoFile,
  compactText,
  formatBytesShort,
  formatCost,
  formatDuration,
  formatTime,
  isImageFile,
  isVideoFile,
  normalizeLink,
  roleTitle,
} from './common';

const STATUS_LABELS: Record<NodeStatus, string> = {
  pending: 'Pending',
  rubric: 'Writing rubric',
  composing: 'Composing',
  evaluating: 'Evaluating',
  done: 'Done',
  blocked: 'Blocked',
  skipped: 'Skipped',
};

export interface NodePanelProps {
  runId: string;
  snapshot: Snapshot;
  loop: LoopSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenTrajectory: (role: string, seq: number) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  connectionLabel: string;
}

export default function NodePanel({
  runId,
  snapshot,
  loop,
  selectedId,
  onSelect,
  onOpenTrajectory,
  mobileOpen,
  onMobileClose,
  connectionLabel,
}: NodePanelProps) {
  const node = nodeById(loop.plan, selectedId);
  const subtask = node && isLeaf(node) ? subtaskById(loop, node.id) : null;
  return <aside className={`status-panel node-panel ${mobileOpen ? 'mobile-open' : ''}`} aria-label="Plan node details">
    <div className="status-panel-head">
      <div>
        <span className="status-eyebrow">{node ? (isLeaf(node) ? 'SUBTASK' : 'PLAN GROUP') : 'RUN'}</span>
        <h2>{node ? node.title || node.id : 'Overview'}</h2>
      </div>
      <div className="status-panel-head-actions">
        {node && <button type="button" className="node-panel-clear" onClick={() => onSelect(null)} title="Back to the run overview">Overview</button>}
        <button className="status-mobile-close" onClick={onMobileClose} aria-label="Close panel"><X size={16} /></button>
      </div>
    </div>
    <div className="node-panel-body">
      {node
        ? <NodeDetails runId={runId} loop={loop} node={node} subtask={subtask} onSelect={onSelect} onOpenTrajectory={onOpenTrajectory} />
        : <RunOverviewPanel snapshot={snapshot} loop={loop} connectionLabel={connectionLabel} />}
    </div>
  </aside>;
}

// ---------------------------------------------------------------------------
// Run overview (nothing selected)
// ---------------------------------------------------------------------------

function RunOverviewPanel({ snapshot, loop, connectionLabel }: { snapshot: Snapshot; loop: LoopSnapshot; connectionLabel: string }) {
  const overview = runOverview(snapshot, loop);
  const counts = Object.entries(overview.counts).filter(([, value]) => value > 0);
  const settled = (overview.counts.done || 0) + (overview.counts.skipped || 0);
  const percent = overview.leafCount ? Math.round((settled / overview.leafCount) * 100) : 0;
  return <>
    <Section title="Task" defaultOpen>
      {overview.task ? <MessageText text={overview.task} /> : <EmptyNote>No task recorded yet.</EmptyNote>}
    </Section>

    <Section title="Progress" count={overview.leafCount ? `${settled}/${overview.leafCount}` : ''}>
      <div className="status-progress status-progress-active"><i style={{ width: `${percent}%` }} /></div>
      <div className="node-chip-row">
        {counts.length
          ? counts.map(([status, value]) => <span key={status} className={`node-chip node-chip-${status}`}>{STATUS_LABELS[status as NodeStatus] || status} {value}</span>)
          : <EmptyNote>No plan leaves yet.</EmptyNote>}
      </div>
      <Field label="Connection">{connectionLabel}</Field>
      {overview.roundsRun !== null && <Field label="Composer episodes">{overview.roundsRun}{overview.maxRounds ? ` / ${overview.maxRounds}` : ''}</Field>}
      {overview.maxEvalRounds !== null && <Field label="Rounds per subtask">up to {overview.maxEvalRounds}</Field>}
      {overview.costUsd !== null && <Field label="Cost so far">{formatCost(overview.costUsd)}</Field>}
      {overview.researchModel && <Field label="Research model"><code>{overview.researchModel}</code></Field>}
      {loop.plan && <Field label="Plan revision">r{overview.revision}{loop.plan_revisions.length > 1 ? ` · ${loop.plan_revisions.length} recorded` : ''}</Field>}
    </Section>

    {(overview.title || overview.summary) && <Section title="Plan summary">
      {overview.title && <strong className="node-panel-plan-title">{overview.title}</strong>}
      {overview.summary ? <MessageText text={overview.summary} /> : <EmptyNote>The planner wrote no summary.</EmptyNote>}
    </Section>}

    {overview.assumptions.length > 0 && <Section title="Assumptions" count={overview.assumptions.length} defaultOpen={false}>
      <ul className="node-list">{overview.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </Section>}

    {overview.questions.length > 0 && <Section title="Open questions" count={overview.questions.length}>
      <ul className="node-list">{overview.questions.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </Section>}

    {overview.decisions.trim() && <Section title="Operator decisions" defaultOpen={false} hint="state/task/DECISIONS.md">
      <MessageText text={overview.decisions} />
    </Section>}

    {overview.finalResponse && <Section title="Final response">
      <MessageText text={overview.finalResponse} />
    </Section>}

    {snapshot.run.failure_reason && <Section title="Failure reason">
      <p className="panel-error">{snapshot.run.failure_reason}</p>
    </Section>}
  </>;
}

// ---------------------------------------------------------------------------
// One node
// ---------------------------------------------------------------------------

function NodeDetails({
  runId,
  loop,
  node,
  subtask,
  onSelect,
  onOpenTrajectory,
}: {
  runId: string;
  loop: LoopSnapshot;
  node: PlanNode;
  subtask: SubtaskView | null;
  onSelect: (id: string) => void;
  onOpenTrajectory: (role: string, seq: number) => void;
}) {
  const leaf = isLeaf(node);
  const chain = ancestors(loop.plan, node.id);
  const status = STATUS_LABELS[node.status as NodeStatus] || node.status;
  return <>
    <div className="node-summary">
      <span className={`node-status-pill node-chip-${node.status}`}>{status}</span>
      <CopyPath value={node.id} />
      {chain.length > 0 && <nav className="node-breadcrumb" aria-label="Plan path">
        {chain.map((item) => <button type="button" key={item.id} onClick={() => onSelect(item.id)}>{item.title || item.id}</button>)}
      </nav>}
      {node.note && <p className="node-note"><AlertTriangle size={12} /> {node.note}</p>}
      <small className="node-added-by">Added by {node.added_by || 'planner'}{leaf ? '' : ` · ${node.children.length} children`}</small>
    </div>

    <Section title="Why this node">
      {node.goal ? <Field label="Goal"><MessageText text={node.goal} /></Field> : <EmptyNote>No goal recorded.</EmptyNote>}
      {node.rationale && <Field label="Rationale"><MessageText text={node.rationale} /></Field>}
      <Field label="Backing">
        {node.backing.length
          ? <ul className="node-backing">{node.backing.map((item, index) => <li key={index} className={`backing-${item.kind}`}>
            <span className="backing-kind">{item.kind}</span>
            {item.kind === 'web' && normalizeLink(item.ref)
              ? <a href={normalizeLink(item.ref) as string} target="_blank" rel="noreferrer">{compactText(item.ref, 120)} <ExternalLink size={11} /></a>
              : item.kind === 'reasoning'
                ? <span className="backing-text">{item.ref}</span>
                : <code className="backing-ref">{item.ref}</code>}
            {item.note && <small>{item.note}</small>}
          </li>)}</ul>
          : <EmptyNote>The planner cited nothing for this node.</EmptyNote>}
      </Field>
    </Section>

    <Section title="Deliverables, acceptance, constraints" count={node.deliverables.length + node.acceptance.length + node.constraints.length}>
      <Field label="Deliverables">{node.deliverables.length ? <ul className="node-list">{node.deliverables.map((item, index) => <li key={index}>{item}</li>)}</ul> : <EmptyNote>None listed.</EmptyNote>}</Field>
      <Field label="Acceptance">{node.acceptance.length ? <ul className="node-list">{node.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul> : <EmptyNote>None listed.</EmptyNote>}</Field>
      <Field label="Constraints">{node.constraints.length ? <ul className="node-list">{node.constraints.map((item, index) => <li key={index}>{item}</li>)}</ul> : <EmptyNote>None listed.</EmptyNote>}</Field>
      {node.depends_on.length > 0 && <Field label="Depends on">
        <div className="node-chip-row">{node.depends_on.map((id) => <button type="button" className="node-dep-chip" key={id} onClick={() => onSelect(id)}>{id} <ArrowUpRight size={11} /></button>)}</div>
      </Field>}
    </Section>

    {!leaf && <Section title="Children" count={node.children.length}>
      <ul className="node-list node-child-list">{node.children.map((child) => <li key={child.id}>
        <button type="button" onClick={() => onSelect(child.id)}><span className={`node-chip node-chip-${child.status}`} />{child.title || child.id}</button>
      </li>)}</ul>
    </Section>}

    {leaf && !subtask && <EmptyNote>This leaf has not been scheduled yet, so the loop has written no rubric, contract, evidence or evaluation for it.</EmptyNote>}

    {leaf && subtask && <>
      <ContractSection contract={subtask.contract} />
      <Section title="Rubric" defaultOpen={false} hint={`state/rubrics/${subtask.id}.md`}>
        {subtask.rubric
          ? <MessageText text={subtask.rubric} />
          : <StateFileText runId={runId} path={`rubrics/${subtask.id}.md`} empty="No rubric was written for this subtask." />}
      </Section>
      <ContextSection runId={runId} subtask={subtask} />
      <Section title="Progress note" hint={`state/progress/${subtask.id}.md`}>
        {subtask.progress ? <MessageText text={subtask.progress} /> : <EmptyNote>The composer left no progress note.</EmptyNote>}
      </Section>
      <EvidenceSection runId={runId} subtask={subtask} />
      <EvaluationsSection subtask={subtask} />
      <EpisodesSection episodes={subtask.episodes} onOpenTrajectory={onOpenTrajectory} />
    </>}
  </>;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function ContractSection({ contract }: { contract: Contract | null }) {
  if (!contract) {
    return <Section title="Contract"><EmptyNote>No contract yet. The rubric agent writes one before the composer starts.</EmptyNote></Section>;
  }
  const passing = contract.criteria.filter((item) => item.passes).length;
  return <Section title="Contract" count={`${passing}/${contract.criteria.length}`}>
    <div className="contract-table-wrap">
      <table className="contract-table">
        <thead><tr><th>Criterion</th><th>M</th><th>W</th><th>Verdict</th><th>Score</th></tr></thead>
        <tbody>
          {contract.criteria.map((item) => <tr key={item.id} className={item.passes ? 'contract-pass' : 'contract-fail'}>
            <td>
              <code>{item.id}</code>
              <span className="contract-statement">{item.statement}</span>
              {item.verify && <small className="contract-verify">verify: {item.verify}</small>}
              {item.evidence && <small className="contract-verify">evidence: {item.evidence}</small>}
              {item.finding && <small className="contract-finding">{item.finding}</small>}
            </td>
            <td>{item.mandatory ? <Check size={12} /> : ''}</td>
            <td>{item.weight}</td>
            <td className="contract-verdict">{item.passes ? 'PASS' : 'FAIL'}</td>
            <td>{item.score === null ? '—' : item.score}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <small className="panel-hint">{contract.scoring.scale} · {contract.scoring.pass_rule}</small>
  </Section>;
}

function ContextSection({ runId, subtask }: { runId: string; subtask: SubtaskView }) {
  const rounds = [...subtask.context].sort((left, right) => right.round - left.round);
  return <Section title="What the composer saw" count={rounds.length} defaultOpen={false}>
    {rounds.length
      ? rounds.map((pack) => <div className="context-round" key={pack.round}>
        <div className="context-round-head">
          <strong>Round {pack.round}</strong>
          <span>{pack.selector || 'selector'}</span>
          <StateFileLink runId={runId} path={`context/${subtask.id}-r${pack.round}.md`} label="open pack" />
        </div>
        {pack.sections.length
          ? <ul className="context-sections">{pack.sections.map((section, index) => <li key={index}>
            <span className={`context-kind context-kind-${section.kind || 'other'}`}>{section.kind || 'section'}</span>
            <span className="context-title">{section.title || section.path || 'untitled'}</span>
            {section.reason && <small>{section.reason}</small>}
            <span className="context-chars">{section.chars.toLocaleString()} chars</span>
          </li>)}</ul>
          : <EmptyNote>The pack recorded no sections.</EmptyNote>}
      </div>)
      : <EmptyNote>No context pack has been selected for this subtask yet.</EmptyNote>}
  </Section>;
}

/** Inline video is opt-in above this size: a proof capture can be very large. */
const AUTO_VIDEO_BYTES = 25 * 1024 * 1024;

function EvidenceVideo({ source, name, bytes }: { source: string; name: string; bytes: number }) {
  const [load, setLoad] = useState(bytes > 0 && bytes <= AUTO_VIDEO_BYTES);
  if (load) return <VideoFile source={source} name={name} />;
  return <button type="button" className="evidence-load" onClick={() => setLoad(true)}>
    <Play size={12} /> Load video{bytes ? ` (${formatBytesShort(bytes)})` : ''}
  </button>;
}

function EvidenceSection({ runId, subtask }: { runId: string; subtask: SubtaskView }) {
  const sizes = new Map((subtask.evidence_meta || []).map((item) => [item.name, item.bytes]));
  const files = subtask.evidence_files;
  const images = files.filter((name) => isImageFile(name)).map((name) => stateFileUrl(runId, `evidence/${subtask.id}/${name}`, { raw: true }));
  const videos = files.filter((name) => isVideoFile(name));
  const others = files.filter((name) => !isImageFile(name) && !isVideoFile(name));
  return <Section title="Evidence" count={files.length} hint={`state/evidence/${subtask.id}/`}>
    {files.length === 0 && <EmptyNote>The composer filed no proof files for this subtask.</EmptyNote>}
    {images.length > 0 && <ImageGallery images={images} label="evidence screenshot" />}
    {images.length > 0 && <ul className="evidence-sizes">{files.filter((name) => isImageFile(name)).map((name) => <li key={name}><code>{name}</code><span>{sizes.has(name) ? formatBytesShort(sizes.get(name) as number) : ''}</span></li>)}</ul>}
    {videos.map((name) => <div className="evidence-item" key={name}>
      <small>{name}{sizes.has(name) ? ` · ${formatBytesShort(sizes.get(name) as number)}` : ''}</small>
      <EvidenceVideo source={stateFileUrl(runId, `evidence/${subtask.id}/${name}`, { raw: true })} name={name} bytes={sizes.get(name) ?? 0} />
    </div>)}
    {others.length > 0 && <div className="evidence-files">
      {others.map((name) => <DownloadLink
        key={name}
        source={stateFileUrl(runId, `evidence/${subtask.id}/${name}`, { raw: true })}
        name={name}
        note={sizes.has(name) ? formatBytesShort(sizes.get(name) as number) : ''}
      />)}
    </div>}
    <LedgerList entries={subtask.ledger || []} total={subtask.ledger_count} />
  </Section>;
}

/**
 * The hook-written ledger: what the composer actually touched.
 *
 * The entries are appended by the write/bash hooks rather than claimed by the
 * agent, so this is the one part of the evidence section the composer cannot
 * author. `ledger_count` is the true total; `ledger` is the bounded tail.
 */
function LedgerList({ entries, total }: { entries: LedgerEntry[]; total: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!entries.length) {
    return total > 0
      ? <p className="panel-hint">{total} ledger entries recorded; none returned in this snapshot.</p>
      : null;
  }
  const writes = entries.filter((entry) => entry.kind === 'write');
  const commands = entries.filter((entry) => entry.kind === 'bash');
  const shown = expanded ? entries : entries.slice(-12);
  const hidden = entries.length - shown.length;
  return <div className="ledger">
    <div className="ledger-head">
      <strong>Files touched / commands run</strong>
      <small>{writes.length} write{writes.length === 1 ? '' : 's'} · {commands.length} command{commands.length === 1 ? '' : 's'}{total > entries.length ? ` · ${total} total` : ''}</small>
    </div>
    <ul className="ledger-list">
      {shown.map((entry, index) => <li key={`${entry.ts}-${index}`} className={`ledger-row ledger-${entry.kind}`}>
        <span className="ledger-mark" aria-hidden="true">{entry.kind === 'write' ? <FilePenLine size={11} /> : <Terminal size={11} />}</span>
        <span className="ledger-body">
          <code>{entry.kind === 'write' ? entry.path || entry.tool : entry.command || entry.tool}</code>
          <small>
            {entry.kind === 'write'
              ? `${entry.sha256_before ? 'modified' : 'created'}${typeof entry.bytes === 'number' ? ` · ${formatBytesShort(entry.bytes)}` : ''} · ${entry.tool}`
              : entry.tool}
          </small>
        </span>
        <time>{formatTime(entry.ts)}</time>
      </li>)}
    </ul>
    {hidden > 0 && <button type="button" className="ledger-toggle" onClick={() => setExpanded(true)}>Show {hidden} earlier entries</button>}
    {expanded && entries.length > 12 && <button type="button" className="ledger-toggle" onClick={() => setExpanded(false)}>Show fewer</button>}
  </div>;
}

function EvaluationsSection({ subtask }: { subtask: SubtaskView }) {
  const rounds = [...subtask.evaluations].sort((left, right) => right.round - left.round);
  return <Section title="Evaluations" count={rounds.length}>
    {rounds.length
      ? rounds.map((record) => <EvaluationCard key={record.round} record={record} />)
      : <EmptyNote>The evaluator has not returned a verdict yet.</EmptyNote>}
  </Section>;
}

function EvaluationCard({ record }: { record: EvaluationRecord }) {
  const failed = record.criteria.filter((item) => !item.passes);
  return <article className={`evaluation-card evaluation-${record.verdict === 'PASS' ? 'pass' : 'needs-work'}`}>
    <header>
      <strong>Round {record.round}</strong>
      <span className="evaluation-verdict">{record.verdict}</span>
      {record.claimed_verdict !== record.verdict && <small>evaluator said {record.claimed_verdict}</small>}
      <time>{formatTime(record.created_at)}</time>
    </header>
    {record.harness_note && <p className="evaluation-harness-note"><AlertTriangle size={12} /> {record.harness_note}</p>}
    {record.summary && <MessageText text={record.summary} />}
    <ul className="evaluation-criteria">
      {record.criteria.map((item) => <li key={item.id} className={item.passes ? 'criterion-pass' : 'criterion-fail'}>
        <span className="criterion-mark">{item.passes ? <Check size={11} /> : <X size={11} />}</span>
        <code>{item.id}</code>
        {item.score !== null && <span className="criterion-score">{item.score}/5</span>}
        {item.finding && <small>{item.finding}</small>}
        {item.checked.length > 0 && <ul className="criterion-checked">{item.checked.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}
      </li>)}
    </ul>
    {failed.length > 0 && <small className="panel-hint">{failed.length} criteria still failing</small>}
    {record.findings.length > 0 && <div className="evaluation-findings">
      <strong>Findings for the composer</strong>
      <ul className="node-list">{record.findings.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>}
    {record.plan_changes.length > 0 && <details className="evaluation-plan-changes">
      <summary>{record.plan_changes.length} plan change{record.plan_changes.length === 1 ? '' : 's'} requested</summary>
      <pre>{JSON.stringify(record.plan_changes, null, 2)}</pre>
    </details>}
    {record.memory_notes.length > 0 && <div className="evaluation-findings">
      <strong>Memory notes</strong>
      <ul className="node-list">{record.memory_notes.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>}
    {record.narrative && <details className="evaluation-narrative">
      <summary>Evaluator narrative</summary>
      <MessageText text={record.narrative} />
    </details>}
  </article>;
}

function EpisodesSection({ episodes, onOpenTrajectory }: { episodes: EpisodeIndexEntry[]; onOpenTrajectory: (role: string, seq: number) => void }) {
  const ordered = [...episodes].sort((left, right) => right.seq - left.seq);
  return <Section title="Episodes" count={ordered.length} defaultOpen={false}>
    {ordered.length
      ? <ul className="episode-list">{ordered.map((entry) => {
        const ref = episodeRef(entry);
        return <li key={`${entry.seq}-${entry.role}`} className={`episode-row episode-${entry.status}`}>
          <div className="episode-main">
            <strong>{roleTitle(entry.role)}</strong>
            <span className="episode-meta">
              ep{ref?.seq ?? entry.seq}
              {entry.round ? ` · r${entry.round}` : ''}
              {` · ${entry.status}`}
              {formatDuration(entry.duration_ms) ? ` · ${formatDuration(entry.duration_ms)}` : ''}
              {formatCost(entry.cost_usd) ? ` · ${formatCost(entry.cost_usd)}` : ''}
            </span>
            {entry.error && <small className="panel-error">{compactText(entry.error, 200)}</small>}
          </div>
          {ref && <button type="button" className="episode-open" onClick={() => onOpenTrajectory(ref.role, ref.seq)}>
            <BookOpen size={12} /> trajectory
          </button>}
        </li>;
      })}</ul>
      : <EmptyNote>No agent episode has run for this subtask.</EmptyNote>}
  </Section>;
}

// ---------------------------------------------------------------------------
// State-file helpers
// ---------------------------------------------------------------------------

/** Fetch one file under the run's `state/` folder and render it as markdown. */
export function StateFileText({ runId, path, empty }: { runId: string; path: string; empty: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!runId) { setText(''); return undefined; }
    let cancelled = false;
    setText(null);
    setError('');
    void fetchStateFile(runId, path)
      .then((value) => { if (!cancelled) setText(value); })
      .catch((reason) => { if (!cancelled) setError(compactText(String(reason), 200)); });
    return () => { cancelled = true; };
  }, [runId, path]);
  if (error) return <EmptyNote>{empty} <small className="panel-error">({error})</small></EmptyNote>;
  if (text === null) return <EmptyNote>Loading {path}…</EmptyNote>;
  return text.trim() ? <MessageText text={text} /> : <EmptyNote>{empty}</EmptyNote>;
}

/** A link that opens one state file in a new tab. */
export function StateFileLink({ runId, path, label }: { runId: string; path: string; label: string }) {
  if (!runId) return <span className="state-file-link state-file-link-disabled"><FileText size={11} /> {label}</span>;
  return <a className="state-file-link" href={stateFileUrl(runId, path)} target="_blank" rel="noreferrer" title={`state/${path}`}>
    <FileText size={11} /> {label}
  </a>;
}
