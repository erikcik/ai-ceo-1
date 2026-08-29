import type { NodeStatus, Plan, PlanNode } from './types';
import { ACTIVE_NODE_STATUSES, NODE_STATUSES } from './types';

/** Every node of the tree in document (depth-first) order. */
export function allNodes(plan: Plan | null | undefined): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    out.push(node);
    (node.children || []).forEach(walk);
  };
  (plan?.nodes || []).forEach(walk);
  return out;
}

/** Leaves in document order — the planner's intended sequence. */
export function leaves(plan: Plan | null | undefined): PlanNode[] {
  return allNodes(plan).filter((node) => !node.children || node.children.length === 0);
}

export function nodeById(plan: Plan | null | undefined, id: string | null): PlanNode | null {
  if (!id) return null;
  return allNodes(plan).find((node) => node.id === id) ?? null;
}

export function parentOf(plan: Plan | null | undefined, id: string): PlanNode | null {
  for (const node of allNodes(plan)) {
    if ((node.children || []).some((child) => child.id === id)) return node;
  }
  return null;
}

/** Ancestor chain from the root down to (excluding) the node. */
export function ancestors(plan: Plan | null | undefined, id: string): PlanNode[] {
  const chain: PlanNode[] = [];
  const seen = new Set<string>([id]);
  let current = parentOf(plan, id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = parentOf(plan, current.id);
  }
  return chain;
}

/** Human-readable breadcrumb: `Root > Branch > Leaf`. */
export function nodePath(plan: Plan | null | undefined, id: string): string[] {
  const node = nodeById(plan, id);
  if (!node) return [];
  return [...ancestors(plan, id).map((item) => item.title), node.title];
}

export function isLeaf(node: PlanNode): boolean {
  return !node.children || node.children.length === 0;
}

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_NODE_STATUSES as readonly string[]).includes(status);
}

/** Leaf status counts, in the order the graph legend renders them. */
export function countStatuses(plan: Plan | null | undefined): Record<NodeStatus, number> {
  const counts = Object.fromEntries(NODE_STATUSES.map((status) => [status, 0])) as Record<NodeStatus, number>;
  for (const leaf of leaves(plan)) {
    const status = (NODE_STATUSES as readonly string[]).includes(leaf.status) ? leaf.status : 'pending';
    counts[status as NodeStatus] += 1;
  }
  return counts;
}

/** Leaves the loop still has to settle (everything but done/skipped). */
export function openLeafCount(plan: Plan | null | undefined): number {
  return leaves(plan).filter((leaf) => leaf.status !== 'done' && leaf.status !== 'skipped').length;
}

// ---------------------------------------------------------------------------
// Layout
//
// A top-down layered tree computed by recursive width allocation: a leaf takes
// a fixed width, a parent takes the width of its children and is centred over
// them. Roots are laid out side by side. No external library is involved, and
// the result is a plain data structure so it can be unit tested.
// ---------------------------------------------------------------------------

export interface PlanLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  columnGap?: number;
  rowGap?: number;
}

export interface PlanLayoutNode {
  id: string;
  node: PlanNode;
  depth: number;
  /** Top-left corner of the node box. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Horizontal centre, used for edge anchoring. */
  cx: number;
  parentId: string | null;
  leaf: boolean;
}

export interface PlanLayoutEdge {
  id: string;
  kind: 'tree' | 'dependency';
  from: string;
  to: string;
  /** Anchor points, already resolved from the node boxes. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PlanLayout {
  nodes: PlanLayoutNode[];
  edges: PlanLayoutEdge[];
  width: number;
  height: number;
  byId: Record<string, PlanLayoutNode>;
  options: Required<PlanLayoutOptions>;
}

export const DEFAULT_PLAN_LAYOUT: Required<PlanLayoutOptions> = {
  nodeWidth: 188,
  nodeHeight: 62,
  columnGap: 22,
  rowGap: 76,
};

/** Lay the plan tree out for the SVG graph. */
export function layoutPlan(plan: Plan | null | undefined, options: PlanLayoutOptions = {}): PlanLayout {
  const settings = { ...DEFAULT_PLAN_LAYOUT, ...options };
  const { nodeWidth, nodeHeight, columnGap, rowGap } = settings;
  const nodes: PlanLayoutNode[] = [];
  const edges: PlanLayoutEdge[] = [];
  const byId: Record<string, PlanLayoutNode> = {};

  const spanOf = (node: PlanNode): number => {
    const children = node.children || [];
    if (!children.length) return nodeWidth;
    const total = children.reduce((sum, child) => sum + spanOf(child), 0) + columnGap * (children.length - 1);
    return Math.max(nodeWidth, total);
  };

  const place = (node: PlanNode, left: number, depth: number, parentId: string | null): void => {
    const span = spanOf(node);
    const centre = left + span / 2;
    const entry: PlanLayoutNode = {
      id: node.id,
      node,
      depth,
      x: centre - nodeWidth / 2,
      y: depth * (nodeHeight + rowGap),
      width: nodeWidth,
      height: nodeHeight,
      cx: centre,
      parentId,
      leaf: isLeaf(node),
    };
    nodes.push(entry);
    byId[node.id] = entry;
    const children = node.children || [];
    if (!children.length) return;
    const childrenSpan = children.reduce((sum, child) => sum + spanOf(child), 0) + columnGap * (children.length - 1);
    let cursor = centre - childrenSpan / 2;
    for (const child of children) {
      place(child, cursor, depth + 1, node.id);
      cursor += spanOf(child) + columnGap;
    }
  };

  let offset = 0;
  for (const root of plan?.nodes || []) {
    place(root, offset, 0, null);
    offset += spanOf(root) + columnGap;
  }

  for (const entry of nodes) {
    if (entry.parentId && byId[entry.parentId]) {
      const parent = byId[entry.parentId];
      edges.push({
        id: `tree:${parent.id}->${entry.id}`,
        kind: 'tree',
        from: parent.id,
        to: entry.id,
        x1: parent.cx,
        y1: parent.y + parent.height,
        x2: entry.cx,
        y2: entry.y,
      });
    }
    for (const dependency of entry.node.depends_on || []) {
      const source = byId[dependency];
      if (!source || source.id === entry.id) continue;
      edges.push({
        id: `dep:${source.id}->${entry.id}`,
        kind: 'dependency',
        from: source.id,
        to: entry.id,
        x1: source.cx,
        y1: source.y + source.height / 2,
        x2: entry.cx,
        y2: entry.y + entry.height / 2,
      });
    }
  }

  const width = nodes.reduce((max, entry) => Math.max(max, entry.x + entry.width), 0);
  const height = nodes.reduce((max, entry) => Math.max(max, entry.y + entry.height), 0);
  return { nodes, edges, width, height, byId, options: settings };
}
