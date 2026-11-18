/**
 * V21 — suite capability probe (artboard
 * `design/mobile-app-onboarding/05-suite-install.html`, `docs/mobile-views-plan.md`
 * §V21, owner amendment L10, task T7p).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * network. `mobile/app/suite-install.tsx` is the rendering shell and
 * `mobile/test/suite-install.test.mjs` pins these rules:
 *
 * - the selection reducer and its dependency rule (checking `gentle-shell`
 *   auto-checks `engram`; unchecking `engram` auto-unchecks `gentle-shell`);
 * - the **capability probe**: an injected `SuiteProbe` answers, per component,
 *   `installed` | `missing` | `unsupported`. There is no simulated installer:
 *   this phone has no `fs_*`/FFI primitive and no package manager, so nothing
 *   is ever installed here and the screen says so;
 * - the default probe (`recordProbe`) reads the real `gentle-movil:suite`
 *   record — written only when a real installation happened — and answers
 *   `unsupported` with the real cause copy for everything else;
 * - per-component persistence: `gentle-movil:suite` is written after every
 *   component settles, and **only an `installed` answer is ever persisted as
 *   `true`**; `missing`, `unsupported`, a thrown probe or a malformed answer
 *   persist `false`;
 * - the primary CTA never promises an install that cannot happen: with no
 *   installer (`canInstall: false`, the truth today) the action is the honest
 *   `Continuar igual →` whenever something selected is not installed;
 * - the onboarding routes this view takes part in (it now continues to
 *   `/overview`, which exists).
 *
 * A throwing probe, a broken store or a malformed answer never throws: the
 * state stays honest and the failure is logged (S7).
 */

/** AsyncStorage key of the persisted per-component result. */
export const SUITE_STORAGE_KEY = 'gentle-movil:suite';

/** AsyncStorage key of the mode chosen in V4. */
export const MODE_STORAGE_KEY = 'gentle-movil:mode';

/** The steps of the onboarding that this logic routes between. */
export const SUITE_ROUTE = '/suite-install';

/** The QR scan screen of the connected path (V1). */
export const QR_ROUTE = '/scan-qr';

/** The app itself once the onboarding is done: the V5 overview dashboard. */
export const OVERVIEW_ROUTE = '/overview';

/* ------------------------------------------------------------------ *
 * Copy (es-AR)
 * ------------------------------------------------------------------ */

/** Row label of a component the phone really has. */
export const INSTALLED_LABEL = 'instalado';

/** Row label of a component a real check found absent. */
export const MISSING_LABEL = 'no instalado';

/** Row label of a component this build can neither install nor check. */
export const UNSUPPORTED_LABEL = 'no disponible';

/**
 * The real cause today, verbatim (task T7p). It is the row note of every
 * `unsupported` answer and the honest reason the CTA does not install.
 */
export const UNSUPPORTED_REASON =
  'Todavía no se puede instalar en el teléfono: el core Rust no expone la instalación local.';

/** Fallback note of a `missing` answer the probe does not explain. */
export const MISSING_REASON =
  'La revisión del teléfono no encontró este componente instalado.';

/** Primary CTA when everything selected is already there. */
export const CONTINUE_LABEL = 'Continuar →';

/** Primary CTA when nothing selected can be installed: honest, never «instalar». */
export const CONTINUE_ANYWAY_LABEL = 'Continuar igual →';

/** Disabled primary CTA when nothing is selected. */
export const NOTHING_SELECTED_LABEL = 'Elegí un componente';

/** Secondary action: re-runs the probe (the only real action besides continuing). */
export const REPROBE_LABEL = 'Volver a revisar';

/** Screen note: what this screen really does, plus the real cause. */
export const PROBE_NOTE = `Esta pantalla revisa el teléfono y te dice qué hay; no simula instalaciones. ${UNSUPPORTED_REASON}`;

/** Note when the person selected only things that are already installed. */
export const ALREADY_INSTALLED_NOTE =
  'Lo que ya está instalado no se vuelve a instalar: la app arranca con lo que hay.';

