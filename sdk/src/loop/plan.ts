// The plan tree: the planner's output, the loop's schedule, and the operator's
// graph. Everything the loop needs to decide "what next" is derived from this
// structure; nothing lives in a transcript.
//
// Records on disk keep snake_case keys (plan.json is read by the workbench
// and by agents).

export type BackingKind = "reasoning" | "web" | "source" | "memory";

export interface Backing {
  kind: BackingKind;
  ref: string;
  note: string;
}

export type NodeStatus =
  | "pending" // waiting for dependencies or its turn
  | "rubric" // rubric agent is writing the contract
  | "composing" // composer is working
  | "evaluating" // evaluator is checking
  | "done" // evaluator returned PASS
  | "blocked" // round budget exhausted without PASS, or an episode failed
  | "skipped"; // removed from scope by the evaluator/operator

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
  last_verdict: "PASS" | "NEEDS_WORK" | null;
  /** Who created the node: "planner" or "evaluator:<subtask>" / "operator". */
  added_by: string;
  /** Free-form status line the loop maintains (e.g. why it is blocked). */
  note: string;
}

export interface Plan {
  schema_version: 1;
  title: string;
  summary: string;
  assumptions: string[];
  questions: string[];
  nodes: PlanNode[];
  revision: number;
  created_at: number;
  updated_at: number;
}

export type PlanChangeOp = "add" | "remove" | "modify";

export interface PlanChange {
  op: PlanChangeOp;
  node_id?: string;
  parent_id?: string;
  node?: Partial<PlanNode> & Record<string, unknown>;
  reason?: string;
}

export interface PlanChangeResult {
  applied: { change: PlanChange; node_id: string }[];
  rejected: { change: PlanChange; reason: string }[];
}

const BACKING_KINDS = new Set<string>(["reasoning", "web", "source", "memory"]);
const NODE_STATUSES = new Set<string>(["pending", "rubric", "composing", "evaluating", "done", "blocked", "skipped"]);
export const MAX_PLAN_DEPTH = 4;
export const MAX_PLAN_NODES = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function strList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter((item) => item);
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "node";
}

function parseBacking(value: unknown): Backing[] {
  if (!Array.isArray(value)) return [];
  const out: Backing[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push({ kind: "reasoning", ref: item.trim(), note: "" });
      continue;
    }
    if (!isRecord(item)) continue;
    const kind = str(item.kind, "reasoning");
    out.push({
      kind: (BACKING_KINDS.has(kind) ? kind : "reasoning") as BackingKind,
      ref: str(item.ref) || str(item.url) || str(item.path) || str(item.page) || "",
      note: str(item.note),
    });
  }
  return out.filter((item) => item.ref || item.note);
}

/** Normalise one node from untrusted planner/evaluator JSON. */
export function parseNode(raw: unknown, options: { addedBy: string; usedIds: Set<string>; depth?: number }): PlanNode {
  const depth = options.depth ?? 1;
  const source = isRecord(raw) ? raw : {};
  const title = str(source.title) || str(source.name) || "Untitled step";
  let id = slugify(str(source.id) || title);
  if (options.usedIds.has(id)) {
    let suffix = 2;
    while (options.usedIds.has(`${id}-${suffix}`)) suffix += 1;
    id = `${id}-${suffix}`;
  }
  options.usedIds.add(id);
  const status = str(source.status);
  const rawChildren = Array.isArray(source.children) ? source.children : [];
  const children =
    depth < MAX_PLAN_DEPTH
      ? rawChildren.map((child) => parseNode(child, { ...options, depth: depth + 1 }))
      : [];
  const verdict = str(source.last_verdict);
  return {
    id,
    title,
    goal: str(source.goal) || str(source.description),
    rationale: str(source.rationale) || str(source.why),
    backing: parseBacking(source.backing),
    constraints: strList(source.constraints),
    deliverables: strList(source.deliverables),
    acceptance: strList(source.acceptance),
    depends_on: strList(source.depends_on).map(slugify),
    children,
    status: (NODE_STATUSES.has(status) ? status : "pending") as NodeStatus,
    rounds: Number.isInteger(source.rounds) ? Number(source.rounds) : 0,
    last_verdict: verdict === "PASS" || verdict === "NEEDS_WORK" ? verdict : null,
    added_by: str(source.added_by) || options.addedBy,
    note: str(source.note),
  };
}

