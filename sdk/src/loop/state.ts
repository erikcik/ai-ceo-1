// The run's state tree: every file the loop writes for agents and for the
// operator, plus the bounded readers the workbench uses to project it. The
// loop keeps no state in memory that is not also here, so a resume can rebuild
// everything from disk.
//
//   <runDir>/state/
//     phase.json            what the loop is doing right now
//     task/TASK.md          operator task verbatim (+ attachments list)
//     prompts/<role>.md     tailored briefings
//     plan/plan.json|PLAN.md, plan/revisions/rNNN.json
//     research/*.md         planner research notes
//     rubrics/<id>.md, contracts/<id>.json
//     context/<id>-rN.json|md
//     progress/<id>.md      composer progress notes
//     evidence/<id>/ledger.jsonl + proof files
//     evaluations/<id>/rN.json|md
//     episodes.jsonl        one line per agent episode (role, subtask, dir, status, cost)
//   <logDir>/role_orchestration/events.jsonl|approvals.jsonl|report.json (supervisor contract)
//   <logDir>/report.json

import fs from "node:fs";
import path from "node:path";

import { ensureDirNofollow } from "../supervisor/control_bus.js";
import { appendEvent, jsonDumpsIndent2, jsonSafe, readLocalBounded, writeLocal } from "./episodes.js";
import { type Plan, parsePlan, renderPlanMarkdown, leaves, countStatuses } from "./plan.js";

export const STATE_DIR_NAME = "state";
export const ORCHESTRATION_DIR_NAME = "role_orchestration";

export type LoopPhase = "intake" | "tailoring" | "planning" | "executing" | "finalizing" | "finished";

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
  verdict: "PASS" | "NEEDS_WORK";
  /** What the evaluator said before the harness applied the contract's pass rule. */
  claimed_verdict: "PASS" | "NEEDS_WORK" | "invalid";
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
  /** Per-role episode number: the NNN of `<role>_episodes/epNNN` (trajectory URL key). */
  ep: number;
  role: string;
  subtask_id: string | null;
  round: number | null;
  dir: string;
  status: "running" | "done" | "error" | "timeout" | "cancelled";
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : fallback;
}

export class RunState {
  readonly runDir: string;
  readonly logDir: string;
  readonly stateDir: string;
  readonly orchestrationDir: string;
  readonly eventsPath: string;

  constructor(options: { runDir: string; logDir: string }) {
    this.runDir = options.runDir;
    this.logDir = options.logDir;
    this.stateDir = path.join(options.runDir, STATE_DIR_NAME);
    this.orchestrationDir = path.join(options.logDir, ORCHESTRATION_DIR_NAME);
    this.eventsPath = path.join(this.orchestrationDir, "events.jsonl");
  }

  // --- layout ------------------------------------------------------------

  dir(name: "task" | "prompts" | "plan" | "research" | "rubrics" | "contracts" | "context" | "progress" | "evidence" | "evaluations"): string {
    return path.join(this.stateDir, name);
  }