/** Mode chosen in V4 (`docs/mobile-views-plan.md` §V4). */
export type AppMode = 'conectado' | 'local' | 'ambos';

/** The three suite components, in artboard order. */
export type SuiteComponent = 'gentle-shell' | 'engram' | 'gentle-ai';

/** One row of the picker. */
export interface SuiteRow {
  component: SuiteComponent;
  /** Visible name (also what `Reintentar …` shows). */
  name: string;
  /** One-line description, transcribed from the artboard. */
  description: string;
}

/** Rows in the order the artboard draws them. */
export const SUITE_COMPONENTS: readonly SuiteRow[] = [
  {
    component: 'gentle-shell',
    name: 'gentle-shell',
    description: 'El agente: chat, código, automatizaciones',
  },
  {
    component: 'engram',
    name: 'engram',
    description: 'Memoria persistente entre sesiones',
  },
  {
    component: 'gentle-ai',
    name: 'gentle-ai',
    description: 'Trabajos y subagentes en segundo plano',
  },
];

/** Which components the person picked. */
export type SuiteSelection = Record<SuiteComponent, boolean>;

/** Artboard default: everything is checked. */
export const DEFAULT_SELECTION: SuiteSelection = {
  'gentle-shell': true,
  engram: true,
  'gentle-ai': true,
};

/** Nothing picked (the primary CTA is disabled at this point). */
export const EMPTY_SELECTION: SuiteSelection = {
  'gentle-shell': false,
  engram: false,
  'gentle-ai': false,
};

/** Persisted result, one boolean per component (`false` = not installed). */
export interface SuiteRecord {
  gentleShell: boolean;
  engram: boolean;
  gentleAi: boolean;
}

/** Not installed yet. */
export const EMPTY_SUITE_RECORD: SuiteRecord = {
  gentleShell: false,
  engram: false,
  gentleAi: false,
};

/* ------------------------------------------------------------------ *
 * Capability probe (the only source of an `installed` answer)
 * ------------------------------------------------------------------ */

/**
 * What a probe can honestly answer for one component:
 *
 * - `installed` — the phone really has it (the default probe only says this
 *   when a real install wrote it in the `gentle-movil:suite` record);
 * - `missing` — a real check ran on the phone and it is not there;
 * - `unsupported` — this build can neither check nor install it: the honest
 *   answer today.
 */
export type SuiteCapability = 'installed' | 'missing' | 'unsupported';

/** Answer of one probe call. */
export interface SuiteProbeResult {
  state: SuiteCapability;
  /** Evidence of the answer, kept in the log (`registro gentle-movil:suite`, …). */
  raw?: unknown;
  /** Why it is not installed, when the probe knows. */
  reason?: string | null;
}

/** Injectable capability probe: the device implementation is `recordProbe`. */
export type SuiteProbe = (component: SuiteComponent) => Promise<SuiteProbeResult>;

/** Per-component runtime state of V21. */
export type SuiteState = 'idle' | 'probing' | SuiteCapability;

/** Raw evidence strings the probes put in the log (never a fake success). */
export const PROBE_RAW_INSTALLED = 'registro gentle-movil:suite';
export const PROBE_RAW_UNSUPPORTED =
  'sin instalador local: el core Rust no expone la instalación';