/** Parse the planner's JSON block (or a stored plan.json) into a Plan. */
export function parsePlan(raw: unknown, options: { addedBy?: string; now?: number } = {}): Plan {
  if (!isRecord(raw)) throw new Error("plan must be a JSON object");
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : Array.isArray(raw.steps) ? raw.steps : null;
  if (!rawNodes || !rawNodes.length) throw new Error("plan has no nodes");
  const usedIds = new Set<string>();
  const nodes = rawNodes.map((node) => parseNode(node, { addedBy: options.addedBy ?? "planner", usedIds }));
  const now = options.now ?? Date.now() / 1000;
  const plan: Plan = {
    schema_version: 1,
    title: str(raw.title) || "Plan",
    summary: str(raw.summary),
    assumptions: strList(raw.assumptions),
    questions: strList(raw.questions),
    nodes,
    revision: Number.isInteger(raw.revision) ? Number(raw.revision) : 0,
    created_at: typeof raw.created_at === "number" ? raw.created_at : now,
    updated_at: typeof raw.updated_at === "number" ? raw.updated_at : now,
  };
  if (allNodes(plan).length > MAX_PLAN_NODES) throw new Error(`plan has more than ${MAX_PLAN_NODES} nodes`);
  if (!leaves(plan).length) throw new Error("plan has no leaf subtasks");
  return plan;
}

export function allNodes(plan: Plan): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  plan.nodes.forEach(walk);
  return out;
}

/** Leaves in depth-first (document) order — the planner's intended sequence. */
export function leaves(plan: Plan): PlanNode[] {
  return allNodes(plan).filter((node) => node.children.length === 0);
}

export function nodeById(plan: Plan, id: string): PlanNode | null {
  return allNodes(plan).find((node) => node.id === id) ?? null;
}

export function parentOf(plan: Plan, id: string): PlanNode | null {
  for (const node of allNodes(plan)) {
    if (node.children.some((child) => child.id === id)) return node;
  }
  return null;
}

/** Ancestor chain from the root down to (excluding) the node. */
export function ancestors(plan: Plan, id: string): PlanNode[] {
  const chain: PlanNode[] = [];
  let current = parentOf(plan, id);
  while (current) {
    chain.unshift(current);
    current = parentOf(plan, current.id);
  }
  return chain;
}

function settled(status: NodeStatus): boolean {
  return status === "done" || status === "skipped";
}

/**
 * The next leaf to work on: first in document order whose dependencies are all
 * settled and that is still pending. Blocked leaves are not retried
 * automatically; the operator can re-open them.
 */
export function nextReadyLeaf(plan: Plan): PlanNode | null {
  const ids = new Set(allNodes(plan).map((node) => node.id));
  for (const leaf of leaves(plan)) {
    if (leaf.status !== "pending") continue;
    const deps = leaf.depends_on.filter((dep) => ids.has(dep));
    const ready = deps.every((dep) => {
      const node = nodeById(plan, dep);
      if (!node) return true;
      // Depending on an internal node means depending on all its leaves.
      const targets = node.children.length ? leaves({ ...plan, nodes: [node] }) : [node];
      return targets.every((target) => settled(target.status));
    });
    if (ready) return leaf;
  }
  return null;
}

/** Leaves that are pending but can never become ready (blocked/cyclic deps). */
export function stuckLeaves(plan: Plan): PlanNode[] {
  if (nextReadyLeaf(plan)) return [];
  return leaves(plan).filter((leaf) => leaf.status === "pending");
}

/** Propagate leaf statuses upwards: an internal node is done when all leaves are settled. */
export function refreshInternalStatuses(plan: Plan): void {
  const walk = (node: PlanNode): NodeStatus => {
    if (!node.children.length) return node.status;
    const childStatuses = node.children.map(walk);
    if (childStatuses.every((status) => status === "skipped")) node.status = "skipped";
    else if (childStatuses.every(settled)) node.status = "done";
    else if (childStatuses.some((status) => status === "blocked")) node.status = "blocked";
    else if (childStatuses.some((status) => ["rubric", "composing", "evaluating"].includes(status))) {
      node.status = childStatuses.find((status) => ["rubric", "composing", "evaluating"].includes(status)) as NodeStatus;
    } else node.status = "pending";
    return node.status;
  };
  plan.nodes.forEach(walk);
}

