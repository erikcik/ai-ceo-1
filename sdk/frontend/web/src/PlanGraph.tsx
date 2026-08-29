// The plan as an interactive node-link tree.
//
// The layout is computed in `core` (recursive width allocation, parents centred
// over their children) and drawn here as hand-rolled SVG: no graph library, no
// runtime dependency. Pan is a drag, zoom is the wheel or the toolbar, and
// clicking a node selects it. "Outline" degrades the same tree to a nested
// list — for screen readers, and for plans too large to read as a picture.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Focus, List, Network, ZoomIn, ZoomOut } from 'lucide-react';
import {
  layoutPlan,
  leaves,
  type NodeStatus,
  type Plan,
  type PlanLayoutNode,
  type PlanNode,
} from '../../core/src';

export type PlanGraphMode = 'graph' | 'outline';

const STATUS_LABELS: Record<NodeStatus, string> = {
  pending: 'Pending',
  rubric: 'Writing rubric',
  composing: 'Composing',
  evaluating: 'Evaluating',
  done: 'Done',
  blocked: 'Blocked',
  skipped: 'Skipped',
};

const LEGEND: { status: NodeStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'composing', label: 'In progress' },
  { status: 'done', label: 'Done' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'skipped', label: 'Skipped' },
];

/** SVG text does not wrap, so titles are clipped to a measured character budget. */
function clip(value: string, max: number): string {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

function statusClassOf(status: string): string {
  return `plan-node-${String(status || 'pending').replaceAll('_', '-')}`;
}

/** `r2/3 · PASS` — the leaf badge; the denominator is the eval-round budget. */
function leafBadge(node: PlanNode, maxEvalRounds?: number | null): string {
  const parts: string[] = [];
  if (node.rounds > 0) parts.push(maxEvalRounds ? `r${node.rounds}/${maxEvalRounds}` : `r${node.rounds}`);
  if (node.last_verdict) parts.push(node.last_verdict === 'PASS' ? 'PASS' : 'NEEDS WORK');
  return parts.join(' · ');
}

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
const PADDING = 36;

export interface PlanGraphProps {
  plan: Plan | null;
  selectedId: string | null;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  mode: PlanGraphMode;
  onModeChange: (mode: PlanGraphMode) => void;
  /** `config.max_eval_rounds`: the denominator of a leaf's round badge. */
  maxEvalRounds?: number | null;
  /** Rendered above the graph: the human gate and the final response. */
  attention?: ReactNode;
  header?: ReactNode;
}

export default function PlanGraph({ plan, selectedId, activeId, onSelect, mode, onModeChange, maxEvalRounds, attention, header }: PlanGraphProps) {
  const layout = useMemo(() => layoutPlan(plan), [plan]);
  // A callback ref (rather than a plain object ref read in a mount-only
  // effect) so the ResizeObserver re-attaches every time the canvas <div>
  // itself mounts — which happens well after the component's first mount,
  // since the canvas only renders once a plan with nodes exists. A
  // mount-only effect would capture a null node forever and the container
  // size would stay stuck at 0x0, leaving "Fit" with nothing to compute.
  const [canvasNode, setCanvasNode] = useState<HTMLDivElement | null>(null);
  const wrapRef = useCallback((node: HTMLDivElement | null) => setCanvasNode(node), []);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: PADDING });
  // The graph re-fits itself while the operator has not taken control of the
  // viewport; the first drag or wheel hands panning over to them for good.
  const [autoFit, setAutoFit] = useState(true);
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!canvasNode) {
      setSize({ width: 0, height: 0 });
      return undefined;
    }
    const measure = () => setSize({ width: canvasNode.clientWidth, height: canvasNode.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(canvasNode);
    return () => observer.disconnect();
  }, [canvasNode]);

  // Bounding box of every positioned node, straight from the layout — the
  // layout's own width/height already are that box (roots start flush left
  // at x=0, y=0; see layoutPlan).
  const bboxWidth = layout.width;
  const bboxHeight = layout.height;

  const fit = useCallback(() => {
    if (!size.width || !size.height || !layout.nodes.length || !bboxWidth || !bboxHeight) return;
    const margin = PADDING * 2;
    const scale = Math.min(
      Math.max(MIN_SCALE, Math.min((size.width - margin) / bboxWidth, (size.height - margin) / bboxHeight)),
      1,
    );
    setView({
      scale,
      x: (size.width - bboxWidth * scale) / 2,
      y: Math.max(PADDING, (size.height - bboxHeight * scale) / 2),
    });
  }, [layout.nodes.length, bboxWidth, bboxHeight, size.width, size.height]);

  useEffect(() => {
    if (autoFit) fit();
  }, [autoFit, fit]);

  // Auto-fit once when a plan first appears, and again whenever the leaf
  // count changes (a new run with a different-shaped tree) — but only while
  // the operator hasn't taken manual control of pan/zoom in the meantime.
  const leafCount = useMemo(() => leaves(plan).length, [plan]);
  const lastLeafCount = useRef<number | null>(null);
  useEffect(() => {
    if (lastLeafCount.current !== leafCount) {
      lastLeafCount.current = leafCount;
      setAutoFit(true);
    }
  }, [leafCount]);

  const takeControl = () => {
    if (autoFit) setAutoFit(false);
  };

  const zoomBy = (factor: number, originX?: number, originY?: number) => {
    takeControl();
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      if (scale === current.scale) return current;
      const cx = originX ?? size.width / 2;
      const cy = originY ?? size.height / 2;
      // Keep the point under the cursor stationary while the scale changes.
      return {
        scale,
        x: cx - ((cx - current.x) / current.scale) * scale,
        y: cy - ((cy - current.y) / current.scale) * scale,
      };
    });
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!layout.nodes.length) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomBy(Math.exp(-event.deltaY / 400), event.clientX - rect.left, event.clientY - rect.top);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    state.moved = true;
    state.x = event.clientX;
    state.y = event.clientY;
    takeControl();
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // A click that ended a pan must not also clear the selection.
    if (!state.moved && event.target === event.currentTarget) onSelect(null);
  };

  const toolbar = <div className="plan-toolbar">
    <div className="plan-toolbar-modes" role="group" aria-label="Plan view">
      <button type="button" className={mode === 'graph' ? 'active' : ''} onClick={() => onModeChange('graph')} title="Graph"><Network size={13} /><span>Graph</span></button>
      <button type="button" className={mode === 'outline' ? 'active' : ''} onClick={() => onModeChange('outline')} title="Outline"><List size={13} /><span>Outline</span></button>
    </div>
    {mode === 'graph' && <div className="plan-toolbar-zoom">
      <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out"><ZoomOut size={14} /></button>
      <span className="plan-zoom-value">{Math.round(view.scale * 100)}%</span>
      <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in"><ZoomIn size={14} /></button>
      <button type="button" onClick={() => { setAutoFit(true); fit(); }} title="Fit the whole plan"><Focus size={13} /><span>Fit</span></button>
    </div>}
    <div className="plan-legend">{LEGEND.map((item) => <span key={item.status} className={`plan-legend-item ${statusClassOf(item.status)}`}><i /> {item.label}</span>)}</div>
  </div>;

  return <div className="plan-pane">
    {header}
    {attention}
    {toolbar}
    {!plan || !layout.nodes.length
      ? <div className="plan-empty">
        <strong>No plan yet</strong>
        <p>The planner writes the plan tree after intake and tailoring. It will appear here as soon as <code>state/plan/plan.json</code> exists.</p>
      </div>
      : mode === 'outline'
        ? <PlanOutline plan={plan} selectedId={selectedId} activeId={activeId} onSelect={onSelect} maxEvalRounds={maxEvalRounds} />
        : <div
          className="plan-canvas"
          ref={wrapRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <svg className="plan-svg" width="100%" height="100%" role="presentation">
            <defs>
              <pattern id="lh-skip-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--faint)" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-strong)" strokeWidth="1.5" />
              </pattern>
              <marker id="lh-dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--mute-soft)" />
              </marker>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
              {layout.edges.map((edge) => {
                if (edge.kind === 'dependency') {
                  const midY = (edge.y1 + edge.y2) / 2;
                  return <path
                    key={edge.id}
                    className="plan-edge plan-edge-dependency"
                    markerEnd="url(#lh-dep-arrow)"
                    d={`M${edge.x1},${edge.y1} C${edge.x1},${midY} ${edge.x2},${midY} ${edge.x2},${edge.y2}`}
                  />;
                }
                const midY = (edge.y1 + edge.y2) / 2;
                return <path
                  key={edge.id}
                  className="plan-edge plan-edge-tree"
                  d={`M${edge.x1},${edge.y1} C${edge.x1},${midY} ${edge.x2},${midY} ${edge.x2},${edge.y2}`}
                />;
              })}
              {layout.nodes.map((entry) => <GraphNode
                key={entry.id}
                entry={entry}
                selected={entry.id === selectedId}
                active={entry.id === activeId}
                onSelect={onSelect}
                maxEvalRounds={maxEvalRounds}
              />)}
            </g>
          </svg>
        </div>}
  </div>;
}

