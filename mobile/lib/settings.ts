/**
 * V18 — Settings logic (artboard `design/mobile-app-core/10-settings.html`,
 * `docs/mobile-views-plan.md` §V18, tasks T7i + T7m).
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
 *   screen);
 * - the device-key fingerprint comes from the real core
 *   (`core.deviceKeyGenerate()`, injected as `DeviceKeySource`): when the core
 *   is not in the build its rejection is shown as `no disponible` **with the
 *   real reason** — this module never invents a fingerprint;
 * - the paired-device row is the real tunnel host plus the real phone label
 *   (`Constants.deviceName` / `Platform.OS`, passed in): one device, this phone,
 *   and `Sin túnel` when the pairing flow opened none. Revoking edits
 *   `authorized_keys` on the PC, so its intent is `pending: true`;
 * - the two toggles (`notificaciones`, `puenteAutomatico`) are preferences the
 *   screen really persists in AsyncStorage under the documented keys
 *   (`TOGGLE_STORAGE_KEYS`). A corrupt value is a typed parse failure, never a
 *   silent default, and every toggle carries `effectWired: false` + its note
 *   because the behavior behind it is not built yet;
 * - the storage-usage row is built only from constants this module really has:
 *   the `lib/logger.ts` rotation limit and ring capacity, plus the byte size of
 *   the stored suite record when it is readable — no fabricated byte count.
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
  CoreUnavailableError,
  type MobileCore,
  core,
  utf8Encode,
} from './core.ts';
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

/**
 * Intent id of revoking a paired device. Revoking really edits
 * `authorized_keys` on the PC, and that path is not built: the copy says so
 * instead of pointing at a screen that would not revoke anything.
 */
export const REVOKE_ROUTE = '/settings/devices/revoke';

/** Action label of the revoke intent. */
export const REVOKE_LABEL = 'Revocar';

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
  dispositivos: 'Dispositivos emparejados',
  modo: 'Modo',
  suite: 'Suite en el teléfono',
  tunel: 'Túnel',
  comportamiento: 'Comportamiento',
  seguridad: 'Seguridad',
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
export const REVOKE_PENDING_NOTE =
  'Revocar todavía no está conectado: borrar la clave de este teléfono edita authorized_keys en la PC y ese camino no está construido.';

/** Retry note of the storage read (this one is wired). */
export const STORAGE_RETRY_NOTE = 'Reintentar vuelve a leer el almacenamiento del teléfono.';

/** Title of the honest storage failure state. */
export const STORAGE_ERROR_TITLE = 'No pudimos leer el almacenamiento';

/** `512 KB` — the rotation limit of `lib/logger.ts`, derived from the constant. */
export const LOG_ROTATE_LABEL = `${Math.round(LOG_ROTATE_BYTES / 1024)} KB`;

/* ------------------------------------------------------------------ *
 * T7m — device key, paired devices, toggles and storage usage
 * ------------------------------------------------------------------ */

/** Title of the security row that carries the device-key fingerprint. */
export const DEVICE_KEY_TITLE = 'Clave de este dispositivo (ed25519)';

/**
 * Honest value of the device-key row when the core cannot answer. The task
 * spells it lowercase: this string is that exact copy, never a placeholder
 * fingerprint.
 */
export const DEVICE_KEY_UNAVAILABLE_LABEL = 'no disponible';

/** Artboard sentence shown under a real fingerprint. */
export const DEVICE_KEY_AVAILABLE_DETAIL =
  'Generada en este dispositivo, nunca sale de él. Si la huella de tu PC cambia, la app te avisa antes de conectar.';

/** Reason when the core answers without a fingerprint (a real core failure). */
export const DEVICE_KEY_EMPTY_REASON = 'el core no devolvió ninguna huella para esta clave';

/** First half of the paired-device row title. */
export const PHONE_TITLE = 'Este teléfono';

/** Honest tail when neither `Constants.deviceName` nor the OS is known. */
export const PHONE_UNKNOWN_NAME = 'sin nombre de equipo';

/** Real OS labels, keyed by `Platform.OS`, when a device name is unavailable. */
export const PHONE_OS_LABELS: Record<string, string> = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
};

/**
 * AsyncStorage keys of the two persisted preferences. They are the only thing
 * this screen really writes; the row note says the behavior behind each one is
 * not wired yet.
 */
export const TOGGLE_IDS = ['notificaciones', 'puenteAutomatico'] as const;
export type ToggleId = (typeof TOGGLE_IDS)[number];

