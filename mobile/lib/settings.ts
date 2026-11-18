/**
 * V18 — Settings logic (artboard `design/mobile-app-core/10-settings.html`,
 * `docs/mobile-views-plan.md` §V18, task T7i).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * AsyncStorage, no network. `mobile/app/settings.tsx` is the rendering shell and
 * `mobile/test/settings.test.mjs` pins these rules.
 *
 * ## Every fact on this screen is real state already on the phone
 *
 * - the mode comes from the record V4 wrote (`MODE_STORAGE_KEY`,
 *   `gentle-movil:mode`): `Conectado` / `Local` / `Ambos`, or `Sin elegir` when
 *   nothing was ever chosen — never a guessed default;
 * - the three suite components come from the record V21 wrote
 *   (`SUITE_STORAGE_KEY`, `gentle-movil:suite`, written by
 *   `persistSuiteRecord`): `Instalado` / `No instalado` per component;
 * - the tunnel identity comes from the tunnel the pairing flow left open
 *   (`getActiveTunnel()`, passed in as a snapshot because that store is native
 *   state this module cannot read); with none the row says `Sin túnel`;
 * - the diagnostics facts are the constants of `lib/logger.ts`
 *   (`LOG_DIR`/`LOG_FILE`, the `LOG_CAPACITY` ring and the `LOG_ROTATE_BYTES`
 *   rotation limit), imported so they can never drift from the writer;
 * - the app/build info is passed in by the caller (`expo-constants` in the
 *   screen).
 *
 * ## Honesty rules (S7)
 *
 * - an empty store is a fact, not a failure: `Sin elegir` + three
 *   `No instalado`, and nothing is logged as an error;
 * - a corrupt or unreadable store is a real `storageError` state with
 *   `Reintentar` (which really re-reads), and the affected values become
 *   `Sin datos` — they are never rendered as `No instalado` or `Sin elegir`
 *   truths;
 * - every destination that is not built yet is a `pending: true` descriptor
 *   with its route and an honest note: re-selecting the mode, reinstalling the
 *   suite, disconnecting/reconnecting the tunnel and sharing the diagnostics;
 * - every storage failure is logged through the injectable `SettingsLogger`
 *   (`logger.tag('settings')` in the app) with `{step, error, raw}`.
 */

import {
  LOG_CAPACITY,
  LOG_DIR,
  LOG_FILE,
  LOG_ROTATE_BYTES,
  describeError,
  logger,
} from './logger.ts';
import {
  type AppMode,
  type SuiteComponent,
  type SuiteRecord,
  EMPTY_SUITE_RECORD,
  MODE_STORAGE_KEY,
  SUITE_COMPONENTS,
  SUITE_ROUTE,
  SUITE_STORAGE_KEY,
  recordFieldFor,
} from './suite.ts';

/* ------------------------------------------------------------------ *
 * Copy (es-AR)
 * ------------------------------------------------------------------ */

/** Route that really re-reads this screen (the storage retry). */
export const SETTINGS_ROUTE = '/settings';

/** Mode re-selection lives in the onboarding selector (V4). */
export const MODE_ROUTE = '/mode-choice';

/**
 * Intent id of the tunnel action. There is no tunnel screen: the copy says so
 * instead of inventing a route that would 404.
 */
export const TUNNEL_ROUTE = '/settings/tunnel';

/** Intent id of the diagnostics export. Same reason as `TUNNEL_ROUTE`. */
export const EXPORT_ROUTE = '/settings/diagnostics/export';

/** Mode label when nothing was ever stored (not a default, a fact). */
export const NO_MODE_LABEL = 'Sin elegir';

/** Value shown when the store could not be read (never `No instalado`). */
export const UNKNOWN_LABEL = 'Sin datos';

/** Honest tunnel copy when the pairing flow left no tunnel open. */
export const SIN_TUNEL_LABEL = 'Sin túnel';