/** Storage surface this module needs (AsyncStorage satisfies it). */
export interface SuiteStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Log surface this module needs (`logger.tag('suite-install')` satisfies it). */
export interface SuiteLog {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Record field that stores the result of one component. */
export function recordFieldFor(component: SuiteComponent): keyof SuiteRecord {
  if (component === 'gentle-shell') {
    return 'gentleShell';
  }
  if (component === 'gentle-ai') {
    return 'gentleAi';
  }
  return 'engram';
}

/**
 * Selection reducer. The dependency rule is enforced in state, not announced:
 *
 * - checking `gentle-shell` also checks `engram` (the agent needs memory);
 * - unchecking `engram` also unchecks `gentle-shell` (nothing to remember with);
 * - `engram` alone stays valid, so unchecking `gentle-shell` keeps it.
 */
export function toggleComponent(selection: SuiteSelection, component: SuiteComponent): SuiteSelection {
  const next: SuiteSelection = { ...selection, [component]: !selection[component] };

  if (component === 'gentle-shell' && next['gentle-shell']) {
    next.engram = true;
  }
  if (component === 'engram' && !next.engram) {
    next['gentle-shell'] = false;
  }

  return next;
}

/** Picked components in artboard order. */
export function selectedComponents(selection: SuiteSelection): SuiteComponent[] {
  return SUITE_COMPONENTS.filter((row) => selection[row.component]).map((row) => row.component);
}

/** How many components the primary CTA installs. */
export function selectedCount(selection: SuiteSelection): number {
  return selectedComponents(selection).length;
}

/** `Instalar N componentes →` (singular for one, as Spanish requires). */
export function installLabel(count: number): string {
  return count === 1 ? 'Instalar 1 componente →' : `Instalar ${count} componentes →`;
}

/** Row label of a settled state (`''` while idle or probing). */
export function rowLabel(state: SuiteState): string {
  if (state === 'installed') {
    return INSTALLED_LABEL;
  }
  if (state === 'missing') {
    return MISSING_LABEL;
  }
  if (state === 'unsupported') {
    return UNSUPPORTED_LABEL;
  }
  return '';
}

/** Honest reason under a row: the probe's own reason, else the fallback copy. */
export function rowNote(state: SuiteState, reason: string | null): string | null {
  if (state === 'missing') {
    return reason === null || reason.trim() === '' ? MISSING_REASON : reason;
  }
  if (state === 'unsupported') {
    return reason === null || reason.trim() === '' ? UNSUPPORTED_REASON : reason;
  }
  return null;
}

/** An installed row is locked: nothing is re-installed and it cannot be unchecked. */
export function rowSelectable(state: SuiteState): boolean {
  return state !== 'installed';
}

/** V4 route: anything that includes local goes through the suite step first. */
export function routeForMode(mode: AppMode): string {
  return mode === 'conectado' ? QR_ROUTE : SUITE_ROUTE;
}

/**
 * Where V21 continues once the person finishes: `/overview` for every mode
 * (the dashboard exists now, so there is no pending route left here).
 */
export function routeAfterSuite(mode: AppMode): string {
  // Both local paths and `ambos` land in the app; the mode is only read for the
  // screen eyebrow now.
  void mode;
  return OVERVIEW_ROUTE;
}

/** Parses a stored mode, falling back to the artboard default. */
export function parseMode(raw: string | null): AppMode {
  return raw === 'local' || raw === 'conectado' || raw === 'ambos' ? raw : 'ambos';
}

/** Parses the stored suite record; anything unusable means "not installed". */
export function parseSuiteRecord(raw: string | null): SuiteRecord {
  if (raw === null) {
    return { ...EMPTY_SUITE_RECORD };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_SUITE_RECORD };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...EMPTY_SUITE_RECORD };
  }
  const value = parsed as Record<string, unknown>;
  const flag = (key: string): boolean => value[key] === true;
  return {
    gentleShell: flag('gentleShell'),
    engram: flag('engram'),
    gentleAi: flag('gentleAi'),
  };
}

/** Serializes the record for `gentle-movil:suite`. */
export function serializeSuiteRecord(record: SuiteRecord): string {
  return JSON.stringify(record);
}

/** Reads the mode V4 persisted; a broken store falls back to `ambos` and logs. */
export async function readMode(storage: SuiteStorage, log?: SuiteLog): Promise<AppMode> {
  try {
    return parseMode(await storage.getItem(MODE_STORAGE_KEY));
  } catch (error) {
    log?.failure('read-mode', error, null);
    return 'ambos';
  }
}

/** Reads the persisted suite record; a broken store means "not installed". */
export async function readSuiteRecord(storage: SuiteStorage, log?: SuiteLog): Promise<SuiteRecord> {
  try {
    return parseSuiteRecord(await storage.getItem(SUITE_STORAGE_KEY));
  } catch (error) {
    log?.failure('read-suite', error, null);
    return { ...EMPTY_SUITE_RECORD };
  }
}