  ensureLayout(): void {
    ensureDirNofollow(this.logDir);
    ensureDirNofollow(this.orchestrationDir);
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o755 });
    for (const name of ["task", "prompts", "plan", "research", "rubrics", "contracts", "context", "progress", "evidence", "evaluations"] as const) {
      fs.mkdirSync(this.dir(name), { recursive: true, mode: 0o755 });
    }
    fs.mkdirSync(path.join(this.dir("plan"), "revisions"), { recursive: true });
  }

  // --- events / phase ----------------------------------------------------

  event(name: string, payload: Record<string, unknown> = {}): void {
    appendEvent(this.eventsPath, name, payload);
  }

  setPhase(record: Partial<PhaseRecord> & { phase: LoopPhase }): PhaseRecord {
    const previous = this.readPhase();
    const next: PhaseRecord = {
      phase: record.phase,
      current_subtask: record.current_subtask ?? (record.phase === "executing" ? previous?.current_subtask ?? null : null),
      current_role: record.current_role ?? null,
      current_round: record.current_round ?? null,
      updated_at: Date.now() / 1000,
      detail: record.detail ?? "",
    };
    this.writeJson(path.join(this.stateDir, "phase.json"), next);
    return next;
  }

  writeRunConfig(config: { max_rounds: number; max_eval_rounds: number; min_research_agents: number; research_model: string }): void {
    this.writeJson(path.join(this.stateDir, "config.json"), config);
  }

  readRunConfig(): LoopSnapshot["config"] {
    const raw = this.readJson(path.join(this.stateDir, "config.json"));
    if (!isRecord(raw)) return null;
    return {
      max_rounds: Number(raw.max_rounds) || 0,
      max_eval_rounds: Number(raw.max_eval_rounds) || 0,
      min_research_agents: Number(raw.min_research_agents) || 0,
      research_model: str(raw.research_model),
    };
  }

  readPhase(): PhaseRecord | null {
    const raw = this.readJson(path.join(this.stateDir, "phase.json"));
    return isRecord(raw) ? (raw as unknown as PhaseRecord) : null;
  }

  // --- task / prompts ----------------------------------------------------

  writeTask(task: string, attachments: string[]): void {
    const lines = [task.trim(), ""];
    if (attachments.length) {
      lines.push("Attachments (workspace-relative):", ...attachments.map((item) => `- ${item}`), "");
    }
    writeLocal(path.join(this.dir("task"), "TASK.md"), lines.join("\n"));
  }

  readTask(): string {
    return readLocalBounded(path.join(this.dir("task"), "TASK.md"), 512 * 1024) ?? "";
  }

  writeBriefing(role: string, text: string): void {
    writeLocal(path.join(this.dir("prompts"), `${role}.md`), text.trim() ? `${text.trim()}\n` : "");
  }

  readBriefing(role: string): string {
    return readLocalBounded(path.join(this.dir("prompts"), `${role}.md`), 256 * 1024) ?? "";
  }

  // --- plan --------------------------------------------------------------

  get planPath(): string {
    return path.join(this.dir("plan"), "plan.json");
  }

  writePlan(plan: Plan, options: { revisionNote?: string } = {}): void {
    plan.updated_at = Date.now() / 1000;
    this.writeJson(this.planPath, plan);
    writeLocal(path.join(this.dir("plan"), "PLAN.md"), renderPlanMarkdown(plan, { withStatus: true }));
    const revisionPath = path.join(this.dir("plan"), "revisions", `r${String(plan.revision).padStart(3, "0")}.json`);
    if (!fs.existsSync(revisionPath)) {
      this.writeJson(revisionPath, { revision: plan.revision, note: options.revisionNote ?? "", written_at: plan.updated_at, plan });
    }
  }

  readPlan(): Plan | null {
    const raw = this.readJson(this.planPath);
    if (!isRecord(raw)) return null;
    try {
      return parsePlan(raw);
    } catch {
      return null;
    }
  }

  // --- rubric / contract -------------------------------------------------

  rubricPath(subtaskId: string): string {
    return path.join(this.dir("rubrics"), `${subtaskId}.md`);
  }

  contractPath(subtaskId: string): string {
    return path.join(this.dir("contracts"), `${subtaskId}.json`);
  }

  writeContract(contract: Contract): void {
    contract.updated_at = Date.now() / 1000;
    this.writeJson(this.contractPath(contract.subtask_id), contract);
  }

  readContract(subtaskId: string): Contract | null {
    const raw = this.readJson(this.contractPath(subtaskId));
    return isRecord(raw) ? parseContract(raw, subtaskId) : null;
  }

  // --- context / progress / evidence -----------------------------------

  writeContextPack(subtaskId: string, round: number, pack: Record<string, unknown>, rendered: string): void {
    const base = path.join(this.dir("context"), `${subtaskId}-r${round}`);
    this.writeJson(`${base}.json`, pack);
    writeLocal(`${base}.md`, rendered);
  }

  progressPath(subtaskId: string): string {
    return path.join(this.dir("progress"), `${subtaskId}.md`);
  }

  readProgress(subtaskId: string): string {
    return readLocalBounded(this.progressPath(subtaskId), 512 * 1024) ?? "";
  }

  evidenceDir(subtaskId: string): string {
    return path.join(this.dir("evidence"), subtaskId);
  }

  ledgerPath(subtaskId: string): string {
    return path.join(this.evidenceDir(subtaskId), "ledger.jsonl");
  }

  // --- evaluations -------------------------------------------------------

  evaluationDir(subtaskId: string): string {
    return path.join(this.dir("evaluations"), subtaskId);
  }

  writeEvaluation(record: EvaluationRecord): void {
    const dir = this.evaluationDir(record.subtask_id);
    fs.mkdirSync(dir, { recursive: true });
    this.writeJson(path.join(dir, `r${record.round}.json`), record);
    writeLocal(path.join(dir, `r${record.round}.md`), renderEvaluationMarkdown(record));
  }

  readEvaluations(subtaskId: string): EvaluationRecord[] {
    const dir = this.evaluationDir(subtaskId);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((name) => /^r\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
    } catch {
      return [];
    }
    const out: EvaluationRecord[] = [];
    for (const name of entries) {
      const raw = this.readJson(path.join(dir, name));
      if (isRecord(raw)) out.push(raw as unknown as EvaluationRecord);
    }
    return out;
  }

  // --- episodes index ----------------------------------------------------

  get episodesIndexPath(): string {
    return path.join(this.stateDir, "episodes.jsonl");
  }

  appendEpisodeIndex(entry: EpisodeIndexEntry): void {
    fs.appendFileSync(this.episodesIndexPath, `${JSON.stringify(jsonSafe(entry))}\n`, "utf-8");
  }

  readEpisodeIndex(): EpisodeIndexEntry[] {
    const text = readLocalBounded(this.episodesIndexPath, 16 * 1024 * 1024) ?? "";
    const bySeq = new Map<number, EpisodeIndexEntry>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as EpisodeIndexEntry;
        if (Number.isInteger(parsed.seq)) bySeq.set(parsed.seq, parsed);
      } catch {
        /* skip */
      }
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  nextEpisodeSeq(): number {
    const entries = this.readEpisodeIndex();
    return entries.length ? entries[entries.length - 1]!.seq + 1 : 1;
  }

  // --- report ------------------------------------------------------------

  writeReport(report: Record<string, unknown>): void {
    const text = jsonDumpsIndent2(report) + "\n";
    writeLocal(path.join(this.logDir, "report.json"), text);
    writeLocal(path.join(this.orchestrationDir, "report.json"), text);
  }

  /**
   * On resume the previous terminal report must stop being the authority:
   * keep it as history (`report.previous.N.json`) and clear both copies so
   * the supervisor and the workbench read the live state until the new one.
   */
  archiveTerminalReport(): void {
    const existing = this.readReport();
    if (!existing) return;
    let index = 1;
    while (fs.existsSync(path.join(this.logDir, `report.previous.${index}.json`))) index += 1;
    try {
      fs.renameSync(path.join(this.logDir, "report.json"), path.join(this.logDir, `report.previous.${index}.json`));
    } catch {
      /* nothing to archive */
    }
    try {
      fs.rmSync(path.join(this.orchestrationDir, "report.json"), { force: true });
    } catch {
      /* already gone */
    }
  }

  readReport(): Record<string, unknown> | null {
    const raw = this.readJson(path.join(this.logDir, "report.json"));
    return isRecord(raw) ? raw : null;
  }

  writeFinalResponse(text: string): void {
    writeLocal(path.join(this.orchestrationDir, "final_response.txt"), text);
    writeLocal(path.join(this.stateDir, "FINAL.md"), text);
  }

  // --- helpers -----------------------------------------------------------

  writeJson(target: string, value: unknown): void {
    writeLocal(target, jsonDumpsIndent2(value) + "\n");
  }

  readJson(target: string): unknown {
    const text = readLocalBounded(target, 8 * 1024 * 1024);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Contract / evaluation parsing
// ---------------------------------------------------------------------------

export function parseContract(raw: unknown, subtaskId: string): Contract {
  const source = isRecord(raw) ? raw : {};
  const rawCriteria = Array.isArray(source.criteria) ? source.criteria : [];
  const usedIds = new Set<string>();
  const criteria: ContractCriterion[] = [];
  rawCriteria.forEach((item, index) => {
    if (!isRecord(item)) return;
    let id = str(item.id).toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || `c${index + 1}`;
    if (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    const weightRaw = Number(item.weight);
    const scoreRaw = item.score;
    criteria.push({
      id,
      statement: str(item.statement) || str(item.criterion) || str(item.text) || `criterion ${index + 1}`,
      verify: str(item.verify) || str(item.how_to_verify) || str(item.verification),
      evidence: str(item.evidence) || str(item.evidence_required),
      mandatory: Boolean(item.mandatory),
      weight: Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1,
      passes: item.passes === true,
      score: typeof scoreRaw === "number" && Number.isFinite(scoreRaw) ? scoreRaw : null,
      finding: str(item.finding),
    });
  });
  if (!criteria.length) throw new Error("contract has no criteria");
  const scoring = isRecord(source.scoring) ? source.scoring : {};
  const now = Date.now() / 1000;
  return {
    subtask_id: subtaskId,
    criteria,
    scoring: {
      scale: str(scoring.scale) || "0-5 per quality criterion",
      pass_rule: str(scoring.pass_rule) || "all mandatory criteria pass and the weighted mean score is at least 3.5",
    },
    created_at: typeof source.created_at === "number" ? source.created_at : now,
    updated_at: now,
  };
}

/** The harness's own reading of the pass rule: mandatory all pass + weighted mean ≥ threshold. */
export function contractPasses(contract: Contract, threshold = 3.5): { passes: boolean; reason: string } {
  const failedMandatory = contract.criteria.filter((item) => item.mandatory && !item.passes).map((item) => item.id);
  if (failedMandatory.length) return { passes: false, reason: `mandatory criteria failed: ${failedMandatory.join(", ")}` };
  const failed = contract.criteria.filter((item) => !item.passes).map((item) => item.id);
  const scored = contract.criteria.filter((item) => item.score !== null);
  if (scored.length) {
    const total = scored.reduce((sum, item) => sum + item.weight, 0);
    const mean = scored.reduce((sum, item) => sum + item.weight * (item.score as number), 0) / (total || 1);
    if (mean < threshold) return { passes: false, reason: `weighted mean score ${mean.toFixed(2)} is below ${threshold}` };
    if (failed.length) return { passes: false, reason: `criteria not passing: ${failed.join(", ")}` };
    return { passes: true, reason: `all criteria pass; weighted mean ${mean.toFixed(2)}` };
  }
  if (failed.length) return { passes: false, reason: `criteria not passing: ${failed.join(", ")}` };
  return { passes: true, reason: "all criteria pass" };
}

export function parseEvaluation(
  raw: unknown,
  options: { subtaskId: string; round: number; contract: Contract; narrative: string; episodeDir: string },
): EvaluationRecord {
  const source = isRecord(raw) ? raw : {};
  const claimed = str(source.verdict).toUpperCase();
  const claimedVerdict: EvaluationRecord["claimed_verdict"] = claimed === "PASS" ? "PASS" : claimed === "NEEDS_WORK" ? "NEEDS_WORK" : "invalid";
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(source.criteria) ? source.criteria : []) {
    if (isRecord(item) && str(item.id)) byId.set(str(item.id).toLowerCase(), item);
  }
  const ungraded: string[] = [];
  const criteria: EvaluationCriterion[] = options.contract.criteria.map((criterion) => {
    const item = byId.get(criterion.id);
    if (!item) {
      ungraded.push(criterion.id);
      return { id: criterion.id, passes: false, score: null, checked: [], finding: `not graded by the evaluator (${criterion.statement})` };
    }
    const score = Number(item.score);
    return {
      id: criterion.id,
      passes: item.passes === true,
      score: Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : null,
      checked: Array.isArray(item.checked) ? item.checked.map((entry) => str(entry)).filter((entry) => entry) : [],
      finding: str(item.finding),
    };
  });
  // Apply the verdict to a copy of the contract and let the pass rule decide.
  const applied: Contract = {
    ...options.contract,
    criteria: options.contract.criteria.map((criterion) => {
      const graded = criteria.find((item) => item.id === criterion.id)!;
      return { ...criterion, passes: graded.passes, score: graded.score, finding: graded.finding };
    }),
  };
  const rule = contractPasses(applied);
  let verdict: EvaluationRecord["verdict"] = rule.passes && claimedVerdict === "PASS" ? "PASS" : "NEEDS_WORK";
  let harnessNote = "";
  if (claimedVerdict === "invalid") harnessNote = "evaluator output had no PASS/NEEDS_WORK verdict; treated as NEEDS_WORK";
  else if (claimedVerdict === "PASS" && !rule.passes) harnessNote = `evaluator said PASS but the contract rule fails: ${rule.reason}`;
  else if (claimedVerdict === "NEEDS_WORK" && rule.passes) harnessNote = `evaluator said NEEDS_WORK although every criterion passes (${rule.reason}); the evaluator's judgement stands`;
  if (claimedVerdict === "NEEDS_WORK") verdict = "NEEDS_WORK";
  const findings = Array.isArray(source.findings) ? source.findings.map((entry) => str(entry)).filter((entry) => entry) : [];
  for (const id of ungraded) {
    const criterion = options.contract.criteria.find((item) => item.id === id)!;
    findings.push(`Criterion ${id} was not graded by the evaluator and therefore counts as failed: ${criterion.statement} (verify: ${criterion.verify || "see rubric"})`);
  }
  if (ungraded.length) harnessNote = `${harnessNote ? `${harnessNote}; ` : ""}ungraded criteria: ${ungraded.join(", ")}`;
  return {
    subtask_id: options.subtaskId,
    round: options.round,
    verdict,
    claimed_verdict: claimedVerdict,
    summary: str(source.summary),
    criteria,
    findings,
    plan_changes: Array.isArray(source.plan_changes) ? source.plan_changes : [],
    memory_notes: Array.isArray(source.memory_notes) ? source.memory_notes.map((entry) => str(entry)).filter((entry) => entry) : [],
    narrative: options.narrative,
    harness_note: harnessNote,
    episode_dir: options.episodeDir,
    created_at: Date.now() / 1000,
  };
}

/** Criteria the evaluator left out of its JSON (they count as failed). */
export function ungradedCriteria(record: EvaluationRecord): string[] {
  return record.criteria.filter((item) => item.finding.startsWith("not graded by the evaluator")).map((item) => item.id);
}

export function renderEvaluationMarkdown(record: EvaluationRecord): string {
  const lines: string[] = [
    `# Evaluation of \`${record.subtask_id}\` — round ${record.round}`,
    "",
    `Verdict: **${record.verdict}**${record.claimed_verdict !== record.verdict ? ` (evaluator said ${record.claimed_verdict})` : ""}`,
  ];
  if (record.harness_note) lines.push(`Harness note: ${record.harness_note}`);
  if (record.summary) lines.push("", record.summary);
  lines.push("", "## Criteria", "");
  for (const item of record.criteria) {
    lines.push(`- ${item.passes ? "PASS" : "FAIL"} \`${item.id}\`${item.score !== null ? ` (${item.score}/5)` : ""}${item.finding ? ` — ${item.finding}` : ""}`);
    for (const checked of item.checked) lines.push(`  - checked: ${checked}`);
  }
  if (record.findings.length) {
    lines.push("", "## Findings for the composer", "");
    for (const finding of record.findings) lines.push(`- ${finding}`);
  }
  if (record.plan_changes.length) {
    lines.push("", "## Plan changes requested", "", "```json", JSON.stringify(record.plan_changes, null, 2), "```");
  }
  if (record.narrative) lines.push("", "## Evaluator narrative", "", record.narrative);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Projection for the workbench (bounded reads only)
// ---------------------------------------------------------------------------

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
  ledger_count: number;
  /** The newest hook-written ledger entries (bounded). */
  ledger: Record<string, unknown>[];
  /** Evidence files with sizes, for the panel to warn before fetching media. */
  evidence_meta: { name: string; bytes: number }[];
  evaluations: EvaluationRecord[];
  context: { round: number; sections: { title: string; kind: string; path: string; reason: string; chars: number }[]; selector: string }[];
  episodes: EpisodeIndexEntry[];
}

export interface LoopSnapshot {
  phase: PhaseRecord | null;
  task: string;
  /** Run limits the loop was started with (state/config.json). */
  config: { max_rounds: number; max_eval_rounds: number; min_research_agents: number; research_model: string } | null;
  plan: Plan | null;
  plan_markdown: string;
  plan_revisions: { revision: number; note: string; written_at: number }[];
  status_counts: Record<string, number> | null;
  briefings: Record<string, string>;
  research: string[];
  research_notes: { file: string; title: string }[];
  subtasks: SubtaskView[];
  episodes: EpisodeIndexEntry[];
  /** Running totals from the episode index (report.json only exists at the end). */
  cost_usd: number;
  composer_episodes: number;
  decisions: string;
  final_response: string;
}

const TEXT_PREVIEW = 64 * 1024;

export function readLoopSnapshot(runDir: string, logDir: string): LoopSnapshot {
  const state = new RunState({ runDir, logDir });
  const plan = state.readPlan();
  const episodes = state.readEpisodeIndex();
  const briefings: Record<string, string> = {};
  for (const role of ["planner", "rubric", "composer", "evaluator"]) {
    const text = state.readBriefing(role);
    if (text) briefings[role] = text.slice(0, TEXT_PREVIEW);
  }
  let research: string[] = [];
  try {
    research = fs.readdirSync(state.dir("research")).filter((name) => name.endsWith(".md")).sort();
  } catch {
    research = [];
  }
  const researchNotes = research.map((file) => {
    const head = readLocalBounded(path.join(state.dir("research"), file), 4096) ?? "";
    const title = /^#\s+(.+)$/m.exec(head)?.[1]?.trim() ?? file.replace(/\.md$/, "").replace(/[-_]+/g, " ");
    return { file, title };
  });
  const planRevisions: LoopSnapshot["plan_revisions"] = [];
  try {
    for (const name of fs.readdirSync(path.join(state.dir("plan"), "revisions")).filter((entry) => /^r\d+\.json$/.test(entry)).sort()) {
      const raw = state.readJson(path.join(state.dir("plan"), "revisions", name));
      if (isRecord(raw)) planRevisions.push({ revision: Number(raw.revision) || 0, note: str(raw.note), written_at: Number(raw.written_at) || 0 });
    }
  } catch {
    /* none */
  }
  const subtasks: SubtaskView[] = [];
  if (plan) {
    for (const leaf of leaves(plan)) {
      let evidenceFiles: string[] = [];
      try {
        evidenceFiles = fs.readdirSync(state.evidenceDir(leaf.id)).filter((name) => name !== "ledger.jsonl").sort();
      } catch {
        evidenceFiles = [];
      }
      const ledgerText = readLocalBounded(state.ledgerPath(leaf.id), 4 * 1024 * 1024) ?? "";
      const ledgerLines = ledgerText.split("\n").filter((line) => line.trim());
      const ledger: Record<string, unknown>[] = [];
      for (const line of ledgerLines.slice(-200)) {
        try {
          const parsed = JSON.parse(line);
          if (isRecord(parsed)) ledger.push(parsed);
        } catch {
          /* skip */
        }
      }
      const evidenceMeta = evidenceFiles.slice(0, 200).map((name) => {
        try {
          return { name, bytes: fs.statSync(path.join(state.evidenceDir(leaf.id), name)).size };
        } catch {
          return { name, bytes: 0 };
        }
      });
      const context: SubtaskView["context"] = [];
      try {
        for (const name of fs.readdirSync(state.dir("context")).filter((entry) => entry.startsWith(`${leaf.id}-r`) && entry.endsWith(".json")).sort()) {
          const raw = state.readJson(path.join(state.dir("context"), name));
          if (!isRecord(raw)) continue;
          const round = Number(/-r(\d+)\.json$/.exec(name)?.[1] ?? 0);
          const sections = Array.isArray(raw.sections)
            ? raw.sections.filter(isRecord).map((section) => ({
                title: str(section.title),
                kind: str(section.kind),
                path: str(section.path),
                reason: str(section.reason),
                chars: Number(section.chars) || 0,
              }))
            : [];
          context.push({ round, sections, selector: str(raw.selector) });
        }
      } catch {
        /* none */
      }
      subtasks.push({
        id: leaf.id,
        title: leaf.title,
        status: leaf.status,
        rounds: leaf.rounds,
        last_verdict: leaf.last_verdict,
        contract: state.readContract(leaf.id),
        rubric: (readLocalBounded(state.rubricPath(leaf.id), TEXT_PREVIEW) ?? ""),
        progress: state.readProgress(leaf.id).slice(0, TEXT_PREVIEW),
        evidence_files: evidenceFiles.slice(0, 200),
        ledger_count: ledgerLines.length,
        ledger,
        evidence_meta: evidenceMeta,
        evaluations: state.readEvaluations(leaf.id),
        context,
        episodes: episodes.filter((entry) => entry.subtask_id === leaf.id),
      });
    }
  }
  return {
    phase: state.readPhase(),
    task: state.readTask(),
    config: state.readRunConfig(),
    plan,
    plan_markdown: plan ? renderPlanMarkdown(plan, { withStatus: true }) : "",
    plan_revisions: planRevisions,
    status_counts: plan ? countStatuses(plan) : null,
    briefings,
    research,
    research_notes: researchNotes,
    subtasks,
    episodes,
    cost_usd: Math.round(episodes.reduce((sum, entry) => sum + (entry.cost_usd ?? 0), 0) * 10000) / 10000,
    composer_episodes: episodes.filter((entry) => entry.role === "composer" && entry.status !== "running").length,
    decisions: readLocalBounded(path.join(state.dir("task"), "DECISIONS.md"), TEXT_PREVIEW) ?? "",
    final_response: readLocalBounded(path.join(state.stateDir, "FINAL.md"), TEXT_PREVIEW) ?? "",
  };
}
