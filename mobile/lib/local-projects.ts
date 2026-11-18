/**
 * V14 — Local projects logic (artboard
 * `design/mobile-app-core/07-local-projects.html`, `docs/mobile-views-plan.md`
 * §V14, task T7k).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * AsyncStorage, no filesystem. `mobile/app/local-projects.tsx` is the rendering
 * shell and `mobile/test/local-projects.test.mjs` pins these rules.
 *
 * ## Only real facts are rendered
 *
 * - the project list comes from the `gentle-movil:local-projects` record the
 *   person actually created (read through the injected async reader) — nothing
 *   is seeded, guessed or demo-filled;
 * - an empty store is a fact: the `empty` state, never an error and never a
 *   fake project;
 * - a corrupt store, or one invalid entry inside an otherwise valid array, is a
 *   typed error that names the failing index: entries are never dropped
 *   silently, because a shorter list would look like real state;
 * - the core Rust does not expose gitoxide yet, so `branch`, dirty count and
 *   last commit do not exist on the device: every row carries
 *   `gitFacts: null` with the literal reason `sin datos de git`. A branch chip
 *   or a `0 cambios` badge would be an invented fact;
 * - opening a project is a `pending: true` intent for `/local-editor` (the
 *   editor lands in the next slice), so the shell logs `route pending` instead
 *   of navigating to a screen that does not exist;
 * - creating a project only records the intent + the local record: `git init`
 *   is gitoxide work and belongs to the local-mode core slice.
 */

import { describeError } from './logger.ts';

/* ------------------------------------------------------------------ *
 * Copy (es-AR) and keys
 * ------------------------------------------------------------------ */

/** AsyncStorage key of the project list the person created on this phone. */
export const LOCAL_PROJECTS_STORAGE_KEY = 'gentle-movil:local-projects';

/** This screen (also the retry target of the storage error card). */
export const LOCAL_PROJECTS_ROUTE = '/local-projects';

/** The editor V15: not built yet, so opening a project stays pending. */
export const LOCAL_EDITOR_ROUTE = '/local-editor';

/** Sandbox folder the local-mode slice will materialize (nothing is written). */
export const PROJECTS_ROOT = 'proyectos';

/** Artboard screen title. */
export const PROJECTS_TITLE = 'Local';

/** Header chip of the artboard: this screen needs no PC and no tunnel. */
export const OFFLINE_CHIP_LABEL = 'sin PC';

/** Primary CTA (`+ Nuevo proyecto`). */
export const NEW_PROJECT_LABEL = '+ Nuevo proyecto';

/** Label + placeholder + submit of the inline name form. */
export const NEW_PROJECT_FIELD_LABEL = 'Nombre del proyecto';
export const NEW_PROJECT_PLACEHOLDER = 'vita-app';
export const NEW_PROJECT_SUBMIT_LABEL = 'Crear';

/** Honest note under the create form: nothing touches git on the phone yet. */
export const NEW_PROJECT_NOTE =
  'Crear el proyecto guarda la ficha en el teléfono: `git init` corre con gitoxide, que todavía no está en el core.';

/** Empty state copy from the view plan (`docs/mobile-views-plan.md` §V14). */
export const EMPTY_TITLE = 'Todavía no hay proyectos';
export const EMPTY_MESSAGE = 'Aún no hay proyectos. Clona un repositorio o crea uno.';

/** Honest qualifier: cloning is not wired either. */
export const EMPTY_NOTE =
  'Crear un proyecto ya se puede; clonar llega con el core Rust (gitoxide) y todavía no está conectado.';

/** Storage failure card. */
export const STORAGE_ERROR_TITLE = 'No pudimos leer los proyectos';
export const STORAGE_NOT_A_LIST = 'El almacenamiento no tiene una lista de proyectos.';
export const STORAGE_JSON_INVALID = 'El almacenamiento no tiene JSON válido';