/**
 * Writes the record for Ajustes. Returns whether it was stored: a failed write
 * is logged and never breaks the flow the person is in.
 */
export async function persistSuiteRecord(
  storage: SuiteStorage,
  record: SuiteRecord,
  log?: SuiteLog,
): Promise<boolean> {
  try {
    await storage.setItem(SUITE_STORAGE_KEY, serializeSuiteRecord(record));
    return true;
  } catch (error) {
    log?.failure('persist-suite', error, { record });
    return false;
  }
}

/**
 * The default probe: reads what a real installation really wrote.
 *
 * `gentle-movil:suite` is the record `runSuiteProbe` writes, and it is written
 * with `true` **only** when a probe answered `installed` with real evidence —
 * so a `true` here means the component is on the phone. Everything else is
 * `unsupported` with the real cause: this build can neither install nor check
 * anything on the phone yet (`UNSUPPORTED_REASON`). A component that is really
 * present is reported as `installed`, so the screen never reinstalls it.
 *
 * The record is read once per probe instance; the screen creates a fresh probe
 * per run, so a later real install is never hidden by a stale cache.
 */
export function recordProbe(storage: SuiteStorage, log?: SuiteLog): SuiteProbe {
  let pending: Promise<SuiteRecord> | null = null;
  return async (component) => {
    pending ??= readSuiteRecord(storage, log);
    const record = await pending;
    if (record[recordFieldFor(component)] === true) {
      return { state: 'installed', raw: PROBE_RAW_INSTALLED, reason: null };
    }
    return { state: 'unsupported', raw: PROBE_RAW_UNSUPPORTED, reason: UNSUPPORTED_REASON };
  };
}

/**
 * Normalizes whatever a probe answered into one of the three real states.
 * Anything unknown — a typo, a missing field, a `true` that is not the literal
 * `installed` — becomes `unsupported`, never `installed`: a component is only
 * ever reported installed on a real `installed` answer.
 */
export function normalizeCapability(value: unknown): SuiteCapability {
  return value === 'installed' || value === 'missing' || value === 'unsupported'
    ? value
    : 'unsupported';
}

/** One settled probe, in the order it happened. */
export interface SuiteProbeOutcome {
  component: SuiteComponent;
  state: SuiteCapability;
  raw: unknown;
  reason: string | null;
}

/** Options of `runSuiteProbe`. */
export interface SuiteProbeOptions {
  /** Components to probe, in the order they should run. */
  components: readonly SuiteComponent[];
  probe: SuiteProbe;
  storage: SuiteStorage;
  log: SuiteLog;
  /** Per-component state changes, so the screen animates only real work. */
  onState?: (component: SuiteComponent, state: 'probing' | SuiteCapability) => void;
  /** Bypasses the stored record (tests); defaults to reading it from storage. */
  initialRecord?: SuiteRecord;
}

/** Result of one run: the record as persisted, plus what the probe answered. */
export interface SuiteProbeRun {
  record: SuiteRecord;
  installed: SuiteComponent[];
  missing: SuiteComponent[];
  unsupported: SuiteComponent[];
  outcomes: SuiteProbeOutcome[];
}

/**
 * Probes the given components one by one, persisting after each one settles.
 *
 * Only an `installed` answer sets its record field to `true`; `missing`,
 * `unsupported`, a thrown probe or a malformed answer set it to `false`. A
 * component that throws becomes `unsupported` (this build cannot confirm it is
 * there) and the run goes on with the rest — the app never crashes because a
 * probe failed. Every answer logs `{component, state, raw}`; failures
 * additionally log the app-wide `{step, error, raw}` failure record.
 */