export const TOGGLE_STORAGE_KEYS: Record<ToggleId, string> = {
  /** `Activado` / `Desactivado` push notifications. */
  notificaciones: 'gentle-movil:settings:notificaciones',
  /** `Activado` / `Desactivado` automatic bridge links. */
  puenteAutomatico: 'gentle-movil:settings:puente-automatico',
};

/** Stored spellings of a toggle: exactly these two, nothing else. */
export const TOGGLE_ON_VALUE = 'on';
export const TOGGLE_OFF_VALUE = 'off';

/** Human values of a toggle row. */
export const TOGGLE_ON_LABEL = 'Activado';
export const TOGGLE_OFF_LABEL = 'Desactivado';
/** Nothing was ever stored: a fact, never a guessed default. */
export const TOGGLE_UNSET_LABEL = 'Sin configurar';

/** Per-toggle copy: title, artboard description and the honest unwired note. */
export const TOGGLE_COPY: Record<
  ToggleId,
  { title: string; description: string; note: string }
> = {
  notificaciones: {
    title: 'Notificaciones push',
    description: 'Avisar cuando Gentle Shell espere respuesta.',
    note: 'La preferencia se guarda en este teléfono, pero el envío de avisos todavía no está construido: cambiarla no cambia ningún aviso.',
  },
  puenteAutomatico: {
    title: 'Bridge de archivos y localhost',
    description: 'Abrir links y archivos que el agente menciona.',
    note: 'La preferencia se guarda en este teléfono, pero abrir links y archivos desde el agente todavía no está construido: cambiarla no cambia el comportamiento.',
  },
};

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
  /** Real phone info; defaults to the honest unknown (`Este teléfono`). */
  phone?: PhoneInfo;
  /** Core surface for the device key; defaults to the real `core` binding. */
  deviceKey?: DeviceKeySource;
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
  /** Toggle this row switches, when it is one of the persisted preferences. */
  toggle?: ToggleId | null;
  /** Honest note shown under the row even when there is no action. */
  note?: string | null;
}