function GraphNode({ entry, selected, active, onSelect, maxEvalRounds }: { entry: PlanLayoutNode; selected: boolean; active: boolean; onSelect: (id: string) => void; maxEvalRounds?: number | null }) {
  const node = entry.node;
  const badge = entry.leaf ? leafBadge(node, maxEvalRounds) : `${node.children.length} steps`;
  const statusText = STATUS_LABELS[node.status as NodeStatus] || node.status;
  return <g
    className={`plan-node ${statusClassOf(node.status)} ${selected ? 'plan-node-selected' : ''} ${active ? 'plan-node-active' : ''} ${entry.leaf ? 'plan-node-leaf' : 'plan-node-branch'}`}
    transform={`translate(${entry.x},${entry.y})`}
    role="button"
    tabIndex={0}
    aria-pressed={selected}
    aria-label={`${node.title} — ${statusText}`}
    onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect(node.id);
    }}
  >
    <rect className="plan-node-box" width={entry.width} height={entry.height} rx="9" ry="9" />
    <rect className="plan-node-bar" width="4" height={entry.height} rx="2" ry="2" />
    <text className="plan-node-title" x="14" y="24">{clip(node.title || node.id, 26)}</text>
    <text className="plan-node-meta" x="14" y="42">{clip(node.id, 22)}</text>
    {badge && <text className="plan-node-badge" x={entry.width - 12} y="42" textAnchor="end">{badge}</text>}
    {node.depends_on.length > 0 && <text className="plan-node-badge" x={entry.width - 12} y="24" textAnchor="end">↳{node.depends_on.length}</text>}
  </g>;
}