/** Retry word used by every screen of the app. */
export const RETRY_LABEL = 'Reintentar';
export const STORAGE_RETRY_NOTE = 'Reintentar vuelve a leer el almacenamiento del teléfono.';

/** The literal reason every row shows until the core exposes git facts. */
export const GIT_FACTS_UNKNOWN_REASON = 'sin datos de git';

/** Why those facts are unknown — never a placeholder that looks like data. */
export const GIT_FACTS_UNKNOWN_DETAIL =
  'El core Rust todavía no expone gitoxide: rama, cambios y último commit quedan sin datos hasta que exista.';

/** Screen-level note about the missing git slice. */
export const GIT_FACTS_NOTE =
  'git todavía no corre en el teléfono: cada proyecto muestra sin datos de git hasta que el core Rust exponga gitoxide.';

/** Only opened projects show a relative time; the rest say so. */
export const NEVER_OPENED_LABEL = 'sin abrir';

/** Create-form validation copy. */
export const NAME_EMPTY_MESSAGE = 'Poné un nombre al proyecto.';
export const NAME_DUPLICATE_MESSAGE = 'Ya existe un proyecto con ese nombre.';

/** Note of the pending editor route. */
export const EDITOR_PENDING_NOTE =
  'El editor todavía no está construido: abrir el proyecto queda pendiente para la próxima rebanada.';

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

/** One project record, exactly as it lives in storage. */
export interface LocalProject {
  /** Local identifier the app generates; unique in the record. */
  id: string;
  /** Visible name (trimmed, non-empty). */
  name: string;
  /** Sandbox-relative folder (`proyectos/<slug>`); nothing is created yet. */
  path: string;
  /** ISO timestamp of the record creation. */
  createdAt: string;
  /** ISO timestamp of the last open, or null when it was never opened. */
  lastOpenedAt: string | null;
}

/** Injected storage reader (`AsyncStorage.getItem` satisfies it). */
export type LocalProjectsReader = (key: string) => Promise<string | null>;

/** Injected storage writer (`AsyncStorage.setItem` satisfies it). */
export type LocalProjectsWriter = (key: string, value: string) => Promise<void>;

/** Why the stored record could not be used. */
export type ProjectsFailureReason = 'storage' | 'json' | 'shape' | 'entry';

/** Outcome of a load: the real list, or a typed failure. */
export type ProjectsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; projects: LocalProject[] }
  | {
      kind: 'error';
      reason: ProjectsFailureReason;
      message: string;
      /** Index of the invalid entry (0-based), or null for a whole-record failure. */
      index: number | null;
    };

/** Outcome of parsing the raw stored value. */
export type ProjectsParse =
  | { ok: true; projects: LocalProject[] }
  | { ok: false; reason: ProjectsFailureReason; message: string; index: number | null };

/** Outcome of a write. A failing store is reported, never thrown. */
export type SaveProjectsResult = { ok: true } | { ok: false; message: string };

/** Create-form field that can fail. */
export type CreateProjectField = 'name';

/** Typed per-field validation error. */
export interface CreateProjectError {
  field: CreateProjectField;
  code: 'empty' | 'duplicate';
  message: string;
}

/** Options of `createProjectIntent` (injected so tests are deterministic). */
export interface CreateProjectOptions {
  /** ISO timestamp of the creation; defaults to now. */
  now?: string;
  /** Identifier to use; defaults to a generated one. */
  id?: string;
}

/** Outcome of a create intent. */
export type CreateProjectResult =
  | { ok: true; project: LocalProject }
  | { ok: false; errors: CreateProjectError[] };

/** Meeting point of every route/intent that is not built yet. */
export interface PendingIntent {
  route: string;
  /** True when the destination does not exist yet: the UI must log it. */
  pending: boolean;
  /** Honest sentence the shell shows/logs. */
  note: string;
}

/** Open intent of one project row. */
export interface OpenProjectIntent extends PendingIntent {
  route: typeof LOCAL_EDITOR_ROUTE;
  projectId: string;
}

