import { useEffect, useMemo, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Braces,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleDotDashed,
  CircleX,
  Copy,
  Ellipsis,
  ExternalLink,
  FileCode2,
  FileJson2,
  FilePenLine,
  FileText,
  Files,
  FlaskConical,
  FolderOpen,
  History,
  ListChecks,
  LoaderCircle,
  KeyRound,
  PanelRight,
  PanelTop,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
  type LucideIcon, Paperclip, RotateCw } from 'lucide-react';
import { MAX_ROUNDS, type ArtifactList, type EventEnvelope, type RunSummary, type Snapshot } from '../../core/src/types';
import { availableCommands, isTrajectoryNoise, managerPlanSummary, managerPlanText, normaliseMaxRounds, projectArtifactView, projectStatus, dedupeEvents, parseCommand, parseNewRunArgs, phaseLabel, projectTrajectoryView, reducePanelState, sortTranscript, DEFAULT_PANEL_STATE, type ArtifactProjection, type FileChangeItem, type PanelName, type StatusView, type TrajectoryItem, type ValidationResultSummary } from '../../core/src';
import {
  abortRun,
  createRun,
  uploadFile,
  reloadService,
  fetchArtifact,
  fetchArtifacts,
  fetchMeta,
  refreshModels,
  fetchRuns,
  fetchTrajectory,
  postInstruction,
  resolveApproval,
  resumeRun,
  stopRun,
  artifactRawUrl,
  fetchImageSource,
  idempotencyKey,
  isConflict,
  isUnauthorized,
  setStoredAuthToken,
  storedAuthToken,
  type WebMeta,
  type AgentChoice,
  type ModelChoice,
  type RoleRuntimeConfig,
  type TrajectoryView,
} from './api';
import { useRunFeed } from './useRunFeed';
import { uiText, useUiLanguage, type UiLanguage } from './i18n';

type DetailsTab = 'artifacts' | 'trajectory' | 'events';
type MessageKind = 'user' | 'plan' | 'assistant' | 'verification' | 'final' | 'live' | 'history';

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

function useful(text?: string | null): text is string {
  return Boolean(text && text.trim() && !text.includes('produced no readable natural-language output'));
}

/** Props that dismiss an overlay on a real backdrop click, but not on a drag.
 *
 * A plain `onClick` on the backdrop also fires when a text selection *starts*
 * inside the dialog and ends on the backdrop, because `click` is dispatched to
 * the nearest common ancestor of mousedown/mouseup. That closed the panel and
 * discarded the selection mid-gesture, so require both ends on the backdrop.
 * The armed flag lives in a ref because a re-render (status polling) can land
 * between the two events.
 */
function useBackdropDismiss(onDismiss: () => void) {
  const armed = useRef(false);
  return {
    onMouseDown: (event: ReactMouseEvent) => {
      armed.current = event.target === event.currentTarget && event.button === 0;
    },
    onMouseUp: (event: ReactMouseEvent) => {
      const dismiss = armed.current && event.target === event.currentTarget;
      armed.current = false;
      if (dismiss) onDismiss();
    },
  };
}

function compactText(text: string, limit = 1600): string {
  const value = text.trim();
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

function cleanAgentOutput(text: string): string {
  // The persisted report starts with machine status fields. They are useful
  // in Details, but they make the conversation feel like a raw log stream.
  return text.trim().replace(/^Status:\s*\S+\s+Integrity:\s*\S+\s+Contract audit:\s*\S+\s*/u, '').trim();
}

function roleTitle(role: string | null | undefined): string {
  if (!role) return 'LongHorizon';
  if (role === 'executor') return 'Executor';
  if (role === 'auditor') return 'Auditor';
  if (role === 'manager') return 'Manager';
  if (role === 'final_response') return 'Final reply';
  return role.replaceAll('_', ' ');
}

function statusLabel(status: string, hasFinalResponse = false, language: UiLanguage = 'en'): string {
  if (status === 'waiting_approval' && hasFinalResponse) return uiText(language, 'Result awaiting confirmation');
  const labels = {
    starting: 'Starting', creating: 'Creating', running: 'Running', stopping: 'Stopping', aborting: 'Aborting',
    waiting_approval: 'Input required', completed: 'Completed', complete: 'Completed', failed: 'Failed', blocked: 'Blocked',
    incomplete: 'Incomplete', cancelled: 'Stopped', canceled: 'Stopped', stopped: 'Stopped', aborted: 'Aborted', idle: 'Idle',
  };
  return (labels as Record<string, string>)[status] || (status ? uiText(language, `Status: ${status}`) : uiText(language, 'Unknown'));
}

function statusClass(status: string): string {
  return `status-dot status-${status.replaceAll('_', '-')}`;
}

function terminalLifecycle(status: unknown): boolean {
  return new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'finished', 'failed', 'failure', 'blocked', 'incomplete', 'cancelled', 'canceled', 'stopped', 'aborted']).has(String(status ?? '').trim().toLowerCase());
}

function stoppingLifecycle(status: unknown): boolean {
  return new Set(['stopping', 'aborting', 'stop_requested', 'abort_requested']).has(String(status ?? '').trim().toLowerCase());
}

// SVG is intentionally treated as text/attachment by the API: rendering an
// untrusted agent-produced SVG in the dashboard origin would allow script and
// external-resource execution. Raster formats remain safe image previews.
const IMAGE_ARTIFACT_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/iu;

function isImageArtifact(name: string): boolean {
  return IMAGE_ARTIFACT_RE.test(name);
}

function formatTime(ts?: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function eventSummary(event: EventEnvelope, language: UiLanguage): string {
  const role = event.role ? ` · ${roleTitle(event.role)}` : '';
  const phase = phaseLabel(event.type);
  return `${phase}${role}`;
}

function commandHelpText(capabilities: Record<string, boolean>, snapshot: Snapshot, hasRun: boolean, language: UiLanguage): string {
  const descriptions: Record<string, string> = {
    help: 'Show available commands', runs: 'List tasks', new: 'Start a new task', attach: 'Switch to a task',
    inject: 'Queue an instruction', approve: 'Resolve an approval', stop: 'Request a graceful stop', abort: 'Abort the active task',
    resume: 'Continue from the rounds already finished', details: 'Open task details', events: 'Open the event panel', artifacts: 'Open run records', trajectory: 'Open the trajectory panel',
  };
  return availableCommands(capabilities, snapshot, hasRun).map((command) => {
    const description = descriptions[command.name] || command.description;
    return `/${command.name}${command.args ? ` ${command.args}` : ''}  ${description}`;
  }).join('\n');
}

function commandErrorText(message: string, _language: UiLanguage): string {
  return message;
}

interface ConversationMessage {
  id: string;
  kind: MessageKind;
  role: string;
  round?: number;
  title: string;
  text: string;
  input?: string;
  activity?: ActivityStep[];
  artifacts?: ArtifactProjection;
  time?: number;
  /** Internal timestamp used to interleave durable operator follow-ups. */
  sortTime?: number;
  /** Round slot for messages that sit between rounds rather than inside one. */
  sortRound?: number;
  /** Whether the text is backed by the harness completion authority. */
  authority?: 'final_response' | 'auditor' | 'report' | 'none';
  /** Rounds folded away by the history control ('history' messages only). */
  hidden?: number;
}

type ActivityAction = 'read' | 'edit' | 'validate' | 'search' | 'task' | 'screenshot' | 'command' | 'result' | 'note';

interface ActivityStep {
  id?: string;
  kind?: string;
  status?: string;
  title?: string;
  action?: ActivityAction;
  summary?: string;
  result?: string;
  detail?: string;
  links?: string[];
  text?: string;
  images?: string[];
  imageWarning?: string;
}

const MODEL_PRESETS: Record<string, { id: string; label: string }[]> = {
  claude_code: [{ id: 'claude-opus-5', label: 'Claude Opus 5 · default' }],
};

type PublicRole = 'manager' | 'executor' | 'auditor';
type RoleSelection = RoleRuntimeConfig & { custom: boolean; effortCustom?: boolean };
const PUBLIC_ROLES: Array<{ id: PublicRole; label: string; description: string }> = [
  { id: 'manager', label: 'Manager', description: 'Plans, routes, and decides completion' },
  { id: 'executor', label: 'Executor', description: 'Runs GUI / CLI subtasks' },
  { id: 'auditor', label: 'Auditor', description: 'Independently verifies and accepts' },
];

// A long-horizon run can contain hundreds/thousands of rounds.  The
// conversation needs recent evidence and the active role; historical detail
// remains available through the Details drawer's on-demand request.
const MAX_TRAJECTORY_ROUNDS = 8;
const MAX_TRAJECTORY_STEPS = 600;

function normalizedModelChoices(value: unknown): { id: string; label: string; availability?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ id: item.trim(), label: item.trim() }];
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    return id ? [{ id, label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id, availability: typeof record.availability === 'string' ? record.availability : undefined }] : [];
  });
}

function defaultAgent(meta: WebMeta | null): string {
  const preferred = meta?.defaults?.agent;
  if (preferred && meta?.agents?.some((item) => item.id === preferred && item.available !== false)) return preferred;
  return meta?.agents?.find((item) => item.available !== false)?.id || 'claude_code';
}

function defaultModel(meta: WebMeta | null, agent: string): string {
  return meta?.agents?.find((item) => item.id === agent)?.default_model
    || (meta?.defaults?.agent === agent ? meta.defaults.model : '')
    || normalizedModelChoices(meta?.models?.[agent])[0]?.id
    || MODEL_PRESETS[agent]?.[0]?.id
    || '';
}

function agentEntry(meta: WebMeta | null, agent: string): AgentChoice | undefined {
  return meta?.agents?.find((item) => item.id === agent);
}

/** Older servers only sent a boolean, so absence of `availability` is not "missing". */
function agentAvailability(item: Pick<AgentChoice, 'availability' | 'available'>): 'usable' | 'found_but_broken' | 'missing' | 'unknown' {
  if (item.availability) return item.availability;
  if (item.available === true) return 'usable';
  if (item.available === false) return 'missing';
  return 'unknown';
}

/**
 * Effort choices for one role. Codex advertises them per model and the lists are
 * uneven between models, so the selected model wins over the agent-wide list.
 */
function reasoningChoicesFor(meta: WebMeta | null, agent: string, model: string): { id: string; label: string; description?: string }[] {
  const support = agentEntry(meta, agent)?.reasoning;
  if (!support?.supported) return [];
  if (support.scope === 'per_model') {
    const modelId = model.trim() || defaultModel(meta, agent);
    const entry = normalizedModelEntries(meta, agent).find((item) => item.id === modelId);
    const details = entry?.reasoning_effort_details;
    if (details?.length) return details.map((item) => ({ id: item.id, label: item.id, description: item.description }));
    if (entry?.reasoning_efforts?.length) return entry.reasoning_efforts.map((id) => ({ id, label: id }));
  }
  return (support.choices || []).map((item) => ({ id: item.id, label: item.label || item.id }));
}

function normalizedModelEntries(meta: WebMeta | null, agent: string): ModelChoice[] {
  const raw = meta?.models?.[agent] || agentEntry(meta, agent)?.models;
  return Array.isArray(raw) ? raw.filter((item): item is ModelChoice => Boolean(item) && typeof item === 'object') : [];
}

interface ImageSourceProjection {
  images: string[];
  omittedLargeDataUrls: number;
}

function projectImageSources(value: unknown): ImageSourceProjection {
  const values = Array.isArray(value) ? value : [value];
  const images: string[] = [];
  let omittedLargeDataUrls = 0;
  for (const source of values) {
    if (typeof source !== 'string') continue;
    const candidate = source.trim();
    // Trajectory data is agent-controlled.  Auto-loading arbitrary http(s)
    // URLs would turn screenshots into a browser-side SSRF/tracking primitive
    // and would also bypass the Web API bearer.  External URLs remain useful
    // as explicit text links; only same-origin API artifacts and bounded
    // raster data URLs are rendered in the gallery.
    const dataImage = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);(?:base64,)?/iu.test(candidate);
    if (dataImage) {
      if (candidate.length <= 2_000_000) images.push(candidate);
      else omittedLargeDataUrls += 1;
    } else if (candidate.startsWith('/api/') && !candidate.startsWith('//')) {
      images.push(candidate);
    }
  }
  return { images: [...new Set(images)], omittedLargeDataUrls };
}

function trajectoryStepText(step: Record<string, unknown>): string {
  if (typeof step.text === 'string' && step.text.trim()) return step.text;
  const { images: _images, image: _image, image_url: _imageUrl, imageUrl: _imageUrlCamel, has_image: _hasImage, ...withoutImages } = step;
  return Object.keys(withoutImages).length ? JSON.stringify(withoutImages, null, 2) : '';
}

function trajectoryResultFailed(step: Record<string, unknown>): boolean {
  if (step.is_error === true || /^(?:error|failed|failure)$/iu.test(String(step.status || ''))) return true;
  const exitCode = step.exit_code ?? step.exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) return true;
  if (typeof exitCode === 'string' && /^-?\d+$/u.test(exitCode.trim()) && Number(exitCode) !== 0) return true;
  const text = typeof step.text === 'string' ? step.text : '';
  const match = text.match(/\[exit_code=(-?\d+)\]/iu) || text.match(/"exit_code"\s*:\s*(-?\d+)/iu);
  return Boolean(match && Number(match[1]) !== 0);
}

