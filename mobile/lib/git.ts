/**
 * V13 — Git changes logic (artboard
 * `design/mobile-app-core/09-git-changes.html`, `docs/mobile-views-plan.md` §V13).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * network of its own. `mobile/app/git-changes.tsx` is the rendering shell and
 * `mobile/test/git.test.mjs` pins these rules:
 *
 * - the staged / unstaged split, then the `Modificados / Nuevos / Borrados /
 *   Renombrados` sections the artboard shows, with the rows sorted by path
 *   inside each section;
 * - the `N archivos · +X −Y` total line, summed from the real numbers the PC
 *   reported (a single file reads `1 archivo`);
 * - one honest state per outcome, mirroring `lib/sessions.ts`:
 *   `loading | empty | success | stale | offline | error`.
 *
 * ## The endpoint this module expects (protocol §4)
 *
 * `loadChanges` performs `GET /api/git/status` over the tunnel channel and
 * expects this body (the endpoint is a bridge extension of protocol §4; the
 * core only guarantees the tunnel and `/api/health` / `/api/sessions` today):
 *
 * ```json
 * {
 *   "workspace": "/home/me/proj",
 *   "branch": "feat/auth-login",
 *   "ahead": 2,
 *   "behind": 0,
 *   "files": [
 *     { "path": "src/a.ts", "status": "modified",
 *       "additions": 3, "deletions": 1, "staged": true }
 *   ]
 * }
 * ```
 *
 * `status` is `added | modified | deleted | renamed`; `staged` is a boolean;
 * `additions` / `deletions` are non-negative integers (git `numstat`). A path
 * that is both staged and unstaged arrives as two entries, exactly like
 * `git status` prints it, and therefore as two rows.
 *
 * Honesty rules (S7), the same the Sessions list follows:
 * - no tunnel → `offline` (`Requiere conexión — git se ejecuta en tu PC.`),
 *   never an empty "no changes" success;
 * - an extension that does not expose the endpoint (404/501) → `error` with
 *   `La extensión no expone los cambios todavía`, never an empty tree;
 * - incomplete/invalid entries → `error` naming the offending path, never
 *   invented files or stats;
 * - a timeout with a previous good answer → `stale` (`Datos de hace N min`);
 * - an empty `files` array is the `empty` state (`Sin cambios en este
 *   workspace.`), never success with zeros.
 *
 * Every failure is logged through the injectable `failure(step, error, raw)`
 * seam (`logger.tag('git-changes')` in the app) with `{step, error, raw}`.
 */

import {
  type BridgeFailure,
  type TunnelChannel,
  bridgeRequest,
} from './bridge.ts';
import { logger } from './logger.ts';

/* ------------------------------------------------------------------ *
 * Wire model (§V13 payload)
 * ------------------------------------------------------------------ */

/** Endpoint expected from the bridge (protocol §4). */
export const GIT_STATUS_PATH = '/api/git/status';

/** The four statuses §V13 renders. */
export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** Section order of the artboard: `Modificados / Nuevos / Borrados`. */
export const STATUS_ORDER: readonly GitFileStatus[] = [
  'modified',
  'added',
  'deleted',
  'renamed',
];

/** Section legend copy. */
export const SECTION_TITLES: Record<GitFileStatus, string> = {
  modified: 'Modificados',
  added: 'Nuevos',
  deleted: 'Borrados',
  renamed: 'Renombrados',
};

/** Row status copy (screen-reader / accessibility label). */
export const STATUS_LABELS: Record<GitFileStatus, string> = {
  modified: 'Modificado',
  added: 'Nuevo',
  deleted: 'Borrado',
  renamed: 'Renombrado',
};

/** Artboard glyphs of the status square. */
export const STATUS_GLYPHS: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
};

/** Tone token each glyph uses (warning / ok / danger / accent). */
export type StatusTone = 'warning' | 'ok' | 'danger' | 'accent';

/** Glyph tone per status, straight from the artboard. */
export const STATUS_TONES: Record<GitFileStatus, StatusTone> = {
  modified: 'warning',
  added: 'ok',
  deleted: 'danger',
  renamed: 'accent',
};