/** Per-component suite values. */
export const INSTALLED_LABEL = 'Instalado';
export const NOT_INSTALLED_LABEL = 'No instalado';

/** Generic retry, same word every screen uses (`docs/mobile-views-plan.md` §1.4). */
export const RETRY_LABEL = 'Reintentar';

/** Artboard name of the screen. */
export const SETTINGS_TITLE = 'Ajustes';

/** Section legends, in artboard order. */
export const SECTION_TITLES = {
  modo: 'Modo',
  suite: 'Suite en el teléfono',
  tunel: 'Túnel',
  diagnostico: 'Diagnóstico',
  acerca: 'Acerca de',
} as const;

/** Honest notes of every destination that is not built yet. */
export const MODE_PENDING_NOTE =
  'Cambiar el modo desde Ajustes todavía no está conectado: el modo se elige en el onboarding.';
export const SUITE_PENDING_NOTE =
  'Reinstalar desde Ajustes todavía no está conectado: la instalación corre en el onboarding.';
export const TUNNEL_PENDING_NOTE =
  'Desconectar o reconectar el túnel todavía no está conectado: el canal SSH lo abre y lo cierra el emparejamiento.';
export const EXPORT_PENDING_NOTE =
  'Compartir el diagnóstico todavía no está conectado: el texto se arma abajo, con los datos reales.';

/** Retry note of the storage read (this one is wired). */
export const STORAGE_RETRY_NOTE = 'Reintentar vuelve a leer el almacenamiento del teléfono.';

/** Title of the honest storage failure state. */
export const STORAGE_ERROR_TITLE = 'No pudimos leer el almacenamiento';

/** `512 KB` — the rotation limit of `lib/logger.ts`, derived from the constant. */
export const LOG_ROTATE_LABEL = `${Math.round(LOG_ROTATE_BYTES / 1024)} KB`;

/** Human labels of the three modes (V18 mirrors V4). */
export const MODE_LABELS: Record<AppMode, string> = {
  conectado: 'Conectado',
  local: 'Local',
  ambos: 'Ambos',
};

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** App/build info the caller knows (`expo-constants` in the screen). */
export interface AppInfo {
  /** `expoConfig.version`, or null when the build does not expose one. */
  version: string | null;
  /** Native build number / `versionCode`, or null. */
  build: string | null;
}

/** The tunnel the pairing flow left open, as `getActiveTunnel()` holds it. */
export interface TunnelSnapshot {
  sessionId: string;
  /** Host the tunnel points at, as the pairing recorded it. */
  host: string;
  /** Remote loopback ports this session really forwards. */
  ports: readonly number[];
}

/** Injected storage reader (`AsyncStorage.getItem` satisfies it). */
export type SettingsStorageReader = (key: string) => Promise<string | null>;

/** Failure sink this module needs (`logger.tag('settings')` satisfies it). */
export interface SettingsLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Default failure sink of the app (one tag, one ring buffer, one log file). */
export const settingsLog: SettingsLogger = logger.tag('settings');

/** Options of `loadSettings`. */
export interface LoadSettingsDeps {
  /** Tunnel snapshot from `getActiveTunnel()`, or null when none was opened. */
  tunnel: TunnelSnapshot | null;
  /** App/build info passed by the caller. */
  app: AppInfo;
  /** Failure sink; defaults to `logger.tag('settings')`. */
  logger?: SettingsLogger;
}

/* ------------------------------------------------------------------ *
 * View model
 * ------------------------------------------------------------------ */

/** Chip tone of a row: installed (green), unknown (amber), plain (grey). */
export type SettingsTone = 'ok' | 'muted' | 'warning' | 'danger';

/** What tapping an action means. */
export interface SettingsAction {
  /** Route or intent id the action points at (also what the log records). */
  route: string;
  /** Button label the row draws. */
  label: string;
  /** True when the destination is not built yet: the UI must say so. */
  pending: boolean;
  /** Honest sentence under the row when `pending`. */
  note: string | null;
}