export function setLeafStatus(plan: Plan, id: string, status: NodeStatus, note?: string): void {
  const node = nodeById(plan, id);
  if (!node) return;
  node.status = status;
  if (note !== undefined) node.note = note;
  refreshInternalStatuses(plan);
  plan.updated_at = Date.now() / 1000;
}

export function countStatuses(plan: Plan): Record<NodeStatus, number> {
  const counts: Record<NodeStatus, number> = {
    pending: 0,
    rubric: 0,
    composing: 0,
    evaluating: 0,
    done: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const leaf of leaves(plan)) counts[leaf.status] += 1;
  return counts;
}

/**
 * Apply evaluator/operator plan changes. Conservative on purpose: a finished
 * leaf cannot be removed or rewritten, and every applied change bumps the
 * revision so the operator can see the plan evolve.
 */
export function applyPlanChanges(plan: Plan, changes: unknown, author: string): PlanChangeResult {
  const result: PlanChangeResult = { applied: [], rejected: [] };
  if (!Array.isArray(changes) || !changes.length) return result;
  const usedIds = new Set(allNodes(plan).map((node) => node.id));
  for (const raw of changes) {
    if (!isRecord(raw)) continue;
    const change: PlanChange = {
      op: str(raw.op) as PlanChangeOp,
      node_id: str(raw.node_id) ? slugify(str(raw.node_id)) : undefined,
      parent_id: str(raw.parent_id) ? slugify(str(raw.parent_id)) : undefined,
      node: isRecord(raw.node) ? (raw.node as PlanChange["node"]) : undefined,
      reason: str(raw.reason),
    };
    if (change.op === "add") {
      if (!change.node) {
        result.rejected.push({ change, reason: "add without a node" });
        continue;
      }
      const parent = change.parent_id ? nodeById(plan, change.parent_id) : null;
      if (change.parent_id && !parent) {
        result.rejected.push({ change, reason: `unknown parent ${change.parent_id}` });
        continue;
      }
      if (parent && parent.children.length === 0 && parent.status !== "pending") {
        result.rejected.push({ change, reason: `parent ${parent.id} is a leaf already in progress` });
        continue;
      }
      const depth = parent ? ancestors(plan, parent.id).length + 2 : 1;
      if (depth > MAX_PLAN_DEPTH) {
        result.rejected.push({ change, reason: "plan would exceed the maximum depth" });
        continue;
      }
      const node = parseNode(change.node, { addedBy: author, usedIds, depth });
      node.status = "pending";
      (parent ? parent.children : plan.nodes).push(node);
      result.applied.push({ change, node_id: node.id });
      continue;
    }
    if (change.op === "remove") {
      const target = change.node_id ? nodeById(plan, change.node_id) : null;
      if (!target) {
        result.rejected.push({ change, reason: `unknown node ${change.node_id ?? ""}` });
        continue;
      }
      const targetLeaves = target.children.length ? leaves({ ...plan, nodes: [target] }) : [target];
      if (targetLeaves.some((leaf) => leaf.status === "done" || leaf.status === "composing" || leaf.status === "evaluating")) {
        result.rejected.push({ change, reason: `${target.id} has finished or in-progress work` });
        continue;
      }
      for (const leaf of targetLeaves) {
        leaf.status = "skipped";
        leaf.note = change.reason ? `removed by ${author}: ${change.reason}` : `removed by ${author}`;
      }
      result.applied.push({ change, node_id: target.id });
      continue;
    }
    if (change.op === "modify") {
      const target = change.node_id ? nodeById(plan, change.node_id) : null;
      if (!target || !change.node) {
        result.rejected.push({ change, reason: `unknown node ${change.node_id ?? ""}` });
        continue;
      }
      if (target.status === "done") {
        result.rejected.push({ change, reason: `${target.id} is already done` });
        continue;
      }
      const patch = change.node;
      if (str(patch.title)) target.title = str(patch.title);
      if (str(patch.goal)) target.goal = str(patch.goal);
      if (str(patch.rationale)) target.rationale = str(patch.rationale);
      if (Array.isArray(patch.backing)) target.backing = parseBacking(patch.backing);
      if (Array.isArray(patch.constraints)) target.constraints = strList(patch.constraints);
      if (Array.isArray(patch.deliverables)) target.deliverables = strList(patch.deliverables);
      if (Array.isArray(patch.acceptance)) target.acceptance = strList(patch.acceptance);
      if (Array.isArray(patch.depends_on)) target.depends_on = strList(patch.depends_on).map(slugify);
      target.note = change.reason ? `modified by ${author}: ${change.reason}` : target.note;
      if (target.status === "blocked") target.status = "pending";
      result.applied.push({ change, node_id: target.id });
      continue;
    }
    result.rejected.push({ change, reason: `unknown op ${String(raw.op)}` });
  }
  if (result.applied.length) {
    plan.revision += 1;
    plan.updated_at = Date.now() / 1000;
    refreshInternalStatuses(plan);
  }
  return result;
}