/** One changed file as the PC reports it. */
export interface ChangedFile {
  path: string;
  status: GitFileStatus;
  /** Lines added (git `numstat`), a real count the PC measured. */
  additions: number;
  /** Lines removed (git `numstat`). */
  deletions: number;
  /** True when the change is in the index (staged). */
  staged: boolean;
}

/** The §V13 payload: changed files plus the header identity. */
export interface ChangesPayload {
  files: ChangedFile[];
  /** Working tree branch (chip in the header), null when the PC omitted it. */
  branch: string | null;
  /** Workspace the PC reported, null when it omitted it. */
  workspace: string | null;
  /** Commits ahead of upstream, null when the PC omitted it. */
  ahead: number | null;
  /** Commits behind upstream, null when the PC omitted it. */
  behind: number | null;
}

/** Parse outcome: the real payload, or why the body is not usable. */
export type ParseResult =
  | { ok: true; payload: ChangesPayload }
  | { ok: false; message: string; raw: string | null };

/** Copy of an incomplete payload (§V13 `error`). */
export const INCOMPLETE_COPY = 'La PC devolvió datos incompletos sobre los cambios.';

/** Raw evidence of any value, truncated for the log and the error card. */
function rawPrefix(value: unknown): string | null {
  try {
    if (value === undefined || value === null) {
      return null;
    }
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.slice(0, 120) : null;
  } catch {
    return null;
  }
}

function isKnownStatus(value: unknown): value is GitFileStatus {
  return (
    value === 'added' || value === 'modified' || value === 'deleted' || value === 'renamed'
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Optional non-negative integer (header counters). */
function optionalCount(value: unknown): number | null {
  return isCount(value) ? Math.trunc(value) : null;
}

/** Optional non-empty string (branch / workspace). */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** One raw entry → a `ChangedFile`, or null when it is not usable. */
function parseFile(entry: unknown): ChangedFile | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.path !== 'string' || record.path === '') {
    return null;
  }
  if (!isKnownStatus(record.status)) {
    return null;
  }
  if (!isCount(record.additions) || !isCount(record.deletions)) {
    return null;
  }
  if (typeof record.staged !== 'boolean') {
    return null;
  }
  return {
    path: record.path,
    status: record.status,
    additions: Math.trunc(record.additions),
    deletions: Math.trunc(record.deletions),
    staged: record.staged,
  };
}

/**
 * Validate the §V13 body. Anything else is refused with the raw evidence of the
 * offending value: a half-understood payload must never become rows, because a
 * row here claims "this is what changed on your PC".
 */