export async function runSuiteProbe(options: SuiteProbeOptions): Promise<SuiteProbeRun> {
  const { components, probe, storage, log, onState } = options;
  const record: SuiteRecord = options.initialRecord ?? (await readSuiteRecord(storage, log));
  const installed: SuiteComponent[] = [];
  const missing: SuiteComponent[] = [];
  const unsupported: SuiteComponent[] = [];
  const outcomes: SuiteProbeOutcome[] = [];

  for (const component of components) {
    onState?.(component, 'probing');
    log.info(`revisando ${component}`, { component, state: 'probing' });

    let raw: unknown = null;
    let state: SuiteCapability;
    let reason: string | null = null;
    try {
      const answer = await probe(component);
      state = normalizeCapability(answer?.state);
      raw = answer?.raw === undefined ? null : answer.raw;
      reason = typeof answer?.reason === 'string' ? answer.reason : null;
      if (answer?.state !== state) {
        log.failure(
          `probe-${component}`,
          new Error(`la revisión de ${component} respondió un estado inválido`),
          answer?.state ?? null,
        );
      }
    } catch (error) {
      // A probe that cannot answer cannot prove the component is there.
      state = 'unsupported';
      reason = UNSUPPORTED_REASON;
      log.failure(`probe-${component}`, error, null);
    }

    log.info(`revisión de ${component}: ${state}`, { component, state, raw });

    if (state === 'installed') {
      installed.push(component);
    } else if (state === 'missing') {
      missing.push(component);
      log.info(`${component} no está instalado`, { component, state, raw });
    } else {
      unsupported.push(component);
    }

    // Only a real `installed` answer is ever persisted as true.
    record[recordFieldFor(component)] = state === 'installed';
    outcomes.push({ component, state, raw, reason });
    await persistSuiteRecord(storage, record, log);

    onState?.(component, state);
  }

  return { record: { ...record }, installed, missing, unsupported, outcomes };
}

/* ------------------------------------------------------------------ *
 * Primary action (never promises an install that cannot happen)
 * ------------------------------------------------------------------ */

/** What the primary CTA of V21 means right now. */
export interface SuitePrimaryAction {
  /** `continue` finishes the step; `install` would run a real installation. */
  kind: 'continue' | 'install';
  label: string;
  /** Components a real installation would touch (empty for `continue`). */
  targets: SuiteComponent[];
  /** True when the label is the honest `Continuar igual →`. */
  honestContinue: boolean;
  /** False only when nothing is selected. */
  enabled: boolean;
}

/** Options of `primaryAction`. */
export interface PrimaryActionOptions {
  /**
   * Whether this build can really install. False today (and by default): the
   * core exposes no local installation, so the CTA must not promise one.
   */
  canInstall?: boolean;
  /** Live row states; a settled probe answers them. */
  states: Partial<Record<SuiteComponent, SuiteState>>;
}

/**
 * The honest primary action for the current selection and probe answers.
 *
 * - nothing selected → disabled;
 * - a real installer and something installable → `Instalar N componentes →`;
 * - everything selected is already installed → `Continuar →`;
 * - something selected is not installed and cannot be installed → the honest
 *   `Continuar igual →`, with `honestContinue: true` so the screen explains
 *   why instead of pretending a green check.
 *
 * An installed component is never an install target: it is not reinstalled.
 */
export function primaryAction(
  selection: SuiteSelection,
  options: PrimaryActionOptions,
): SuitePrimaryAction {
  const canInstall = options.canInstall === true;
  const selected = selectedComponents(selection);

  if (selected.length === 0) {
    return {
      kind: 'continue',
      label: NOTHING_SELECTED_LABEL,
      targets: [],
      honestContinue: false,
      enabled: false,
    };
  }

  const stateOf = (component: SuiteComponent): SuiteState => options.states[component] ?? 'idle';
  const installed = selected.filter((component) => stateOf(component) === 'installed');
  const targets = selected.filter((component) => {
    const state = stateOf(component);
    return state !== 'installed' && state !== 'unsupported';
  });

  if (canInstall && targets.length > 0) {
    return {
      kind: 'install',
      label: installLabel(targets.length),
      targets,
      honestContinue: false,
      enabled: true,
    };
  }

  if (installed.length === selected.length) {
    return {
      kind: 'continue',
      label: CONTINUE_LABEL,
      targets: [],
      honestContinue: false,
      enabled: true,
    };
  }

  // Nothing selected can be installed: say it, do not promise an install.
  return {
    kind: 'continue',
    label: CONTINUE_ANYWAY_LABEL,
    targets: [],
    honestContinue: true,
    enabled: true,
  };
}
