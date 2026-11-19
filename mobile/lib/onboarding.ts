/**
 * Onboarding exit — the `gentle-movil:onboarded` flag and the routes that read
 * it (task T7p, `docs/mobile-views-plan.md` §V4/§V21).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * AsyncStorage instance. `mobile/test/onboarding.test.mjs` pins these rules.
 *
 * ## Storage key
 *
 * `gentle-movil:onboarded` — `'true'` once the onboarding really finished,
 * `'false'` when it did not (or after a re-pair). It is written exactly here:
 *
 * - `finishModeChoice` writes it for `conectado`, right after the mode choice:
 *   that mode has no phone-side install, so pairing + mode is the whole
 *   onboarding;
 * - `finishSuiteStep` writes it for `ambos` and `local`, after the suite step;
 * - `rePair` writes `'false'` (the Ajustes action), so the entry sends the
 *   person back to the QR scan.
 *
 * ## Reading it safely
 *
 * Only the exact stored word `'true'` means onboarded. A missing value is "not
 * onboarded" (a fresh install) and anything else is corrupt: it is treated as
 * not onboarded and logged, so a broken store never crashes the app entry and
 * never traps the person inside the app either.
 */

import {
  OVERVIEW_ROUTE,
  QR_ROUTE,
  SUITE_ROUTE,
  type AppMode,
  type SuiteLog,
  type SuiteStorage,
} from './suite.ts';

/** AsyncStorage key of the finished-onboarding flag. */
export const ONBOARDED_STORAGE_KEY = 'gentle-movil:onboarded';

/** The only stored word that means "the onboarding is done". */
export const ONBOARDED_TRUE = 'true';

/** Written when the onboarding has to run again. */
export const ONBOARDED_FALSE = 'false';

/** Entry route of the app when the onboarding is done: the V5 dashboard. */
export const APP_HOME_ROUTE = OVERVIEW_ROUTE;

/** First step of the onboarding: the V1 QR scan. */
export const ONBOARDING_START_ROUTE = QR_ROUTE;

/** Section legend of the Ajustes action that re-runs the onboarding. */
export const REPAIR_SECTION_TITLE = 'Emparejamiento';

/** Row title of the re-pair action (the escape hatch of the app). */
export const REPAIR_LABEL = 'Volver a emparejar';

/** What the re-pair action really does. */
export const REPAIR_DETAIL =
  'Borra el onboarding de este teléfono y vuelve al escaneo del QR para emparejarlo de nuevo.';

/** Button label of the re-pair action. */
export const REPAIR_ACTION_LABEL = 'Volver a emparejar';

/** Honest note shown while the re-pair action runs. */
export const REPAIR_PENDING_NOTE = 'Volviendo al escaneo del QR…';

/** Honest note when the flag could not be cleared (the person is told, not trapped). */
export const REPAIR_FAILED_NOTE =
  'No pudimos borrar el onboarding: el teléfono no dejó escribir su almacenamiento.';

/** Storage surface this module needs (AsyncStorage satisfies it). */
export type OnboardingStorage = SuiteStorage;

/** Log surface this module needs (`logger.tag('onboarding')` satisfies it). */
export type OnboardingLog = SuiteLog;

/** `'true'` and nothing else: the flag never has a second truthy spelling. */
export function parseOnboarded(raw: string | null): boolean {
  return raw !== null && raw.trim() === ONBOARDED_TRUE;
}

/**
 * The route a flag state maps to: `/overview` when the onboarding already
 * finished, `/scan-qr` otherwise (the first step of V1). `bootDecision` below is
 * what the entry really uses (a saved pairing wins over the flag, S12), and it
 * takes its routes from here so there is one place that names them.
 */
export function initialRouteFor(onboarded: boolean): string {
  return onboarded ? APP_HOME_ROUTE : ONBOARDING_START_ROUTE;
}

/**
 * Reads the flag. A missing value means "not onboarded"; a corrupt value is
 * treated the same way **and logged**, so the entry never crashes on it.
 */
export async function readOnboarded(
  storage: OnboardingStorage,
  log?: OnboardingLog,
): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await storage.getItem(ONBOARDED_STORAGE_KEY);
  } catch (error) {
    log?.failure('read-onboarded', error, null);
    return false;
  }

  if (raw !== null && raw.trim() !== ONBOARDED_TRUE && raw.trim() !== ONBOARDED_FALSE) {
    log?.failure(
      'read-onboarded',
      new Error('el estado del onboarding guardado no es válido'),
      { key: ONBOARDED_STORAGE_KEY, raw },
    );
    return false;
  }

  return parseOnboarded(raw);
}

/**
 * Writes the finished-onboarding flag. Returns whether it was stored: a failed
 * write is logged and never breaks the flow the person is in.
 */