const STATUS_MARK: Record<NodeStatus, string> = {
  pending: "[ ]",
  rubric: "[~]",
  composing: "[~]",
  evaluating: "[?]",
  done: "[x]",
  blocked: "[!]",
  skipped: "[-]",
};

/** Human-readable outline of the plan, used for PLAN.md and inside prompts. */
export function renderPlanMarkdown(plan: Plan, options: { withStatus?: boolean; highlight?: string | null } = {}): string {
  const lines: string[] = [`# ${plan.title}`, ""];
  if (plan.summary) lines.push(plan.summary, "");
  if (plan.assumptions.length) {
    lines.push("Assumptions:");
    for (const item of plan.assumptions) lines.push(`- ${item}`);
    lines.push("");
  }
  if (plan.questions.length) {
    lines.push("Open questions for the operator:");
    for (const item of plan.questions) lines.push(`- ${item}`);
    lines.push("");
  }
  const walk = (node: PlanNode, depth: number) => {
    const indent = "  ".repeat(depth);
    const mark = options.withStatus ? `${STATUS_MARK[node.status]} ` : "";
    const here = options.highlight === node.id ? "  <-- this subtask" : "";
    lines.push(`${indent}- ${mark}**${node.title}** (\`${node.id}\`)${here}`);
    if (node.goal) lines.push(`${indent}  goal: ${node.goal}`);
    if (node.rationale) lines.push(`${indent}  why: ${node.rationale}`);
    for (const backing of node.backing) {
      lines.push(`${indent}  backed by ${backing.kind}: ${backing.ref}${backing.note ? ` — ${backing.note}` : ""}`);
    }
    if (node.deliverables.length) lines.push(`${indent}  deliverables: ${node.deliverables.join(", ")}`);
    if (node.acceptance.length) lines.push(`${indent}  acceptance: ${node.acceptance.join(" | ")}`);
    if (node.constraints.length) lines.push(`${indent}  constraints: ${node.constraints.join(" | ")}`);
    if (node.depends_on.length) lines.push(`${indent}  depends on: ${node.depends_on.join(", ")}`);
    if (options.withStatus && node.note) lines.push(`${indent}  note: ${node.note}`);
    node.children.forEach((child) => walk(child, depth + 1));
  };
  plan.nodes.forEach((node) => walk(node, 0));
  return lines.join("\n") + "\n";
}

/** A compact one-node description for the rubric/composer/evaluator prompts. */
export function renderNodeBrief(plan: Plan, id: string): string {
  const node = nodeById(plan, id);
  if (!node) return "";
  const chain = ancestors(plan, id);
  const lines: string[] = [];
  if (chain.length) lines.push(`Path: ${chain.map((item) => item.title).join(" > ")} > ${node.title}`);
  lines.push(`Subtask id: ${node.id}`, `Title: ${node.title}`, `Goal: ${node.goal}`);
  if (node.rationale) lines.push(`Rationale: ${node.rationale}`);
  for (const backing of node.backing) {
    lines.push(`Backed by ${backing.kind}: ${backing.ref}${backing.note ? ` — ${backing.note}` : ""}`);
  }
  if (node.constraints.length) lines.push(`Constraints:`, ...node.constraints.map((item) => `- ${item}`));
  if (node.deliverables.length) lines.push(`Deliverables:`, ...node.deliverables.map((item) => `- ${item}`));
  if (node.acceptance.length) lines.push(`Acceptance:`, ...node.acceptance.map((item) => `- ${item}`));
  if (node.depends_on.length) lines.push(`Depends on: ${node.depends_on.join(", ")}`);
  return lines.join("\n");
}
