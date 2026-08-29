// Shared presentation primitives for the workbench.
//
// Everything here is loop-agnostic: markdown rendering, the image gallery, the
// trajectory/evidence cards, the approval card and the small formatting
// helpers. The loop-specific surfaces (plan graph, node panel, drawers) build
// on these.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  BookOpen,
  Braces,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleDotDashed,
  CircleX,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileJson2,
  FilePenLine,
  FileText,
  Files,
  FlaskConical,
  ListChecks,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import {
  isTrajectoryNoise,
  projectTrajectoryView,
  MAX_ROUNDS,
  type ArtifactProjection,
  type FileChangeItem,
  type TrajectoryItem,
  type ValidationResultSummary,
  type Approval,
} from '../../core/src';
import { downloadApiFile, fetchObjectUrl, type TrajectoryView } from './api';
import { useUiLanguage } from './i18n';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function compactText(text: string, limit = 1600): string {
  const value = String(text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

export function formatTime(ts?: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export function formatDuration(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${Math.round(seconds % 60)}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatCost(usd?: number | null): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '';
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    starting: 'Starting', creating: 'Creating', running: 'Running', stopping: 'Stopping', aborting: 'Aborting',
    waiting_approval: 'Input required', completed: 'Completed', complete: 'Completed', failed: 'Failed', blocked: 'Blocked',
    incomplete: 'Incomplete', cancelled: 'Stopped', canceled: 'Stopped', stopped: 'Stopped', aborted: 'Aborted', idle: 'Idle',
  };
  return labels[status] || (status ? `Status: ${status}` : 'Unknown');
}

export function statusClass(status: string): string {
  return `status-dot status-${String(status || 'idle').replaceAll('_', '-')}`;
}

/** Display name for a loop role (`prompt_tailor` → `Prompt tailor`). */
export function roleTitle(role: string | null | undefined): string {
  if (!role) return 'Loop';
  const labels: Record<string, string> = {
    prompt_tailor: 'Prompt tailor',
    planner: 'Planner',
    rubric: 'Rubric',
    composer: 'Composer',
    evaluator: 'Evaluator',
    final_response: 'Final reply',
    context: 'Context selector',
  };
  return labels[role] || role.replaceAll('_', ' ');
}

// SVG is intentionally treated as text/attachment by the API: rendering an
// untrusted agent-produced SVG in the dashboard origin would allow script and
// external-resource execution. Raster formats remain safe image previews.
const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/iu;
const VIDEO_FILE_RE = /\.(?:mp4|webm|mov)$/iu;

export function isImageFile(name: string): boolean {
  return IMAGE_FILE_RE.test(name);
}

export function isVideoFile(name: string): boolean {
  return VIDEO_FILE_RE.test(name);
}

// Keep links useful in prose and code output without turning template strings
// such as `http://127.0.0.1:{args.port}` into clickable destinations.
const URL_RE = /https?:\/\/[^\s<>"'`]+/giu;

export function normalizeLink(value: string): string | null {
  // Markdown and quoted shell output commonly leave closing punctuation on the
  // URL. Strip it, while rejecting unresolved `{placeholder}` values.
  const candidate = value.trim().replace(/[.,;:!?]+$/u, '').replace(/[)\]}]+$/u, '');
  if (!candidate || /[{}]/u.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

export function extractLinks(text: string): string[] {
  const links = (text.match(URL_RE) || []).map(normalizeLink).filter((value): value is string => Boolean(value));
  return [...new Set(links)];
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
export function useBackdropDismiss(onDismiss: () => void) {
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

// ---------------------------------------------------------------------------
// Markdown rendering
//
// Rubrics, progress notes, evaluations and briefings are authored as markdown,
// so the workbench renders the block structure the agents wrote: headings,
// ordered/unordered (and nested) lists, quotes, rules and fenced code, with
// inline code/emphasis/links inside every one of them.
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

export function MessageText({ text }: { text: string }) {
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

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** Clamped text that expands in place when there is more to read. */
export function ExpandableText({ text: value, lines = 2 }: { text: string; lines?: number }) {
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

/** A titled, collapsible block — the unit every node-panel section is built from. */
export function Section({
  title,
  count,
  defaultOpen = true,
  hint,
  children,
}: {
  title: string;
  count?: number | string;
  defaultOpen?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return <section className={`panel-section ${open ? 'panel-section-open' : ''}`}>
    <button type="button" className="panel-section-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
      <span className="panel-section-caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      <span className="panel-section-title">{title}</span>
      {count !== undefined && count !== '' && <small className="panel-section-count">{count}</small>}
    </button>
    {open && <div className="panel-section-body" id={bodyId}>
      {hint && <p className="panel-hint">{hint}</p>}
      {children}
    </div>}
  </section>;
}

/** Key/value row used throughout the node panel. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="panel-field"><span className="panel-field-label">{label}</span><div className="panel-field-value">{children}</div></div>;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="panel-empty">{children}</p>;
}

/** A monospace path with a copy button. */
export function CopyPath({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <span className="copy-path">
    <code title={value}>{value}</code>
    <button type="button" className="copy-path-button" aria-label={`Copy ${value}`} title={copied ? 'Copied' : 'Copy'} onClick={() => {
      void navigator.clipboard?.writeText(value).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }).catch(() => setCopied(false));
    }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>
  </span>;
}

// ---------------------------------------------------------------------------
// Images, video and downloads
// ---------------------------------------------------------------------------

export function ImageGallery({ images, label }: { images: string[]; label: string }) {
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
  const imageKey = images.join(' ');
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
        const objectUrl = await fetchObjectUrl(source);
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
    // Do not cancel an in-flight fetch just because the live feed caused a
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

/**
 * A video served by the API.
 *
 * The bytes are fetched through `fetchObjectUrl` so the bearer token travels
 * in a header rather than in the `src` URL.
 */
export function VideoFile({ source, name }: { source: string; name: string }) {
  const [objectUrl, setObjectUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let created = '';
    void fetchObjectUrl(source).then((url) => {
      if (cancelled) { if (url !== source) URL.revokeObjectURL(url); return; }
      created = url;
      setObjectUrl(url);
    }).catch((reason) => { if (!cancelled) setError(compactText(String(reason), 160)); });
    return () => {
      cancelled = true;
      if (created && created !== source) URL.revokeObjectURL(created);
    };
  }, [source]);
  if (error) return <p className="panel-empty">{name}: {error}</p>;
  if (!objectUrl) return <p className="panel-empty">Loading {name}…</p>;
  return <video className="evidence-video" src={objectUrl} controls preload="metadata" />;
}

/** Download button for an API-served file (carries the bearer token). */
export function DownloadLink({ source, name, note }: { source: string; name: string; note?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <span className="evidence-download">
    <button type="button" disabled={busy} onClick={() => {
      setBusy(true);
      setError('');
      void downloadApiFile(source, name).catch((reason) => setError(compactText(String(reason), 120))).finally(() => setBusy(false));
    }}><Download size={12} /><span>{name}</span>{note && <em>{note}</em>}</button>
    {error && <small className="panel-error">{error}</small>}
  </span>;
}

// ---------------------------------------------------------------------------
// Trajectory activity
// ---------------------------------------------------------------------------

export type ActivityAction = 'read' | 'edit' | 'validate' | 'search' | 'task' | 'screenshot' | 'command' | 'result' | 'note';

export interface ActivityStep {
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
    // Trajectory data is agent-controlled. Auto-loading arbitrary http(s) URLs
    // would turn screenshots into a browser-side SSRF/tracking primitive and
    // would also bypass the Web API bearer. External URLs remain useful as
    // explicit text links; only same-origin API artifacts and bounded raster
    // data URLs are rendered in the gallery.
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

export function trajectoryStepText(step: Record<string, unknown>): string {
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

export function stepImageProjection(step: Record<string, unknown>): ImageSourceProjection {
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

function trajectoryTitle(action: ActivityAction): string {
  return ({
    read: 'Read and inspect', edit: 'Update files', validate: 'Run validation', search: 'Search sources', task: 'Update task list',
    screenshot: 'Capture screenshot', command: 'Run command', result: 'Execution result', note: 'Work summary',
  } as Record<ActivityAction, string>)[action];
}

function trajectorySummary(item: TrajectoryItem): string {
  const raw = item.raw as Record<string, unknown>;
  const input = raw.input && typeof raw.input === 'object' ? raw.input as Record<string, unknown> : {};
  if (item.kind === 'tool_use') {
    if (typeof input.command === 'string') return compactText(input.command.replace(/\s+/gu, ' '), 180);
    if (Array.isArray(input.changes)) {
      const paths = input.changes.map((change) => change && typeof change === 'object' ? String((change as Record<string, unknown>).path || '') : '').filter(Boolean);
      return paths.length ? `${paths.length} files · ${paths.slice(0, 2).join(', ')}` : 'Preparing file changes';
    }
    if (typeof input.query === 'string') return compactText(input.query, 180);
    return compactText(item.text || 'Preparing tool call', 180);
  }
  const value = (item.text || '').replace(/\[exit_code=0\]/giu, '').trim();
  if (item.kind === 'tool_result') {
    const visible = value.replace(/(?:^|\n)\[image\](?=\n|$)/giu, '').trim();
    if (visible) return compactText(visible.split(/\n+/u).find(Boolean) || visible, 180);
    if (item.images.length) return `${item.images.length} screenshots returned`;
    return 'Result returned';
  }
  if (item.kind === 'result') return value ? compactText(value.split(/\n+/u).find(Boolean) || value, 220) : 'Stage completed';
  return compactText(value, 220);
}

/** Turn one episode's trajectory into the operator-facing activity list. */
export function trajectoryActivity(trajectory: TrajectoryView | undefined | null, includeResult = true): ActivityStep[] {
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
      const summary = trajectorySummary(item);
      const toolId = String(raw.id || raw.tool_use_id || '').trim();
      const matchedResult = item.kind === 'tool_use' && toolId ? toolResults.get(toolId) : undefined;
      const paired = includeResult ? matchedResult : undefined;
      const ownImageProjection = stepImageProjection(raw);
      const resultImageProjection = paired ? stepImageProjection(paired.raw) : { images: [], omittedLargeDataUrls: 0 };
      const images = [...new Set([...ownImageProjection.images, ...resultImageProjection.images])];
      const omittedLargeDataUrls = ownImageProjection.omittedLargeDataUrls + resultImageProjection.omittedLargeDataUrls;
      const action = trajectoryAction(raw, item.kind, images);
      const pairedText = paired ? trajectoryStepText(paired.raw) : '';
      const resultText = paired && !isTrajectoryNoise(pairedText)
        ? pairedText.replace(/(?:^|\n)\[image\](?=\n|$)/giu, '').replace(/\[exit_code=0\]/giu, '').trim()
        : '';
      const resultSummary = resultText
        ? compactText(resultText.split(/\n+/u).find(Boolean) || resultText, 180)
        : resultImageProjection.images.length
          ? `${resultImageProjection.images.length} screenshots returned`
          : paired ? 'Completed with no additional output' : '';
      const ownDetail = trajectoryStepText(raw);
      const pairedDetail = paired ? trajectoryStepText(paired.raw) : '';
      const detail = [ownDetail, pairedDetail && !isTrajectoryNoise(pairedDetail) && pairedDetail !== ownDetail ? `Result\n${pairedDetail}` : ''].filter(Boolean).join('\n\n');
      const status = item.isError || matchedResult?.failed
        ? 'failed'
        : item.kind === 'tool_use'
          ? matchedResult ? 'done' : 'running'
          : 'done';
      return {
        id: `${projection.episode}-${projection.role}-${item.index}`,
        kind: images.length > 0 && item.kind === 'tool_result' ? 'image' : item.kind,
        status,
        title: trajectoryTitle(action),
        action,
        summary,
        result: resultSummary,
        detail,
        text: item.text,
        links: extractLinks(`${summary}\n${resultText}\n${detail}`),
        images,
        imageWarning: omittedLargeDataUrls > 0 ? `${omittedLargeDataUrls} screenshots over 2 MB were hidden` : undefined,
      };
    });
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

export function TrajectorySteps({ steps }: { steps: ActivityStep[] }) {
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

const MAX_TRAJECTORY_STEPS = 600;

/** The raw step list shown in the drawer's Trajectory tab. */
export function TrajectoryDetail({ data, error, onRetry }: { data: TrajectoryView | null; error?: string; onRetry?: () => void }) {
  const { text } = useUiLanguage();
  const [visibleCount, setVisibleCount] = useState(MAX_TRAJECTORY_STEPS);
  useEffect(() => setVisibleCount(MAX_TRAJECTORY_STEPS), [data?.episode, data?.role, data?.raw_chars]);
  if (error) return <div className="drawer-pre trajectory-detail-list"><div className="drawer-error-state"><span className="drawer-error">{text('Failed to load trajectory: ')}{compactText(error, 240)}</span>{onRetry && <button type="button" onClick={onRetry}>{text('Retry')}</button>}</div></div>;
  if (!data) return <div className="drawer-pre trajectory-detail-list">{text('Select an episode.')}</div>;
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
      return <section className="trajectory-detail-step" key={`trajectory-${sourceIndex}`}><div className="trajectory-detail-heading">{String(sourceIndex + 1).padStart(2, '0')} <span>{String(step.kind || 'step').toUpperCase()}</span></div>{stepText && <pre>{stepText}</pre>}{imageProjection.images.length > 0 && <ImageGallery images={imageProjection.images} label={text('intermediate screenshot')} />}{imageProjection.omittedLargeDataUrls > 0 && <div className="trajectory-image-warning"><AlertTriangle size={12} /><span>{text(`${imageProjection.omittedLargeDataUrls} screenshots over 2 MB were hidden`)}</span></div>}</section>;
    })}
    {total > MAX_TRAJECTORY_STEPS && <small className="drawer-field-note">{text(`Showing the latest ${visible} of ${total} steps.`)}</small>}
  </div>;
}

// ---------------------------------------------------------------------------
// Execution artifacts
// ---------------------------------------------------------------------------

export function hasExecutionArtifacts(projection: ArtifactProjection): boolean {
  return projection.files.totalFiles > 0 || projection.validations.total > 0;
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

export function EditedFilesCard({ projection }: { projection: ArtifactProjection['files'] }) {
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
    <header className="edited-files-head"><span className="edited-files-mark" aria-hidden="true"><Files size={20} strokeWidth={1.7} /></span><div><strong>{title}</strong>{projection.scope === 'workspace' && <small>{text('From the workspace diff; not attributed to the composer')}</small>}</div>{exactLines && <span className="edited-files-total"><span>+{projection.additions}</span><span>-{projection.deletions}</span></span>}</header>
    {visibleFiles.length > 0 && <ul className="edited-file-list">{visibleFiles.map((file) => <FilePathRow file={file} key={`${file.previousPath || ''}:${file.path}`} />)}</ul>}
    {unknownPaths > 0 && <p className="edited-files-unknown">{text(`${unknownPaths} additional file path${unknownPaths === 1 ? '' : 's'} were not listed in the current trajectory`)}</p>}
    {knownHidden > 0 && <button type="button" className="edited-files-toggle" onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}<span>{expanded ? text('Hide files') : text(`Show ${knownHidden} more file${knownHidden === 1 ? '' : 's'}`)}</span></button>}
  </section>;
}

function validationOperationLabel(operation: ValidationResultSummary['operations'][number]): string {
  const labels = { test: 'Tests', typecheck: 'Type check', build: 'Build', lint: 'Lint', 'diff-check': 'Diff check' };
  return labels[operation];
}

function ValidationIcon({ status }: { status: ValidationResultSummary['status'] }) {
  if (status === 'passed') return <CircleCheck size={17} strokeWidth={1.9} />;
  if (status === 'failed') return <CircleX size={17} strokeWidth={1.9} />;
  if (status === 'running') return <LoaderCircle className="trajectory-spinner" size={17} strokeWidth={1.9} />;
  return <CircleDotDashed size={17} strokeWidth={1.9} />;
}

export function ValidationResults({ projection }: { projection: ArtifactProjection['validations'] }) {
  const { text } = useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  if (!projection.total) return null;
  const visibleItems = expanded ? projection.items : projection.items.slice(-6);
  const hidden = Math.max(0, projection.items.length - visibleItems.length);
  return <section className="validation-results" aria-label={text('Validation results')}>
    <div className="evidence-section-title"><span><ShieldCheck size={16} />{text('Validation results')}</span><small>{text(`${projection.passed} passed`)}{projection.failed ? text(` · ${projection.failed} failed`) : ''}{projection.running ? text(` · ${projection.running} running`) : ''}</small></div>
    <div className="validation-list">{visibleItems.map((item) => <article className={`validation-row validation-${item.status}`} key={item.id}>
      <span className="validation-icon" aria-hidden="true"><ValidationIcon status={item.status} /></span>
      <div className="validation-main"><div className="validation-head"><strong>{item.label || 'Validation'}</strong><span>{item.operations.map((operation) => validationOperationLabel(operation)).join(' / ')}</span><small>ep{item.episode} · {roleTitle(item.role)}</small></div><div className="validation-summary">
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

export function ExecutionArtifacts({ projection, live }: { projection: ArtifactProjection; live: boolean }) {
  const { text } = useUiLanguage();
  if (!hasExecutionArtifacts(projection)) return null;
  return <div className={`execution-artifacts ${live ? 'execution-artifacts-live' : ''}`}>
    <div className="execution-artifacts-label"><Sparkles size={14} /><span>{live ? text('Live execution artifacts') : text('Execution artifacts')}</span>{live && <small>{text('Updates with the trajectory')}</small>}</div>
    <EditedFilesCard projection={projection.files} />
    <ValidationResults projection={projection.validations} />
  </div>;
}

// ---------------------------------------------------------------------------
// Human gate
// ---------------------------------------------------------------------------

const GATE_TITLES: Record<string, string> = {
  completed: 'Every subtask passed',
  max_rounds: 'Composer budget exhausted',
  needs_input: 'The planner has questions',
  needs_human: 'A subtask is blocked',
  repeated_failure: 'Repeated episode failures',
};

export function ApprovalCard({
  approval,
  busy,
  userInput,
  onUserInput,
  extraRounds,
  onExtraRounds,
  onApprove,
  onFocusSubtask,
}: {
  approval: Approval;
  busy: boolean;
  userInput: string;
  onUserInput: (value: string) => void;
  extraRounds: string;
  onExtraRounds: (value: string) => void;
  onApprove: (id: string, action: string, userInput?: string, extraRounds?: number) => void;
  onFocusSubtask?: (subtaskId: string) => void;
}) {
  const { text } = useUiLanguage();
  const options = approval.options.length ? approval.options : [{ value: 'continue', label: 'Continue' }, { value: 'stop', label: 'Stop', style: 'danger' }];
  const trigger = String(approval.context?.trigger || '');
  const subtaskId = typeof approval.context?.subtask_id === 'string' ? approval.context.subtask_id : '';
  const title = GATE_TITLES[trigger] || approval.title;
  const inputPlaceholder = approval.input_label && !/^Optional/iu.test(approval.input_label) ? approval.input_label : text('Optional: enter an answer or instruction');
  const optionLabel = (label: string) => /continue/iu.test(label) ? text('Continue run') : /end/iu.test(label) ? text('End run') : /stop/iu.test(label) ? text('Stop run') : label;
  // Older servers omit the flag; fall back to the triggers that are known to
  // grant rounds so the input does not disappear against a mixed deployment.
  const allowRounds = approval.allow_extra_rounds ?? ['completed', 'max_rounds', 'repeated_failure'].includes(trigger);
  const roundsValue = extraRounds.trim();
  const roundsInvalid = roundsValue !== '' && !(/^\d+$/u.test(roundsValue) && Number(roundsValue) >= 1 && Number(roundsValue) <= MAX_ROUNDS);
  const roundsPayload = () => (roundsValue === '' || roundsInvalid ? undefined : Number(roundsValue));
  return <article className="approval-card"><div className="message-avatar approval-avatar"><AlertTriangle size={12} /></div><div className="message-body">
    <div className="message-meta"><strong>{title}</strong><span className="approval-label">{text('Input required')}</span></div>
    {subtaskId && <button type="button" className="approval-subtask" onClick={() => onFocusSubtask?.(subtaskId)} disabled={!onFocusSubtask}>{text('Subtask')} <code>{subtaskId}</code></button>}
    <MessageText text={approval.message} />
    {approval.allow_input && <textarea className="approval-input" value={userInput} onChange={(event) => onUserInput(event.target.value)} placeholder={inputPlaceholder} disabled={busy} />}
    {allowRounds && <label className="approval-rounds">{text('Extra composer episodes when continuing')}<input type="number" min={1} max={MAX_ROUNDS} step={1} value={extraRounds} disabled={busy} placeholder={text('Blank = keep the configured budget')} onChange={(event) => onExtraRounds(event.target.value)} /><span className={roundsInvalid ? 'approval-rounds-error' : 'approval-rounds-note'}>{roundsInvalid ? text(`Enter a whole number from 1 to ${MAX_ROUNDS}`) : text('Only affects “Continue run”')}</span></label>}
    {approval.answers.length > 0 && <div className="approval-answers" aria-label={text('Quick answers')}>{approval.answers.map((answer) => <button type="button" key={answer} disabled={busy || roundsInvalid} onClick={() => onApprove(approval.approval_id, 'continue', answer, roundsPayload())}>{answer}</button>)}</div>}
    <div className="approval-actions">{options.map((option) => <button key={option.value} disabled={busy || (roundsInvalid && option.value !== 'stop')} className={option.style === 'danger' ? 'danger-text' : ''} onClick={() => onApprove(approval.approval_id, option.value, undefined, option.value === 'stop' ? undefined : roundsPayload())}>{optionLabel(option.label)}</button>)}</div>
  </div></article>;
}
