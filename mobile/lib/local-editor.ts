/**
 * V15/V16 — Local editor logic (artboard
 * `design/mobile-app-core/08-local-editor.html`, `docs/mobile-views-plan.md`
 * §V15/§V16, task T7l).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * filesystem, no network of its own. `mobile/app/local-editor.tsx` is the
 * rendering shell and `mobile/test/local-editor.test.mjs` pins these rules with
 * injected fake sources (plus a fake channel for the two wire cases).
 *
 * ## The honesty constraint this module is built around
 *
 * There is no filesystem FFI in the Rust core yet (`fs_read`/`fs_list`/
 * `fs_write` do not exist) and the bridge serves no fs endpoint. So:
 *
 * - content is read through an injected `EditorSource`: the real one asks the
 *   bridge (`/api/fs/tree`, `/api/fs/read`) when a tunnel is open, and a `501`
 *   or `404` becomes an `error` state carrying that failure — never an empty
 *   file presented as a successful read;
 * - with no tunnel (local mode) there is nothing to ask: the state is `no-fs`
 *   and the copy names the real cause (the core has no fs FFI), never a blank
 *   buffer that looks like an empty file, and never a fake list;
 * - no syntax highlighting is invented: the model only produces line numbers,
 *   tab expansion and a real truncation cap, which the shell paints with the
 *   plain text colour;
 * - saving is not wired: `saveIntent` is `pending: true` for
 *   `POST /api/fs/write` with the honest note, so a dirty buffer stays dirty;
 * - a huge file is cut at a real cap and the `truncado` marker names how much
 *   was hidden (`renderCode`), and the shell opens it read-only instead of
 *   letting an edit apply to truncated text.
 *
 * ## Honest states (§V15 table)
 *
 * `loading | empty | success | stale | offline | error` plus `no-fs` for the
 * local-mode capability gap. `stale` is a timeout after a good answer (the
 * cached tree with the minutes since it) and `offline` is no tunnel at all.
 */

import { type TunnelChannel, bridgeRequest } from './bridge.ts';
import { logger } from './logger.ts';

/* ------------------------------------------------------------------ *
 * Routes, endpoints and copy (es-AR)
 * ------------------------------------------------------------------ */

/** This screen. */
export const LOCAL_EDITOR_ROUTE = '/local-editor';

/** Back target of the editor (V14). */
export const LOCAL_PROJECTS_ROUTE = '/local-projects';

/** Screen title when the open project has no name yet. */
export const EDITOR_TITLE = 'Editor local';

/** Endpoint the source lists the project folder with (declared by the extension). */
export const FS_TREE_PATH = '/api/fs/tree';

/** Endpoint the source reads one file with (not served yet). */
export const FS_READ_PATH = '/api/fs/read';

/** Endpoint a save would be posted to (not served yet). */
export const FS_WRITE_PATH = '/api/fs/write';

/** Default deadline of one fs call, matching the other bridge calls. */
export const FS_TIMEOUT_MS = 8_000;

/** Tab size the pane expands to (artboard `tab-size: 2`). */
export const TAB_SIZE = 2;

/** Characters of a file the pane renders before marking the truncation. */
export const DISPLAY_CHAR_CAP = 20_000;

/** Copy of the `no-fs` state: what happens, in the person's words. */
export const NO_FS_COPY = 'Sin acceso a archivos';

/** The real cause: there is no filesystem FFI in the core yet. */
export const NO_FS_REASON =
  'el core Rust todavía no expone fs_read/fs_list: no hay FFI de archivos en el teléfono.';

/** Full `no-fs` sentence (title + real cause). */
export const NO_FS_MESSAGE = `${NO_FS_COPY}: ${NO_FS_REASON}`;

/** §V15 `empty-project`. */
export const TREE_EMPTY_COPY = 'Proyecto vacío. Crea un archivo.';

/** Why the artboard's `Nuevo archivo` CTA cannot exist yet (no `fs_write`). */
export const TREE_EMPTY_NOTE =
  'Crear un archivo necesita fs_write, que todavía no está en el core: el botón Nuevo archivo no está conectado.';

/** §V15 `no-file-open`: the welcome pane. */
export const NO_FILE_COPY = 'Elegí un archivo del proyecto para abrirlo.';

/** §V15 `offline`: with no tunnel there is nothing to read from the PC. */
export const OFFLINE_COPY = 'Requiere conexión — los archivos están en tu PC.';

/** Reconnect hint next to the offline copy. */
export const RECONNECTING_COPY = 'Reconectando…';