// Keep links useful in prose and code output without turning template strings
// such as `http://127.0.0.1:{args.port}` into clickable destinations.
const URL_RE = /https?:\/\/[^\s<>"'`]+/giu;

function normalizeLink(value: string): string | null {
  // Markdown and quoted shell output commonly leave closing punctuation on
  // the URL. Strip it, while rejecting unresolved `{placeholder}` values.
  const candidate = value.trim().replace(/[.,;:!?]+$/u, '').replace(/[)\]}]+$/u, '');
  if (!candidate || /[{}]/u.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

function extractLinks(text: string): string[] {
  const links = (text.match(URL_RE) || []).map(normalizeLink).filter((value): value is string => Boolean(value));
  return [...new Set(links)];
}

function stepImageProjection(step: Record<string, unknown>): ImageSourceProjection {
  const projections = [step.images, step.image, step.image_url, step.imageUrl].map(projectImageSources);
  return {
    images: [...new Set(projections.flatMap((item) => item.images))],
    omittedLargeDataUrls: projections.reduce((total, item) => total + item.omittedLargeDataUrls, 0),
  };
}

function trajectoryAction(step: Record<string, unknown>, kind: string, images: string[]): ActivityAction {
  const name = String(step.name || '').toLowerCase();
  const input = step.input && typeof step.input === 'object' ? step.input as Record<string, unknown> : {};
  const command = String(input.command || input.cmd || '').trim();
  if (images.length || /(?:screen_?shot|capture|snapshot)/iu.test(name)) return 'screenshot';
  if (/^(?:apply_patch|file_change|edit|multiedit|write|notebookedit)$/iu.test(name)) return 'edit';
  if (name === 'web_search') return 'search';
  if (name === 'todo_list') return 'task';
  if (command && /(?:\bpytest\b|\bunittest\b|\b(?:npm|pnpm|yarn|bun)\b[^\n]*(?:\btest\b|\btypecheck\b|\bbuild\b|\blint\b)|\btsc\b|\bvitest\b|\bjest\b|\bcargo\s+test\b|\bgo\s+test\b|\bgit\s+diff\b[^\n]*--check)/iu.test(command)) return 'validate';
  if (/^(?:read|glob|grep)$/iu.test(name)) return name === 'read' ? 'read' : 'search';
  if (command && /(?:^|[;&|]\s*|\s)(?:cat|sed|head|tail|less|rg|grep|find|fd|ls|tree|pwd|wc)\b|\bgit\s+(?:status|diff|show|log)\b/iu.test(command)) return 'read';
  if (kind === 'tool_use') return 'command';
  if (kind === 'result' || kind === 'tool_result') return 'result';
  return 'note';
}

function trajectoryTitle(action: ActivityAction, _language: UiLanguage): string {
  return ({
    read: 'Read and inspect', edit: 'Update files', validate: 'Run validation', search: 'Search sources', task: 'Update task list',
    screenshot: 'Capture screenshot', command: 'Run command', result: 'Execution result', note: 'Work summary',
  } as Record<ActivityAction, string>)[action];
}

function trajectorySummary(item: TrajectoryItem, language: UiLanguage): string {
  const raw = item.raw as Record<string, unknown>;
  const input = raw.input && typeof raw.input === 'object' ? raw.input as Record<string, unknown> : {};
  if (item.kind === 'tool_use') {
    if (typeof input.command === 'string') return compactText(input.command.replace(/\s+/gu, ' '), 180);
    if (Array.isArray(input.changes)) {
      const paths = input.changes.map((change) => change && typeof change === 'object' ? String((change as Record<string, unknown>).path || '') : '').filter(Boolean);
      return paths.length ? uiText(language, `${paths.length} files · ${paths.slice(0, 2).join(', ')}`) : uiText(language, 'Preparing file changes');
    }
    if (typeof input.query === 'string') return compactText(input.query, 180);
    return compactText(item.text || uiText(language, 'Preparing tool call'), 180);
  }
  const value = (item.text || '').replace(/\[exit_code=0\]/giu, '').trim();
  if (item.kind === 'tool_result') {
    const visible = value.replace(/(?:^|\n)\[image\](?=\n|$)/giu, '').trim();
    if (visible) return compactText(visible.split(/\n+/u).find(Boolean) || visible, 180);
    if (item.images.length) return uiText(language, `${item.images.length} screenshots returned`);
    return uiText(language, 'Result returned');
  }
  if (item.kind === 'result') return value ? compactText(value.split(/\n+/u).find(Boolean) || value, 220) : uiText(language, 'Stage completed');
  return compactText(value, 220);
}

function trajectoryActivity(trajectory: TrajectoryView | undefined, includeResult = true, language: UiLanguage = 'en'): ActivityStep[] {
  if (!trajectory) return [];
  const toolResults = new Map<string, { failed: boolean; raw: Record<string, unknown> }>();
  for (const step of trajectory.steps) {
    if (step.kind !== 'tool_result') continue;
    const raw = step as Record<string, unknown>;
    const id = String(raw.tool_use_id || raw.id || '').trim();
    if (id) toolResults.set(id, { failed: trajectoryResultFailed(raw), raw });
  }
  const projection = projectTrajectoryView(trajectory, {
    maxSteps: 80,
    maxTextChars: 240,
    includeKinds: includeResult
      ? ['text', 'tool_use', 'tool_result', 'result', 'error']
      : ['text', 'tool_use', 'error'],
  });
  const visibleToolIds = new Set(projection.items
    .filter((item) => item.kind === 'tool_use')
    .map((item) => String((item.raw as Record<string, unknown>).id || '').trim())
    .filter(Boolean));
  return projection.items
    .filter((item) => !isTrajectoryNoise(item.text))
    .filter((item) => Boolean(item.text?.trim() || item.images.length || item.hasImage))
    .filter((item) => {
      if (item.kind !== 'tool_result') return true;
      const resultId = String((item.raw as Record<string, unknown>).tool_use_id || '').trim();
      return !resultId || !visibleToolIds.has(resultId);
    })
    .map((item): ActivityStep => {
      const raw = item.raw as Record<string, unknown>;
      const summary = trajectorySummary(item, language);
      const toolId = String(raw.id || raw.tool_use_id || '').trim();
      const matchedResult = item.kind === 'tool_use' && toolId ? toolResults.get(toolId) : undefined;
      const paired = includeResult ? matchedResult : undefined;
      const ownImageProjection = stepImageProjection(raw);
      const resultImageProjection = paired ? stepImageProjection(paired.raw) : { images: [], omittedLargeDataUrls: 0 };
      const ownImages = ownImageProjection.images;
      const resultImages = resultImageProjection.images;
      const images = [...new Set([...ownImages, ...resultImages])];
      const omittedLargeDataUrls = ownImageProjection.omittedLargeDataUrls + resultImageProjection.omittedLargeDataUrls;
      const action = trajectoryAction(raw, item.kind, images);
      const pairedText = paired ? trajectoryStepText(paired.raw) : '';
      const resultText = paired && !isTrajectoryNoise(pairedText)
        ? pairedText.replace(/(?:^|\n)\[image\](?=\n|$)/giu, '').replace(/\[exit_code=0\]/giu, '').trim()
        : '';
      const resultSummary = resultText ? compactText(resultText.split(/\n+/u).find(Boolean) || resultText, 180) : resultImages.length ? uiText(language, `${resultImages.length} screenshots returned`) : paired ? uiText(language, 'Completed with no additional output') : '';
      const ownDetail = trajectoryStepText(raw);
      const pairedDetail = paired ? trajectoryStepText(paired.raw) : '';
      const detail = [ownDetail, pairedDetail && !isTrajectoryNoise(pairedDetail) && pairedDetail !== ownDetail ? `${uiText(language, 'Result')}\n${pairedDetail}` : ''].filter(Boolean).join('\n\n');
      const status = item.isError || matchedResult?.failed
        ? 'failed'
        : item.kind === 'tool_use'
          ? matchedResult ? 'done' : 'running'
          : 'done';
      return {
        id: `${projection.roundIndex}-${projection.role}-${item.index}`,
        kind: images.length > 0 && item.kind === 'tool_result' ? 'image' : item.kind,
        status,
        title: trajectoryTitle(action, language),
        action,
        summary,
        result: resultSummary,
        detail,
        text: item.text,
        links: extractLinks(`${summary}\n${resultText}\n${detail}`),
        images,
        imageWarning: omittedLargeDataUrls > 0 ? uiText(language, `${omittedLargeDataUrls} screenshots over 2 MB were hidden`) : undefined,
      };
    });
}

function hasExecutionArtifacts(projection: ArtifactProjection): boolean {
  return projection.files.totalFiles > 0 || projection.validations.total > 0;
}

interface CompletionEvidence {
  satisfied: boolean;
  finalResponse: string;
  reportText: string;
}

/** Read the durable completion report without trusting arbitrary role output. */
function completionEvidence(snapshot: Snapshot): CompletionEvidence {
  const run = snapshot.run as Snapshot['run'] & { completion_satisfied?: unknown; completion_authority?: unknown };
  const legacy = snapshot.legacy && typeof snapshot.legacy === 'object' ? snapshot.legacy as Record<string, unknown> : {};
  const nested = legacy.report && typeof legacy.report === 'object' ? legacy.report as Record<string, unknown> : legacy;
  const satisfied = run.completion_satisfied === true || nested.completion_satisfied === true;
  const finalResponse = typeof run.final_response === 'string' && run.final_response.trim()
    ? run.final_response.trim()
    : typeof nested.final_response === 'string'
      ? nested.final_response.trim()
      : [...snapshot.rounds].reverse().find((round) => useful(round.final_response))?.final_response?.trim() || '';
  const reportText = typeof nested.latest_auditor_report === 'string'
    ? nested.latest_auditor_report.trim()
    : typeof nested.auditor_report === 'string'
      ? nested.auditor_report.trim()
      : '';
  return { satisfied, finalResponse, reportText };
}

function terminalResultLabel(status: string, language: UiLanguage): string {
  if (status === 'failed') return uiText(language, 'Run failed');
  if (status === 'cancelled' || status === 'canceled') return uiText(language, 'Run stopped');
  if (status === 'blocked' || status === 'incomplete') return uiText(language, 'Task incomplete');
  return uiText(language, 'Run result');
}

function conversationStageTime(snapshot: Snapshot, round: number, stage: 'manager' | 'executor' | 'auditor' | 'final_response'): number | undefined {
  const prefix = stage === 'final_response' ? 'round.final_response.' : `round.${stage}.`;
  const times = snapshot.events
    .filter((event) => event.round === round && event.type.startsWith(prefix))
    .map((event) => event.ts)
    .filter((value) => Number.isFinite(value) && value > 0);
  return times.length ? Math.max(...times) : undefined;
}

function approvalResponseText(approval: Snapshot['approvals'][number], language: UiLanguage): string {
  const userInput = approval.user_input.trim();
  if (userInput) return userInput;
  const option = approval.options.find((item) => item.value === approval.action);
  const label = option?.label || approval.action;
  if (/continue/iu.test(label) || approval.action === 'continue') return uiText(language, 'Continue run');
  if (/end/iu.test(label)) return uiText(language, 'End task');
  if (/stop|abort|cancel/iu.test(label) || ['stop', 'abort', 'cancel'].includes(approval.action)) return uiText(language, 'Stop task');
  return label;
}

/** Shared clip length for every conversation card. */
const CONVERSATION_TEXT_LIMIT = 900;

/** How long a graceful stop may run before a force-kill is offered. */
const STOP_GRACE_MS = 3_000;

/**
 * When the shown reply was written.
 *
 * Taken from the `completed` event of the last round that produced one. A
 * discarded reply keeps its text in `run.final_response` while its round text
 * is cleared, so neither the round list nor the round's latest event (which
 * would be the discard) can date it.
 */
function finalResponseTime(snapshot: Snapshot): number | undefined {
  const completed = snapshot.events
    .filter((event) => event.type === 'round.final_response.completed')
    .map((event) => event.ts)
    .filter((value) => Number.isFinite(value) && value > 0);
  return completed.length ? Math.max(...completed) : snapshot.run.finished_at || undefined;
}

/** Round a free-form operator message belongs to, from the rounds' own event times. */
function roundForTime(snapshot: Snapshot, time: number | undefined): number {
  if (!time) return Number.MAX_SAFE_INTEGER;
  let slot = 0;
  for (const round of snapshot.rounds) {
    const started = conversationStageTime(snapshot, round.round_index, 'manager');
    if (started && started <= time) slot = round.round_index;
  }
  return slot;
}

function conversationFor(snapshot: Snapshot, trajectoryMap: Record<string, TrajectoryView>, liveTrajectory: TrajectoryView | null, artifacts: ArtifactProjection, language: UiLanguage, showAllRounds: boolean): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const task = snapshot.mission.task.trim();
  const taskTime = snapshot.run.started_at || snapshot.events.find((event) => event.type === 'run.started')?.ts;
  // The original request precedes every round, including the collapsed-history
  // notice, so it gets a slot below the first round rather than round 0.
  if (task) messages.push({ id: 'task', kind: 'user', role: 'You', title: 'You', text: task, sortTime: taskTime || undefined, sortRound: -1 });

  // Long tasks fold their older rounds away by default so the feed stays
  // responsive, but the fold is a control rather than a dead end: the marker
  // below expands the whole history in place and collapses it again.
  const hiddenRounds = showAllRounds ? 0 : Math.max(0, snapshot.rounds.length - MAX_TRAJECTORY_ROUNDS);
  if (hiddenRounds > 0 || (showAllRounds && snapshot.rounds.length > MAX_TRAJECTORY_ROUNDS)) {
    messages.push({
      id: 'history-collapsed',
      kind: 'history',
      role: 'LongHorizon',
      sortRound: 0,
      hidden: hiddenRounds,
      title: hiddenRounds > 0 ? uiText(language, 'Earlier rounds collapsed') : uiText(language, 'Showing every round'),
      text: '',
    });
  }
  for (const round of (showAllRounds ? snapshot.rounds : snapshot.rounds.slice(-MAX_TRAJECTORY_ROUNDS))) {
    const managerText = managerPlanText(round);
    if (useful(managerText)) {
      messages.push({
        id: `plan-${round.round_index}`,
        kind: 'plan',
        role: 'Manager',
        round: round.round_index,
        title: uiText(language, `Plan · Round ${round.round_index}`),
        input: task,
        // Full section: a pre-truncated summary silently dropped text and left
        // no expand affordance, since the card only clips what it is given.
        text: managerPlanSummary(managerText, Number.MAX_SAFE_INTEGER),
        sortTime: conversationStageTime(snapshot, round.round_index, 'manager'),
        activity: trajectoryActivity(trajectoryMap[`${round.round_index}:manager`], false, language),
      });
    }
    if (useful(round.executor_output)) {
      messages.push({
        id: `executor-${round.round_index}`,
        kind: 'assistant',
        role: 'Executor',
        round: round.round_index,
        title: uiText(language, `Executor · Round ${round.round_index}`),
        input: managerPlanSummary(round.plan_text || '') || round.next_step,
        text: cleanAgentOutput(round.executor_output),
        sortTime: conversationStageTime(snapshot, round.round_index, 'executor'),
        activity: trajectoryActivity(trajectoryMap[`${round.round_index}:executor`], true, language),
      });
    }
    if (useful(round.auditor_report)) {
      messages.push({
        id: `auditor-${round.round_index}`,
        kind: 'verification',
        role: 'Auditor',
        round: round.round_index,
        title: uiText(language, `Verification · Round ${round.round_index}`),
        input: cleanAgentOutput(round.executor_output || round.task_state || ''),
        text: cleanAgentOutput(round.auditor_report),
        sortTime: conversationStageTime(snapshot, round.round_index, 'auditor'),
        activity: trajectoryActivity(trajectoryMap[`${round.round_index}:auditor`], true, language),
      });
    }
  }

  if (liveTrajectory && liveTrajectory.steps.length && ['running', 'starting', 'waiting_approval', 'stopping', 'aborting'].includes(snapshot.run.status)) {
    const activity = trajectoryActivity(liveTrajectory, true, language);
    const visible = liveTrajectory.steps
      .filter((step) => step.kind === 'text' || step.kind === 'result')
      .map((step) => String(step.text || '').trim())
      .filter(Boolean);
    const latest = visible.at(-1);
    if (latest || activity.length > 0 || hasExecutionArtifacts(artifacts)) {
      messages.push({
        id: `live-${liveTrajectory.round_index}-${liveTrajectory.role}`,
        kind: 'live',
        role: roleTitle(liveTrajectory.role),
        round: liveTrajectory.round_index,
        title: uiText(language, `${roleTitle(liveTrajectory.role)} is working`),
        text: compactText(latest || uiText(language, 'Intermediate screenshot')),
        activity,
        // Work happening right now is always the newest thing in the transcript.
        sortRound: Number.MAX_SAFE_INTEGER,
        artifacts: hasExecutionArtifacts(artifacts) ? artifacts : undefined,
      });
    }
  }

  const terminal = terminalLifecycle(snapshot.run.status);
  const evidence = completionEvidence(snapshot);
  const latestAuditor = [...messages].reverse().find((message) => message.kind === 'verification');
  // The Executor's output is an implementation result, not the final answer.
  // A final card is sourced from the persisted completion report or Auditor;
  // if neither exists, show an explicit missing-evidence result instead of
  // presenting an unverified claim as authoritative.
  // The backend deliberately writes the closing reply before raising the
  // completion approval, so the operator can decide whether to accept it or
  // continue the run. Show that durable reply while waiting for the decision;
  // otherwise the approval asks about an answer the operator cannot inspect.
  if (terminal || evidence.finalResponse) {
    const nonSuccessTerminal = ['failed', 'blocked', 'incomplete', 'cancelled', 'canceled'].includes(snapshot.run.status);
    const authoritativeText = evidence.finalResponse || snapshot.run.failure_reason || evidence.reportText || (evidence.satisfied || nonSuccessTerminal ? latestAuditor?.text || '' : '');
    const text = authoritativeText || uiText(language, `${terminalResultLabel(snapshot.run.status, language)}, but the Auditor's final report has not been received.`);
    messages.push({
      id: 'final-answer',
      kind: 'final',
      role: 'LongHorizon',
      title: evidence.finalResponse || evidence.satisfied ? uiText(language, 'Final answer') : terminalResultLabel(snapshot.run.status, language),
      text,
      authority: evidence.finalResponse
        ? 'final_response'
        : evidence.reportText && (evidence.satisfied || nonSuccessTerminal)
          ? 'report'
        : authoritativeText && latestAuditor && (evidence.satisfied || nonSuccessTerminal)
          ? 'auditor'
          : 'none',
      // The reply is written mid-run (before the completion gate), so it takes
      // its own event time: pinning it last placed it below replies the operator
      // sent after reading it.
      sortTime: finalResponseTime(snapshot),
      sortRound: finalResponseTime(snapshot) ? undefined : Number.MAX_SAFE_INTEGER,
      artifacts: hasExecutionArtifacts(artifacts) ? artifacts : undefined,
    });
  }

  for (const item of [...(snapshot.operator_messages || [])].sort((left, right) => left.created_at - right.created_at)) {
    const time = Number.isFinite(item.created_at) && item.created_at > 0 ? item.created_at : undefined;
    messages.push({
      id: `operator-${item.id}`,
      kind: 'user',
      role: uiText(language, 'You'),
      title: uiText(language, 'You'),
      text: item.text,
      time,
      sortTime: time,
      sortRound: roundForTime(snapshot, time),
    });
  }
  for (const approval of snapshot.approvals) {
    if (approval.status === 'pending' || (!approval.user_input.trim() && !approval.action.trim())) continue;
    const time = approval.resolved_at && Number.isFinite(approval.resolved_at) ? approval.resolved_at : undefined;
    messages.push({
      id: `approval-response-${approval.approval_id}`,
      kind: 'user',
      role: uiText(language, 'You'),
      title: uiText(language, 'You'),
      text: approvalResponseText(approval, language),
      time,
      sortTime: time,
      // Only used when the record has no resolved_at: the round that raised the
      // approval is a better guess than dropping it to the top.
      sortRound: Number.isFinite(approval.round_index) ? approval.round_index : roundForTime(snapshot, time),
    });
  }
  return sortTranscript(messages);
}