export async function markOnboarded(
  storage: OnboardingStorage,
  log?: OnboardingLog,
): Promise<boolean> {
  try {
    await storage.setItem(ONBOARDED_STORAGE_KEY, ONBOARDED_TRUE);
    log?.info('onboarding terminado', { key: ONBOARDED_STORAGE_KEY, value: ONBOARDED_TRUE });
    return true;
  } catch (error) {
    log?.failure('persist-onboarded', error, { key: ONBOARDED_STORAGE_KEY });
    return false;
  }
}

/**
 * Clears the flag (it is stored as `'false'`, not removed: the record stays
 * readable and Ajustes can still show what happened). Same failure contract as
 * `markOnboarded`.
 */
export async function clearOnboarded(
  storage: OnboardingStorage,
  log?: OnboardingLog,
): Promise<boolean> {
  try {
    await storage.setItem(ONBOARDED_STORAGE_KEY, ONBOARDED_FALSE);
    log?.info('onboarding reiniciado', { key: ONBOARDED_STORAGE_KEY, value: ONBOARDED_FALSE });
    return true;
  } catch (error) {
    log?.failure('clear-onboarded', error, { key: ONBOARDED_STORAGE_KEY });
    return false;
  }
}

/** Where a mode's onboarding ends and whether it ends there. */
export interface ModeChoiceExit {
  /** Route to push next. */
  route: string;
  /** Whether this step really wrote the flag (a failed write is `false`). */
  onboardedNow: boolean;
}

/** `ambos` and `local` still have the phone-side suite step; `conectado` does not. */
export function modeNeedsSuiteStep(mode: AppMode): boolean {
  return mode === 'ambos' || mode === 'local';
}

/**
 * Exit of V4. `conectado` finishes the onboarding right here (no phone-side
 * install): the flag is written and the app home is next. `ambos`/`local` go to
 * the suite step and the flag is left untouched for `finishSuiteStep`.
 */
export async function finishModeChoice(
  storage: OnboardingStorage,
  mode: AppMode,
  log?: OnboardingLog,
): Promise<ModeChoiceExit> {
  if (modeNeedsSuiteStep(mode)) {
    log?.info('suite pendiente', { mode, route: SUITE_ROUTE });
    return { route: SUITE_ROUTE, onboardedNow: false };
  }

  const written = await markOnboarded(storage, log);
  log?.info('onboarding terminado en la elección de modo', {
    mode,
    route: APP_HOME_ROUTE,
    stored: written,
  });
  // A failed write never blocks the exit: the person goes into the app and
  // Ajustes can re-run the onboarding.
  return { route: APP_HOME_ROUTE, onboardedNow: written };
}

/**
 * Exit of V21: the onboarding really finished, so the flag is written and the
 * app continues at `/overview`. Returns the route to push; a failed write is
 * logged by `markOnboarded` and does not block the exit (the person is not
 * trapped: Ajustes can re-run the onboarding).
 */
export async function finishSuiteStep(
  storage: OnboardingStorage,
  log?: OnboardingLog,
): Promise<string> {
  await markOnboarded(storage, log);
  return APP_HOME_ROUTE;
}

/** Outcome of the Ajustes re-pair action: where it goes and whether the flag was cleared. */
export interface RePairResult {
  /** Route to push next: the QR scan (V1). */
  route: string;
  /** Whether the `gentle-movil:onboarded` flag was really cleared. */
  cleared: boolean;
}

/**
 * Ajustes action: clears the flag and points at the QR scan, so re-pairing is
 * always one tap away and the person is never trapped in the app.
 *
 * `cleared: false` means the store refused the write: the screen still goes to
 * the QR scan (the person is not blocked) and says the flag could not be erased.
 */
export async function rePair(
  storage: OnboardingStorage,
  log?: OnboardingLog,
): Promise<RePairResult> {
  const cleared = await clearOnboarded(storage, log);
  log?.info('volver al onboarding', { route: ONBOARDING_START_ROUTE, cleared });
  return { route: ONBOARDING_START_ROUTE, cleared };
}

/* ------------------------------------------------------------------ *
 * Boot gate (T17, S11/S12)
 * ------------------------------------------------------------------ */

/** One saved device, as the boot gate reads it (`ConnectionRecord` satisfies it). */
export interface BootConnection {
  id: string;
}

/** Everything the entry is allowed to decide on. */
export interface BootGateInput {
  /** `gentle-movil:onboarded` as `readOnboarded` reported it. */
  onboarded: boolean;
  /** The active saved connection, or `null` when there is none. */
  connection: BootConnection | null;
  /** How many connections are saved (defaults to 0; `connection` implies one). */
  saved?: number;
  /**
   * `gentle-movil:mode` as the person chose it in V4 (`readChosenMode`), or
   * `null` when the phone has never chosen one. Local mode needs no PC at all,
   * so this input is what keeps those people out of the QR onboarding.
   */
  mode: AppMode | null;
}