/** Copy when the bridge does not serve the fs endpoints yet (404/501). */
export const MISSING_ENDPOINT_COPY = 'La extensión no expone los archivos todavía';

/** Copy of an unusable `/api/fs/list` body. */
export const INCOMPLETE_TREE_COPY = 'La PC devolvió un árbol de archivos incompleto.';

/** Copy of a read body without a text (never treated as an empty file). */
export const INCOMPLETE_FILE_COPY = 'La PC devolvió un archivo incompleto.';

/** Tree error card title. */
export const ERROR_TITLE = 'No pudimos leer los archivos';

/** Read error card title (exact copy of the view plan reaction table). */
export const READ_ERROR_TITLE = 'No pudimos abrir el archivo.';

/** §V15 `large-file`: a truncated buffer is shown, never edited. */
export const LARGE_FILE_COPY = 'Archivo grande: abierto en solo lectura.';

/** Why it is read-only: an edit over the cut would corrupt the file. */
export const LARGE_FILE_DETAIL =
  'El archivo supera el tope de la vista, así que el final está truncado: editar acá guardaría un archivo incompleto.';

/** Confirm sheet of a dirty buffer (§V15 tab reaction). */
export const DISCARD_TITLE = '¿Descartar cambios?';
export const DISCARD_MESSAGE =
  'El archivo tiene cambios sin guardar y guardar todavía no está conectado: descartarlos los pierde.';
export const DISCARD_CONFIRM_LABEL = 'Descartar cambios';
export const DISCARD_CANCEL_LABEL = 'Seguir editando';

/** Save button label. */
export const SAVE_LABEL = 'Guardar';

/** Honest note of the save button: writing is not wired. */
export const SAVE_PENDING_NOTE =
  'Guardar todavía no está conectado: el core Rust no expone fs_write y la extensión no tiene /api/fs/write. El buffer queda con cambios sin guardar.';

/** Retry word used by every screen of the app. */
export const RETRY_LABEL = 'Reintentar';

/** Retry note of the tree card (it really re-asks the source). */
export const RETRY_NOTE = 'Reintentar vuelve a pedir el árbol de archivos.';

/* ------------------------------------------------------------------ *
 * File list model
 * ------------------------------------------------------------------ */

/** One entry of the project tree, exactly as the source reported it. */
export interface FileEntry {
  /** Project-relative path (`src/app.ts`). */
  path: string;
  /** Size in bytes; `0` for a directory (the source never invents one). */
  size: number;
  kind: 'file' | 'dir';
}

/** Parse outcome of a tree body. */
export type TreeParse =
  | { ok: true; entries: FileEntry[] }
  | {
      ok: false;
      message: string;
      /** 0-based index of the invalid entry, or null for a whole-body failure. */
      index: number | null;
      /** Raw evidence of the offending value, for the log and the card. */
      raw: string | null;
    };

/** Raw evidence of any value, truncated for the log and the error card. */
function rawPrefix(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.slice(0, 160) : null;
  } catch {
    return null;
  }
}

/** One raw entry → a `FileEntry`, or null when it is not usable. */
function parseEntry(value: unknown): FileEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  if (path === '') {
    return null;
  }
  // `kind` is this model's field; the bridge lists `type`, so both are read.
  // A symlink or anything else is neither a file nor a dir: refusing it is
  // honest, and the message names it (a file row would be a lie).
  const kindRaw = entry.kind ?? entry.type;
  if (kindRaw !== 'file' && kindRaw !== 'dir') {
    return null;
  }
  // A directory size is 0 by definition; a null/absent size on a FILE means the
  // source does not know it, and inventing `0 B` would be a fake fact.
  const rawSize = entry.size;
  const size =
    typeof rawSize === 'number' && Number.isInteger(rawSize) && rawSize >= 0
      ? rawSize
      : rawSize === null && kindRaw === 'dir'
        ? 0
        : null;
  if (size === null) {
    return null;
  }
  return { path, size, kind: kindRaw };
}

/** Path of an invalid entry, when the value carries one (to name it). */
function pathOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const path = (value as Record<string, unknown>).path;
  return typeof path === 'string' && path.trim() !== '' ? path.trim() : null;
}

/**
 * Parse the `/api/fs/tree` body (`{ "entries": [...] }`).
 *
 * Each entry is `{path, size, kind: 'file' | 'dir'}`; the bridge lists
 * `{name, path, type, size}` instead, so `type` is accepted for `kind` and a
 * `null` size is only usable for a directory.
 *
 * Strict by design: an invalid entry fails the whole tree and the message names
 * it (index and path). Dropping it would leave a shorter list that looks like
 * the truth of the project.
 */