/** One rendered row. */
export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string | null;
  /** `abierto hace 2 h` / `sin abrir`. */
  lastOpenedLabel: string;
  /** Always null until the core exposes git facts — never a fake value. */
  gitFacts: null;
  /** Literal reason (`sin datos de git`). */
  gitFactsReason: string;
  /** Why they are unknown (gitoxide is not exposed yet). */
  gitFactsDetail: string;
  open: OpenProjectIntent;
}

/** Screen state of the shell. */
export type ProjectsStatus = 'loading' | 'empty' | 'success' | 'error';

/** Storage failure card, with the retry that really re-reads. */
export interface ProjectsError {
  title: string;
  message: string;
  /** Failure detail; for an entry failure it names the project index. */
  detail: string;
  index: number | null;
  reason: ProjectsFailureReason;
  action: { route: string; label: string; pending: false; note: string };
}

/** Empty-state card. */
export interface ProjectsEmpty {
  title: string;
  message: string;
  note: string | null;
}

/** The whole screen, derived from state that was already read. */
export interface ProjectsViewModel {
  status: ProjectsStatus;
  title: string;
  chip: string;
  count: number;
  countLabel: string;
  rows: ProjectRow[];
  empty: ProjectsEmpty | null;
  error: ProjectsError | null;
  loading: boolean;
  create: {
    label: string;
    fieldLabel: string;
    placeholder: string;
    submitLabel: string;
    note: string;
  };
  gitNote: string;
}

/* ------------------------------------------------------------------ *
 * Parsing (injected raw value, never storage access)
 * ------------------------------------------------------------------ */

/** Strict string field: non-empty after trimming. */
function textField(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** ISO timestamp field; anything `Date.parse` refuses is invalid. */
function dateField(value: unknown): string | null {
  const text = textField(value);
  if (text === null || Number.isNaN(Date.parse(text))) {
    return null;
  }
  return text;
}

/** Parses one entry; `null` means it is not a valid project record. */
function parseEntry(value: unknown): LocalProject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = textField(entry.id);
  const name = textField(entry.name);
  const path = textField(entry.path);
  const createdAt = dateField(entry.createdAt);
  const lastOpenedAt = entry.lastOpenedAt === null ? null : dateField(entry.lastOpenedAt);

  if (id === null || name === null || path === null || createdAt === null) {
    return null;
  }
  if (entry.lastOpenedAt !== null && lastOpenedAt === null) {
    return null;
  }

  return { id, name, path, createdAt, lastOpenedAt };
}

/**
 * Parses the `gentle-movil:local-projects` record.
 *
 * - `null` (never written) is an empty list: a fact, not a failure;
 * - broken JSON or a non-array value fails the whole record;
 * - an invalid entry fails the record and names its index (`proyecto 2`) — it
 *   is never skipped, because the remaining list would then look like the truth.
 */
export function parseProjects(raw: string | null): ProjectsParse {
  if (raw === null) {
    return { ok: true, projects: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: 'json', message: describeError(error).message, index: null };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'shape', message: STORAGE_NOT_A_LIST, index: null };
  }

  const projects: LocalProject[] = [];
  for (const [index, value] of parsed.entries()) {
    const project = parseEntry(value);
    if (project === null) {
      return {
        ok: false,
        reason: 'entry',
        message: `El proyecto ${index + 1} del almacenamiento no tiene la forma esperada.`,
        index,
      };
    }
    projects.push(project);
  }

  return { ok: true, projects };
}

/** Serializes the list exactly as `parseProjects` reads it back. */
export function serializeProjects(projects: readonly LocalProject[]): string {
  return JSON.stringify(projects);
}

/* ------------------------------------------------------------------ *
 * Ordering and formatting
 * ------------------------------------------------------------------ */