/** One row of a section. */
export interface SettingsRow {
  id: string;
  title: string;
  /** Secondary line (description or evidence), or null. */
  detail: string | null;
  /** Right-hand chip value; empty string means "no chip". */
  value: string;
  tone: SettingsTone;
  action: SettingsAction | null;
}

/** Section the shell renders, in artboard order. */
export interface SettingsSection {
  id: 'modo' | 'suite' | 'tunel' | 'diagnostico' | 'acerca';
  title: string;
  rows: SettingsRow[];
}

/** One suite component and whether the stored record says it is installed. */
export interface SuiteStatusRow {
  component: SuiteComponent;
  name: string;
  description: string;
  installed: boolean;
  value: string;
  tone: SettingsTone;
}

/** The tunnel identity as the screen shows it. */
export interface TunnelView {
  present: boolean;
  host: string | null;
  ports: number[];
  sessionId: string | null;
  /** Chip value: the host, or `Sin túnel`. */
  value: string;
  /** Evidence line: ports + session id, or why there is no tunnel. */
  detail: string;
  tone: SettingsTone;
}

/** Diagnostics facts, straight from `lib/logger.ts`. */
export interface DiagnosticsFacts {
  logFile: string;
  /** `${LOG_DIR}/${LOG_FILE}` as it lives under the document directory. */
  logPath: string;
  capacity: number;
  rotateBytes: number;
  /** Human form of `rotateBytes` (`512 KB`). */
  rotateLabel: string;
}

/** Honest storage failure state, with the retry that really re-reads. */
export interface SettingsStorageError {
  /** Keys that could not be read (one per failure). */
  keys: string[];
  /** First failure message exactly as the platform/JSON parser reported it. */
  message: string;
  title: string;
  detail: string;
  action: SettingsAction;
}

/** The whole screen, derived from real state. */
export interface SettingsViewModel {
  /** Stored mode, or null when nothing valid is stored. */
  mode: AppMode | null;
  /** False when the mode key could not be read (`Sin datos`, not `Sin elegir`). */
  modeKnown: boolean;
  /** `Conectado` / `Local` / `Ambos` / `Sin elegir` / `Sin datos`. */
  modeLabel: string;
  suite: SuiteStatusRow[];
  /** False when the suite record could not be read (values become `Sin datos`). */
  suiteKnown: boolean;
  tunnel: TunnelView;
  app: AppInfo;
  diagnostics: DiagnosticsFacts;
  /** Sections in artboard order. */
  sections: SettingsSection[];
  storageError: SettingsStorageError | null;
  /** Exact text the export intent would share (real facts only). */
  exportText: string;
}

/* ------------------------------------------------------------------ *
 * Parsing (injected raw values, never storage access)
 * ------------------------------------------------------------------ */

/**
 * Mode V4 stored as a plain string. Anything unrecognized is `null` (the screen
 * then says `Sin elegir`) — this module never falls back to a default mode the
 * way the onboarding router does.
 */
export function parseStoredMode(raw: string | null): AppMode | null {
  return raw === 'conectado' || raw === 'local' || raw === 'ambos' ? raw : null;
}

/** Outcome of parsing the stored suite record. */
export type SuiteRecordParse =
  | { ok: true; record: SuiteRecord }
  | { ok: false; message: string };

/**
 * Parses the `gentle-movil:suite` record. Unlike `parseSuiteRecord` in
 * `lib/suite.ts` (which must keep the installer running), a corrupt record is
 * reported as `ok: false` here: Ajustes has to show `Sin datos` instead of
 * claiming nothing is installed.
 *
 * `persistSuiteRecord` writes camelCase fields (`gentleShell`, `gentleAi`); the
 * kebab spelling (`gentle-shell`) is also accepted because it is the name of
 * the component in every other surface.
 */