export function parseTree(body: unknown): TreeParse {
  if (typeof body !== 'object' || body === null) {
    return {
      ok: false,
      message: INCOMPLETE_TREE_COPY,
      index: null,
      raw: rawPrefix(body),
    };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.entries)) {
    return {
      ok: false,
      message: `${INCOMPLETE_TREE_COPY} El cuerpo no trae una lista de entradas.`,
      index: null,
      raw: rawPrefix(body),
    };
  }

  const entries: FileEntry[] = [];
  for (const [index, value] of record.entries.entries()) {
    const entry = parseEntry(value);
    if (entry === null) {
      const path = pathOf(value);
      const name = path === null ? '' : ` (${path})`;
      return {
        ok: false,
        message: `La entrada ${index + 1} del árbol${name} no tiene la forma esperada.`,
        index,
        raw: rawPrefix(value),
      };
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * Ordering of the tree: directories first, then files, alphabetical inside each
 * group (case-insensitive, es-AR) so the list never jumps between reads.
 */
export function orderEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'dir' ? -1 : 1;
    }
    return left.path.localeCompare(right.path, 'es-AR', { sensitivity: 'base' });
  });
}

/** `1.4 kB` / `12 B` / `—` when the size is not a usable number. */
export function formatSize(size: number): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return '—';
  }
  if (size < 1024) {
    return `${Math.trunc(size)} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} kB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** One row of the rendered tree. */
export interface FileRow {
  /** Project-relative path (also the row key). */
  path: string;
  /** Last segment (`app.ts`), what the row shows. */
  name: string;
  kind: 'file' | 'dir';
  /** Nesting level derived from the path segments. */
  depth: number;
  size: number;
  sizeLabel: string;
}

/** Display rows of an already ordered tree. */
export function treeRows(entries: readonly FileEntry[]): FileRow[] {
  return entries.map((entry) => {
    const segments = entry.path.split('/').filter((segment) => segment !== '');
    return {
      path: entry.path,
      name: segments[segments.length - 1] ?? entry.path,
      kind: entry.kind,
      depth: Math.max(0, segments.length - 1),
      size: entry.size,
      sizeLabel: formatSize(entry.size),
    };
  });
}

/** Breadcrumb segments of an open file (`src/app.ts` → `['src', 'app.ts']`). */
export function breadcrumb(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/* ------------------------------------------------------------------ *
 * Buffer model
 * ------------------------------------------------------------------ */

/** One open file: what is on screen next to what the file actually holds. */
export interface EditorBuffer {
  path: string;
  /** Current text (what the person typed). */
  text: string;
  /** Text the file had when it was opened; the diff base of `dirty`. */
  original: string;
  /** Always derived from `text !== original` — never set by hand. */
  dirty: boolean;
}

/** Opens a buffer from content that really came from the file. */
export function openBuffer(path: string, text: string): EditorBuffer {
  return { path, text, original: text, dirty: false };
}

/** Applies an edit; `dirty` is re-derived from the diff against the original. */
export function editBuffer(buffer: EditorBuffer, text: string): EditorBuffer {
  return {
    path: buffer.path,
    text,
    original: buffer.original,
    dirty: text !== buffer.original,
  };
}

/** Outcome of closing a buffer. */
export type CloseBufferResult =
  | { ok: true; discarded: boolean }
  | { ok: false; needsConfirm: true; message: string };

/**
 * Closes a buffer. A dirty one is never lost silently: without `confirm` the
 * result is `needsConfirm` and the shell must ask. `confirm` is the explicit
 * "discard" the human tapped.
 */
export function closeBuffer(buffer: EditorBuffer, confirm: boolean = false): CloseBufferResult {
  if (buffer.dirty && !confirm) {
    return { ok: false, needsConfirm: true, message: DISCARD_MESSAGE };
  }
  return { ok: true, discarded: buffer.dirty };
}

/* ------------------------------------------------------------------ *
 * Display model (line numbers, tabs, truncation)
 * ------------------------------------------------------------------ */

/** One rendered line of the pane. */
export interface DisplayLine {
  /** 1-based number shown in the gutter. */
  number: number;
  /** Text with tabs already expanded. */
  text: string;
}

/** What the pane renders, and whether it is complete. */
export interface CodeView {
  lines: DisplayLine[];
  truncated: boolean;
  /** Characters hidden behind the marker (0 when nothing was cut). */
  hidden: number;
  /** `… [truncado: N caracteres ocultos]`, or null when the file fits. */
  marker: string | null;
}

/** Expands tabs to the next stop of `size`, column-aware (`a\tb` → `a b`). */
export function expandTabs(line: string, size: number = TAB_SIZE): string {
  const width = size > 0 ? size : TAB_SIZE;
  let out = '';
  let column = 0;
  for (const char of line) {
    if (char === '\t') {
      const pad = width - (column % width);
      out += ' '.repeat(pad);
      column += pad;
      continue;
    }
    out += char;
    column += 1;
  }
  return out;
}

/** The real marker that replaces a silent cut. */
export function truncationMarker(hidden: number): string {
  const noun = hidden === 1 ? 'carácter oculto' : 'caracteres ocultos';
  return `… [truncado: ${hidden} ${noun}]`;
}

/**
 * Render model of one buffer: 1-based line numbers, expanded tabs, and a real
 * truncation at `cap` characters. Over the cap the head is kept and the marker
 * names exactly how many characters were hidden.
 */
export function renderCode(text: string, cap: number = DISPLAY_CHAR_CAP): CodeView {
  const expanded = text.split('\n').map((line) => expandTabs(line));
  const total = expanded.reduce((sum, line, index) => sum + line.length + (index === 0 ? 0 : 1), 0);

  const lines: DisplayLine[] = [];
  let used = 0;
  for (const [index, line] of expanded.entries()) {
    const cost = line.length + (index === 0 ? 0 : 1);
    if (used + cost > cap) {
      const hidden = total - used;
      return { lines, truncated: true, hidden, marker: truncationMarker(hidden) };
    }
    used += cost;
    lines.push({ number: index + 1, text: line });
  }
  return { lines, truncated: false, hidden: 0, marker: null };
}

/* ------------------------------------------------------------------ *
 * Save intent
 * ------------------------------------------------------------------ */

/** What tapping save means today: a real request to an endpoint that is absent. */
export interface SaveIntent {
  /** Always true: `fs_write` does not exist and the bridge serves no fs write. */
  pending: true;
  method: 'POST';
  /** `/api/fs/write` — the route the save would be posted to. */
  route: string;
  path: string;
  text: string;
  dirty: boolean;
  /** Honest note the shell shows instead of a fake `Guardado` chip. */
  note: string;
}

/** Build the save descriptor. Pure: the buffer is untouched and stays dirty. */
export function saveIntent(buffer: EditorBuffer): SaveIntent {
  return {
    pending: true,
    method: 'POST',
    route: FS_WRITE_PATH,
    path: buffer.path,
    text: buffer.text,
    dirty: buffer.dirty,
    note: SAVE_PENDING_NOTE,
  };
}

/* ------------------------------------------------------------------ *
 * Injected source seam
 * ------------------------------------------------------------------ */

/** Why a source could not answer. */
export type EditorFailureKind =
  | 'no-fs'
  | 'offline'
  | 'timeout'
  | 'missing-endpoint'
  | 'bad-response';

/** Typed source failure, with the raw evidence for the log. */
export interface EditorFailure {
  kind: EditorFailureKind;
  /** Human copy the UI can show as-is (es-AR). */
  message: string;
  /** Raw evidence (`status=501 /api/fs/list`, `write=0`, …). */
  raw: string | null;
}

/** One source answer: the raw payload, or why there is none. */
export type SourceResult = { ok: true; body: unknown } | { ok: false; failure: EditorFailure };

/**
 * Everything this screen needs from the outside world. Injected, so the tests
 * never touch a device and the app can swap local-mode FFI in later without
 * touching the model.
 */
export interface EditorSource {
  /** Lists the project folder (`/api/fs/tree` today). */
  list(): Promise<SourceResult>;
  /** Reads one file (`/api/fs/read` today). */
  read(path: string): Promise<SourceResult>;
}

/** Failure sink this module needs (`logger.tag('local-editor')` satisfies it). */
export interface EditorLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Default failure sink for the app (one tag, one ring buffer, one log). */
export const editorLog: EditorLogger = logger.tag('local-editor');

const noFsFailure = (raw: string): EditorFailure => ({
  kind: 'no-fs',
  message: NO_FS_MESSAGE,
  raw,
});

/**
 * The real source: the bridge when a tunnel exists, and the honest capability
 * gap when it does not.
 *
 * A null channel is local mode (no PC involved): the files would come from the
 * on-device core FFI, which does not exist yet, so every call fails `no-fs`
 * instead of pretending the project is empty.
 */
export function bridgeEditorSource(channel: TunnelChannel | null): EditorSource {
  if (channel === null) {
    return {
      async list() {
        return { ok: false, failure: noFsFailure('no-tunnel') };
      },
      async read() {
        return { ok: false, failure: noFsFailure('no-tunnel') };
      },
    };
  }

  return {
    list: () => request(channel, FS_TREE_PATH),
    read: (path: string) => request(channel, `${FS_READ_PATH}?path=${encodeURIComponent(path)}`),
  };
}

/** Bridge failure kind → this module's kind (there is no `protocol-status` here). */
function failureKind(kind: string): EditorFailureKind {
  if (kind === 'timeout') {
    return 'timeout';
  }
  if (kind === 'offline') {
    return 'offline';
  }
  return 'bad-response';
}

/** One bridge GET → a source answer, mapping the failures honestly. */
async function request(
  channel: TunnelChannel,
  path: string,
  timeoutMs: number = FS_TIMEOUT_MS,
): Promise<SourceResult> {
  const result = await bridgeRequest<unknown>(channel, path, { timeoutMs });
  if (!result.ok) {
    return {
      ok: false,
      failure: {
        kind: failureKind(result.failure.kind),
        message: result.failure.message,
        raw: result.failure.raw ?? result.failure.kind,
      },
    };
  }
  if (result.status < 200 || result.status >= 300) {
    // The bridge answered, but not with files. A missing endpoint is the
    // expected state today, and it must read as "not available", never as
    // "the project is empty".
    const missing = result.status === 404 || result.status === 501;
    return {
      ok: false,
      failure: {
        kind: missing ? 'missing-endpoint' : 'bad-response',
        message: missing ? MISSING_ENDPOINT_COPY : `La PC respondió ${result.status}.`,
        raw: `status=${result.status} ${path}`,
      },
    };
  }
  return { ok: true, body: result.body };
}

/* ------------------------------------------------------------------ *
 * Honest states
 * ------------------------------------------------------------------ */

/** The §V15 states table, logic level, plus the local-mode capability gap. */
export type TreeState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; entries: FileEntry[] }
  | { kind: 'stale'; entries: FileEntry[]; minutes: number }
  | { kind: 'offline'; entries: FileEntry[] | null; minutes: number | null }
  | { kind: 'error'; message: string; raw: string | null }
  | { kind: 'no-fs'; message: string; raw: string | null };

/** State of one read: a real buffer, or the honest reason there is none. */
export type BufferState =
  | { kind: 'loading' }
  | { kind: 'success'; buffer: EditorBuffer }
  | { kind: 'no-fs'; message: string; raw: string | null }
  | { kind: 'offline'; message: string; raw: string | null }
  | { kind: 'error'; message: string; raw: string | null };

/**
 * Last good tree, so a later timeout can show the cached entries with the honest
 * age instead of inventing a project layout.
 */
export class TreeCache {
  private entries: FileEntry[] | null = null;
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Marks "the source answered this tree, now". */
  mark(entries: readonly FileEntry[]): void {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.at = this.now();
  }

  /** Cached entries + minutes since they arrived, or null when never answered. */
  snapshot(): { entries: FileEntry[]; minutes: number } | null {
    if (this.at === 0 || this.entries === null) {
      return null;
    }
    const minutes = Math.max(1, Math.floor((this.now() - this.at) / 60_000));
    return { entries: this.entries, minutes };
  }

  /** Drops the cache: an empty project is truth, not something to fall back to. */
  clear(): void {
    this.entries = null;
    this.at = 0;
  }
}

/** Dependencies of `loadTree` (injected cache + logger). */
export interface LoadTreeDeps {
  /** Cache of the last good tree (stale/offline rows). */
  cache?: TreeCache | null;
  /** Failure sink; defaults to `editorLog`. */
  logger?: EditorLogger;
}

/** One source failure → the §V15 state it deserves. */
export function stateFromFailure(failure: EditorFailure, cache: TreeCache | null = null): TreeState {
  const cached = cache?.snapshot() ?? null;
  switch (failure.kind) {
    case 'no-fs':
      return { kind: 'no-fs', message: failure.message, raw: failure.raw };
    case 'offline':
      return {
        kind: 'offline',
        entries: cached?.entries ?? null,
        minutes: cached?.minutes ?? null,
      };
    case 'timeout':
      return cached === null
        ? { kind: 'offline', entries: null, minutes: null }
        : { kind: 'stale', entries: cached.entries, minutes: cached.minutes };
    default:
      return { kind: 'error', message: failure.message, raw: failure.raw };
  }
}

/**
 * Load the project tree from the injected source. A null source is the local
 * mode of today: `no-fs` naming the missing core FFI, never a blank tree.
 *
 * Never throws: every outcome is one of the honest states.
 */
export async function loadTree(
  source: EditorSource | null,
  deps: LoadTreeDeps = {},
): Promise<TreeState> {
  const log = deps.logger ?? editorLog;
  const cache = deps.cache ?? null;

  if (source === null) {
    log.failure('source', new Error('Sin fuente de archivos en el teléfono.'), 'source=null');
    return { kind: 'no-fs', message: NO_FS_MESSAGE, raw: 'source=null' };
  }

  const result = await source.list();
  if (!result.ok) {
    log.failure('fs-list', new Error(result.failure.message), result.failure.raw ?? result.failure.kind);
    return stateFromFailure(result.failure, cache);
  }

  const parsed = parseTree(result.body);
  if (!parsed.ok) {
    log.failure('fs-list-parse', new Error(parsed.message), parsed.raw);
    return { kind: 'error', message: parsed.message, raw: parsed.raw };
  }

  const entries = orderEntries(parsed.entries);
  if (entries.length === 0) {
    // A real empty project: no rows, no cache to fall back to.
    cache?.clear();
    return { kind: 'empty' };
  }

  cache?.mark(entries);
  return { kind: 'success', entries };
}

/** Parse outcome of a read body. */
export type FileParse =
  | { ok: true; path: string; text: string }
  | { ok: false; message: string; raw: string | null };

/**
 * Parse the `/api/fs/read` body (`{ "path": "...", "text": "..." }`).
 *
 * `text` (this model) and `content` (the bridge) are both accepted; anything
 * else is an error, because treating a missing text as `''` would show an empty
 * file that the person would then "edit" and believe. `path` is optional (the
 * requested path wins when it is absent).
 */
export function parseFile(body: unknown, requested: string): FileParse {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: INCOMPLETE_FILE_COPY, raw: rawPrefix(body) };
  }
  const record = body as Record<string, unknown>;
  // `text` is this model's field; the bridge answers `content`.
  const text = typeof record.text === 'string' ? record.text : record.content;
  if (typeof text !== 'string') {
    return {
      ok: false,
      message: `${INCOMPLETE_FILE_COPY} El cuerpo no trae el texto del archivo.`,
      raw: rawPrefix(body),
    };
  }
  const reported = typeof record.path === 'string' ? record.path.trim() : '';
  return { ok: true, path: reported === '' ? requested : reported, text };
}

/** Dependencies of `readFile`. */
export interface ReadFileDeps {
  logger?: EditorLogger;
}

/**
 * Read one file through the injected source and open its buffer.
 *
 * A null source is `no-fs`; a bridge 501 is `error` carrying the failure; a 200
 * without text is `error` too. In none of those is an empty buffer returned.
 */
export async function readFile(
  source: EditorSource | null,
  path: string,
  deps: ReadFileDeps = {},
): Promise<BufferState> {
  const log = deps.logger ?? editorLog;

  if (source === null) {
    log.failure('source', new Error('Sin fuente de archivos en el teléfono.'), 'source=null');
    return { kind: 'no-fs', message: NO_FS_MESSAGE, raw: 'source=null' };
  }

  const result = await source.read(path);
  if (!result.ok) {
    log.failure('fs-read', new Error(result.failure.message), result.failure.raw ?? result.failure.kind);
    if (result.failure.kind === 'no-fs') {
      return { kind: 'no-fs', message: result.failure.message, raw: result.failure.raw };
    }
    if (result.failure.kind === 'offline' || result.failure.kind === 'timeout') {
      return { kind: 'offline', message: result.failure.message, raw: result.failure.raw };
    }
    return { kind: 'error', message: result.failure.message, raw: result.failure.raw };
  }

  const parsed = parseFile(result.body, path);
  if (!parsed.ok) {
    log.failure('fs-read-parse', new Error(parsed.message), parsed.raw);
    return { kind: 'error', message: parsed.message, raw: parsed.raw };
  }

  return { kind: 'success', buffer: openBuffer(parsed.path, parsed.text) };
}