/** Relative label of `lastOpenedAt` against an injectable clock. */
export function formatLastOpened(lastOpenedAt: string | null, now: number = Date.now()): string {
  if (lastOpenedAt === null) {
    return NEVER_OPENED_LABEL;
  }
  const opened = Date.parse(lastOpenedAt);
  if (Number.isNaN(opened)) {
    return NEVER_OPENED_LABEL;
  }

  const minutes = Math.max(0, Math.floor((now - opened) / 60_000));
  if (minutes < 1) {
    return 'abierto recién';
  }
  if (minutes < 60) {
    return `abierto hace ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `abierto hace ${hours} h`;
  }
  return `abierto hace ${Math.floor(hours / 24)} d`;
}

/**
 * Ordering of the list: last opened first, never-opened last, and alphabetical
 * (case-insensitive, es-AR) inside each group so the order is stable.
 */
export function orderProjects(projects: readonly LocalProject[]): LocalProject[] {
  const opened = (project: LocalProject): number =>
    project.lastOpenedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(project.lastOpenedAt);

  return [...projects].sort((left, right) => {
    const leftOpened = opened(left);
    const rightOpened = opened(right);
    if (leftOpened !== rightOpened) {
      return rightOpened - leftOpened;
    }
    return left.name.localeCompare(right.name, 'es-AR', { sensitivity: 'base' });
  });
}

/** `1 proyecto` / `N proyectos` (Spanish requires the singular). */
export function countLabelFor(count: number): string {
  return count === 1 ? '1 proyecto' : `${count} proyectos`;
}

/* ------------------------------------------------------------------ *
 * Intents
 * ------------------------------------------------------------------ */

/**
 * Intent of tapping a project. The editor does not exist yet, so this is
 * `pending: true` with the id the shell must log — never a navigation.
 */
export function openProjectIntent(project: Pick<LocalProject, 'id'>): OpenProjectIntent {
  return {
    route: LOCAL_EDITOR_ROUTE,
    projectId: project.id,
    pending: true,
    note: EDITOR_PENDING_NOTE,
  };
}

/** Sandbox folder name derived from the project name. */
export function slugFor(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-');
  return slug === '' ? 'proyecto' : slug;
}

/** Monotonic suffix so two intents in the same millisecond stay unique. */
let idSuffix = 0;

/** Identifier of a new project (injectable through `options.id`). */
function nextId(nowIso: string): string {
  idSuffix += 1;
  return `p-${Date.parse(nowIso).toString(36)}-${idSuffix.toString(36)}`;
}

/**
 * Validates the create form and returns the record that would be stored.
 *
 * Rules: trimmed, non-empty, and unique case-insensitively against the projects
 * that are already stored. Errors are typed per field (`name`) with a `code`,
 * so the shell can place each message under the right input.
 */
export function createProjectIntent(
  name: string,
  existing: readonly LocalProject[],
  options: CreateProjectOptions = {},
): CreateProjectResult {
  const trimmed = name.trim();

  if (trimmed === '') {
    return {
      ok: false,
      errors: [{ field: 'name', code: 'empty', message: NAME_EMPTY_MESSAGE }],
    };
  }

  const normalized = trimmed.toLowerCase();
  const duplicated = existing.some((project) => project.name.trim().toLowerCase() === normalized);
  if (duplicated) {
    return {
      ok: false,
      errors: [{ field: 'name', code: 'duplicate', message: NAME_DUPLICATE_MESSAGE }],
    };
  }

  const now = options.now ?? new Date().toISOString();
  return {
    ok: true,
    project: {
      id: options.id ?? nextId(now),
      name: trimmed,
      path: `${PROJECTS_ROOT}/${slugFor(trimmed)}`,
      createdAt: now,
      lastOpenedAt: null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * View model
 * ------------------------------------------------------------------ */

/** Options of `buildProjectsView` (injectable clock for the relative labels). */
export interface BuildProjectsOptions {
  now?: number;
}

/** One row, always with the honest git gap. */
export function projectRow(project: LocalProject, now: number = Date.now()): ProjectRow {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    lastOpenedAt: project.lastOpenedAt,
    lastOpenedLabel: formatLastOpened(project.lastOpenedAt, now),
    gitFacts: null,
    gitFactsReason: GIT_FACTS_UNKNOWN_REASON,
    gitFactsDetail: GIT_FACTS_UNKNOWN_DETAIL,
    open: openProjectIntent(project),
  };
}

/** Builds the whole screen from state that was already read. */
export function buildProjectsView(
  state: ProjectsState,
  options: BuildProjectsOptions = {},
): ProjectsViewModel {
  const now = options.now ?? Date.now();
  const base = {
    title: PROJECTS_TITLE,
    chip: OFFLINE_CHIP_LABEL,
    create: {
      label: NEW_PROJECT_LABEL,
      fieldLabel: NEW_PROJECT_FIELD_LABEL,
      placeholder: NEW_PROJECT_PLACEHOLDER,
      submitLabel: NEW_PROJECT_SUBMIT_LABEL,
      note: NEW_PROJECT_NOTE,
    },
    gitNote: GIT_FACTS_NOTE,
  } as const;

  if (state.kind === 'loading') {
    return {
      ...base,
      status: 'loading',
      count: 0,
      countLabel: 'Leyendo proyectos…',
      rows: [],
      empty: null,
      error: null,
      loading: true,
    };
  }

  if (state.kind === 'error') {
    return {
      ...base,
      status: 'error',
      count: 0,
      countLabel: 'Sin datos',
      rows: [],
      empty: null,
      loading: false,
      error: {
        title: STORAGE_ERROR_TITLE,
        message: errorMessageFor(state),
        detail: `No pudimos leer ${LOCAL_PROJECTS_STORAGE_KEY}: ${state.message}`,
        index: state.index,
        reason: state.reason,
        action: {
          route: LOCAL_PROJECTS_ROUTE,
          label: RETRY_LABEL,
          pending: false,
          note: STORAGE_RETRY_NOTE,
        },
      },
    };
  }

  const ordered = orderProjects(state.projects);
  const rows = ordered.map((project) => projectRow(project, now));

  if (rows.length === 0) {
    return {
      ...base,
      status: 'empty',
      count: 0,
      countLabel: countLabelFor(0),
      rows,
      error: null,
      loading: false,
      empty: { title: EMPTY_TITLE, message: EMPTY_MESSAGE, note: EMPTY_NOTE },
    };
  }

  return {
    ...base,
    status: 'success',
    count: rows.length,
    countLabel: countLabelFor(rows.length),
    rows,
    empty: null,
    error: null,
    loading: false,
  };
}

/** Failure copy of the storage card: what failed, in the person's words. */
function errorMessageFor(state: {
  reason: ProjectsFailureReason;
  message: string;
  index: number | null;
}): string {
  if (state.reason === 'json') {
    return `${STORAGE_JSON_INVALID}: ${state.message}`;
  }
  return state.message;
}

/* ------------------------------------------------------------------ *
 * Loading and saving (injected storage)
 * ------------------------------------------------------------------ */

/**
 * Reads the project list through the injected reader. A store that throws is a
 * `storage` failure; it never throws by design, so the screen always has a
 * model to draw.
 */
export async function loadProjects(read: LocalProjectsReader): Promise<ProjectsState> {
  let raw: string | null;
  try {
    raw = await read(LOCAL_PROJECTS_STORAGE_KEY);
  } catch (error) {
    return { kind: 'error', reason: 'storage', message: describeError(error).message, index: null };
  }

  const parsed = parseProjects(raw);
  if (parsed.ok) {
    return { kind: 'loaded', projects: parsed.projects };
  }
  return { kind: 'error', reason: parsed.reason, message: parsed.message, index: parsed.index };
}

/**
 * Writes the list through the injected writer. A failing write is reported as a
 * typed result (the caller decides what to say), never thrown.
 */
export async function saveProjects(
  write: LocalProjectsWriter,
  projects: readonly LocalProject[],
): Promise<SaveProjectsResult> {
  try {
    await write(LOCAL_PROJECTS_STORAGE_KEY, serializeProjects(projects));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describeError(error).message };
  }
}