export default function App() {
  const { language, text } = useUiLanguage();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState(readRunId);
  const [error, setError] = useState('');
  const [dismissedFeedError, setDismissedFeedError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [composerUploading, setComposerUploading] = useState(false);
  const [reloading, setReloading] = useState(false);
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
  const composerFileInput = useRef<HTMLInputElement | null>(null);
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
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('artifacts');
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [artifactList, setArtifactList] = useState<ArtifactList | null>(null);
  const [artifactError, setArtifactError] = useState('');
  const [artifactName, setArtifactName] = useState('');
  const [artifactText, setArtifactText] = useState('');
  const [artifactReload, setArtifactReload] = useState(0);
  const [trajectoryRole, setTrajectoryRole] = useState('executor');
  const [trajectoryData, setTrajectoryData] = useState<TrajectoryView | null>(null);
  const [trajectoryError, setTrajectoryError] = useState('');
  const [trajectoryReload, setTrajectoryReload] = useState(0);
  const [trajectories, setTrajectories] = useState<Record<string, TrajectoryView>>({});
  const [followLatest, setFollowLatest] = useState(true);
  // Older rounds are folded out of the feed by default; this opens them in place.
  const [showAllRounds, setShowAllRounds] = useState(false);
  const [mobileStatusOpen, setMobileStatusOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const [panelState, dispatchPanel] = useReducer(reducePanelState, DEFAULT_PANEL_STATE);
  const conversationRef = useRef<HTMLElement>(null);
  const operationKeys = useRef(new Map<string, string>());
  const trajectoryInFlight = useRef(new Set<string>());
  const trajectoryLoadedSizes = useRef(new Map<string, number>());
  const trajectoryRequestSeq = useRef(new Map<string, number>());
  const liveTrajectoryInFlight = useRef(new Set<string>());
  const runListGeneration = useRef(0);
  const artifactRequest = useRef(0);
  const trajectoryRequest = useRef(0);

  const feed = useRunFeed(runId, authRevision);
  const snapshot = feed.snapshot;
  const connection = feed.connection;

  const currentRun = runs.find((run) => run.id === runId);
  const statusView = useMemo(() => projectStatus(snapshot), [snapshot]);
  const activeRound = snapshot.active_round ?? statusView.current?.round ?? snapshot.rounds.at(-1)?.round_index ?? null;
  // During a stop/abort transition the backend may clear ``active_role``
  // before the last trajectory flush.  Use the shared status projection as a
  // conservative fallback so the final visible step is not lost.
  const activeRole = snapshot.active_role
    || (statusView.current && statusView.current.key !== 'record' ? statusView.current.key : '');
  const orderedTrajectories = useMemo(() => Object.entries(trajectories)
    .sort(([left], [right]) => {
      const [leftRound, leftRole] = left.split(':');
      const [rightRound, rightRole] = right.split(':');
      const roundDifference = Number(leftRound) - Number(rightRound);
      if (roundDifference) return roundDifference;
      const roleOrder: Record<string, number> = { manager: 0, executor: 1, auditor: 2 };
      return (roleOrder[leftRole] ?? 9) - (roleOrder[rightRole] ?? 9);
    })
    .map(([, trajectory]) => trajectory)
    .slice(-MAX_TRAJECTORY_ROUNDS * 4), [trajectories]);
  const executionArtifacts = useMemo(() => projectArtifactView(orderedTrajectories, { maxFiles: 200, maxValidations: 24 }), [orderedTrajectories]);
  const messages = useMemo(() => conversationFor(snapshot, trajectories, activeRole ? trajectories[`${activeRound}:${activeRole}`] || null : null, executionArtifacts, language, showAllRounds), [snapshot, activeRole, activeRound, trajectories, executionArtifacts, language, showAllRounds]);
  // A stale approval record can survive a stop/crash. Keep it in Details for
  // audit history, but never render an actionable card after lifecycle has
  // become terminal; doing so suggests that clicking it can resume a dead run.
  const pendingApprovalIds = useMemo(() => new Set(statusView.pendingApprovals.map((approval) => approval.id)), [statusView.pendingApprovals]);
  const pendingApprovals = snapshot.approvals.filter((approval) => pendingApprovalIds.has(approval.approval_id));
  const filteredRuns = runs.filter((run) => `${run.id} ${run.task}`.toLowerCase().includes(search.toLowerCase()));
  const commandOptions = availableCommands(capabilities, snapshot, Boolean(runId));
  const visibleError = error || (feed.error && feed.error !== dismissedFeedError ? feed.error : '');
  const typedCommand = parseCommand(instruction);
  const typedCommandName = typedCommand?.name;
  const canCreateRun = meta !== null && capabilities.create_run !== false;
  const canStopRun = capabilities.stop !== false && snapshot.controls.can_abort
    && !terminalLifecycle(snapshot.run.status) && !stoppingLifecycle(snapshot.run.status);
  // Force-kill is offered only while a stop is still visibly stuck: SIGKILL
  // costs the run its final report, so it must not be a same-click alternative
  // to a graceful stop, and it must disappear as soon as the worker does.
  const canAbortRun = capabilities.abort !== false && stopIgnored
    && stoppingLifecycle(snapshot.run.status);
  const canResumeRun = capabilities.resume !== false && snapshot.controls.can_resume;
  // A resumable run accepts typing too: sending reopens the run and delivers the
  // text as the first instruction, so the operator does not have to continue
  // first and then race the worker to type.
  const composerResumes = Boolean(runId) && !snapshot.controls.can_inject && canResumeRun;
  const composerInteractive = Boolean(runId && snapshot.controls.can_inject) || composerResumes;
  const composerCanSend = composerInteractive && Boolean(instruction.trim()) && Boolean(
    typedCommand ? commandOptions.some((item) => item.name === typedCommandName) : true,
  );
  // Sending from a resumable run goes through the lifecycle call, which tracks
  // `controlBusy`; without it the send button stays live and fires twice.
  const composerBusy = busy || (composerResumes && controlBusy);
  const composerPlaceholder = composerResumes
    ? text('Type an instruction and send to continue the run with it')
    : composerInteractive
      ? text('Enter a follow-up instruction')
      : !runId
        ? text('Click “New task” in the sidebar to begin')
        : pendingApprovals.length > 0
          ? text('Resolve the approval request above first')
          : stoppingLifecycle(snapshot.run.status)
            ? text('Stopping the task…')
            : terminalLifecycle(snapshot.run.status)
              ? text('Task ended')
              : text('Input is unavailable during the current stage');
  const composerFooter = composerResumes
    ? text('Sending continues the run')
    : composerInteractive
      ? text('Command')
      : pendingApprovals.length > 0
        ? text('Waiting for your approval')
        : text('Input disabled');

  function operationKey(scope: string, fingerprint: string): { id: string; key: string } {
    const id = `${scope}\u0000${fingerprint}`;
    const existing = operationKeys.current.get(id);
    if (existing) return { id, key: existing };
    const key = idempotencyKey(scope);
    operationKeys.current.set(id, key);
    return { id, key };
  }

  function clearOperationKey(id: string): void {
    operationKeys.current.delete(id);
  }

  function trajectoryIdentity(round: number, role: string): string {
    return `${runId}:${round}:${role}`;
  }

  function beginTrajectoryRequest(requestKey: string): number {
    const next = (trajectoryRequestSeq.current.get(requestKey) || 0) + 1;
    trajectoryRequestSeq.current.set(requestKey, next);
    return next;
  }

  function commitTrajectory(storageKey: string, requestKey: string, requestId: number, next: TrajectoryView, size?: number): void {
    if (trajectoryRequestSeq.current.get(requestKey) !== requestId) return;
    if (typeof size === 'number' && Number.isFinite(size)) trajectoryLoadedSizes.current.set(storageKey, size);
    // The request sequence above rejects responses that started before a newer
    // poll.  Do not use payload length as a freshness signal: when a role ends,
    // the backend rebuilds its live trajectory into a deduplicated normalized
    // file, which can legitimately be shorter than the preceding live view.
    setTrajectories((current) => ({ ...current, [storageKey]: next }));
  }

  useEffect(() => {
    const onRunNotFound = () => setRunId('');
    window.addEventListener('lh-run-not-found', onRunNotFound);
    return () => window.removeEventListener('lh-run-not-found', onRunNotFound);
  }, []);

  useEffect(() => {
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
      // the run while this poll still sees the previous list.  Switching to
      // the first row here loses the newly selected run and makes the UI look
      // as if creation/attach failed.  Keep an explicit selection until the
      // run-scoped feed receives its authoritative 404/4404 signal; only
      // choose a default when there is no selection at all.
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
  }, [runId, authRevision, text]);

  useEffect(() => {
    rememberRunId(runId);
    setTrajectories({});
    trajectoryInFlight.current.clear();
    trajectoryLoadedSizes.current.clear();
    trajectoryRequestSeq.current.clear();
    liveTrajectoryInFlight.current.clear();
    artifactRequest.current += 1;
    trajectoryRequest.current += 1;
    setArtifactList(null);
    setArtifactError('');
    setArtifactName('');
    setArtifactText('');
    setTrajectoryData(null);
    setTrajectoryError('');
    setShowAllRounds(false);
  }, [runId]);

  useEffect(() => {
    if (!feed.error || !/\b401\b/u.test(feed.error)) return;
    setAuthOpen(true);
    setError(text('This Web service requires an access token. Enter it in Connection settings.'));
  }, [feed.error, text]);

  const recentRounds = useMemo(() => {
    const recent = snapshot.rounds.slice(-MAX_TRAJECTORY_ROUNDS);
    if (activeRound !== null && !recent.some((round) => round.round_index === activeRound)) {
      const active = snapshot.rounds.find((round) => round.round_index === activeRound);
      if (active) return [...recent.slice(-(MAX_TRAJECTORY_ROUNDS - 1)), active];
    }
    return recent;
  }, [snapshot.rounds, activeRound]);
  const trajectoryTargets = recentRounds.flatMap((round) => (round.roles || []).map((role) => ({
    key: `${round.round_index}:${role}`,
    requestKey: trajectoryIdentity(round.round_index, role),
    round: round.round_index,
    role,
    size: Number.isFinite(round.role_sizes?.[role]) ? Number(round.role_sizes?.[role]) : -1,
  })));
  const trajectoryKeys = trajectoryTargets.map((target) => `${target.key}@${target.size}`).join('|');
  useEffect(() => {
    if (!runId || !trajectoryKeys) return;
    let cancelled = false;
    const loadAll = async () => {
      const pending = trajectoryTargets.filter((target) => {
        const loadedSize = trajectoryLoadedSizes.current.get(target.key);
        return !Object.hasOwn(trajectories, target.key)
          || (target.size >= 0 && loadedSize !== target.size);
      }).filter((target) => !trajectoryInFlight.current.has(target.requestKey));
      if (!pending.length) return;
      // Four concurrent reads keep a large historical run from opening one
      // request per role/round and still drain the queue in the same effect.
      const queue = [...pending];
      const worker = async () => {
        while (!cancelled) {
          const target = queue.shift();
          if (!target) return;
          trajectoryInFlight.current.add(target.requestKey);
          const requestId = beginTrajectoryRequest(target.requestKey);
          try {
            const trajectory = await fetchTrajectory(runId, target.round, target.role);
            if (!cancelled) commitTrajectory(target.key, target.requestKey, requestId, trajectory, target.size >= 0 ? target.size : undefined);
          } catch {
            // A role file is created lazily; the live poll/snapshot will retry.
          } finally {
            trajectoryInFlight.current.delete(target.requestKey);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
    };
    void loadAll();
    return () => { cancelled = true; };
  // ``trajectoryKeys`` is a compact version vector (round/role/byte size).
  // It changes when a live JSONL file grows, so completed roles also refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, trajectoryKeys, trajectories]);

  // Trajectory files are the live assistant response. Polling them fills the
  // gap between lifecycle events, so the user sees intermediate text while an
  // agent is still thinking/working instead of only seeing the final report.
  useEffect(() => {
    if (!runId || activeRound === null || !activeRole) return;
    let cancelled = false;
    const key = `${activeRound}:${activeRole}`;
    const requestKey = trajectoryIdentity(activeRound, activeRole);
    const load = async () => {
      if (liveTrajectoryInFlight.current.has(requestKey)) return;
      liveTrajectoryInFlight.current.add(requestKey);
      const requestId = beginTrajectoryRequest(requestKey);
      try {
        const next = await fetchTrajectory(runId, activeRound, activeRole);
        if (!cancelled) commitTrajectory(key, requestKey, requestId, next);
      } catch {
        // The role file is created lazily; the next poll will retry.
      } finally {
        liveTrajectoryInFlight.current.delete(requestKey);
      }
    };
    void load();
    const timer = window.setInterval(load, 800);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [runId, activeRound, activeRole]);

  useEffect(() => {
    if (!detailsOpen || !runId) return;
    const requestId = ++artifactRequest.current;
    setArtifactList(null);
    setArtifactError('');
    setArtifactName('');
    setArtifactText('');
    if (selectedRound === null) return () => { artifactRequest.current += 1; };
    void fetchArtifacts(runId, selectedRound)
      .then((next) => { if (requestId === artifactRequest.current) setArtifactList(next); })
      .catch((reason) => { if (requestId === artifactRequest.current) { setArtifactList(null); setArtifactError(String(reason)); } });
    return () => { artifactRequest.current += 1; };
  }, [detailsOpen, runId, selectedRound, artifactReload]);

  useEffect(() => {
    if (!detailsOpen || detailsTab !== 'trajectory' || !runId) return;
    const requestId = ++trajectoryRequest.current;
    setTrajectoryData(null);
    setTrajectoryError('');
    if (selectedRound === null || !trajectoryRole) return () => { trajectoryRequest.current += 1; };
    void fetchTrajectory(runId, selectedRound, trajectoryRole)
      .then((next) => { if (requestId === trajectoryRequest.current) setTrajectoryData(next); })
      .catch((reason) => { if (requestId === trajectoryRequest.current) { setTrajectoryData(null); setTrajectoryError(String(reason)); } });
    return () => { trajectoryRequest.current += 1; };
  }, [detailsOpen, detailsTab, runId, selectedRound, trajectoryRole, trajectoryReload]);

  useEffect(() => {
    if (selectedRound === null) return;
    const roles = snapshot.rounds.find((round) => round.round_index === selectedRound)?.roles || [];
    if (roles.length && !roles.includes(trajectoryRole)) setTrajectoryRole(roles[0]);
  }, [selectedRound, snapshot.rounds, trajectoryRole]);

  useEffect(() => {
    if (followLatest && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [messages, pendingApprovals.length, snapshot.run.status, followLatest]);

  // Measure how long the run stays in `stopping` locally rather than comparing
  // `stop_requested_at` against the browser clock, which may be skewed from the
  // server's. An abort already requested needs no second escalation offer.
  useEffect(() => {
    const stopping = stoppingLifecycle(snapshot.run.status);
    const alreadyAborting = String(snapshot.run.requested_action || '') === 'abort';
    if (!stopping || alreadyAborting) {
      setStopIgnored(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setStopIgnored(true), STOP_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [runId, snapshot.run.status, snapshot.run.requested_action, snapshot.run.stop_requested_at]);

  useEffect(() => {
    if (!mobileStatusOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileStatusOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileStatusOpen]);

  useEffect(() => {
    if (!detailsOpen && !authOpen) return undefined;
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
  }, [detailsOpen, authOpen]);

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
      if (command.name === 'help') { setError(commandHelpText(capabilities, snapshot, Boolean(runId), language)); setInstruction(''); return; }
      if (command.name === 'details' || command.name === 'events' || command.name === 'artifacts' || command.name === 'trajectory') {
        const panel = command.name as PanelName;
        dispatchPanel({ type: 'open', panel });
        setDetailsTab(panel === 'details' ? 'artifacts' : panel);
        setSelectedRound(activeRound);
        setDetailsOpen(true);
        setInstruction('');
        return;
      }
      if (command.name === 'runs') { setError(runs.map((run) => `${run.id} · ${run.task || 'Untitled task'}`).join('\n') || text('No tasks yet')); setInstruction(''); return; }
      if (command.name === 'attach') {
        if (!command.args[0]) setError(text('Usage: /attach <run_id>'));
        else setRunId(command.args[0]);
        setInstruction('');
        return;
      }
      if (command.name === 'new') {
        const parsed = parseNewRunArgs(command.args);
        if (parsed.error || !parsed.task) {
          setError(parsed.error ? commandErrorText(parsed.error, language) : text('Usage: /new <task> [--language en] [--effort level] [--manager-agent id] [--manager-model id] [--manager-effort level] [--executor-agent id] [--executor-model id] [--executor-effort level] [--auditor-agent id] [--auditor-model id] [--auditor-effort level] [--workspace path] [--rounds n]'));
          setInstruction('');
          return;
        }
        setControlBusy(true); setError('');
        const selectedAgent = parsed.agent || meta?.defaults?.agent || meta?.agents?.find((item) => item.available !== false)?.id || 'claude_code';
        const selectedModel = parsed.model || (parsed.agent ? undefined : meta?.defaults?.model);
        const payload = {
          task: parsed.task,
          agent: selectedAgent,
          model: selectedModel,
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
      setError(text('This task has ended or cannot accept input. Use /new, /attach, /resume, or open Details.'));
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
    }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  /** Deliver a resume instruction once the reopened worker accepts injections. */
  async function queueResumeInstruction(targetRunId: string, messageText: string) {
    const requestKey = idempotencyKey('instruction');
    const createdAt = Date.now() / 1000;
    feed.appendOperatorMessage({ id: requestKey, text: messageText, created_at: createdAt, status: 'queued' });
    // The worker is forked asynchronously, so `can_control` stays false for a
    // moment and the API answers 409.  Bounded retries keep a genuine rejection
    // (revoked capability, run replaced) from looping forever.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await postInstruction(targetRunId, messageText, requestKey);
        await feed.refresh();
        return;
      } catch (reason) {
        if (!isConflict(reason) || attempt === 19) {
          feed.appendOperatorMessage({ id: requestKey, text: messageText, created_at: createdAt, status: 'failed' });
          setError(text('The follow-up instruction could not be delivered. Send it again once the task is running.'));
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
        // Stop/Abort changes supervisor control state without appending a role
        // event. Refresh immediately so the header and rail switch to
        // "stopping" instead of waiting for the next WebSocket lifecycle poll.
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

  async function openArtifact(round: number, name: string) {
    const requestId = ++artifactRequest.current;
    setArtifactName(name);
    if (isImageArtifact(name)) {
      setArtifactText('');
      return;
    }
    setArtifactText(text('Loading…'));
    try {
      const text = await fetchArtifact(runId, round, name);
      if (requestId === artifactRequest.current) setArtifactText(text);
    }
    catch (reason) { if (requestId === artifactRequest.current) setArtifactText(String(reason)); }
  }

  async function submitNewRun(task: string, roles: Record<PublicRole, RoleRuntimeConfig>, workspace: string, maxRounds: string, promptLanguage: 'en', capabilities: string[]) {
    setControlBusy(true); setError('');
    const manager = roles.manager;
    const payload = { task, agent: manager.agent, model: manager.model || undefined, roles, workspace: workspace || undefined, max_rounds: normaliseMaxRounds(maxRounds), prompt_language: promptLanguage, capabilities };
    const request = operationKey('create', JSON.stringify(payload));
    try {
      const created = await createRun(payload, request.key);
      setRunId(created.id); setCreatingNew(false); setDetailsOpen(false);
      clearOperationKey(request.id);
    } catch (reason) { setError(String(reason)); }
    finally { setControlBusy(false); }
  }

  async function refreshModelCatalogue() {
    const next = await refreshModels();
    setMeta(next);
    setCapabilities(next.capabilities);
  }

  const connectionLabel = !runId
    ? text('Idle')
    : connection === 'connected' ? text('Connected')
    : connection === 'loading' ? text('Connecting')
    : connection === 'reconnecting' ? text('Reconnecting')
    : connection === 'closed' ? text('Disconnected')
    : text('Connection error');

  return (
    <div className="codex-shell codex-workbench">
      <aside className="codex-sidebar">
        <div className="codex-brand"><span className="codex-mark"><Sparkles size={14} /></span><span>LongHorizon</span></div>
        <button className="new-task-button" onClick={() => { setCreatingNew(true); setDetailsOpen(true); }} disabled={!canCreateRun}><Plus size={14} />{text('New task')}</button>
        <label className="session-search"><span><Search size={13} /></span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={text('Search tasks')} /></label>
        <div className="session-label">{text('Tasks')} <span>{runs.length}</span></div>
        <div className="session-list">
          {filteredRuns.map((run) => <button key={run.id} className={`session-item ${run.id === runId ? 'selected' : ''}`} onClick={() => setRunId(run.id)}><span className={statusClass(run.status)} /><span className="session-copy"><strong>{run.task || 'Untitled task'}</strong><small>{run.id}</small></span></button>)}
          {!filteredRuns.length && <div className="sidebar-empty">{text('No tasks yet')}</div>}
        </div>
        <div className="sidebar-footer">
          <span className="connection-state" title={`${connectionLabel} · ${text('Local workspace')}`}><span className={`connection-dot connection-${runId ? connection : 'idle'}`} /><span className="connection-copy"><span className="connection-phase">{connectionLabel}<span className="connection-sep">·</span></span>{' '}<span className="connection-phase">{text('Local workspace')}</span></span></span>
          <span className="connection-actions"><button type="button" className="connection-settings" onClick={() => setAuthOpen(true)} title={text('Connection settings')} aria-label={text('Connection settings')}><KeyRound size={13} /></button>{meta?.capabilities?.reload && <button type="button" className="connection-settings" disabled={reloading} onClick={() => void reloadHarness()} title={text('Reload the harness (restart on current source)')} aria-label={text('Reload the harness')}><RotateCw size={13} className={reloading ? 'reload-spin' : ''} /></button>}</span>
        </div>
      </aside>

      <main className="codex-main">
        <header className="codex-header"><div className="header-context"><span className="header-folder"><PanelTop size={16} /></span><strong className="header-title">{currentRun?.task || runId || text('New task')}</strong><span className="header-more"><Ellipsis size={16} /></span></div><div className="header-actions"><span className={statusClass(snapshot.run.status)} /><span className="header-status">{statusLabel(snapshot.run.status, Boolean(statusView.finalResponse), language)}</span><button className="mobile-status-button" onClick={() => setMobileStatusOpen((open) => !open)} aria-label={text('Open task status')} title={text('Task status')}><PanelRight size={14} /><span>{text('Status')}</span></button>{canStopRun && <button onClick={() => void lifecycle('stop')} disabled={controlBusy} title={text('Let the worker finish up and write its report')}>{text('Stop')}</button>}{canAbortRun && <button className="danger-text" onClick={() => void lifecycle('abort')} disabled={controlBusy} title={text('The stop did not take effect. Force-kill the process; this run will not write a report')}>{text('Force stop')}</button>}{canResumeRun && <button onClick={() => void lifecycle('resume')} disabled={controlBusy} title={text('Continue from the rounds already finished instead of starting over')}>{text('Continue')}</button>}{canResumeRun && <button onClick={() => void lifecycle('restart')} disabled={controlBusy} title={text('Start a new task from round 1 with the same task and configuration')}>{text('Restart')}</button>}<button className="details-button" disabled={!runId} onClick={() => { if (!runId) return; setCreatingNew(false); setSelectedRound(activeRound); dispatchPanel({ type: 'open', panel: 'details' }); setDetailsOpen(true); }} aria-label={text('View details')} title={runId ? text('Details') : text('Select a task to view details')}><FolderOpen size={14} /><span>{text('Details')}</span></button></div></header>

        <section className="conversation" aria-label="LongHorizon conversation" ref={conversationRef} onScroll={(event) => { const node = event.currentTarget; setFollowLatest(node.scrollHeight - node.scrollTop - node.clientHeight < 48); }}>
          {!runId && <div className="welcome"><div className="welcome-mark"><Sparkles size={20} /></div><h1>{text('What do you want to accomplish?')}</h1><p>{text('Start a real LongHorizon task. Plans, intermediate work, verification, and the final answer will appear here as they happen.')}</p>{meta && !canCreateRun && <p className="welcome-note">{text('This connection is read-only. Start ')}<code>lh-harness web</code>{text(' to create tasks.')}</p>}{!meta && <p className="welcome-note">{text('Connecting to the Web service…')}</p>}<button className="welcome-button" disabled={!canCreateRun} onClick={() => { setCreatingNew(true); setDetailsOpen(true); }}><Plus size={15} />{text('Start task')}</button></div>}
          {runId && messages.map((message) => message.kind === 'history'
            ? <HistoryToggle key={message.id} hidden={message.hidden || 0} total={snapshot.rounds.length} expanded={showAllRounds} onToggle={() => setShowAllRounds((open) => !open)} />
            : <ConversationMessage key={message.id} message={message} />)}
          {runId && !messages.length && <div className="empty-conversation"><span className="thinking-dot" />{text('Waiting for LongHorizon to start…')}</div>}
          {['running', 'starting', 'stopping', 'aborting'].includes(snapshot.run.status) && <div className="working-line" role="status" aria-live="polite"><span className="thinking-dot" /><span>{snapshot.run.status === 'stopping' || snapshot.run.status === 'aborting' ? text('Finishing up and stopping the worker') : activeRole ? text(`${roleTitle(activeRole)} is working`) : text('LongHorizon is working')}</span></div>}
          {statusView.awaitingHandoff && <div className="working-line" role="status" aria-live="polite"><span className="thinking-dot" /><span>{text('Submitted. Waiting for the worker to pick it up…')}</span></div>}
          {pendingApprovals.map((approval) => <ApprovalCard key={approval.approval_id} approval={approval} busy={busy} userInput={approvalInputs[approval.approval_id] || ''} onUserInput={(value) => setApprovalInputs((current) => ({ ...current, [approval.approval_id]: value }))} extraRounds={approvalRounds[approval.approval_id] || ''} onExtraRounds={(value) => setApprovalRounds((current) => ({ ...current, [approval.approval_id]: value }))} onApprove={approve} />)}
        </section>

        {visibleError && <div className="error-line" role="alert" aria-live="assertive"><span><AlertTriangle size={14} /></span>{visibleError}<button onClick={() => { setError(''); setDismissedFeedError(feed.error); }}>{text('Dismiss')}</button></div>}
        <div className={`composer-wrap ${composerInteractive ? '' : 'composer-disabled'}`}><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void sendInstruction(); } }} placeholder={composerPlaceholder} disabled={composerBusy || !composerInteractive} /><div className="composer-footer"><span>{composerFooter}{composerInteractive && <> · <kbd>⌘</kbd><kbd>↵</kbd> {text('Send')}</>}</span><span className="composer-actions"><button type="button" className="composer-attach" title={text('Attach files to this message')} aria-label={text('Attach files to this message')} disabled={composerBusy || !composerInteractive || composerUploading} onClick={() => composerFileInput.current?.click()}><Paperclip size={13} />{composerUploading ? text('Uploading…') : text('Attach')}</button><input ref={composerFileInput} type="file" multiple hidden onChange={(event) => { void attachToInstruction(event.target.files); event.target.value = ''; }} /><button onClick={() => void sendInstruction()} disabled={composerBusy || !composerCanSend || composerUploading}>{text('Send')}</button></span></div></div>
      </main>

      {mobileStatusOpen && <button type="button" className="status-mobile-backdrop" onClick={() => setMobileStatusOpen(false)} aria-label={text('Close task status')} />}
      <StatusPanel
        view={statusView}
        snapshot={snapshot}
        connection={connection}
        mobileOpen={mobileStatusOpen}
        onMobileClose={() => setMobileStatusOpen(false)}
        onDetails={() => {
          setCreatingNew(false);
          setSelectedRound(activeRound);
          dispatchPanel({ type: 'open', panel: 'details' });
          setDetailsOpen(true);
        }}
      />

      {detailsOpen && <DetailsDrawer creating={creatingNew} runId={runId} snapshot={snapshot} meta={meta} selectedRound={selectedRound} setSelectedRound={setSelectedRound} tab={panelState.panel === 'details' ? detailsTab : panelState.panel} setTab={(tab) => { setDetailsTab(tab); dispatchPanel({ type: 'open', panel: tab === 'artifacts' && panelState.panel === 'details' ? 'details' : tab }); }} artifactList={artifactList} artifactError={artifactError} artifactName={artifactName} artifactText={artifactText} openArtifact={openArtifact} retryArtifacts={() => setArtifactReload((value) => value + 1)} trajectoryRole={trajectoryRole} setTrajectoryRole={setTrajectoryRole} trajectoryData={trajectoryData} trajectoryError={trajectoryError} retryTrajectory={() => setTrajectoryReload((value) => value + 1)} onClose={() => { dispatchPanel({ type: 'close' }); setDetailsOpen(false); setCreatingNew(false); }} onCreate={submitNewRun} onRefreshModels={refreshModelCatalogue} controlBusy={controlBusy} />}
      {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onSaved={() => { setAuthOpen(false); setAuthRevision((value) => value + 1); setError(''); setDismissedFeedError(''); }} />}
    </div>
  );
}

function localizedNextStep(view: StatusView, language: UiLanguage): string {
  if (view.nextStepKey === 'approval') return uiText(language, 'Resolve the pending approval to continue.');
  if (view.nextStepKey === 'gui') return uiText(language, 'Execute the GUI subtask.');
  if (view.nextStepKey === 'cli') return uiText(language, 'Execute the CLI subtask.');
  if (view.nextStepKey === 'ask') return /waiting for your input/iu.test(view.nextStep) ? uiText(language, 'Waiting for your input.') : view.nextStep;
  if (view.nextStepKey === 'blocked') return uiText(language, 'Resolve the blocker before continuing.');
  if (view.nextStepKey === 'invalid') return uiText(language, 'The Manager needs to revise the current plan.');
  if (view.nextStepKey === 'done') return view.status === 'done' ? uiText(language, 'The task is complete. No further action is needed.') : uiText(language, 'Waiting for final verification.');
  if (view.nextStepKey === 'stopping') return uiText(language, 'Stopping the run and waiting for the worker to finish.');
  if (view.nextStepKey === 'manager') return uiText(language, 'The Manager is preparing the next step.');
  if (view.nextStepKey === 'executor') return uiText(language, 'The Executor is carrying out the plan.');
  if (view.nextStepKey === 'auditor') return uiText(language, 'The Auditor is verifying the latest result.');
  if (view.nextStepKey === 'record') return uiText(language, 'Record this round and continue.');
  if (view.nextStepKey === 'custom') return view.nextStep;
  if (/^start manager planning\.?$/iu.test(view.nextStep)) return uiText(language, 'Waiting for the Manager to create a plan.');
  if (/^no further action\.?$/iu.test(view.nextStep)) return uiText(language, 'The task has ended. No further action is needed.');
  return view.nextStep;
}

function localizedRoleSummary(role: StatusView['roleStatuses'][number], language: UiLanguage): string {
  if (role.status === 'skipped') return uiText(language, 'Not triggered in this round.');
  const summary = role.summary.trim();
  if (!summary || /^No .+ output recorded\.?$/iu.test(summary)) return uiText(language, 'No output recorded yet.');
  if (/^done$/iu.test(summary)) return uiText(language, 'Completed.');
  if (/^Status:\s*complete\b/iu.test(summary)) return uiText(language, 'Audit passed; the result is complete.');
  if (/^Status:\s*(?:incomplete|blocked)\b/iu.test(summary)) return uiText(language, 'The audit found an issue that needs attention.');
  return summary;
}

/** Clamped text that expands in place when there is more to read.
 *
 * Role summaries can be a single unbroken path or command far wider than the
 * rail, so they are clamped to a few lines and only opened on request. The
 * toggle is a real button so keyboard and screen-reader users get the same
 * affordance, and `lh-clamp` keeps the collapsed height stable.
 */
function ExpandableText({ text: value, lines = 2 }: { text: string; lines?: number }) {
  const { text } = useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  // Measured rather than guessed from length: whether the text overflows
  // depends on the rail width and on where the string can wrap.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setClamped(node.scrollHeight - node.clientHeight > 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, lines, expanded]);
  const toggleable = clamped || expanded;
  return <span className="lh-clamp-wrap">
    <span
      ref={ref}
      className={`lh-clamp ${expanded ? 'lh-clamp-open' : ''}`}
      style={expanded ? undefined : { WebkitLineClamp: lines }}
      title={toggleable && !expanded ? value : undefined}
    >{value}</span>
    {toggleable && <button type="button" className="lh-clamp-toggle" onClick={() => setExpanded((open) => !open)}>
      {expanded ? text('Show less') : text('Show more')}
    </button>}
  </span>;
}

function localizedStageStatus(status: string, _language: UiLanguage): string {
  return status === 'active' ? 'Current stage' : status === 'stopping' ? 'Stopping' : status === 'waiting' ? 'Awaiting approval' : status === 'done' ? 'Result recorded' : status === 'failed' ? 'Needs attention' : status === 'blocked' ? 'Blocked' : status === 'cancelled' ? 'Stopped' : status === 'skipped' ? 'Not triggered' : 'Waiting for prior stage';
}

function StatusPanel({ view, snapshot, connection, mobileOpen, onMobileClose, onDetails }: { view: StatusView; snapshot: Snapshot; connection: string; mobileOpen: boolean; onMobileClose: () => void; onDetails: () => void }) {
  const { language, text } = useUiLanguage();
  const hasRun = Boolean(view.runId && view.task.trim());
  const round = view.rounds.find((item) => item.round === (view.currentRound ?? view.activeRound)) || view.rounds.at(-1);
  const stages = round?.stages.filter((stage) => stage.key !== 'record') || view.stages.filter((stage) => stage.key !== 'record').slice(-3);
  const roleItems = hasRun ? view.roleStatuses : [];
  // `record` is a persistence marker, not an operator-visible stage. Use the
  // same execution-stage denominator for the chain counter and progress bar.
  const executionStages = view.stages.filter((stage) => stage.key !== 'record' && stage.status !== 'skipped');
  const roundExecutionStages = stages.filter((stage) => stage.key !== 'record' && stage.status !== 'skipped');
  const doneCount = roundExecutionStages.filter((stage) => stage.status === 'done').length;
  const totalCount = roundExecutionStages.length;
  const percent = Math.round(view.progress.ratio * 100);
  const nextStep = hasRun ? localizedNextStep(view, language) : text('Create or select a task.');
  const routedTask = view.nextStepDetail ? managerPlanSummary(view.nextStepDetail, 180) : '';
  const nextDetail = !hasRun
    ? text('The actual Manager, Executor, and Auditor results will appear here after the task starts.')
    : routedTask
    ? routedTask
    : view.nextStepDetail
    ? compactText(view.nextStepDetail.replace(/^Current task state:\s*/iu, '').replace(/^Completed:\s*/iu, text('Completed: ')), 180)
    : text('Status updates automatically as Manager, Executor, and Auditor results arrive.');
  const connectionLabel = !hasRun ? text('No task selected') : connection === 'connected' ? (['done', 'failed', 'blocked', 'cancelled'].includes(view.status) ? text('Synced') : text('Live')) : connection === 'loading' ? text('Connecting') : connection === 'reconnecting' ? text('Reconnecting') : connection === 'closed' ? text('Disconnected') : text('Connection error');
  const localized = statusLabel(view.runStatus || view.status, Boolean(view.finalResponse), language);
  const resultLabel = view.status === 'failed'
    ? text('Failed')
    : view.status === 'blocked'
      ? text('Incomplete')
        : view.status === 'cancelled'
          ? text('Stopped')
          : view.runStatus === 'aborting' || view.runStatus === 'aborted'
            ? text('Aborting')
            : view.status === 'stopping'
              ? text('Stopping')
              : view.status === 'done'
                ? text('Complete')
                : text('In progress');
  const roundBudget = Number(snapshot.run.max_rounds || 0);
  const budgetSuffix = roundBudget > 0 ? ` / ${roundBudget}` : '';
  const roundLabel = view.activeRound !== null ? text(`Round ${view.activeRound}${budgetSuffix}`) : view.currentRound !== null ? text(`Latest R${view.currentRound}${budgetSuffix}`) : text('Not started');
  const roleState = (status: string) => status === 'active' ? text('In progress') : status === 'stopping' ? text('Stopping') : status === 'waiting' ? text('Awaiting approval') : status === 'done' ? text('Completed') : status === 'failed' ? text('Failed') : status === 'blocked' ? text('Blocked') : status === 'skipped' ? text('Not triggered') : text('Pending');
  return <aside className={`status-panel ${mobileOpen ? 'mobile-open' : ''}`} aria-label={text('Task status panel')} aria-live="polite">
    <div className="status-panel-head"><div><span className="status-eyebrow">RUN STATUS</span><h2>{text('Task status')}</h2></div><div className="status-panel-head-actions"><span className={`status-panel-dot phase-${view.status} connection-${hasRun ? connection : 'idle'}`} title={`${localized} · ${connectionLabel}`} /><button className="status-mobile-close" onClick={onMobileClose} aria-label={text('Close task status')}><X size={16} /></button></div></div>
    <div className="status-overview"><div className="status-overview-line"><strong>{localized}</strong><span>{connectionLabel}</span></div><p>{view.taskSummary || text('No task selected')}</p><div className={`status-progress status-progress-${view.status}`}><i style={{ width: `${percent}%` }} /></div><div className="status-progress-meta"><span>{executionStages.length ? text(`${percent}% overall · ${resultLabel}${totalCount ? ` · This round ${doneCount}/${totalCount}` : ''}`) : hasRun ? text('Waiting for the first round') : text('Not started')}</span><span>{roundLabel}</span></div></div>
    <section className="status-section"><div className="status-section-title"><span>{text('Execution chain')}</span><small>{totalCount ? `${doneCount}/${totalCount}` : '—'}</small></div>{stages.length ? <ol className="status-stage-list">{stages.filter((stage) => stage.key !== 'record').map((stage) => <li className={`status-stage stage-${stage.status}`} key={stage.id}><span className="stage-marker">{stage.status === 'done' ? <Check size={10} /> : stage.status === 'failed' ? <X size={10} /> : stage.status === 'active' || stage.status === 'stopping' ? <LoaderCircle className="trajectory-spinner" size={10} /> : stage.status === 'waiting' ? <CircleDotDashed size={10} /> : stage.status === 'blocked' ? <AlertTriangle size={10} /> : <Circle size={8} />}</span><div><strong>{stage.label}</strong><small>{localizedStageStatus(stage.status, language)}</small></div></li>)}</ol> : <p className="status-empty-copy">{text('No round results yet. Each stage will appear here after the task starts.')}</p>}</section>
    <section className="status-section"><div className="status-section-title"><span>{text('Next step')}</span><small>{round ? (view.activeRound !== null ? `R${round.round}` : text(`Latest R${round.round}`)) : '—'}</small></div><div className="status-next-step"><span className="status-next-icon"><ArrowRight size={13} /></span><div><strong>{nextStep}</strong><p>{nextDetail}</p></div></div></section>
    {hasRun && <section className="status-section"><div className="status-section-title"><span>{text('Role output')}</span><small>{roleItems.length}</small></div><div className="status-role-list">{roleItems.map((role) => <div className="status-role-row" key={role.key}><span className={`role-marker phase-${role.status}`}>{role.key === 'manager' ? 'M' : role.key === 'executor' ? 'E' : 'A'}</span><div className="status-role-copy"><div><strong>{role.label}</strong><span className={`role-status-text phase-${role.status}`}>{roleState(role.status)}</span></div><small><ExpandableText text={localizedRoleSummary(role, language)} lines={2} /></small></div></div>)}</div></section>}
    {(view.pendingApprovals.length > 0 || view.warnings.length > 0) && <section className="status-section status-notices"><div className="status-section-title"><span>{text('Needs attention')}</span><small>{view.pendingApprovals.length + view.warnings.length}</small></div>{view.pendingApprovals.length > 0 && <div className="status-notice notice-approval"><span><AlertTriangle size={11} /></span><div><strong>{text('Waiting for your approval')}</strong><small>{text(`${view.pendingApprovals.length} approval request${view.pendingApprovals.length === 1 ? '' : 's'} paused the task`)}</small></div></div>}{view.warnings.map((warning, index) => <div className="status-notice notice-warning" key={`${warning}-${index}`}><span><AlertTriangle size={11} /></span><div><strong>{text('Run notice')}</strong><small>{compactText(warning, 180)}</small></div></div>)}</section>}
    {hasRun && <button className="status-details-link" onClick={onDetails}>{text('View artifacts, trajectory, and events')} <ExternalLink size={13} /></button>}
  </aside>;
}

const ACTIVITY_ICONS: Record<ActivityAction, LucideIcon> = {
  read: BookOpen,
  edit: FilePenLine,
  validate: FlaskConical,
  search: Search,
  task: ListChecks,
  screenshot: Camera,
  command: SquareTerminal,
  result: CheckCircle2,
  note: CircleDotDashed,
};

function TrajectoryIcon({ action, status }: { action: ActivityAction; status: string }) {
  const Icon = status === 'failed' ? XCircle : status === 'running' ? LoaderCircle : ACTIVITY_ICONS[action];
  return <Icon className={status === 'running' ? 'trajectory-spinner' : ''} size={15} strokeWidth={1.8} />;
}

function TrajectorySteps({ steps }: { steps: ActivityStep[] }) {
  const { text } = useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  if (!steps.length) return null;
  const hidden = Math.max(0, steps.length - 10);
  const visibleSteps = expanded || !hidden ? steps : steps.slice(-10);
  return <div className="trajectory-steps" aria-label={text('Intermediate steps')}>
    {hidden > 0 && <button type="button" className="trajectory-history-toggle" onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}<span>{expanded ? text('Hide earlier steps') : text(`Show ${hidden} earlier steps`)}</span></button>}
    {visibleSteps.map((step, index) => {
    const summary = step.summary || step.text || '';
    const detail = step.detail && step.detail !== summary ? step.detail : '';
    const links = step.links || [];
    const images = step.images || [];
    const status = step.status || 'done';
    const action = step.action || 'note';
    return <article className={`trajectory-step-row trajectory-${status} action-${action}`} key={step.id || `${step.kind}-${index}`}>
      <span className="trajectory-step-icon" aria-hidden="true"><TrajectoryIcon action={action} status={status} /></span>
      <div className="trajectory-step-main"><div className="trajectory-step-head"><strong>{step.title || (step.kind === 'tool_use' ? text('Tool call') : text('Step result'))}</strong><span>{status === 'running' ? text('In progress') : status === 'failed' ? text('Failed') : text('Completed')}</span></div>{summary && <p>{summary}</p>}{step.result && <div className={`trajectory-result trajectory-result-${status}`}>{status === 'failed' ? <CircleX size={13} /> : status === 'running' ? <LoaderCircle className="trajectory-spinner" size={13} /> : <CircleCheck size={13} />}<span>{step.result}</span></div>}{links.length > 0 && <div className="trajectory-links">{links.slice(0, 3).map((href) => <a href={href} target="_blank" rel="noreferrer" key={href}>{href.replace(/^https?:\/\//u, '').slice(0, 58)} <ExternalLink size={11} /></a>)}</div>}{images.length > 0 && <ImageGallery images={images} label={text('intermediate screenshot')} />}{step.imageWarning && <div className="trajectory-image-warning"><AlertTriangle size={12} /><span>{step.imageWarning}</span></div>}{detail && <details className="trajectory-detail"><summary>{text('View raw details')}</summary><pre>{detail}</pre></details>}</div>
    </article>;
  })}</div>;
}

function fileVisual(file: FileChangeItem): { Icon: LucideIcon; tone: string } {
  const extension = file.extension || '';
  if (['ts', 'tsx', 'js', 'jsx'].includes(extension)) return { Icon: Braces, tone: 'file-tone-script' };
  if (extension === 'json') return { Icon: FileJson2, tone: 'file-tone-data' };
  if (['md', 'txt', 'rst'].includes(extension)) return { Icon: FileText, tone: 'file-tone-text' };
  if (['py', 'go', 'rs', 'java', 'css', 'scss', 'html', 'sh', 'zsh', 'yaml', 'yml', 'toml'].includes(extension)) return { Icon: FileCode2, tone: 'file-tone-code' };
  return { Icon: FileText, tone: 'file-tone-default' };
}

function FilePathRow({ file }: { file: FileChangeItem }) {
  const { text } = useUiLanguage();
  const [copied, setCopied] = useState(false);
  const { Icon, tone } = fileVisual(file);
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return <li className="edited-file-row">
    <span className={`edited-file-icon ${tone}`} aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>
    <span className="edited-file-path" title={file.path}>{file.path}</span>
    {file.additions !== null && file.deletions !== null && <span className="edited-file-lines"><span>+{file.additions}</span><span>-{file.deletions}</span></span>}
    <button type="button" className="copy-path-button" onClick={() => void copyPath()} title={copied ? text('Copied') : text('Copy path')} aria-label={text(`Copy path ${file.path}`)}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
  </li>;
}

function EditedFilesCard({ projection }: { projection: ArtifactProjection['files'] }) {
  const { text } = useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  if (!projection.totalFiles) return null;
  const previewCount = 3;
  const knownHidden = Math.max(0, projection.items.length - previewCount);
  const unknownPaths = Math.max(0, projection.totalFiles - projection.items.length);
  const visibleFiles = expanded ? projection.items : projection.items.slice(0, previewCount);
  const exactLines = projection.lineCountCoverage === 'complete' && projection.additions !== null && projection.deletions !== null;
  const title = projection.scope === 'agent'
    ? text(`Edited ${projection.totalFiles} file${projection.totalFiles === 1 ? '' : 's'}`)
    : text(`Detected ${projection.totalFiles} workspace change${projection.totalFiles === 1 ? '' : 's'}`);
  return <section className="edited-files-card" aria-label={title}>
    <header className="edited-files-head"><span className="edited-files-mark" aria-hidden="true"><Files size={20} strokeWidth={1.7} /></span><div><strong>{title}</strong>{projection.scope === 'workspace' && <small>{text('From the workspace diff; not attributed to the Agent')}</small>}</div>{exactLines && <span className="edited-files-total"><span>+{projection.additions}</span><span>-{projection.deletions}</span></span>}</header>
    {visibleFiles.length > 0 && <ul className="edited-file-list">{visibleFiles.map((file) => <FilePathRow file={file} key={`${file.previousPath || ''}:${file.path}`} />)}</ul>}
    {unknownPaths > 0 && <p className="edited-files-unknown">{text(`${unknownPaths} additional file path${unknownPaths === 1 ? '' : 's'} were not listed in the current trajectory`)}</p>}
    {knownHidden > 0 && <button type="button" className="edited-files-toggle" onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}<span>{expanded ? text('Hide files') : text(`Show ${knownHidden} more file${knownHidden === 1 ? '' : 's'}`)}</span></button>}
  </section>;
}

function validationOperationLabel(operation: ValidationResultSummary['operations'][number], language: UiLanguage): string {
  const labels = { test: 'Tests', typecheck: 'Type check', build: 'Build', lint: 'Lint', 'diff-check': 'Diff check' };
  return labels[operation];
}

function ValidationIcon({ status }: { status: ValidationResultSummary['status'] }) {
  if (status === 'passed') return <CircleCheck size={17} strokeWidth={1.9} />;
  if (status === 'failed') return <CircleX size={17} strokeWidth={1.9} />;
  if (status === 'running') return <LoaderCircle className="trajectory-spinner" size={17} strokeWidth={1.9} />;
  return <CircleDotDashed size={17} strokeWidth={1.9} />;
}

function ValidationResults({ projection }: { projection: ArtifactProjection['validations'] }) {
  const { language, text } = useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  if (!projection.total) return null;
  const visibleItems = expanded ? projection.items : projection.items.slice(-6);
  const hidden = Math.max(0, projection.items.length - visibleItems.length);
  return <section className="validation-results" aria-label={text('Validation results')}>
    <div className="evidence-section-title"><span><ShieldCheck size={16} />{text('Validation results')}</span><small>{text(`${projection.passed} passed`)}{projection.failed ? text(` · ${projection.failed} failed`) : ''}{projection.running ? text(` · ${projection.running} running`) : ''}</small></div>
    <div className="validation-list">{visibleItems.map((item) => <article className={`validation-row validation-${item.status}`} key={item.id}>
      <span className="validation-icon" aria-hidden="true"><ValidationIcon status={item.status} /></span>
      <div className="validation-main"><div className="validation-head"><strong>{item.label || 'Validation'}</strong><span>{item.operations.map((operation) => validationOperationLabel(operation, language)).join(' / ')}</span><small>R{item.roundIndex} · {roleTitle(item.role)}</small></div><div className="validation-summary">
        {item.passedCount !== null && <code>{text(`${item.passedCount} passed`)}</code>}
        {item.failedCount !== null && item.failedCount > 0 && <code className="validation-failed-chip">{text(`${item.failedCount} failed`)}</code>}
        {item.skippedCount !== null && item.skippedCount > 0 && <code>{text(`${item.skippedCount} skipped`)}</code>}
        {item.moduleCount !== null && <code>{text(`${item.moduleCount} modules`)}</code>}
        {item.passedCount === null && item.failedCount === null && item.moduleCount === null && <span>{item.status === 'running' ? text('Running') : item.status === 'passed' ? text('Passed') : item.status === 'failed' ? text('Failed') : item.summary}</span>}
      </div><details className="validation-detail"><summary>{text('View command')}</summary><code>{item.command}</code></details></div>
    </article>)}</div>
    {(hidden > 0 || expanded && projection.items.length > 6) && <button type="button" className="validation-toggle" onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}<span>{expanded ? text('Hide earlier results') : text(`Show ${hidden} earlier results`)}</span></button>}
  </section>;
}

function ExecutionArtifacts({ projection, live }: { projection: ArtifactProjection; live: boolean }) {
  const { text } = useUiLanguage();
  if (!hasExecutionArtifacts(projection)) return null;
  return <div className={`execution-artifacts ${live ? 'execution-artifacts-live' : ''}`}>
    <div className="execution-artifacts-label"><Sparkles size={14} /><span>{live ? text('Live execution artifacts') : text('Execution artifacts')}</span>{live && <small>{text('Updates with the trajectory')}</small>}</div>
    <EditedFilesCard projection={projection.files} />
    <ValidationResults projection={projection.validations} />
  </div>;
}

function HistoryToggle({ hidden, total, expanded, onToggle }: { hidden: number; total: number; expanded: boolean; onToggle: () => void }) {
  const { text } = useUiLanguage();
  return <article className="conversation-message message-history">
    <div className="message-avatar"><History size={12} /></div>
    <div className="message-body">
      <div className="message-meta"><strong>{expanded ? text(`All ${total} rounds shown`) : text(`${hidden} earlier rounds hidden`)}</strong></div>
      <p className="history-note">{expanded
        ? text('The full history is in the feed. Collapsing keeps only the most recent rounds rendered, which keeps long tasks responsive.')
        : text('Older rounds are folded away so long tasks stay responsive. Open them here, or inspect them in Details → Trajectory / Events.')}</p>
      <button type="button" className="history-toggle" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        <span>{expanded ? text('Collapse earlier rounds') : text(`Show ${hidden} earlier rounds`)}</span>
      </button>
    </div>
  </article>;
}

function ConversationMessage({ message }: { message: ConversationMessage }) {
  const { text } = useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  const [showInput, setShowInput] = useState(false);
  // One threshold for every role card: per-kind limits made otherwise identical
  // messages clip inconsistently, which reads as a rendering glitch.
  const clipped = !expanded && message.text.length > CONVERSATION_TEXT_LIMIT;
  const displayText = clipped ? `${message.text.slice(0, CONVERSATION_TEXT_LIMIT).trimEnd()}…` : message.text;
  const isAgent = ['plan', 'assistant', 'verification'].includes(message.kind);
  return <article className={`conversation-message message-${message.kind}`}><div className="message-avatar">{message.kind === 'user' ? text('You') : message.kind === 'final' ? <Sparkles size={12} /> : message.role.slice(0, 1)}</div><div className="message-body"><div className="message-meta"><strong>{message.title}</strong>{message.time && <time>{formatTime(message.time)}</time>}</div>{isAgent && message.input && <><button className="agent-input-row" onClick={() => setShowInput((current) => !current)}><span className="agent-step-icon"><ArrowRight size={14} /></span><span className="agent-input-copy"><small>{text('Input')}</small>{compactText(message.input, 220)}</span><span className="agent-chevron">{showInput ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>{showInput && <div className="agent-input-expanded"><MessageText text={message.input} /></div>}<div className="agent-output-label">{message.kind === 'plan' ? text('Plan summary') : message.kind === 'verification' ? text('Verification result') : text('Execution result')}</div></>}{message.activity && message.activity.length > 0 && <TrajectorySteps steps={message.activity} />}<MessageText text={displayText} />{message.artifacts && <ExecutionArtifacts projection={message.artifacts} live={message.kind === 'live'} />}{(clipped || expanded) && <button type="button" className="message-expand" onClick={() => setExpanded((open) => !open)}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}<span>{expanded ? text('Show less') : text('Show full output')}</span></button>}{message.kind === 'plan' && <span className="message-hint">{text('Internal prompts are hidden; only the actionable summary is shown')}</span>}{message.kind === 'final' && <span className={`final-badge final-authority-${message.authority || 'none'}`}>{message.authority === 'final_response' ? text('LongHorizon final response') : message.authority === 'report' ? text('Auditor final report') : message.authority === 'auditor' ? text('Auditor verification') : text('Awaiting authoritative report')}</span>}</div></article>;
}

function ImageGallery({ images, label }: { images: string[]; label: string }) {
  const { text } = useUiLanguage();
  const [selected, setSelected] = useState<string | null>(null);
  const stageDismiss = useBackdropDismiss(() => setSelected(null));
  const [fitToWindow, setFitToWindow] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const attempted = useRef(new Set<string>());
  const blobUrls = useRef(new Map<string, string>());
  const activeSources = useRef(new Set(images));
  const mounted = useRef(true);
  activeSources.current = new Set(images);

  const retry = (source: string) => {
    const objectUrl = blobUrls.current.get(source);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    blobUrls.current.delete(source);
    attempted.current.delete(source);
    setResolved((current) => {
      const next = { ...current };
      delete next[source];
      return next;
    });
    setFailed((current) => {
      const next = { ...current };
      delete next[source];
      return next;
    });
  };

  // A gallery can live for the duration of a long run. Revoke object URLs as
  // soon as their source leaves the projection, and always release the
  // remaining URLs when the gallery unmounts.
  const imageKey = images.join('\u0000');
  useEffect(() => {
    const active = new Set(images.filter((source) => source.startsWith('/api/')));
    const activeImages = new Set(images);
    for (const [source, objectUrl] of blobUrls.current.entries()) {
      if (!active.has(source)) {
        URL.revokeObjectURL(objectUrl);
        blobUrls.current.delete(source);
      }
    }
    for (const source of attempted.current) {
      if (!active.has(source)) attempted.current.delete(source);
    }
    setResolved((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([source]) => active.has(source)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setFailed((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([source]) => activeImages.has(source)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [imageKey]);

  useEffect(() => {
    // React StrictMode replays effect setup/cleanup in development. Reset the
    // flag in setup so the real mounted pass can still accept completed loads.
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const objectUrl of blobUrls.current.values()) URL.revokeObjectURL(objectUrl);
      blobUrls.current.clear();
    };
  }, []);

  useEffect(() => {
    // `resolved[source]` is intentionally allowed to be an empty string after
    // a failed request. Use key presence, not truthiness, so a broken image is
    // rendered once as unavailable instead of entering an infinite retry loop.
    const pending = [...new Set(images.filter((source) => source.startsWith('/api/')
      && !Object.hasOwn(resolved, source)
      && !attempted.current.has(source)))];
    if (!pending.length) return undefined;
    pending.forEach((source) => attempted.current.add(source));
    void Promise.all(pending.map(async (source) => {
      try {
        const objectUrl = await fetchImageSource(source);
        return [source, objectUrl] as const;
      } catch {
        return [source, ''] as const;
      }
    })).then((items) => {
      const accepted = items.filter(([source, objectUrl]) => {
        if (mounted.current && activeSources.current.has(source)) return true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return false;
      });
      if (!mounted.current || !accepted.length) return;
      for (const [source, objectUrl] of accepted) if (objectUrl) blobUrls.current.set(source, objectUrl);
      setResolved((current) => ({ ...current, ...Object.fromEntries(accepted) }));
    });
    // Do not cancel an in-flight fetch just because the SSE feed caused a
    // rerender. `attempted` prevents a duplicate request, while `activeSources`
    // rejects and releases results for images that really left the gallery.
    return undefined;
  }, [imageKey, resolved]);

  useEffect(() => {
    if (!selected) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
      if (event.key === '+' || event.key === '=') { setFitToWindow(false); setZoom((value) => Math.min(4, value + 0.25)); }
      if (event.key === '-') { setFitToWindow(false); setZoom((value) => Math.max(0.25, value - 0.25)); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  const openImage = (source: string) => {
    setNaturalSize({ width: 0, height: 0 });
    setZoom(1);
    setFitToWindow(true);
    setSelected(source);
  };

  if (!images.length) return null;
  return <>
    <div className="image-gallery" aria-label={label}>
      {images.map((source, index) => { const apiSource = source.startsWith('/api/'); const pending = apiSource && !Object.hasOwn(resolved, source); const display = apiSource ? resolved[source] : source; const unavailable = !pending && (!display || failed[source]); return <button type="button" className={`image-thumb-button ${unavailable ? 'image-thumb-unavailable' : ''}`} key={`${source.slice(0, 32)}-${index}`} onClick={() => unavailable ? retry(source) : display && openImage(display)} aria-label={unavailable ? text(`Retry ${label} ${index + 1}`) : text(`View ${label} ${index + 1}`)} disabled={pending}>{pending ? <span>{text('Loading image…')}</span> : unavailable ? <span>{text('Image unavailable · Click to retry')}</span> : <img className="image-thumb" src={display} alt={`${label} ${index + 1}`} loading="lazy" onError={() => setFailed((current) => ({ ...current, [source]: true }))} />}</button>; })}
    </div>
    {selected && createPortal(<div className="image-lightbox" role="dialog" aria-modal="true" aria-label={text('Image preview')}>
      <div className="image-lightbox-toolbar">
        <button type="button" onClick={() => { setFitToWindow(false); setZoom((value) => Math.max(0.25, value - 0.25)); }} aria-label={text('Zoom out')}><ZoomOut size={17} /></button>
        <button type="button" className={fitToWindow ? 'active' : ''} onClick={() => setFitToWindow(true)}>{text('Fit to window')}</button>
        <button type="button" className={!fitToWindow && zoom === 1 ? 'active' : ''} onClick={() => { setFitToWindow(false); setZoom(1); }}>100%</button>
        <button type="button" onClick={() => { setFitToWindow(false); setZoom((value) => Math.min(4, value + 0.25)); }} aria-label={text('Zoom in')}><ZoomIn size={17} /></button>
        <span>{fitToWindow ? text('Fit') : `${Math.round(zoom * 100)}%`}{naturalSize.width ? ` · ${naturalSize.width}×${naturalSize.height}` : ''}</span>
        <button type="button" className="image-lightbox-close" onClick={() => setSelected(null)} aria-label={text('Close image preview')}><X size={19} /></button>
      </div>
      <div className="image-lightbox-stage" {...stageDismiss}>
        <img
          className={`image-lightbox-image ${fitToWindow ? 'image-lightbox-image-fit' : ''}`}
          src={selected}
          alt={text('Enlarged preview')}
          style={!fitToWindow && naturalSize.width ? { width: `${naturalSize.width * zoom}px`, maxWidth: 'none', maxHeight: 'none' } : undefined}
          onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
      </div>
    </div>, document.body)}
  </>;
}

function TrajectoryDetail({ data, error, onRetry }: { data: TrajectoryView | null; error?: string; onRetry?: () => void }) {
  const { text } = useUiLanguage();
  const [visibleCount, setVisibleCount] = useState(MAX_TRAJECTORY_STEPS);
  useEffect(() => setVisibleCount(MAX_TRAJECTORY_STEPS), [data?.round_index, data?.role, data?.raw_chars]);
  if (error) return <div className="drawer-pre trajectory-detail-list">{/^No round results/u.test(error) ? <span className="drawer-muted">{error}</span> : <div className="drawer-error-state"><span className="drawer-error">{text('Failed to load trajectory: ')}{compactText(error, 240)}</span>{onRetry && <button type="button" onClick={onRetry}>{text('Retry')}</button>}</div>}</div>;
  if (!data) return <div className="drawer-pre trajectory-detail-list">{text('Select a role trajectory.')}</div>;
  const displaySteps = data.steps
    .map((step, sourceIndex) => ({ step, sourceIndex }))
    .filter(({ step }) => !isTrajectoryNoise(trajectoryStepText(step)));
  const total = displaySteps.length;
  const visible = Math.min(total, visibleCount);
  const start = Math.max(0, total - visible);
  const hidden = start;
  return <div className="drawer-pre trajectory-detail-list">
    {hidden > 0 && <button type="button" className="trajectory-detail-more" onClick={() => setVisibleCount((count) => Math.min(total, count + MAX_TRAJECTORY_STEPS))}>{text(`Show ${hidden} earlier steps`)}</button>}
    {data.warning && <p className="drawer-muted">{data.warning}</p>}
    {displaySteps.slice(start).map(({ step, sourceIndex }) => {
      const stepText = trajectoryStepText(step);
      const imageProjection = stepImageProjection(step);
      const images = imageProjection.images;
      return <section className="trajectory-detail-step" key={`trajectory-${sourceIndex}`}><div className="trajectory-detail-heading">{String(sourceIndex + 1).padStart(2, '0')} <span>{String(step.kind || 'step').toUpperCase()}</span></div>{stepText && <pre>{stepText}</pre>}{images.length > 0 && <ImageGallery images={images} label={text('intermediate screenshot')} />}{imageProjection.omittedLargeDataUrls > 0 && <div className="trajectory-image-warning"><AlertTriangle size={12} /><span>{text(`${imageProjection.omittedLargeDataUrls} screenshots over 2 MB were hidden`)}</span></div>}</section>;
    })}
    {total > MAX_TRAJECTORY_STEPS && <small className="drawer-field-note">{text(`Showing the latest ${visible} of ${total} steps. Load earlier results as needed.`)}</small>}
  </div>;
}

// ---------------------------------------------------------------------------
// Markdown rendering
//
// Manager plans, auditor reports and executor summaries are authored as
// markdown, so the conversation renders the block structure the agents wrote:
// headings, ordered/unordered (and nested) lists, quotes, rules and fenced
// code, with inline code/emphasis/links inside every one of them. A plan read
// as one undifferentiated paragraph is the single worst way to review it.
// ---------------------------------------------------------------------------

const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>"'`]+)/gu;

function inlineMessageText(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(INLINE_PATTERN)) {
    const part = match[0];
    const index = match.index ?? cursor;
    if (index > cursor) nodes.push(<span key={`text-${cursor}`}>{value.slice(cursor, index)}</span>);
    if (part.startsWith('`')) {
      nodes.push(<code key={`code-${index}`}>{part.slice(1, -1)}</code>);
    } else if (part.startsWith('**') || part.startsWith('__')) {
      nodes.push(<strong key={`strong-${index}`}>{part.slice(2, -2)}</strong>);
    } else if (part.startsWith('*')) {
      nodes.push(<em key={`em-${index}`}>{part.slice(1, -1)}</em>);
    } else if (part.startsWith('[')) {
      const split = part.indexOf('](');
      const label = part.slice(1, split);
      const href = normalizeLink(part.slice(split + 2, -1));
      nodes.push(href
        ? <a href={href} target="_blank" rel="noreferrer" key={`link-${index}`}>{label}</a>
        : <span key={`text-${index}`}>{part}</span>);
    } else {
      const href = normalizeLink(part);
      nodes.push(href
        ? <a href={href} target="_blank" rel="noreferrer" key={`link-${index}`}>{href}</a>
        : <span key={`text-${index}`}>{part}</span>);
    }
    cursor = index + part.length;
  }
  if (cursor < value.length) nodes.push(<span key={`text-${cursor}`}>{value.slice(cursor)}</span>);
  return nodes.length ? nodes : [<span key="text-empty">{value}</span>];
}

type MarkdownListItem = { depth: number; ordered: boolean; value?: number; text: string };
type MarkdownBlock =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: MarkdownListItem[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'paragraph'; lines: string[] };

const MD_FENCE = /^\s{0,3}(?:```|~~~)/u;
const MD_RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const MD_HEADING = /^ {0,3}(#{1,6})\s+(.*)$/u;
const MD_QUOTE = /^ {0,3}>\s?(.*)$/u;
const MD_BULLET = /^(\s*)[-*+•]\s+(.*)$/u;
const MD_ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/u;
const MD_TASK = /^\[([ xX])\]\s+(.*)$/u;

function startsBlock(line: string): boolean {
  return MD_FENCE.test(line) || MD_HEADING.test(line) || MD_RULE.test(line) || MD_QUOTE.test(line)
    || MD_BULLET.test(line) || MD_ORDERED.test(line);
}

/** Indent width in "levels": two spaces (or one tab) per nesting level, capped. */
function listDepth(indent: string): number {
  return Math.min(4, Math.floor(indent.replace(/\t/gu, '  ').length / 2));
}

function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (MD_FENCE.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !MD_FENCE.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1; // the closing fence, or the end of the text
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (!line.trim()) { index += 1; continue; }

    if (MD_RULE.test(line)) { blocks.push({ kind: 'rule' }); index += 1; continue; }

    const heading = MD_HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      index += 1;
      continue;
    }

    if (MD_QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = MD_QUOTE.exec(lines[index]!);
        if (!match) break;
        quoted.push(match[1]!);
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    if (MD_BULLET.test(line) || MD_ORDERED.test(line)) {
      const items: MarkdownListItem[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        if (!current.trim()) {
          // A blank line only ends the list when no further item follows it.
          const next = lines[index + 1];
          if (next && (MD_BULLET.test(next) || MD_ORDERED.test(next))) { index += 1; continue; }
          break;
        }
        const bullet = MD_BULLET.exec(current);
        const ordered = bullet ? null : MD_ORDERED.exec(current);
        if (bullet) {
          items.push({ depth: listDepth(bullet[1]!), ordered: false, text: bullet[2]! });
          index += 1;
          continue;
        }
        if (ordered) {
          items.push({ depth: listDepth(ordered[1]!), ordered: true, value: Number(ordered[2]), text: ordered[3]! });
          index += 1;
          continue;
        }
        if (startsBlock(current) || !items.length) break;
        // A plain line under an item is that item's continuation.
        items[items.length - 1]!.text += ` ${current.trim()}`;
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (!current.trim() || startsBlock(current)) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }

  return blocks;
}

function ListItemBody({ text }: { text: string }) {
  const task = MD_TASK.exec(text);
  if (!task) return <>{inlineMessageText(text)}</>;
  return <><span className={`message-task ${task[1]! === ' ' ? '' : 'message-task-done'}`} aria-hidden="true">{task[1]! === ' ' ? '☐' : '☑'}</span>{inlineMessageText(task[2]!)}</>;
}

function MarkdownList({ items, keyPrefix }: { items: MarkdownListItem[]; keyPrefix: string }) {
  const base = items.reduce((least, item) => Math.min(least, item.depth), items[0]?.depth ?? 0);
  const rows: { item: MarkdownListItem; children: MarkdownListItem[] }[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    index += 1;
    const children: MarkdownListItem[] = [];
    while (index < items.length && items[index]!.depth > base) {
      children.push(items[index]!);
      index += 1;
    }
    rows.push({ item, children });
  }
  const ordered = rows[0]?.item.ordered ?? false;
  const start = ordered ? rows[0]?.item.value ?? 1 : undefined;
  const children = rows.map((row, rowIndex) => <li key={`${keyPrefix}-${rowIndex}`} className={MD_TASK.test(row.item.text) ? 'message-task-item' : undefined}>
    <ListItemBody text={row.item.text} />
    {row.children.length > 0 && <MarkdownList items={row.children} keyPrefix={`${keyPrefix}-${rowIndex}`} />}
  </li>);
  return ordered
    ? <ol start={start === 1 ? undefined : start}>{children}</ol>
    : <ul>{children}</ul>;
}

function MessageText({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return <div className="message-text">{blocks.map((block, index) => {
    switch (block.kind) {
      case 'code':
        return <pre className="message-code" key={index}><code>{block.text}</code></pre>;
      case 'heading':
        return <h3 className={`message-heading message-heading-${block.level}`} key={index}>{inlineMessageText(block.text)}</h3>;
      case 'list':
        return <MarkdownList items={block.items} keyPrefix={`list-${index}`} key={index} />;
      case 'quote':
        return <blockquote className="message-quote" key={index}>{block.lines.map((line, lineIndex) => <p key={lineIndex}>{inlineMessageText(line)}</p>)}</blockquote>;
      case 'rule':
        return <hr className="message-rule" key={index} />;
      default:
        return <p key={index}>{block.lines.map((line, lineIndex) => <span key={lineIndex}>{inlineMessageText(line)}{lineIndex < block.lines.length - 1 && <br />}</span>)}</p>;
    }
  })}</div>;
}

function ApprovalCard({ approval, busy, userInput, onUserInput, extraRounds, onExtraRounds, onApprove }: { approval: Snapshot['approvals'][number]; busy: boolean; userInput: string; onUserInput: (value: string) => void; extraRounds: string; onExtraRounds: (value: string) => void; onApprove: (id: string, action: string, userInput?: string, extraRounds?: number) => void }) {
  const { text } = useUiLanguage();
  const options = approval.options.length ? approval.options : [{ value: 'continue', label: 'Continue' }, { value: 'stop', label: 'Stop', style: 'danger' }];
  const completed = approval.context?.trigger === 'completed' || approval.title === 'Task complete. Continue the run?';
  const title = completed ? text('The result is ready. End the task?') : approval.title;
  const message = completed ? text('The Manager confirmed the task is complete and the final answer is shown above. You can end the task or continue with another round.') : approval.message;
  const inputPlaceholder = approval.input_label && !/^Optional/i.test(approval.input_label) ? approval.input_label : text('Optional: enter an answer or instruction');
  const optionLabel = (label: string) => /continue/i.test(label) ? text('Continue run') : /end/i.test(label) ? text('End task') : /stop/i.test(label) ? text('Stop') : label;
  // Older servers omit the flag; fall back to the triggers that are known to
  // grant rounds so the input does not disappear against a mixed deployment.
  const allowRounds = approval.allow_extra_rounds ?? ['completed', 'max_rounds', 'repeated_failure'].includes(String(approval.context?.trigger || ''));
  const roundsValue = extraRounds.trim();
  const roundsInvalid = roundsValue !== '' && !(/^\d+$/.test(roundsValue) && Number(roundsValue) >= 1 && Number(roundsValue) <= MAX_ROUNDS);
  const roundsPayload = () => (roundsValue === '' || roundsInvalid ? undefined : Number(roundsValue));
  return <article className="approval-card"><div className="message-avatar approval-avatar"><AlertTriangle size={12} /></div><div className="message-body"><div className="message-meta"><strong>{title}</strong><span className="approval-label">{text('Input required')}</span></div><MessageText text={message} />{approval.allow_input && <textarea className="approval-input" value={userInput} onChange={(event) => onUserInput(event.target.value)} placeholder={inputPlaceholder} disabled={busy} />}{allowRounds && <label className="approval-rounds">{text('Extra rounds when continuing')}<input type="number" min={1} max={MAX_ROUNDS} step={1} value={extraRounds} disabled={busy} placeholder={text('Blank = keep the configured round budget')} onChange={(event) => onExtraRounds(event.target.value)} /><span className={roundsInvalid ? 'approval-rounds-error' : 'approval-rounds-note'}>{roundsInvalid ? text(`Enter a whole number from 1 to ${MAX_ROUNDS}`) : text('Only affects “Continue run”')}</span></label>} {approval.answers.length > 0 && <div className="approval-answers" aria-label={text('Quick answers')}>{approval.answers.map((answer) => <button type="button" key={answer} disabled={busy || roundsInvalid} onClick={() => onApprove(approval.approval_id, 'continue', answer, roundsPayload())}>{answer}</button>)}</div>}<div className="approval-actions">{options.map((option) => <button key={option.value} disabled={busy || (roundsInvalid && option.value !== 'stop')} className={option.style === 'danger' ? 'danger-text' : ''} onClick={() => onApprove(approval.approval_id, option.value, undefined, option.value === 'stop' ? undefined : roundsPayload())}>{optionLabel(option.label)}</button>)}</div></div></article>;
}

function RoleRuntimePicker({ role, selection, meta, onChange }: { role: typeof PUBLIC_ROLES[number]; selection: RoleSelection; meta: WebMeta | null; onChange: (value: RoleSelection) => void }) {
  const { text } = useUiLanguage();
  const agentChoices = meta?.agents?.length
    ? meta.agents.map((item) => ({ id: item.id, label: item.label || item.id, availability: agentAvailability(item), version: item.version || '', problem: item.problem || '' }))
    : [{ id: 'claude_code', label: 'Claude Code' }].map((item) => ({ ...item, availability: 'unknown' as const, version: '', problem: '' }));
  const discovered = normalizedModelChoices(
    meta?.models?.[selection.agent] || meta?.agents?.find((item) => item.id === selection.agent)?.models,
  );
  const choices = discovered.length ? discovered : MODEL_PRESETS[selection.agent] || [];
  const providerDefault = defaultModel(meta, selection.agent) || 'provider default';
  const selectValue = selection.custom
    ? '__custom__'
    : selection.model && choices.some((choice) => choice.id === selection.model)
      ? selection.model
      : selection.model ? '__custom__' : '';
  const discovery = meta?.model_discovery?.[selection.agent]
    || meta?.agents?.find((item) => item.id === selection.agent)?.discovery;
  const discoveryNote = discovery?.account_scoped
    ? text(`Detected ${choices.length} models from the current account.`)
    : discovery?.warning || text('The provider will verify model availability when the worker starts.');
  const backendScopeNote = '';
  const roleDescription = role.id === 'manager'
    ? text('Planning, routing, and completion decisions')
    : role.id === 'executor'
      ? text('Executes GUI and CLI subtasks')
      : text('Independent verification and acceptance');
  const agentSuffix = (item: typeof agentChoices[number]) => item.availability === 'missing'
    ? text(' · Not installed')
    : item.availability === 'found_but_broken'
      ? text(' · Installed but not runnable')
      : item.version ? ` · ${item.version}` : '';
  const selectedAgentEntry = agentChoices.find((item) => item.id === selection.agent);
  const brokenAgent = selectedAgentEntry?.availability === 'found_but_broken' ? selectedAgentEntry : null;
  const reasoning = agentEntry(meta, selection.agent)?.reasoning;
  const effortChoices = reasoningChoicesFor(meta, selection.agent, selection.model || '');
  const effort = selection.reasoning_effort || '';
  const effortSelectValue = selection.effortCustom
    ? '__custom__'
    : effort && effortChoices.some((choice) => choice.id === effort)
      ? effort
      : effort ? '__custom__' : '';
  const effortProviderDefault = reasoning?.provider_default
    ? text(`Provider default (your codex config: ${reasoning.provider_default})`)
    : text('Provider default');
  const effortNote = !reasoning?.supported
    ? reasoning?.note || text('This harness exposes no reasoning-effort switch.')
    : selection.effortCustom || (effort && !effortChoices.some((choice) => choice.id === effort))
      ? reasoning.validation === 'silently_ignored'
        ? text('Note: this harness ignores an unrecognised value and silently continues at its default effort instead of failing.')
        : text('A custom effort is not in the detected list. If the provider rejects it, the task fails immediately with the reason.')
      : reasoning.scope === 'per_model'
        ? text('The available tiers follow the selected model and come from the current session.')
        : text(`The tiers come from ${reasoning.source === 'cli_help' ? 'the CLI itself' : 'a built-in list'}.`);
  return <section className="role-runtime-card">
    <div className="role-runtime-title"><span className="role-runtime-mark">{role.label[0]}</span><div><strong>{role.label}</strong><small>{roleDescription}</small></div></div>
    <div className="role-runtime-grid">
      <label className="drawer-field"><span>Harness</span><select value={selection.agent} onChange={(event) => onChange({ agent: event.target.value, model: '', custom: false, reasoning_effort: '', effortCustom: false })}>{agentChoices.map((choice) => <option value={choice.id} key={choice.id} disabled={choice.availability === 'missing'}>{choice.label}{agentSuffix(choice)}</option>)}</select></label>
      <label className="drawer-field"><span>Model</span><select value={selectValue} onChange={(event) => { const value = event.target.value; onChange(value === '__custom__' ? { ...selection, model: '', custom: true } : { ...selection, model: value, custom: false }); }}><option value="">{text(`Provider default (${providerDefault})`)}</option>{choices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label}</option>)}<option value="__custom__">{text('Custom model…')}</option></select></label>
    </div>
    {selection.custom && <input className="role-runtime-custom" autoFocus value={selection.model || ''} onChange={(event) => onChange({ ...selection, model: event.target.value })} placeholder={text('Enter a model name exposed by the provider')} />}
    {brokenAgent && <small className="drawer-field-note agent-broken">{text('This harness is on PATH but cannot run: ')}{compactText(brokenAgent.problem, 200)}</small>}
    <label className="drawer-field"><span>{text('Reasoning effort')}</span><select value={effortSelectValue} disabled={!reasoning?.supported} onChange={(event) => { const value = event.target.value; onChange(value === '__custom__' ? { ...selection, reasoning_effort: '', effortCustom: true } : { ...selection, reasoning_effort: value, effortCustom: false }); }}><option value="">{effortProviderDefault}</option>{effortChoices.map((choice) => <option value={choice.id} key={choice.id} title={choice.description}>{choice.label}{choice.description ? ` · ${choice.description}` : ''}</option>)}{reasoning?.supported && <option value="__custom__">{text('Custom effort…')}</option>}</select></label>
    {selection.effortCustom && <input className="role-runtime-custom" autoFocus value={selection.reasoning_effort || ''} onChange={(event) => onChange({ ...selection, reasoning_effort: event.target.value })} placeholder={text('Enter an effort value this harness accepts')} />}
    <small className="drawer-field-note">{effortNote}</small>
    <small className={`drawer-field-note ${discovery?.account_scoped ? 'model-detected' : ''}`}>{selection.custom ? text('You may try a custom model that was not detected. If it is unavailable, unauthorized, or the credentials are invalid, the task will fail immediately with the provider reason.') : [backendScopeNote, discoveryNote].filter(Boolean).join(' ')}</small>
  </section>;
}

type Attachment = { id: string; name: string; bytes: number; status: 'uploading' | 'done' | 'error'; path?: string; error?: string };

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The Manager only sees the task text, so attached files are announced there by workspace-relative path. */
function taskWithAttachments(task: string, attachments: Attachment[]): string {
  const done = attachments.filter((item) => item.status === 'done' && item.path);
  if (!done.length) return task;
  const lines = done.map((item) => `- ${item.path} (${formatBytesShort(item.bytes)})`);
  return `${task}\n\nInput files (already uploaded to the workspace's \`inbox/\` folder; use these workspace-relative paths):\n${lines.join('\n')}`;
}

function DetailsDrawer({ creating, runId, snapshot, meta, selectedRound, setSelectedRound, tab, setTab, artifactList, artifactError, artifactName, artifactText, openArtifact, retryArtifacts, trajectoryRole, setTrajectoryRole, trajectoryData, trajectoryError, retryTrajectory, onClose, onCreate, onRefreshModels, controlBusy }: { creating: boolean; runId: string; snapshot: Snapshot; meta: WebMeta | null; selectedRound: number | null; setSelectedRound: (value: number) => void; tab: DetailsTab; setTab: (value: DetailsTab) => void; artifactList: ArtifactList | null; artifactError?: string; artifactName: string; artifactText: string; openArtifact: (round: number, name: string) => Promise<void>; retryArtifacts?: () => void; trajectoryRole: string; setTrajectoryRole: (value: string) => void; trajectoryData: TrajectoryView | null; trajectoryError?: string; retryTrajectory?: () => void; onClose: () => void; onCreate: (task: string, roles: Record<PublicRole, RoleRuntimeConfig>, workspace: string, maxRounds: string, promptLanguage: 'en', capabilities: string[]) => Promise<void>; onRefreshModels: () => Promise<void>; controlBusy: boolean }) {
  const { language, text } = useUiLanguage();
  const backdrop = useBackdropDismiss(onClose);
  const [task, setTask] = useState('');
  const [roleSelections, setRoleSelections] = useState<Record<PublicRole, RoleSelection>>({
    manager: { agent: 'claude_code', model: '', custom: false, reasoning_effort: '', effortCustom: false },
    executor: { agent: 'claude_code', model: '', custom: false, reasoning_effort: '', effortCustom: false },
    auditor: { agent: 'claude_code', model: '', custom: false, reasoning_effort: '', effortCustom: false },
  });
  const rolesInitialised = useRef(false);
  const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
  const [modelRefreshError, setModelRefreshError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const externalTools = meta?.external_tools ?? [];
  const [grantedTools, setGrantedTools] = useState<Record<string, boolean>>({});
  const toolsInitialised = useRef(false);
  useEffect(() => {
    if (toolsInitialised.current || !externalTools.length) return;
    setGrantedTools(Object.fromEntries(externalTools.map((tool) => [tool.id, Boolean(tool.always_on || tool.default_on)])));
    toolsInitialised.current = true;
  }, [externalTools]);
  const selectedCapabilities = externalTools.filter((tool) => tool.always_on || grantedTools[tool.id]).map((tool) => tool.id);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const uploadsBusy = attachments.some((item) => item.status === 'uploading');
  async function attachFiles(list: FileList | null) {
    if (!list?.length) return;
    const target = workspace.trim() || undefined;
    for (const file of Array.from(list)) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((current) => [...current, { id, name: file.name, bytes: file.size, status: 'uploading' }]);
      try {
        const stored = await uploadFile(file, target);
        setAttachments((current) => current.map((item) => item.id === id ? { ...item, status: 'done', path: stored.path, name: stored.name, bytes: stored.bytes } : item));
      } catch (reason) {
        setAttachments((current) => current.map((item) => item.id === id ? { ...item, status: 'error', error: compactText(String(reason instanceof Error ? reason.message : reason), 120) } : item));
      }
    }
  }
  const [maxRounds, setMaxRounds] = useState('25');
  const [roundLimit, setRoundLimit] = useState(MAX_TRAJECTORY_ROUNDS);
  useEffect(() => {
    if (!meta || rolesInitialised.current) return;
    const fallbackAgent = defaultAgent(meta);
    setRoleSelections(Object.fromEntries(PUBLIC_ROLES.map(({ id }) => {
      const configured = meta.defaults?.roles?.[id];
      const roleAgent = configured?.agent || fallbackAgent;
      return [id, { agent: roleAgent, model: configured?.model || '', custom: false, reasoning_effort: configured?.reasoning_effort || '', effortCustom: false }];
    })) as Record<PublicRole, RoleSelection>);
    rolesInitialised.current = true;
  }, [meta]);
  const roundChoices = useMemo(() => {
    const recent = snapshot.rounds.slice(-roundLimit);
    if (selectedRound !== null && !recent.some((round) => round.round_index === selectedRound)) {
      const selected = snapshot.rounds.find((round) => round.round_index === selectedRound);
      return selected ? [selected, ...recent] : recent;
    }
    return recent;
  }, [snapshot.rounds, roundLimit, selectedRound]);
  const hiddenRounds = Math.max(0, snapshot.rounds.length - roundChoices.length);
  const roles = snapshot.rounds.find((round) => round.round_index === selectedRound)?.roles || [];
  const events = dedupeEvents(snapshot.events).slice(-80);
  const resolvedRoles = Object.fromEntries(PUBLIC_ROLES.map(({ id }) => {
    const selection = roleSelections[id];
    const effort = selection.reasoning_effort?.trim() || '';
    return [id, {
      agent: selection.agent,
      model: selection.model?.trim() || defaultModel(meta, selection.agent),
      // Omitted rather than sent empty so the backend keeps "follow the
      // provider default" distinct from an explicit value.
      ...(effort ? { reasoning_effort: effort } : {}),
    }];
  })) as Record<PublicRole, RoleRuntimeConfig>;
  return <div className="drawer-backdrop" {...backdrop}><aside className={`details-drawer ${creating ? 'create-drawer' : ''}`} role="dialog" aria-modal="true" aria-label={creating ? text('Create new task') : text('Task details')}>
    <div className="drawer-header"><div><div className="drawer-eyebrow">{creating ? text('NEW TASK') : text('TASK DETAILS')}</div><h2>{creating ? text('Create a LongHorizon task') : text('Details')}</h2></div><button className="drawer-close" onClick={onClose} aria-label={text('Close')}><X size={18} /></button></div>
    {creating ? <>
      <p className="drawer-copy">{text('A real worker will execute the task. The status panel tracks progress while the conversation shows readable step results.')}</p>
      <label className="drawer-field"><span>{text('Task')}</span><textarea autoFocus value={task} onChange={(event) => setTask(event.target.value)} placeholder={text('What should LongHorizon do?')} /></label>
      <div className="drawer-field attach-field"><span>{text('Input files')} <small>{text('optional · uploaded now to <workspace>/inbox/')}</small></span>
        <div className="attach-row"><button type="button" className="attach-button" disabled={controlBusy} onClick={() => fileInput.current?.click()}><Paperclip size={14} />{text('Attach files')}</button><input ref={fileInput} type="file" multiple hidden onChange={(event) => { void attachFiles(event.target.files); event.target.value = ''; }} /><small className="attach-hint">{text('Set Workspace first if you use one. Files are listed in the task as inbox/<name>.')}</small></div>
        {attachments.length > 0 && <ul className="attach-list">{attachments.map((item) => <li key={item.id} className={`attach-item attach-${item.status}`}><span className="attach-name" title={item.name}>{item.path || item.name}</span><span className="attach-meta">{formatBytesShort(item.bytes)}{item.status === 'uploading' ? ` · ${text('uploading…')}` : item.status === 'error' ? ` · ${item.error}` : ''}</span><button type="button" className="attach-remove" aria-label={text('Remove from task')} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><X size={12} /></button></li>)}</ul>}
      </div>
      <div className="role-runtime-head"><div><strong>{text('Role runtime configuration')}</strong><small>{text('Choose Claude Code and a model independently for each role')}</small></div><button type="button" disabled={modelRefreshBusy} onClick={() => { setModelRefreshBusy(true); setModelRefreshError(''); void onRefreshModels().catch((reason) => setModelRefreshError(String(reason))).finally(() => setModelRefreshBusy(false)); }}>{modelRefreshBusy ? text('Detecting…') : text('Refresh models')}</button></div>
      {modelRefreshError && <div className="drawer-error-state"><span className="drawer-error">{text('Model detection failed: ')}{compactText(modelRefreshError, 240)}</span></div>}
      <div className="role-runtime-list">{PUBLIC_ROLES.map((role) => <RoleRuntimePicker key={role.id} role={role} selection={roleSelections[role.id]} meta={meta} onChange={(value) => setRoleSelections((current) => ({ ...current, [role.id]: value }))} />)}</div>
      <label className="drawer-field"><span>{text('Max rounds')} <small>1–{MAX_ROUNDS}</small></span><input inputMode="numeric" type="text" pattern="[0-9]*" value={maxRounds} onChange={(event) => setMaxRounds(event.target.value.replace(/\D+/gu, ''))} onBlur={() => setMaxRounds(String(normaliseMaxRounds(maxRounds)))} /></label>
      <label className="drawer-field"><span>Workspace <small>{text('optional')}</small></span><input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder={text('Use the Web server workspace root')} /></label>
      {externalTools.length > 0 && <div className="drawer-field tools-field"><span>{text('External tools')} <small>{text('what this run may use')}</small></span>
        <ul className="tools-list">{externalTools.map((tool) => {
          const on = Boolean(tool.always_on || grantedTools[tool.id]);
          const blocked = !tool.always_on && !tool.credential_ready;
          return <li key={tool.id} className={`tool-item ${on ? 'tool-on' : ''}`}>
            <label className="tool-toggle"><input type="checkbox" checked={on} disabled={Boolean(tool.always_on) || blocked} onChange={(event) => setGrantedTools((current) => ({ ...current, [tool.id]: event.target.checked }))} /><span className="tool-name">{tool.label}{tool.always_on ? ` · ${text('always on')}` : ''}</span></label>
            <p className="tool-summary">{tool.summary}{tool.note ? ` ${tool.note}` : ''}</p>
            {blocked && <p className="tool-blocked">{text('No credential configured — add it to ~/.lh-harness/secrets.env, then reload.')}</p>}
          </li>;
        })}</ul>
      </div>}
      <div className="drawer-actions"><button onClick={onClose}>{text('Cancel')}</button><button className="primary-action" disabled={!task.trim() || controlBusy || uploadsBusy || PUBLIC_ROLES.some(({ id }) => !roleSelections[id].agent || roleSelections[id].custom && !roleSelections[id].model?.trim() || roleSelections[id].effortCustom && !roleSelections[id].reasoning_effort?.trim())} onClick={() => void onCreate(taskWithAttachments(task.trim(), attachments), resolvedRoles, workspace.trim(), maxRounds, 'en', selectedCapabilities)}>{controlBusy ? text('Starting…') : text('Start task')}</button></div>
    </> : <>
      <div className="details-tabs" role="tablist" aria-label={text('Detail categories')}><button id="details-tab-artifacts" role="tab" aria-controls="details-panel-artifacts" aria-selected={tab === 'artifacts'} tabIndex={tab === 'artifacts' ? 0 : -1} className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}>{text('Run records')}</button><button id="details-tab-trajectory" role="tab" aria-controls="details-panel-trajectory" aria-selected={tab === 'trajectory'} tabIndex={tab === 'trajectory' ? 0 : -1} className={tab === 'trajectory' ? 'active' : ''} onClick={() => setTab('trajectory')}>{text('Trajectory')}</button><button id="details-tab-events" role="tab" aria-controls="details-panel-events" aria-selected={tab === 'events'} tabIndex={tab === 'events' ? 0 : -1} className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>{text('Events')}</button></div>
      <div className="drawer-rounds"><span>{text('Rounds')}</span>{hiddenRounds > 0 && <button className="drawer-round-more" onClick={() => setRoundLimit((limit) => Math.min(snapshot.rounds.length, limit + MAX_TRAJECTORY_ROUNDS))}>{text(`+${hiddenRounds} earlier`)}</button>}{roundChoices.map((round) => <button className={round.round_index === selectedRound ? 'active' : ''} key={round.round_index} onClick={() => setSelectedRound(round.round_index)}>R{round.round_index}</button>)}</div>
      {tab === 'artifacts' && <div id="details-panel-artifacts" className="drawer-content" role="tabpanel" aria-labelledby="details-tab-artifacts"><p className="drawer-artifact-note">{text(`These are the three roles' records for this round. Actual deliverables are saved in the task workspace${snapshot.run.workspace ? `: ${snapshot.run.workspace}` : ''} or the target application, where the Auditor independently checks them.`)}</p><div className="artifact-list-drawer">{artifactList?.artifacts.map((name) => <button className={name === artifactName ? 'active' : ''} title={name} key={name} onClick={() => void openArtifact(selectedRound || 0, name)}>{name}</button>)}{selectedRound === null && <span className="drawer-muted">{text('No round results yet.')}</span>}{selectedRound !== null && artifactError && <div className="drawer-error-state"><span className="drawer-error">{text('Failed to load records: ')}{compactText(artifactError, 240)}</span>{retryArtifacts && <button type="button" onClick={retryArtifacts}>{text('Retry')}</button>}</div>}{selectedRound !== null && !artifactError && !artifactList && <span className="drawer-muted">{text('Loading run records…')}</span>}{artifactList && !artifactList.artifacts.length && <span className="drawer-muted">{text('No run records for this round.')}</span>}</div>{artifactName && isImageArtifact(artifactName) ? <div className="drawer-image-preview"><ImageGallery images={[artifactRawUrl(runId, selectedRound || 0, artifactName)]} label={artifactName} /></div> : <pre className="drawer-pre">{artifactText || text('Select a run record.')}</pre>}</div>}
      {tab === 'trajectory' && <div id="details-panel-trajectory" className="drawer-content" role="tabpanel" aria-labelledby="details-tab-trajectory"><div className="drawer-rounds role-picker"><span>{text('Role')}</span>{roles.map((role) => <button className={role === trajectoryRole ? 'active' : ''} key={role} onClick={() => setTrajectoryRole(role)}>{roleTitle(role)}</button>)}</div><TrajectoryDetail data={trajectoryData} error={selectedRound === null ? text('No round results yet.') : trajectoryError} onRetry={retryTrajectory} /></div>}
      {tab === 'events' && <div id="details-panel-events" className="drawer-content" role="tabpanel" aria-labelledby="details-tab-events"><div className="event-list-drawer">{events.map((event) => <div key={event.event_id}><time>{formatTime(event.ts)}</time><span>{eventSummary(event, language)}</span></div>)}</div></div>}
    </>}
  </aside></div>;
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