function PlanOutline({ plan, selectedId, activeId, onSelect, maxEvalRounds }: { plan: Plan; selectedId: string | null; activeId: string | null; onSelect: (id: string) => void; maxEvalRounds?: number | null }) {
  const renderNodes = (nodes: PlanNode[], depth: number) => <ul className="plan-outline-list" style={{ paddingLeft: depth ? 18 : 0 }}>
    {nodes.map((node) => <li key={node.id}>
      <button
        type="button"
        className={`plan-outline-row ${statusClassOf(node.status)} ${node.id === selectedId ? 'selected' : ''} ${node.id === activeId ? 'active' : ''}`}
        onClick={() => onSelect(node.id)}
        aria-pressed={node.id === selectedId}
      >
        <span className="plan-outline-mark" aria-hidden="true" />
        <span className="plan-outline-copy">
          <strong>{node.title || node.id}</strong>
          <small><code>{node.id}</code> · {STATUS_LABELS[node.status as NodeStatus] || node.status}{leafBadge(node, maxEvalRounds) ? ` · ${leafBadge(node, maxEvalRounds)}` : ''}</small>
        </span>
      </button>
      {node.children.length > 0 && renderNodes(node.children, depth + 1)}
    </li>)}
  </ul>;
  return <div className="plan-outline" aria-label="Plan outline">{renderNodes(plan.nodes, 0)}</div>;
}