export function parseChanges(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(body) };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.files)) {
    return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(body) };
  }
  const files: ChangedFile[] = [];
  for (const entry of record.files) {
    const parsed = parseFile(entry);
    if (parsed === null) {
      return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(entry) };
    }
    files.push(parsed);
  }
  return {
    ok: true,
    payload: {
      files,
      branch: optionalText(record.branch),
      workspace: optionalText(record.workspace),
      ahead: optionalCount(record.ahead),
      behind: optionalCount(record.behind),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Grouping, order and totals
 * ------------------------------------------------------------------ */

/** One row of the §V13 list. */
export interface FileRow {
  path: string;
  status: GitFileStatus;
  /** `M` / `A` / `D` / `R` square glyph. */
  glyph: string;
  /** `Modificado` / `Nuevo` / `Borrado` / `Renombrado`. */
  statusLabel: string;
  tone: StatusTone;
  additions: number;
  deletions: number;
  /** `+9 −2` (real counts, U+2212 minus as the artboard). */
  delta: string;
  staged: boolean;
  /** `/git-changes/<path>` — the diff view is planned (V13), not built. */
  route: string;
}

/** One status section inside a group (`Modificados`, …). */
export interface FileSection {
  id: GitFileStatus;
  title: string;
  rows: FileRow[];
}

/** Staged or unstaged group. */
export interface FileGroup {
  id: 'staged' | 'unstaged';
  /** `Preparados` / `Sin preparar`. */
  title: string;
  count: number;
  rows: FileRow[];
  sections: FileSection[];
}

/** Group ids and titles, artboard order (staged first). */
export const GROUP_TITLES: Record<FileGroup['id'], string> = {
  staged: 'Preparados',
  unstaged: 'Sin preparar',
};

/** Diff route of one file (the view does not exist yet). */
export function diffRoute(path: string): string {
  return `/git-changes/${encodeURIComponent(path)}`;
}

/** `+9 −2`. */
export function deltaLabel(additions: number, deletions: number): string {
  return `+${additions} −${deletions}`;
}

/** One `ChangedFile` → one row. */
export function fileRow(file: ChangedFile): FileRow {
  return {
    path: file.path,
    status: file.status,
    glyph: STATUS_GLYPHS[file.status],
    statusLabel: STATUS_LABELS[file.status],
    tone: STATUS_TONES[file.status],
    additions: file.additions,
    deletions: file.deletions,
    delta: deltaLabel(file.additions, file.deletions),
    staged: file.staged,
    route: diffRoute(file.path),
  };
}

/** Path order inside a section: code-point ascending, stable. */
export function sortByPath<T extends { path: string }>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.path !== b.row.path) {
        return a.row.path < b.row.path ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * Staged first, then unstaged; inside each group one section per status in
 * `STATUS_ORDER`, rows sorted by path. Empty groups and empty sections are
 * omitted — an empty `Nuevos` header would claim something happened.
 */
export function groupFiles(files: readonly ChangedFile[]): FileGroup[] {
  const groups: FileGroup[] = [];
  for (const id of ['staged', 'unstaged'] as const) {
    const members = files.filter((file) => file.staged === (id === 'staged'));
    if (members.length === 0) {
      continue;
    }
    const rows = sortByPath(members).map(fileRow);
    const sections: FileSection[] = [];
    for (const status of STATUS_ORDER) {
      const sectionRows = rows.filter((row) => row.status === status);
      if (sectionRows.length > 0) {
        sections.push({ id: status, title: SECTION_TITLES[status], rows: sectionRows });
      }
    }
    groups.push({
      id,
      title: GROUP_TITLES[id],
      count: rows.length,
      rows,
      sections,
    });
  }
  return groups;
}

/** Totals of the whole change set. */
export interface ChangeTotals {
  /** Rows (git reports a staged+unstaged path twice, so it counts twice). */
  files: number;
  additions: number;
  deletions: number;
}

/** Sum the real numbers; nothing is estimated. */
export function changeTotals(files: readonly ChangedFile[]): ChangeTotals {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** `3 archivos · +12 −3` (singular: `1 archivo · +2 −1`). */
export function summaryLine(totals: ChangeTotals): string {
  return `${totals.files} ${totals.files === 1 ? 'archivo' : 'archivos'} · +${totals.additions} −${totals.deletions}`;
}

/* ------------------------------------------------------------------ *
 * Honest states
 * ------------------------------------------------------------------ */

/** The §V13 states table, logic level. */
export type ChangesState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; payload: ChangesPayload }
  | { kind: 'stale'; minutes: number; payload: ChangesPayload }
  | { kind: 'offline'; payload: ChangesPayload | null; minutes: number | null }
  | { kind: 'error'; message: string; raw: string | null };

/**
 * Last good `/api/git/status` answer, so a later timeout can show the cached
 * rows with the honest age instead of inventing a tree or pretending it is
 * clean.
 */
export class ChangesCache {
  private payload: ChangesPayload | null = null;
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Marks "the PC answered this tree, now". */
  mark(payload: ChangesPayload): void {
    this.payload = {
      files: [...payload.files],
      branch: payload.branch,
      workspace: payload.workspace,
      ahead: payload.ahead,
      behind: payload.behind,
    };
    this.at = this.now();
  }

  /** Cached payload + minutes since it arrived, or null when never answered. */
  snapshot(): { payload: ChangesPayload; minutes: number } | null {
    if (this.at === 0 || this.payload === null) {
      return null;
    }
    const minutes = Math.max(1, Math.floor((this.now() - this.at) / 60_000));
    return { payload: this.payload, minutes };
  }

  /** Drops the cache: a clean tree is truth, not something to fall back to. */
  clear(): void {
    this.payload = null;
    this.at = 0;
  }
}

/** Failure sink this module needs (`logger.tag('git-changes')` satisfies it). */
export interface GitLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Injectable dependencies (cache, logger, deadline). */
export interface LoadChangesDeps {
  /** Cache of the last good answer (stale/offline rows). */
  cache?: ChangesCache;
  /** Failure sink; defaults to `logger.tag('git-changes')`. */
  logger?: GitLogger;
  /** Deadline of the `/api/git/status` call (default `GIT_STATUS_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** Default deadline of one git status fetch, matching the other bridge calls. */
export const GIT_STATUS_TIMEOUT_MS = 8_000;

/** Copy when the tunnel is down (§V13 offline). */
export const OFFLINE_COPY = 'Requiere conexión — git se ejecuta en tu PC.';

/** Copy of the reconnect hint next to `OFFLINE_COPY`. */
export const RECONNECTING_COPY = 'Reconectando…';

/** Copy when the extension does not serve the endpoint yet. */
export const MISSING_ENDPOINT_COPY = 'La extensión no expone los cambios todavía';

/** Copy of the error card title (§V13 `error`). */
export const ERROR_TITLE = 'No pudimos leer los cambios';

/** Copy when the tree is clean (§V13 `empty`). */
export const EMPTY_COPY = 'Sin cambios en este workspace.';

/** Raw evidence of a failure, always something the log can keep. */
function rawOf(failure: BridgeFailure): string {
  return failure.raw ?? failure.kind;
}

/**
 * One failed bridge call → the §V13 state it deserves. Mirrors
 * `stateFromFailure` of `lib/sessions.ts`:
 *
 * - `offline` → offline, with the cached rows when there are any;
 * - `timeout` → stale when something was cached, offline when nothing was;
 * - `bad-response` / `protocol-status` → error carrying message + raw.
 */
export function stateFromFailure(
  failure: BridgeFailure,
  cache: ChangesCache | null = null,
): ChangesState {
  const cached = cache?.snapshot() ?? null;
  switch (failure.kind) {
    case 'offline':
      return {
        kind: 'offline',
        payload: cached?.payload ?? null,
        minutes: cached?.minutes ?? null,
      };
    case 'timeout':
      return cached === null
        ? { kind: 'offline', payload: null, minutes: null }
        : { kind: 'stale', minutes: cached.minutes, payload: cached.payload };
    default:
      return { kind: 'error', message: failure.message, raw: failure.raw };
  }
}

/** Default failure sink for the app (one tag, one ring buffer, one log file). */
export const gitLog: GitLogger = logger.tag('git-changes');

/**
 * Fetch `GET /api/git/status` over the tunnel channel and return the §V13
 * state. A null channel means the app has no tunnel (never opened or closed),
 * which is `offline` — the screen says so instead of showing a clean tree.
 *
 * Never throws and never invents: every failure is the matching §V13 state.
 */
export async function loadChanges(
  channel: TunnelChannel | null,
  deps: LoadChangesDeps = {},
): Promise<ChangesState> {
  const log = deps.logger ?? gitLog;
  const cache = deps.cache ?? null;

  if (channel === null) {
    log.failure('tunnel', new Error('Sin túnel abierto hacia la PC.'), null);
    return stateFromFailure(
      {
        kind: 'offline',
        message: 'Sin túnel hacia la PC.',
        raw: null,
        error: null,
      },
      cache,
    );
  }

  const result = await bridgeRequest<unknown>(channel, GIT_STATUS_PATH, {
    timeoutMs: deps.timeoutMs ?? GIT_STATUS_TIMEOUT_MS,
  });
  if (!result.ok) {
    log.failure(
      'git-status-request',
      result.failure.error ?? new Error(result.failure.message),
      rawOf(result.failure),
    );
    return stateFromFailure(result.failure, cache);
  }

  if (result.status < 200 || result.status >= 300) {
    // The bridge answered, but not with a change set. A missing endpoint is
    // the expected state today (protocol §4 has no git surface yet): it must
    // read as "this is not available", never as "nothing changed".
    const missing = result.status === 404 || result.status === 501;
    const message = missing ? MISSING_ENDPOINT_COPY : `La PC respondió ${result.status}.`;
    const raw = `status=${result.status} ${GIT_STATUS_PATH}`;
    log.failure('git-status-request', new Error(message), raw);
    return { kind: 'error', message, raw };
  }

  const parsed = parseChanges(result.body);
  if (!parsed.ok) {
    log.failure('git-status-parse', new Error(parsed.message), parsed.raw);
    return { kind: 'error', message: parsed.message, raw: parsed.raw };
  }

  if (parsed.payload.files.length === 0) {
    // A real clean tree: nothing on screen, no zeros pretending to be data and
    // no cache to fall back to on the next timeout.
    cache?.clear();
    return { kind: 'empty' };
  }

  cache?.mark(parsed.payload);
  return { kind: 'success', payload: parsed.payload };
}

/* ------------------------------------------------------------------ *
 * Render model
 * ------------------------------------------------------------------ */

/** What `git-changes.tsx` renders, per §V13 states + reactions. */
export interface ChangesViewModel {
  state: 'loading' | 'empty' | 'success' | 'stale' | 'offline' | 'error';
  /** Non-empty staged/unstaged groups (empty groups and sections omitted). */
  groups: FileGroup[];
  /** `{files, additions, deletions}` of the whole change set, when there is data. */
  totals: ChangeTotals | null;
  /** `3 archivos · +12 −3`, when there is data. */
  summary: string | null;
  /** Branch chip copy, null when the PC omitted it. */
  branch: string | null;
  /** Ahead/behind counters, null when the PC omitted them. */
  ahead: number | null;
  behind: number | null;
  /** Workspace the PC reported, null when it omitted it. */
  workspace: string | null;
  /** Amber chip over cached rows (`Datos de hace N min` / `Última vez hace N min`). */
  staleChip: string | null;
  /** Offline banner copy (`Requiere conexión — git se ejecuta en tu PC.`). */
  banner: string | null;
  /** Reconnect hint next to the offline banner (`Reconectando…`). */
  bannerHint: string | null;
  /** Error card copy + raw evidence (`No pudimos leer los cambios`). */
  error: { title: string; message: string; raw: string | null } | null;
  /** `Sin cambios en este workspace.` only for a genuinely clean tree. */
  emptyMessage: string | null;
  /** Rows read from the cache (offline/stale): muted, status frozen. */
  frozen: boolean;
  /** Skeleton rows are showing (pull-to-refresh keeps the rows). */
  loading: boolean;
}

/** Build the render model from a §V13 state. */
export function buildChangesView(state: ChangesState): ChangesViewModel {
  const base: Omit<ChangesViewModel, 'state'> = {
    groups: [],
    totals: null,
    summary: null,
    branch: null,
    ahead: null,
    behind: null,
    workspace: null,
    staleChip: null,
    banner: null,
    bannerHint: null,
    error: null,
    emptyMessage: null,
    frozen: false,
    loading: false,
  };

  /** Shared projection of a payload that may be live or cached. */
  const projection = (payload: ChangesPayload, frozen: boolean) => {
    const totals = changeTotals(payload.files);
    return {
      groups: groupFiles(payload.files),
      totals,
      summary: summaryLine(totals),
      branch: payload.branch,
      ahead: payload.ahead,
      behind: payload.behind,
      workspace: payload.workspace,
      frozen,
    };
  };

  switch (state.kind) {
    case 'loading':
      return { ...base, state: 'loading', loading: true };
    case 'empty':
      return { ...base, state: 'empty', emptyMessage: EMPTY_COPY };
    case 'error':
      return {
        ...base,
        state: 'error',
        error: { title: ERROR_TITLE, message: state.message, raw: state.raw },
      };
    case 'success':
      return { ...base, state: 'success', ...projection(state.payload, false) };
    case 'stale':
      return {
        ...base,
        state: 'stale',
        ...projection(state.payload, true),
        staleChip: `Datos de hace ${state.minutes} min`,
      };
    case 'offline': {
      if (state.payload === null) {
        // Nothing cached: only the honest offline notice, no invented rows.
        return {
          ...base,
          state: 'offline',
          banner: OFFLINE_COPY,
          bannerHint: RECONNECTING_COPY,
        };
      }
      const minutes = state.minutes;
      return {
        ...base,
        state: 'offline',
        ...projection(state.payload, true),
        staleChip: minutes === null ? null : `Última vez hace ${minutes} min`,
        banner: OFFLINE_COPY,
        bannerHint: RECONNECTING_COPY,
      };
    }
  }
}
