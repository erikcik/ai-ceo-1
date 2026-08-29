// The create-task drawer: the task text, its input files, one runtime picker
// per loop role (planner / composer / evaluator), the composer-episode budget,
// the workspace, and the external-tool grants for this run.

import { useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { MAX_ROUNDS, normaliseMaxRounds, type LoopRole } from '../../core/src';
import { uploadFile, type AgentChoice, type ModelChoice, type RoleRuntimeConfig, type WebMeta } from './api';
import { compactText, formatBytesShort, useBackdropDismiss } from './common';

const MODEL_PRESETS: Record<string, { id: string; label: string }[]> = {
  claude_code: [{ id: 'claude-opus-5', label: 'Claude Opus 5 · default' }],
};

export type RoleSelection = RoleRuntimeConfig & { custom: boolean; effortCustom?: boolean };

export const LOOP_ROLE_CARDS: Array<{ id: LoopRole; label: string; description: string }> = [
  { id: 'planner', label: 'Planner', description: 'Researches and writes the plan tree' },
  { id: 'composer', label: 'Composer', description: 'Does the work and files the evidence' },
  { id: 'evaluator', label: 'Evaluator', description: 'Grades the contract and may revise the plan' },
];

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

export function defaultAgent(meta: WebMeta | null): string {
  const preferred = meta?.defaults?.agent;
  if (preferred && meta?.agents?.some((item) => item.id === preferred && item.available !== false)) return preferred;
  return meta?.agents?.find((item) => item.available !== false)?.id || 'claude_code';
}

export function defaultModel(meta: WebMeta | null, agent: string): string {
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

function normalizedModelEntries(meta: WebMeta | null, agent: string): ModelChoice[] {
  const raw = meta?.models?.[agent] || agentEntry(meta, agent)?.models;
  return Array.isArray(raw) ? raw.filter((item): item is ModelChoice => Boolean(item) && typeof item === 'object') : [];
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

export function RoleRuntimePicker({ role, selection, meta, onChange }: { role: typeof LOOP_ROLE_CARDS[number]; selection: RoleSelection; meta: WebMeta | null; onChange: (value: RoleSelection) => void }) {
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
    ? `Detected ${choices.length} models from the current account.`
    : discovery?.warning || 'The provider will verify model availability when the worker starts.';
  const agentSuffix = (item: typeof agentChoices[number]) => item.availability === 'missing'
    ? ' · Not installed'
    : item.availability === 'found_but_broken'
      ? ' · Installed but not runnable'
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
    ? `Provider default (your codex config: ${reasoning.provider_default})`
    : 'Provider default';
  const effortNote = !reasoning?.supported
    ? reasoning?.note || 'This harness exposes no reasoning-effort switch.'
    : selection.effortCustom || (effort && !effortChoices.some((choice) => choice.id === effort))
      ? reasoning.validation === 'silently_ignored'
        ? 'Note: this harness ignores an unrecognised value and silently continues at its default effort instead of failing.'
        : 'A custom effort is not in the detected list. If the provider rejects it, the run fails immediately with the reason.'
      : reasoning.scope === 'per_model'
        ? 'The available tiers follow the selected model and come from the current session.'
        : `The tiers come from ${reasoning.source === 'cli_help' ? 'the CLI itself' : 'a built-in list'}.`;
  return <section className="role-runtime-card">
    <div className="role-runtime-title"><span className="role-runtime-mark">{role.label[0]}</span><div><strong>{role.label}</strong><small>{role.description}</small></div></div>
    <div className="role-runtime-grid">
      <label className="drawer-field"><span>Harness</span><select value={selection.agent} onChange={(event) => onChange({ agent: event.target.value, model: '', custom: false, reasoning_effort: '', effortCustom: false })}>{agentChoices.map((choice) => <option value={choice.id} key={choice.id} disabled={choice.availability === 'missing'}>{choice.label}{agentSuffix(choice)}</option>)}</select></label>
      <label className="drawer-field"><span>Model</span><select value={selectValue} onChange={(event) => { const value = event.target.value; onChange(value === '__custom__' ? { ...selection, model: '', custom: true } : { ...selection, model: value, custom: false }); }}><option value="">{`Provider default (${providerDefault})`}</option>{choices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label}</option>)}<option value="__custom__">Custom model…</option></select></label>
    </div>
    {selection.custom && <input className="role-runtime-custom" autoFocus value={selection.model || ''} onChange={(event) => onChange({ ...selection, model: event.target.value })} placeholder="Enter a model name exposed by the provider" />}
    {brokenAgent && <small className="drawer-field-note agent-broken">This harness is on PATH but cannot run: {compactText(brokenAgent.problem, 200)}</small>}
    <label className="drawer-field"><span>Reasoning effort</span><select value={effortSelectValue} disabled={!reasoning?.supported} onChange={(event) => { const value = event.target.value; onChange(value === '__custom__' ? { ...selection, reasoning_effort: '', effortCustom: true } : { ...selection, reasoning_effort: value, effortCustom: false }); }}><option value="">{effortProviderDefault}</option>{effortChoices.map((choice) => <option value={choice.id} key={choice.id} title={choice.description}>{choice.label}{choice.description ? ` · ${choice.description}` : ''}</option>)}{reasoning?.supported && <option value="__custom__">Custom effort…</option>}</select></label>
    {selection.effortCustom && <input className="role-runtime-custom" autoFocus value={selection.reasoning_effort || ''} onChange={(event) => onChange({ ...selection, reasoning_effort: event.target.value })} placeholder="Enter an effort value this harness accepts" />}
    <small className="drawer-field-note">{effortNote}</small>
    <small className={`drawer-field-note ${discovery?.account_scoped ? 'model-detected' : ''}`}>{selection.custom ? 'You may try a custom model that was not detected. If it is unavailable, unauthorized, or the credentials are invalid, the run will fail immediately with the provider reason.' : discoveryNote}</small>
  </section>;
}

type Attachment = { id: string; name: string; bytes: number; status: 'uploading' | 'done' | 'error'; path?: string; error?: string };

/** The composer only sees the task text, so attached files are announced there by workspace-relative path. */
function taskWithAttachments(task: string, attachments: Attachment[]): string {
  const done = attachments.filter((item) => item.status === 'done' && item.path);
  if (!done.length) return task;
  const lines = done.map((item) => `- ${item.path} (${formatBytesShort(item.bytes)})`);
  return `${task}\n\nInput files (already uploaded to the workspace's \`inbox/\` folder; use these workspace-relative paths):\n${lines.join('\n')}`;
}

export interface CreateTaskProps {
  meta: WebMeta | null;
  controlBusy: boolean;
  onClose: () => void;
  onCreate: (
    task: string,
    roles: Record<LoopRole, RoleRuntimeConfig>,
    workspace: string,
    maxRounds: string,
    capabilities: string[],
  ) => Promise<void>;
  onRefreshModels: () => Promise<void>;
}

export default function CreateTask({ meta, controlBusy, onClose, onCreate, onRefreshModels }: CreateTaskProps) {
  const backdrop = useBackdropDismiss(onClose);
  const [task, setTask] = useState('');
  const [roleSelections, setRoleSelections] = useState<Record<LoopRole, RoleSelection>>({
    planner: { agent: 'claude_code', model: '', custom: false, reasoning_effort: '', effortCustom: false },
    composer: { agent: 'claude_code', model: '', custom: false, reasoning_effort: '', effortCustom: false },
    evaluator: { agent: 'claude_code', model: '', custom: false, reasoning_effort: '', effortCustom: false },
  });
  const rolesInitialised = useRef(false);
  const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
  const [modelRefreshError, setModelRefreshError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [maxRounds, setMaxRounds] = useState('25');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const externalTools = meta?.external_tools ?? [];
  const [grantedTools, setGrantedTools] = useState<Record<string, boolean>>({});
  const toolsInitialised = useRef(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const uploadsBusy = attachments.some((item) => item.status === 'uploading');

  useEffect(() => {
    if (toolsInitialised.current || !externalTools.length) return;
    setGrantedTools(Object.fromEntries(externalTools.map((tool) => [tool.id, Boolean(tool.always_on || tool.default_on)])));
    toolsInitialised.current = true;
  }, [externalTools]);

  useEffect(() => {
    if (!meta || rolesInitialised.current) return;
    const fallbackAgent = defaultAgent(meta);
    setRoleSelections(Object.fromEntries(LOOP_ROLE_CARDS.map(({ id }) => {
      const configured = meta.defaults?.roles?.[id];
      const roleAgent = configured?.agent || fallbackAgent;
      return [id, { agent: roleAgent, model: configured?.model || '', custom: false, reasoning_effort: configured?.reasoning_effort || '', effortCustom: false }];
    })) as Record<LoopRole, RoleSelection>);
    rolesInitialised.current = true;
  }, [meta]);

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

  const selectedCapabilities = externalTools.filter((tool) => tool.always_on || grantedTools[tool.id]).map((tool) => tool.id);
  const resolvedRoles = Object.fromEntries(LOOP_ROLE_CARDS.map(({ id }) => {
    const selection = roleSelections[id];
    const effort = selection.reasoning_effort?.trim() || '';
    return [id, {
      agent: selection.agent,
      model: selection.model?.trim() || defaultModel(meta, selection.agent),
      // Omitted rather than sent empty so the backend keeps "follow the
      // provider default" distinct from an explicit value.
      ...(effort ? { reasoning_effort: effort } : {}),
    }];
  })) as Record<LoopRole, RoleRuntimeConfig>;
  const invalid = !task.trim() || controlBusy || uploadsBusy || LOOP_ROLE_CARDS.some(({ id }) =>
    !roleSelections[id].agent
    || roleSelections[id].custom && !roleSelections[id].model?.trim()
    || roleSelections[id].effortCustom && !roleSelections[id].reasoning_effort?.trim());

  return <div className="drawer-backdrop" {...backdrop}><aside className="details-drawer create-drawer" role="dialog" aria-modal="true" aria-label="Create a new run">
    <div className="drawer-header"><div><div className="drawer-eyebrow">NEW RUN</div><h2>Create a run</h2></div><button className="drawer-close" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
    <p className="drawer-copy">The planner turns this task into a plan tree. Each leaf is then contracted, composed and evaluated until it passes, and the graph shows that happening.</p>
    <label className="drawer-field"><span>Task</span><textarea autoFocus value={task} onChange={(event) => setTask(event.target.value)} placeholder="What should the harness do?" /></label>

    <div className="drawer-field attach-field"><span>Input files <small>optional · uploaded now to &lt;workspace&gt;/inbox/</small></span>
      <div className="attach-row"><button type="button" className="attach-button" disabled={controlBusy} onClick={() => fileInput.current?.click()}><Paperclip size={14} />Attach files</button><input ref={fileInput} type="file" multiple hidden onChange={(event) => { void attachFiles(event.target.files); event.target.value = ''; }} /><small className="attach-hint">Set Workspace first if you use one. Files are listed in the task as inbox/&lt;name&gt;.</small></div>
      {attachments.length > 0 && <ul className="attach-list">{attachments.map((item) => <li key={item.id} className={`attach-item attach-${item.status}`}><span className="attach-name" title={item.name}>{item.path || item.name}</span><span className="attach-meta">{formatBytesShort(item.bytes)}{item.status === 'uploading' ? ' · uploading…' : item.status === 'error' ? ` · ${item.error}` : ''}</span><button type="button" className="attach-remove" aria-label="Remove from task" onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><X size={12} /></button></li>)}</ul>}
    </div>

    <div className="role-runtime-head"><div><strong>Role runtime configuration</strong><small>Pick a harness and model independently for the planner, composer and evaluator</small></div><button type="button" disabled={modelRefreshBusy} onClick={() => { setModelRefreshBusy(true); setModelRefreshError(''); void onRefreshModels().catch((reason) => setModelRefreshError(String(reason))).finally(() => setModelRefreshBusy(false)); }}>{modelRefreshBusy ? 'Detecting…' : 'Refresh models'}</button></div>
    {modelRefreshError && <div className="drawer-error-state"><span className="drawer-error">Model detection failed: {compactText(modelRefreshError, 240)}</span></div>}
    <div className="role-runtime-list">{LOOP_ROLE_CARDS.map((role) => <RoleRuntimePicker key={role.id} role={role} selection={roleSelections[role.id]} meta={meta} onChange={(value) => setRoleSelections((current) => ({ ...current, [role.id]: value }))} />)}</div>

    <label className="drawer-field"><span>Max composer episodes <small>1–{MAX_ROUNDS}</small></span><input inputMode="numeric" type="text" pattern="[0-9]*" value={maxRounds} onChange={(event) => setMaxRounds(event.target.value.replace(/\D+/gu, ''))} onBlur={() => setMaxRounds(String(normaliseMaxRounds(maxRounds)))} /></label>
    <label className="drawer-field"><span>Workspace <small>optional</small></span><input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="Use the Web server workspace root" /></label>

    {externalTools.length > 0 && <div className="drawer-field tools-field"><span>External tools <small>what this run may use</small></span>
      <ul className="tools-list">{externalTools.map((tool) => {
        const on = Boolean(tool.always_on || grantedTools[tool.id]);
        const blocked = !tool.always_on && !tool.credential_ready;
        return <li key={tool.id} className={`tool-item ${on ? 'tool-on' : ''}`}>
          <label className="tool-toggle"><input type="checkbox" checked={on} disabled={Boolean(tool.always_on) || blocked} onChange={(event) => setGrantedTools((current) => ({ ...current, [tool.id]: event.target.checked }))} /><span className="tool-name">{tool.label}{tool.always_on ? ' · always on' : ''}</span></label>
          <p className="tool-summary">{tool.summary}{tool.note ? ` ${tool.note}` : ''}</p>
          {blocked && <p className="tool-blocked">No credential configured — add it to ~/.lh-harness/secrets.env, then reload.</p>}
        </li>;
      })}</ul>
    </div>}

    <div className="drawer-actions"><button onClick={onClose}>Cancel</button><button className="primary-action" disabled={invalid} onClick={() => void onCreate(taskWithAttachments(task.trim(), attachments), resolvedRoles, workspace.trim(), maxRounds, selectedCapabilities)}>{controlBusy ? 'Starting…' : 'Start run'}</button></div>
  </aside></div>;
}
