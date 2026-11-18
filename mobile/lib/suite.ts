/**
 * V21 — suite installer logic (artboard
 * `design/mobile-app-onboarding/05-suite-install.html`, `docs/mobile-views-plan.md`
 * §V21, owner amendment L10).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * network. `mobile/app/suite-install.tsx` is the rendering shell and
 * `mobile/test/suite-install.test.mjs` pins these rules:
 *
 * - the selection reducer and its dependency rule (checking `gentle-shell`
 *   auto-checks `engram`; unchecking `engram` auto-unchecks `gentle-shell`);
 * - the per-component install runner (`installing` → `ok` | `fail`, one honest
 *   `{component, ok, raw}` record per attempt, failure never blocks the others);
 * - the `gentle-movil:suite` record, written after every component settles so
 *   Ajustes can read it later (a failure persists as `false`);
 * - the onboarding routes this view takes part in.
 *
 * A failing install or a broken store never throws: the state stays honest and
 * the failure is logged (S7).
 */

/** AsyncStorage key of the persisted per-component result. */
export const SUITE_STORAGE_KEY = 'gentle-movil:suite';

/** AsyncStorage key of the mode chosen in V4. */
export const MODE_STORAGE_KEY = 'gentle-movil:mode';

/** The steps of the onboarding that this logic routes between. */
export const SUITE_ROUTE = '/suite-install';

/** The QR scan screen of the connected path (V1). */
export const QR_ROUTE = '/scan-qr';

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

/** Per-component runtime state of V21. */
export type SuiteState = 'idle' | 'installing' | 'ok' | 'fail';

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

/** `Reintentar <nombre>` for the failed set only. */
export function retryLabel(failed: readonly SuiteComponent[]): string {
  return `Reintentar ${failed.join(', ')}`;
}

/** V4 route: anything that includes local goes through the installer first. */
export function routeForMode(mode: AppMode): string {
  return mode === 'conectado' ? QR_ROUTE : SUITE_ROUTE;
}

/**
 * Where V21 continues once the person finishes (or continues anyway): the QR
 * scan for `ambos`, and `null` for `local` — its root entry is still a stub, so
 * the screen stays and logs `local route pending` instead of faking a route.
 */
export function routeAfterSuite(mode: AppMode): string | null {
  return mode === 'local' ? null : QR_ROUTE;
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

/** Outcome an installer reports for one component (`ok:false` = honest failure). */
export interface SuiteInstallerOutcome {
  ok: boolean;
  /** Raw evidence of the attempt, kept in the log (`exit 1: …`, stdout, …). */
  raw?: unknown;
  /** Why it failed, when the installer does not throw. */
  reason?: unknown;
}

/** Injectable installer: the device implementation writes inside the sandbox. */
export type SuiteInstaller = (component: SuiteComponent) => Promise<SuiteInstallerOutcome>;

/** One settled attempt, in the order it happened. */
export interface SuiteInstallOutcome {
  component: SuiteComponent;
  state: 'ok' | 'fail';
  raw: unknown;
}

/** Options of `runSuiteInstall`. */
export interface SuiteInstallOptions {
  /** Components to attempt, in the order they should run. */
  components: readonly SuiteComponent[];
  install: SuiteInstaller;
  storage: SuiteStorage;
  log: SuiteLog;
  /** Per-component state changes, so the screen can animate (`installing` → `ok`). */
  onState?: (component: SuiteComponent, state: 'installing' | 'ok' | 'fail') => void;
  /** Bypasses the stored record (tests); defaults to reading it from storage. */
  initialRecord?: SuiteRecord;
}

/** Result of one run: the record as persisted, plus what happened. */
export interface SuiteRunResult {
  record: SuiteRecord;
  ok: SuiteComponent[];
  failed: SuiteComponent[];
  outcomes: SuiteInstallOutcome[];
}

/**
 * Installs the given components one by one, persisting after each one settles.
 *
 * A component that throws or reports `ok:false` becomes `fail` and the run goes
 * on with the rest (S7: the app never crashes because an install failed). Every
 * attempt logs `{component, ok, raw}`; failures additionally log the app-wide
 * `{step, error, raw}` failure record.
 */
export async function runSuiteInstall(options: SuiteInstallOptions): Promise<SuiteRunResult> {
  const { components, install, storage, log, onState } = options;
  const record: SuiteRecord =
    options.initialRecord ?? (await readSuiteRecord(storage, log));
  const ok: SuiteComponent[] = [];
  const failed: SuiteComponent[] = [];
  const outcomes: SuiteInstallOutcome[] = [];

  for (const component of components) {
    onState?.(component, 'installing');
    log.info(`instalando ${component}`, { component, state: 'installing' });

    let outcome: SuiteInstallerOutcome;
    let thrown: unknown = null;
    try {
      outcome = await install(component);
    } catch (error) {
      thrown = error;
      outcome = { ok: false, raw: null, reason: error };
    }

    const succeeded = outcome.ok === true;
    const raw = outcome.raw === undefined ? null : outcome.raw;

    if (succeeded) {
      ok.push(component);
      log.info(`${component} instalado`, { component, ok: true, raw });
    } else {
      failed.push(component);
      log.error(`${component} no se pudo instalar`, { component, ok: false, raw });
      log.failure(
        `install-${component}`,
        outcome.reason ?? thrown ?? new Error(`la instalación de ${component} falló`),
        raw,
      );
    }

    record[recordFieldFor(component)] = succeeded;
    outcomes.push({ component, state: succeeded ? 'ok' : 'fail', raw });
    await persistSuiteRecord(storage, record, log);

    onState?.(component, succeeded ? 'ok' : 'fail');
  }

  return { record: { ...record }, ok, failed, outcomes };
}