/** Why a local-mode boot with no saved connection goes home instead of pairing. */
export const LOCAL_MODE_NO_PC_REASON =
  'modo local: este teléfono no necesita ninguna PC para trabajar; podés agregar una conexión cuando quieras desde el menú de conexión';

/**
 * Appended to the pairing reason when the phone never chose a mode: the gate
 * must not read a missing choice as "local", so it says so out loud.
 */
export const UNKNOWN_MODE_NO_CONNECTION_NOTE =
  'no hay ningún modo elegido, así que no podemos asumir el modo local';

/** The reason a `conectado`/`ambos` phone with nothing saved pairs again. */
export const PAIRING_LOST_REASON =
  'el onboarding terminó pero no queda ninguna conexión guardada: hay que emparejar de nuevo';

/** The reason a fresh install (or a phone with no mode) starts at V1. */
export const FIRST_LAUNCH_REASON = 'primer arranque sin ninguna conexión guardada';

/** What the entry does next and why. */
export interface BootDecision {
  /** `onboarding` shows V1 again; `home` enters the app. */
  kind: 'onboarding' | 'home';
  /** Route to redirect to (`/scan-qr` or `/overview`). */
  route: string;
  /** True when the app must reconnect with the saved device key (S12). */
  reconnect: boolean;
  /** The saved connection the reconnect will use, when there is one. */
  connection: BootConnection | null;
  /** Honest explanation, logged by the entry. */
  reason: string;
}

/**
 * The boot decision table of S11/S12/S6, mode-aware.
 *
 * S12 is the rule that wins: the onboarding is shown **only** when there is no
 * saved connection at all. A saved pairing sends the app to the home screen and
 * to a real reconnect, with or without the legacy `onboarded` flag — and a flag
 * without any saved pairing is not a connection (it would reconnect to
 * nothing), so it goes back to the onboarding and says why.
 *
 * S6 is the other half: local mode is a real mode of the product, and it needs
 * no PC at all. So a `local` phone with nothing saved enters the app and does
 * **not** reconnect — it must never be locked out of its own local projects by
 * a QR screen. `conectado`/`ambos` still pair (that half of the product needs a
 * PC), and a phone that never chose a mode is not read as local: it pairs and
 * the reason says the choice is missing.
 *
 * | mode | saved connection | decision |
 * | --- | --- | --- |
 * | any | active connection | `/overview`, reconnect (the pairing wins) |
 * | any | records, none active | `/overview`, no reconnect, pick one in the menu |
 * | `local` | none | `/overview`, no reconnect, `LOCAL_MODE_NO_PC_REASON` |
 * | `conectado` | none | `/scan-qr`, no reconnect, the existing reason |
 * | `ambos` | none | `/scan-qr`, no reconnect, the existing reason |
 * | `null` | none | `/scan-qr`, no reconnect, the existing reason + `UNKNOWN_MODE_NO_CONNECTION_NOTE` |
 */
export function bootDecision(input: BootGateInput): BootDecision {
  const saved = input.saved ?? (input.connection === null ? 0 : 1);

  if (input.connection !== null) {
    return {
      kind: 'home',
      route: initialRouteFor(true),
      reconnect: true,
      connection: input.connection,
      reason: input.onboarded
        ? 'el onboarding ya terminó y hay una conexión guardada: la app reconecta sola'
        : 'hay una conexión guardada aunque el flag del onboarding no esté: reconecta sin repetir el onboarding',
    };
  }

  if (saved > 0) {
    return {
      kind: 'home',
      route: initialRouteFor(true),
      reconnect: false,
      connection: null,
      reason:
        'hay conexiones guardadas pero ninguna está marcada como activa: elegí una desde el menú de conexión',
    };
  }

  // No saved connection. Local mode is the one that works without a PC.
  if (input.mode === 'local') {
    return {
      kind: 'home',
      route: initialRouteFor(true),
      reconnect: false,
      connection: null,
      reason: LOCAL_MODE_NO_PC_REASON,
    };
  }

  const pairingReason = input.onboarded ? PAIRING_LOST_REASON : FIRST_LAUNCH_REASON;
  return {
    kind: 'onboarding',
    route: initialRouteFor(false),
    reconnect: false,
    connection: null,
    // A missing mode is never read as `local`: say that the choice is missing.
    reason:
      input.mode === null
        ? `${pairingReason}; ${UNKNOWN_MODE_NO_CONNECTION_NOTE}`
        : pairingReason,
  };
}