/** Section the shell renders, in artboard order. */
export interface SettingsSection {
  id:
    | 'dispositivos'
    | 'modo'
    | 'suite'
    | 'tunel'
    | 'comportamiento'
    | 'seguridad'
    | 'diagnostico'
    | 'acerca';
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

/** Real phone info the caller knows (`expo-constants` / `Platform` in the screen). */
export interface PhoneInfo {
  /** `Constants.deviceName`, or null when the build does not expose one. */
  deviceName: string | null;
  /** `Platform.OS`, or null when the platform is unknown. */
  os: string | null;
}

/** Where a device-key result came from, so the row can say the real cause. */
export type DeviceKeyCause = 'core-unavailable' | 'failure';

/** Outcome of calling the real `core.deviceKeyGenerate()`. */
export type DeviceKeyResult =
  | { ok: true; publicKey: string; fingerprint: string }
  | { ok: false; cause: DeviceKeyCause; name: string; reason: string };

/** The only core surface this module calls (injected, so tests stay offline). */
export type DeviceKeySource = Pick<MobileCore, 'deviceKeyGenerate'>;

/** The device-key row as the screen shows it. */
export interface DeviceKeyFacts {
  available: boolean;
  /** Real `SHA256:` fingerprint, or null — never invented. */
  fingerprint: string | null;
  /** Public key the core returned, or null (it is never shown as the fingerprint). */
  publicKey: string | null;
  cause: DeviceKeyCause | null;
  /** Rejection message verbatim, or null when the key was read. */
  reason: string | null;
  /** Chip value: the fingerprint, or `no disponible`. */
  value: string;
  detail: string;
  tone: SettingsTone;
}

/** One real paired device. Today there is exactly one: this phone. */
export interface PairedDeviceRow {
  id: string;
  title: string;
  detail: string;
  /** Chip value: the real tunnel host, or `Sin túnel`. */
  value: string;
  tone: SettingsTone;
  /** True only while the pairing flow's tunnel is open. */
  live: boolean;
  /** Revoke intent (always `pending: true`: it edits the PC's `authorized_keys`). */
  action: SettingsAction;
}

/** Outcome of parsing one stored toggle preference. */
export type ToggleParse =
  | { ok: true; enabled: boolean | null }
  | { ok: false; message: string };

/** One persisted preference and what it honestly does today. */
export interface SettingsToggleRow {
  id: ToggleId;
  title: string;
  description: string;
  /** AsyncStorage key this toggle really writes. */
  storageKey: string;
  enabled: boolean | null;
  /** False when the stored value was corrupt/unreadable (row becomes `Sin datos`). */
  known: boolean;
  value: string;
  tone: SettingsTone;
  /** True only when the preference really changes behavior: it does not yet. */
  effectWired: boolean;
  /** Honest sentence shown in the row while `effectWired` is false. */
  note: string;
}

/** Storage facts built only from values this module really has. */
export interface StorageUsageFacts {
  logFile: string;
  /** Rotation limit in bytes (`lib/logger.ts`), not a measured usage. */
  logLimitBytes: number;
  logLimitLabel: string;
  capacity: number;
  /** Byte size of the stored suite record, or null when there is none/unknown. */
  suiteBytes: number | null;
  /** Human form of `suiteBytes`, or the honest absence phrase. */
  suiteLabel: string;
  /** Chip value: the real rotation limit, the only byte figure of the log. */
  value: string;
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
  /** Paired devices: this phone, with the real tunnel host and the Revoke intent. */
  devices: PairedDeviceRow[];
  /** Device-key fingerprint, or `no disponible` with the real cause. */
  deviceKey: DeviceKeyFacts;
  /** The two persisted preferences, in artboard order. */
  toggles: SettingsToggleRow[];
  /** Real storage facts (log constants + the suite record size). */
  storageUsage: StorageUsageFacts;
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

/* ------------------------------------------------------------------ *
 * T7m builders
 * ------------------------------------------------------------------ */

/**
 * Calls the real `core.deviceKeyGenerate()` (or an injected source) and turns
 * every outcome into a typed result: a key, or a rejection with its verbatim
 * reason. Nothing here fabricates a fingerprint.
 */
export async function resolveDeviceKey(
  source: DeviceKeySource = core,
): Promise<DeviceKeyResult> {
  try {
    const pair = await source.deviceKeyGenerate();
    const fingerprint = typeof pair.fingerprint === 'string' ? pair.fingerprint.trim() : '';
    const publicKey = typeof pair.publicKey === 'string' ? pair.publicKey.trim() : '';
    if (fingerprint === '') {
      // A key without a fingerprint cannot be shown: that is a real failure.
      return {
        ok: false,
        cause: 'failure',
        name: 'EmptyFingerprint',
        reason: DEVICE_KEY_EMPTY_REASON,
      };
    }
    return { ok: true, publicKey, fingerprint };
  } catch (error) {
    const described = describeError(error);
    const cause: DeviceKeyCause =
      error instanceof CoreUnavailableError || described.name === 'CoreUnavailableError'
        ? 'core-unavailable'
        : 'failure';
    return { ok: false, cause, name: described.name, reason: described.message };
  }
}

/** Device-key row facts, from the typed result (never from a placeholder). */
export function deviceKeyFacts(result: DeviceKeyResult): DeviceKeyFacts {
  if (result.ok) {
    return {
      available: true,
      fingerprint: result.fingerprint,
      publicKey: result.publicKey,
      cause: null,
      reason: null,
      value: result.fingerprint,
      detail: DEVICE_KEY_AVAILABLE_DETAIL,
      tone: 'ok',
    };
  }

  const prefix =
    result.cause === 'core-unavailable'
      ? 'La huella la genera el core nativo, que esta compilación no trae'
      : 'El core no pudo devolver la clave de este teléfono';

  return {
    available: false,
    fingerprint: null,
    publicKey: null,
    cause: result.cause,
    reason: result.reason,
    value: DEVICE_KEY_UNAVAILABLE_LABEL,
    detail: `${prefix}: ${result.reason}`,
    tone: 'warning',
  };
}

/** Real phone label: the device name, else the real OS, else null. */
export function phoneLabel(phone: PhoneInfo): string | null {
  const name = typeof phone.deviceName === 'string' ? phone.deviceName.trim() : '';
  if (name !== '') {
    return name;
  }
  const os = typeof phone.os === 'string' ? phone.os.trim().toLowerCase() : '';
  return PHONE_OS_LABELS[os] ?? null;
}

/**
 * The one real paired device (this phone) with the real tunnel host, or
 * `Sin túnel` when the pairing flow opened none. The Revoke intent is always
 * `pending: true`: it edits `authorized_keys` on the PC.
 */
export function pairedDevices(tunnel: TunnelView, phone: PhoneInfo): PairedDeviceRow[] {
  const label = phoneLabel(phone);
  const title = `${PHONE_TITLE} · ${label ?? PHONE_UNKNOWN_NAME}`;
  const detail = tunnel.present
    ? `ed25519 · ${tunnel.detail}`
    : 'ed25519 · el emparejamiento no dejó ningún túnel abierto en esta sesión';

  return [
    {
      id: 'device-this-phone',
      title,
      detail,
      value: tunnel.value,
      tone: tunnel.present ? 'ok' : 'muted',
      live: tunnel.present,
      action: {
        route: REVOKE_ROUTE,
        label: REVOKE_LABEL,
        pending: true,
        note: REVOKE_PENDING_NOTE,
      },
    },
  ];
}

/**
 * Parses one stored toggle. `null` means nothing was ever stored (an honest
 * "unset" fact); the only valid stored spellings are `on` and `off`, so any
 * other value is a typed failure instead of a silent default.
 */
export function parseStoredToggle(raw: string | null): ToggleParse {
  if (raw === null) {
    return { ok: true, enabled: null };
  }
  const value = raw.trim();
  if (value === TOGGLE_ON_VALUE) {
    return { ok: true, enabled: true };
  }
  if (value === TOGGLE_OFF_VALUE) {
    return { ok: true, enabled: false };
  }
  const shown = value.length > 32 ? `${value.slice(0, 32)}…` : value;
  return {
    ok: false,
    message: `La preferencia guardada no es "${TOGGLE_ON_VALUE}" ni "${TOGGLE_OFF_VALUE}": "${shown}"`,
  };
}

/** Exact string `saveToggle` writes for the given state. */
export function serializeToggle(enabled: boolean): string {
  return enabled ? TOGGLE_ON_VALUE : TOGGLE_OFF_VALUE;
}

/** Injected storage writer (`AsyncStorage.setItem` satisfies it). */
export type SettingsStorageWriter = (key: string, value: string) => Promise<void>;

/** Persists one toggle under its documented key (the real write of the screen). */
export async function saveToggle(
  write: SettingsStorageWriter,
  id: ToggleId,
  enabled: boolean,
): Promise<void> {
  await write(TOGGLE_STORAGE_KEYS[id], serializeToggle(enabled));
}

/** The two preference rows, each with the honest `effectWired: false` note. */
export function toggleRows(values: Record<ToggleId, ToggleParse>): SettingsToggleRow[] {
  return TOGGLE_IDS.map((id) => {
    const copy = TOGGLE_COPY[id];
    const parsed = values[id];
    const known = parsed.ok;
    const enabled = parsed.ok ? parsed.enabled : null;

    let value: string;
    if (!known) {
      value = UNKNOWN_LABEL;
    } else if (enabled === null) {
      value = TOGGLE_UNSET_LABEL;
    } else {
      value = enabled ? TOGGLE_ON_LABEL : TOGGLE_OFF_LABEL;
    }

    return {
      id,
      title: copy.title,
      description: copy.description,
      storageKey: TOGGLE_STORAGE_KEYS[id],
      enabled,
      known,
      value,
      tone: !known ? 'warning' : enabled === true ? 'ok' : 'muted',
      // Nothing behind these preferences is built yet, so nothing is pretended.
      effectWired: false,
      note: copy.note,
    };
  });
}

/** `52 B` / `3 KB` — a byte count that really came from a byte length. */
export function byteLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Storage facts from the values this module really owns: the log rotation limit
 * and ring capacity (`lib/logger.ts`) and the byte length of the stored suite
 * record. No byte count is invented: with no readable record the row says so.
 */
export function storageUsageFacts(
  suiteRaw: string | null,
  suiteKnown: boolean,
): StorageUsageFacts {
  const suiteBytes = suiteRaw === null ? null : utf8Encode(suiteRaw).length;
  const suiteLabel = !suiteKnown
    ? 'registro de suite ilegible'
    : suiteBytes === null
      ? 'sin registro de suite'
      : byteLabel(suiteBytes);

  return {
    logFile: LOG_FILE,
    logLimitBytes: LOG_ROTATE_BYTES,
    logLimitLabel: LOG_ROTATE_LABEL,
    capacity: LOG_CAPACITY,
    suiteBytes,
    suiteLabel,
    value: LOG_ROTATE_LABEL,
    detail: `Registro hasta ${LOG_ROTATE_LABEL} (rota a ese tamaño) · ${LOG_CAPACITY} entradas en memoria · registro de suite ${suiteLabel}`,
    tone: suiteKnown ? 'muted' : 'warning',
  };
}

/** Everything `buildExportText` is allowed to read from the view model. */
export type SettingsExportSource = Pick<
  SettingsViewModel,
  | 'app'
  | 'modeLabel'
  | 'suite'
  | 'suiteKnown'
  | 'tunnel'
  | 'deviceKey'
  | 'diagnostics'
  | 'storageError'
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
    // The fingerprint is public by design; when the core cannot answer the
    // line carries the same honest `no disponible` the row shows.
    `clave del dispositivo: ${source.deviceKey.fingerprint ?? DEVICE_KEY_UNAVAILABLE_LABEL}`,
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
  /** Raw suite record as it was stored, for the honest byte count. */
  suiteRaw?: string | null;
  tunnel: TunnelSnapshot | null;
  app: AppInfo;
  /** Real phone info the caller knows. */
  phone: PhoneInfo;
  /** Result of `core.deviceKeyGenerate()` (already awaited by the caller). */
  deviceKey: DeviceKeyResult;
  /** Parsed preference records, one per persisted key. */
  toggles: Record<ToggleId, ToggleParse>;
  storageError: SettingsStorageError | null;
}

/** Builds the whole screen from state that was already read. */
export function buildSettings(input: BuildSettingsInput): SettingsViewModel {
  const modeLabel = modeLabelFor(input.mode, input.modeKnown);
  const suite = suiteStatuses(input.suite, input.suiteKnown);
  const tunnel = tunnelView(input.tunnel);
  const diagnostics = diagnosticsFacts();
  const deviceKey = deviceKeyFacts(input.deviceKey);
  const toggles = toggleRows(input.toggles);
  const storageUsage = storageUsageFacts(input.suiteRaw ?? null, input.suiteKnown);
  const devices = pairedDevices(tunnel, input.phone);

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
      id: 'dispositivos',
      title: SECTION_TITLES.dispositivos,
      rows: devices.map((device) => ({
        id: device.id,
        title: device.title,
        detail: device.detail,
        value: device.value,
        tone: device.tone,
        action: device.action,
      })),
    },
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
      id: 'comportamiento',
      title: SECTION_TITLES.comportamiento,
      rows: toggles.map((toggle) => ({
        id: `toggle-${toggle.id}`,
        title: toggle.title,
        detail: toggle.description,
        value: toggle.value,
        tone: toggle.tone,
        action: null,
        toggle: toggle.id,
        // `effectWired: false`: the preference is saved, the behavior is not.
        note: toggle.effectWired ? null : toggle.note,
      })),
    },
    {
      id: 'seguridad',
      title: SECTION_TITLES.seguridad,
      rows: [
        {
          id: 'device-key',
          title: DEVICE_KEY_TITLE,
          detail: deviceKey.detail,
          value: deviceKey.value,
          tone: deviceKey.tone,
          action: null,
        },
      ],
    },
    {
      id: 'diagnostico',
      title: SECTION_TITLES.diagnostico,
      rows: [
        {
          id: 'storage',
          title: 'Uso de almacenamiento',
          detail: storageUsage.detail,
          value: storageUsage.value,
          tone: storageUsage.tone,
          action: null,
        },
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
    deviceKey,
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
    devices,
    deviceKey,
    toggles,
    storageUsage,
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
 * Reads the mode, the suite record and the two persisted preferences from the
 * injected storage, calls the real device key and returns the honest view
 * model. A store that throws or holds a corrupt value becomes the
 * `storageError` state (with the affected values marked `Sin datos`), and the
 * failure is logged with the key it came from. A core that cannot answer for
 * the device key is *not* a storage failure: the row carries the real reason
 * (`no disponible`).
 *
 * This function never throws by design: the screen always has a model to draw.
 */
export async function loadSettings(
  read: SettingsStorageReader,
  deps: LoadSettingsDeps,
): Promise<SettingsViewModel> {
  const log = deps.logger ?? settingsLog;
  const failures: { key: string; message: string }[] = [];

  const [modeRead, suiteRead, toggleReads, deviceKey] = await Promise.all([
    readKey(read, MODE_STORAGE_KEY),
    readKey(read, SUITE_STORAGE_KEY),
    Promise.all(TOGGLE_IDS.map(async (id) => [id, await readKey(read, TOGGLE_STORAGE_KEYS[id])] as const)),
    resolveDeviceKey(deps.deviceKey ?? core),
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

  const toggles = {} as Record<ToggleId, ToggleParse>;
  for (const [id, toggleRead] of toggleReads) {
    const key = TOGGLE_STORAGE_KEYS[id];
    if (!toggleRead.ok) {
      toggles[id] = { ok: false, message: toggleRead.message };
      failures.push({ key, message: toggleRead.message });
      continue;
    }
    const parsed = parseStoredToggle(toggleRead.raw);
    toggles[id] = parsed;
    if (!parsed.ok) {
      failures.push({ key, message: parsed.message });
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
    suiteRaw: suiteRead.ok ? suiteRead.raw : null,
    tunnel: deps.tunnel,
    app: deps.app,
    phone: deps.phone ?? { deviceName: null, os: null },
    deviceKey,
    toggles,
    storageError,
  });
}