export function parseStoredSuite(raw: string | null): SuiteRecordParse {
  if (raw === null) {
    return { ok: true, record: { ...EMPTY_SUITE_RECORD } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: describeError(error).message };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'El registro guardado no tiene la forma esperada.' };
  }

  const value = parsed as Record<string, unknown>;
  const flag = (...keys: string[]): boolean => keys.some((key) => value[key] === true);

  return {
    ok: true,
    record: {
      gentleShell: flag('gentleShell', 'gentle-shell'),
      engram: flag('engram'),
      gentleAi: flag('gentleAi', 'gentle-ai'),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Pure builders
 * ------------------------------------------------------------------ */

/** `Conectado` / `Local` / `Ambos`, or the honest absence value. */
export function modeLabelFor(mode: AppMode | null, known: boolean): string {
  if (!known) {
    return UNKNOWN_LABEL;
  }
  return mode === null ? NO_MODE_LABEL : MODE_LABELS[mode];
}

/** Per-component installation state, in the order V21 lists the components. */
export function suiteStatuses(record: SuiteRecord, known: boolean): SuiteStatusRow[] {
  return SUITE_COMPONENTS.map((row) => {
    const installed = record[recordFieldFor(row.component)] === true;
    return {
      component: row.component,
      name: row.name,
      description: row.description,
      installed,
      value: known ? (installed ? INSTALLED_LABEL : NOT_INSTALLED_LABEL) : UNKNOWN_LABEL,
      tone: known ? (installed ? 'ok' : 'muted') : 'warning',
    };
  });
}

/** Tunnel identity of the given snapshot, or the honest `Sin túnel` row. */
export function tunnelView(tunnel: TunnelSnapshot | null): TunnelView {
  if (tunnel === null) {
    return {
      present: false,
      host: null,
      ports: [],
      sessionId: null,
      value: SIN_TUNEL_LABEL,
      detail: 'No hay ningún túnel abierto en esta sesión de la app.',
      tone: 'muted',
    };
  }

  const host = tunnel.host.trim() === '' ? null : tunnel.host.trim();
  const sessionId = tunnel.sessionId.trim() === '' ? null : tunnel.sessionId.trim();
  const ports = [...tunnel.ports];
  const portsLabel =
    ports.length === 0 ? 'sin puertos abiertos' : `puertos ${ports.join(', ')}`;
  const sessionLabel = sessionId === null ? 'sesión sin identificar' : `sesión ${sessionId}`;

  return {
    present: true,
    host,
    ports,
    sessionId,
    value: host ?? 'Túnel abierto',
    detail: `${portsLabel} · ${sessionLabel}`,
    tone: 'ok',
  };
}

/** Diagnostics facts, imported from the writer (`lib/logger.ts`). */
export function diagnosticsFacts(): DiagnosticsFacts {
  return {
    logFile: LOG_FILE,
    logPath: `${LOG_DIR}/${LOG_FILE}`,
    capacity: LOG_CAPACITY,
    rotateBytes: LOG_ROTATE_BYTES,
    rotateLabel: LOG_ROTATE_LABEL,
  };
}

/** Everything `buildExportText` is allowed to read from the view model. */
export type SettingsExportSource = Pick<
  SettingsViewModel,
  'app' | 'modeLabel' | 'suite' | 'suiteKnown' | 'tunnel' | 'diagnostics' | 'storageError'
>;

/**
 * The exact text the export intent would share. Built only from values already
 * on the screen — a missing version, an unread store or a tunnel-less session
 * leaves an honest line, never a placeholder that looks like real data.
 */
export function buildExportText(source: SettingsExportSource): string {
  const version = source.app.version ?? 'sin datos';
  const build = source.app.build === null ? '' : ` · build ${source.app.build}`;
  const suite = source.suiteKnown
    ? source.suite
        .map((row) => `${row.name} ${row.installed ? 'instalado' : 'no instalado'}`)
        .join(' · ')
    : 'sin datos';
  const facts = source.diagnostics;

  const lines: string[] = [
    'Gentle Movil · diagnóstico',
    `versión ${version}${build}`,
    `modo: ${source.modeLabel}`,
    `suite: ${suite}`,
    `túnel: ${source.tunnel.present ? source.tunnel.detail : SIN_TUNEL_LABEL}`,
    `registro: ${facts.logPath} (${facts.capacity} entradas en memoria · rota a los ${facts.rotateLabel})`,
  ];
  if (source.storageError !== null) {
    lines.push(`almacenamiento: ${source.storageError.detail}`);
  }
  return lines.join('\n');
}

/** Inputs of `buildSettings`: already-read state, nothing is fetched here. */
export interface BuildSettingsInput {
  mode: AppMode | null;
  modeKnown: boolean;
  suite: SuiteRecord;
  suiteKnown: boolean;
  tunnel: TunnelSnapshot | null;
  app: AppInfo;
  storageError: SettingsStorageError | null;
}

/** Builds the whole screen from state that was already read. */
export function buildSettings(input: BuildSettingsInput): SettingsViewModel {
  const modeLabel = modeLabelFor(input.mode, input.modeKnown);
  const suite = suiteStatuses(input.suite, input.suiteKnown);
  const tunnel = tunnelView(input.tunnel);
  const diagnostics = diagnosticsFacts();

  const modeAction: SettingsAction = {
    route: MODE_ROUTE,
    label: 'Cambiar',
    pending: true,
    note: MODE_PENDING_NOTE,
  };

  const suiteAction: SettingsAction = {
    route: SUITE_ROUTE,
    label: 'Reinstalar',
    pending: true,
    note: SUITE_PENDING_NOTE,
  };

  const tunnelAction: SettingsAction = {
    route: TUNNEL_ROUTE,
    label: tunnel.present ? 'Desconectar' : 'Reconectar',
    pending: true,
    note: TUNNEL_PENDING_NOTE,
  };

  const exportAction: SettingsAction = {
    route: EXPORT_ROUTE,
    label: 'Exportar',
    pending: true,
    note: EXPORT_PENDING_NOTE,
  };

  const sections: SettingsSection[] = [
    {
      id: 'modo',
      title: SECTION_TITLES.modo,
      rows: [
        {
          id: 'modo',
          title: 'Modo actual',
          detail: 'Se elige en el onboarding y se aplica sin reiniciar la app.',
          value: modeLabel,
          tone: !input.modeKnown ? 'warning' : input.mode === null ? 'muted' : 'ok',
          action: modeAction,
        },
      ],
    },
    {
      id: 'suite',
      title: SECTION_TITLES.suite,
      rows: [
        ...suite.map((row) => ({
          id: `suite-${row.component}`,
          title: row.name,
          detail: row.description,
          value: row.value,
          tone: row.tone,
          action: null,
        })),
        {
          id: 'suite-reinstall',
          title: 'Reinstalar la suite',
          detail: 'Vuelve a correr la instalación en el teléfono.',
          value: '',
          tone: 'muted',
          action: suiteAction,
        },
      ],
    },
    {
      id: 'tunel',
      title: SECTION_TITLES.tunel,
      rows: [
        {
          id: 'tunel-estado',
          title: 'Túnel SSH',
          detail: tunnel.detail,
          value: tunnel.value,
          tone: tunnel.tone,
          action: null,
        },
        {
          id: 'tunel-accion',
          title: tunnel.present ? 'Cerrar el túnel' : 'Abrir un túnel',
          detail: null,
          value: '',
          tone: 'muted',
          action: tunnelAction,
        },
      ],
    },
    {
      id: 'diagnostico',
      title: SECTION_TITLES.diagnostico,
      rows: [
        {
          id: 'log',
          title: 'Registro',
          detail: `${diagnostics.logPath} · ${diagnostics.capacity} entradas en memoria · rota a los ${diagnostics.rotateLabel}`,
          value: diagnostics.logFile,
          tone: 'muted',
          action: null,
        },
        {
          id: 'export',
          title: 'Exportar diagnóstico',
          detail: 'Copia los datos reales de esta pantalla para pegarlos en un issue.',
          value: '',
          tone: 'muted',
          action: exportAction,
        },
      ],
    },
    {
      id: 'acerca',
      title: SECTION_TITLES.acerca,
      rows: [
        {
          id: 'version',
          title: 'Gentle Movil',
          detail: input.app.build === null ? null : `build ${input.app.build}`,
          value: input.app.version ?? UNKNOWN_LABEL,
          tone: 'muted',
          action: null,
        },
      ],
    },
  ];

  const source: SettingsExportSource = {
    app: input.app,
    modeLabel,
    suite,
    suiteKnown: input.suiteKnown,
    tunnel,
    diagnostics,
    storageError: input.storageError,
  };

  return {
    mode: input.mode,
    modeKnown: input.modeKnown,
    modeLabel,
    suite,
    suiteKnown: input.suiteKnown,
    tunnel,
    app: input.app,
    diagnostics,
    sections,
    storageError: input.storageError,
    exportText: buildExportText(source),
  };
}

/* ------------------------------------------------------------------ *
 * Loading (injected storage)
 * ------------------------------------------------------------------ */

type RawRead = { ok: true; raw: string | null } | { ok: false; message: string };

/** One key read; a broken store becomes a typed failure, never a throw. */
async function readKey(read: SettingsStorageReader, key: string): Promise<RawRead> {
  try {
    return { ok: true, raw: await read(key) };
  } catch (error) {
    return { ok: false, message: describeError(error).message };
  }
}

/**
 * Reads the mode and the suite record from the injected storage and returns the
 * honest view model. A store that throws or holds corrupt JSON becomes the
 * `storageError` state (with the affected values marked `Sin datos`), and the
 * failure is logged with the key it came from.
 *
 * This function never throws by design: the screen always has a model to draw.
 */
export async function loadSettings(
  read: SettingsStorageReader,
  deps: LoadSettingsDeps,
): Promise<SettingsViewModel> {
  const log = deps.logger ?? settingsLog;
  const failures: { key: string; message: string }[] = [];

  const [modeRead, suiteRead] = await Promise.all([
    readKey(read, MODE_STORAGE_KEY),
    readKey(read, SUITE_STORAGE_KEY),
  ]);

  let mode: AppMode | null = null;
  let modeKnown = true;
  if (modeRead.ok) {
    mode = parseStoredMode(modeRead.raw);
  } else {
    modeKnown = false;
    failures.push({ key: MODE_STORAGE_KEY, message: modeRead.message });
  }

  let suite: SuiteRecord = { ...EMPTY_SUITE_RECORD };
  let suiteKnown = true;
  if (!suiteRead.ok) {
    suiteKnown = false;
    failures.push({ key: SUITE_STORAGE_KEY, message: suiteRead.message });
  } else {
    const parsed = parseStoredSuite(suiteRead.raw);
    if (parsed.ok) {
      suite = parsed.record;
    } else {
      suiteKnown = false;
      failures.push({ key: SUITE_STORAGE_KEY, message: parsed.message });
    }
  }

  for (const failure of failures) {
    log.failure('read-settings', new Error(failure.message), { key: failure.key });
  }

  const storageError: SettingsStorageError | null =
    failures.length === 0
      ? null
      : {
          keys: failures.map((failure) => failure.key),
          message: failures[0].message,
          title: STORAGE_ERROR_TITLE,
          detail: `No pudimos leer ${failures.map((failure) => failure.key).join(', ')}: ${failures[0].message}`,
          action: {
            route: SETTINGS_ROUTE,
            label: RETRY_LABEL,
            pending: false,
            note: STORAGE_RETRY_NOTE,
          },
        };

  return buildSettings({
    mode,
    modeKnown,
    suite,
    suiteKnown,
    tunnel: deps.tunnel,
    app: deps.app,
    storageError,
  });
}
