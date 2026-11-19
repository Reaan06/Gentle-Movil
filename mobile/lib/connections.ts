/**
 * Connection registry — one persisted record per paired device (T17, S11/S12).
 *
 * The app has to survive a restart without sending the person through the
 * onboarding again (S12: «cuando uno ya terminó el onboarding que no pase»), so
 * the pairing is persisted. Two AsyncStorage keys hold it:
 *
 * - `gentle-movil:connections` — a JSON array of `ConnectionRecord`;
 * - `gentle-movil:connections:active` — the `id` of the active record.
 *
 * ## What is stored, and what is never stored
 *
 * A record keeps exactly what a key-only reconnect needs: the routing facts
 * (`host`, `port`, `user`), the **host** fingerprint the reconnect pins
 * (`fingerprint`), the **phone key** fingerprint it was paired with
 * (`deviceKeyFingerprint`), plus `id`, `label` and `addedAt`. The SSH password
 * is NEVER part of a record: the pairing hands it to the core once and nothing
 * here copies it. `parseConnectionRecord` rebuilds each record from the known
 * fields only, so a `pw`/`password`/`secret` field that somehow reached storage
 * is dropped on the next read (and reported, not swallowed).
 *
 * ## Strict, honest parse
 *
 * A corrupt entry is rejected, the valid ones are kept, and every rejection is
 * logged with `{step, error, raw}` — the payload that produced it included.
 * An unreadable store is `ok: false` (the caller must NOT read that as "no
 * saved connection": that would send the person back to the onboarding for a
 * storage failure). Everything is injected (storage + logger), so
 * `mobile/test/connections.test.mjs` pins all of it offline.
 *
 * ## Menu model
 *
 * `connectionActions` / `connectionRows` are the pure model of the connection
 * menu that the Overview chip opens (S11): Reconectar, Cambiar de conexión,
 * Agregar otro dispositivo — each one either really works or says the real
 * reason it cannot, never a disabled button with no explanation.
 */

import { normalizeHostFingerprint } from './provision.ts';
import { logger } from './logger.ts';

/** AsyncStorage key of the persisted registry (JSON array of records). */
export const CONNECTIONS_STORAGE_KEY = 'gentle-movil:connections';

/** AsyncStorage key of the active connection id. */
export const ACTIVE_CONNECTION_STORAGE_KEY = 'gentle-movil:connections:active';

/** One paired device, as the app persists it. */
export interface ConnectionRecord {
  /** Stable id: `<user>@<host>:<port>`. */
  id: string;
  /** Name the person sees in the connection list. */
  label: string;
  /** LAN IP or hostname of the PC. */
  host: string;
  /** SSH port (22 when the QR omitted it). */
  port: number;
  /** SSH user on the PC. */
  user: string;
  /** Host ed25519 SHA-256 fingerprint (64 lowercase hex, no separators). */
  fingerprint: string;
  /** Fingerprint of the phone key the PC accepted (`''` when unknown). */
  deviceKeyFingerprint: string;
  /** ISO-8601 instant of the pairing that first added this device. */
  addedAt: string;
}

/** Routing facts of a pairing (`PairInfo` satisfies it). */
export interface PairingFacts {
  host: string;
  port: number;
  user: string;
  /** Host fingerprint the QR carried (any display form). */
  fp: string;
}

/** Storage surface this module needs (AsyncStorage satisfies it). */
export interface ConnectionsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Log surface this module needs (`logger.tag('connections')` satisfies it). */
export interface ConnectionsLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Default sink for the app: one tag, one ring, one log file. */
export const connectionsLog: ConnectionsLog = logger.tag('connections');

/** Field names a stored record must never carry (the SSH password lives nowhere here). */
const SECRET_FIELDS: readonly string[] = ['pw', 'password', 'passphrase', 'secret', 'token'];

/** Minimum and maximum SSH port a record can hold. */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * Strict parser of one stored record. Returns `null` for anything that cannot
 * route a reconnect: a missing/blank field, a port that is not a real SSH port,
 * a fingerprint that is not 64 hex, or an `addedAt` that is not a date.
 *
 * The record is **rebuilt** from the known fields, so unknown fields (and any
 * secret a previous build might have written) never survive a read.
 */
export function parseConnectionRecord(value: unknown): ConnectionRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;

  const id = textOrNull(raw.id);
  const label = textOrNull(raw.label);
  const host = textOrNull(raw.host);
  const user = textOrNull(raw.user);
  const fingerprint = typeof raw.fingerprint === 'string' ? normalizeHostFingerprint(raw.fingerprint) : null;
  const port = raw.port;
  const addedAt = textOrNull(raw.addedAt);
  const deviceKeyFingerprint = typeof raw.deviceKeyFingerprint === 'string' ? raw.deviceKeyFingerprint.trim() : null;

  if (id === null || label === null || host === null || user === null) {
    return null;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return null;
  }
  if (fingerprint === null) {
    return null;
  }
  if (deviceKeyFingerprint === null) {
    return null;
  }
  if (addedAt === null || Number.isNaN(Date.parse(addedAt))) {
    return null;
  }

  return {
    id,
    label,
    host,
    port,
    user,
    fingerprint,
    deviceKeyFingerprint,
    addedAt: new Date(addedAt).toISOString(),
  };
}

/** Outcome of reading the registry. */
export interface ReadConnectionsResult {
  /** False when the store itself could not be read (NOT "no connections"). */
  ok: boolean;
  /** Every record that parsed strictly, in stored order. */
  records: ConnectionRecord[];
  /** True when something had to be dropped or the payload was not a list. */
  repaired: boolean;
}

/**
 * Reads the registry. A payload that is not a JSON array, or entries that do not
 * parse, are repaired honestly: the valid records are returned and each
 * rejection is logged with its raw evidence. An unreadable store is `ok: false`.
 */
export async function readConnections(
  storage: ConnectionsStorage,
  log: ConnectionsLog = connectionsLog,
): Promise<ReadConnectionsResult> {
  let raw: string | null;
  try {
    raw = await storage.getItem(CONNECTIONS_STORAGE_KEY);
  } catch (error) {
    log.failure('read-connections', error, { key: CONNECTIONS_STORAGE_KEY });
    return { ok: false, records: [], repaired: false };
  }

  if (raw === null) {
    return { ok: true, records: [], repaired: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.failure('parse-connections', error, { key: CONNECTIONS_STORAGE_KEY, raw });
    return { ok: true, records: [], repaired: true };
  }

  if (!Array.isArray(parsed)) {
    log.failure(
      'parse-connections',
      new Error('las conexiones guardadas no son una lista'),
      { key: CONNECTIONS_STORAGE_KEY, raw },
    );
    return { ok: true, records: [], repaired: true };
  }

  const records: ConnectionRecord[] = [];
  let repaired = false;
  const seen = new Set<string>();

  parsed.forEach((entry, index) => {
    const record = parseConnectionRecord(entry);
    if (record === null) {
      repaired = true;
      log.failure(
        'parse-connection',
        new Error('la conexión guardada no tiene los datos que necesita una reconexión'),
        { index, entry: entry ?? null },
      );
      return;
    }
    if (seen.has(record.id)) {
      repaired = true;
      log.failure(
        'parse-connection',
        new Error('la conexión guardada está repetida'),
        { index, id: record.id },
      );
      return;
    }
    seen.add(record.id);
    records.push(record);

    if (entry !== null && typeof entry === 'object') {
      const leaked = SECRET_FIELDS.filter((field) => field in (entry as Record<string, unknown>));
      if (leaked.length > 0) {
        log.warn('la conexión guardada traía una contraseña: no se conserva', {
          index,
          id: record.id,
          fields: leaked,
        });
      }
    }
  });

  return { ok: true, records, repaired };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Persists the registry. Returns whether the write really happened: a refused
 * write is logged with `{step, error, raw}` and reported as `false`, so no
 * caller can believe a connection was saved when it was not.
 */
export async function writeConnections(
  storage: ConnectionsStorage,
  records: readonly ConnectionRecord[],
  log: ConnectionsLog = connectionsLog,
): Promise<boolean> {
  try {
    await storage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch (error) {
    log.failure('persist-connections', error, { key: CONNECTIONS_STORAGE_KEY, count: records.length });
    return false;
  }
}

/** Outcome of adding/updating one record. */
export interface AddConnectionResult {
  /** Whether the registry was really written. */
  ok: boolean;
  records: ConnectionRecord[];
  /** True when an existing record of the same id was updated in place. */
  replaced: boolean;
}

/** Stable id of a device: `<user>@<host>:<port>`. */
export function connectionId(facts: { host: string; port: number; user: string }): string {
  return `${facts.user}@${facts.host}:${facts.port}`;
}

/** Default name of a device: `<user>@<host>` (the port rides in the row detail). */
export function connectionLabel(record: Pick<ConnectionRecord, 'host' | 'user'>): string {
  return `${record.user}@${record.host}`;
}

/** `aaaa…aaaa`: enough of a fingerprint to recognise it, never all 64 chars. */
export function shortFingerprint(fingerprint: string): string {
  const text = fingerprint.trim();
  if (text.length <= 8) {
    return text;
  }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/**
 * Record of a successful pairing. Returns `null` (never a half record) when the
 * pairing facts cannot route a reconnect; the SSH password and the one-time
 * invite token are **not** copied, whatever the pairing object carries.
 */
export function recordFromPair(
  facts: PairingFacts,
  deviceKeyFingerprint = '',
  now: number = Date.now(),
): ConnectionRecord | null {
  const host = textOrNull(facts?.host);
  const user = textOrNull(facts?.user);
  const port = facts?.port;
  const fingerprint = typeof facts?.fp === 'string' ? normalizeHostFingerprint(facts.fp) : null;

  if (host === null || user === null || fingerprint === null) {
    return null;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return null;
  }

  const id = connectionId({ host, port, user });
  return {
    id,
    label: connectionLabel({ host, user }),
    host,
    port,
    user,
    fingerprint,
    deviceKeyFingerprint: typeof deviceKeyFingerprint === 'string' ? deviceKeyFingerprint.trim() : '',
    addedAt: new Date(now).toISOString(),
  };
}

/**
 * Adds a record, or updates the one with the same id in place. An update keeps
 * the original `addedAt` (that date belongs to the first pairing of the device)
 * and the original position, so the list does not shuffle under the person.
 */
export async function addConnection(
  storage: ConnectionsStorage,
  record: ConnectionRecord,
  log: ConnectionsLog = connectionsLog,
): Promise<AddConnectionResult> {
  const read = await readConnections(storage, log);
  if (!read.ok) {
    return { ok: false, records: read.records, replaced: false };
  }

  const index = read.records.findIndex((entry) => entry.id === record.id);
  let records: ConnectionRecord[];
  let replaced = false;
  if (index >= 0) {
    const previous = read.records[index] as ConnectionRecord;
    records = read.records.slice();
    records[index] = { ...record, addedAt: previous.addedAt };
    replaced = true;
  } else {
    records = [...read.records, record];
  }

  const ok = await writeConnections(storage, records, log);
  log.info(replaced ? 'conexión actualizada' : 'conexión guardada', {
    id: record.id,
    host: record.host,
    port: record.port,
    user: record.user,
    stored: ok,
  });
  return { ok, records: ok ? records : read.records, replaced };
}

/** Outcome of removing one record. */
export interface RemoveConnectionResult {
  ok: boolean;
  records: ConnectionRecord[];
  removed: boolean;
  /** True when the removed record was the active one and its id was cleared. */
  activeCleared: boolean;
}

/**
 * Removes one record. When it was the active one, the active key is cleared
 * (the id is not left pointing at a device that no longer exists). An id that
 * is not in the registry is logged and reported as `removed: false`.
 */
export async function removeConnection(
  storage: ConnectionsStorage,
  id: string,
  log: ConnectionsLog = connectionsLog,
): Promise<RemoveConnectionResult> {
  const read = await readConnections(storage, log);
  if (!read.ok) {
    return { ok: false, records: read.records, removed: false, activeCleared: false };
  }

  const found = read.records.some((entry) => entry.id === id);
  if (!found) {
    log.failure('remove-connection', new Error('esa conexión no está guardada'), { id });
    return { ok: true, records: read.records, removed: false, activeCleared: false };
  }

  const records = read.records.filter((entry) => entry.id !== id);
  const ok = await writeConnections(storage, records, log);
  if (!ok) {
    return { ok: false, records: read.records, removed: false, activeCleared: false };
  }

  const active = await readActiveId(storage, log);
  let activeCleared = false;
  if (active === id) {
    activeCleared = await clearActiveId(storage, log);
  }
  log.info('conexión borrada', { id, activeCleared, stored: records.length });
  return { ok: true, records, removed: true, activeCleared };
}

/** Outcome of marking a record active. */
export interface SetActiveResult {
  ok: boolean;
  active: ConnectionRecord | null;
  /** Real reason it could not be activated (`null` on success). */
  reason: string | null;
}

/** Reason shown when the id the caller asked for is not in the registry. */
export const UNKNOWN_CONNECTION_REASON = 'esa conexión no está guardada en este teléfono';

/**
 * Marks one saved record as active. An id that is not in the registry is
 * refused with its real reason — activating a device the app cannot name would
 * make the boot gate reconnect to nothing.
 */
export async function setActiveConnection(
  storage: ConnectionsStorage,
  id: string,
  log: ConnectionsLog = connectionsLog,
): Promise<SetActiveResult> {
  const read = await readConnections(storage, log);
  if (!read.ok) {
    return { ok: false, active: null, reason: 'no se pudo leer las conexiones guardadas' };
  }
  const record = read.records.find((entry) => entry.id === id) ?? null;
  if (record === null) {
    log.failure('set-active-connection', new Error(UNKNOWN_CONNECTION_REASON), { id });
    return { ok: false, active: null, reason: UNKNOWN_CONNECTION_REASON };
  }
  try {
    await storage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, record.id);
  } catch (error) {
    log.failure('persist-active-connection', error, { key: ACTIVE_CONNECTION_STORAGE_KEY, id });
    return { ok: false, active: null, reason: 'el teléfono no dejó guardar la conexión activa' };
  }
  log.info('conexión activa', { id: record.id, host: record.host, port: record.port, user: record.user });
  return { ok: true, active: record, reason: null };
}

/* ------------------------------------------------------------------ *
 * Active id
 * ------------------------------------------------------------------ */

/** The record `activeId` names, or `null` when there is none / it is dangling. */
export function activeConnection(
  records: readonly ConnectionRecord[],
  activeId: string | null,
): ConnectionRecord | null {
  if (activeId === null || activeId.trim() === '') {
    return null;
  }
  return records.find((record) => record.id === activeId) ?? null;
}

async function readActiveId(
  storage: ConnectionsStorage,
  log: ConnectionsLog,
): Promise<string | null> {
  try {
    const raw = await storage.getItem(ACTIVE_CONNECTION_STORAGE_KEY);
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text === '' ? null : text;
  } catch (error) {
    log.failure('read-active-connection', error, { key: ACTIVE_CONNECTION_STORAGE_KEY });
    return null;
  }
}

async function clearActiveId(storage: ConnectionsStorage, log: ConnectionsLog): Promise<boolean> {
  try {
    await storage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY);
    return true;
  } catch (error) {
    log.failure('clear-active-connection', error, { key: ACTIVE_CONNECTION_STORAGE_KEY });
    return false;
  }
}

/** Outcome of reading the registry plus its active record. */
/** Outcome of persisting the pairing that just succeeded. */
export interface RememberPairingResult {
  ok: boolean;
  id: string | null;
  /** Why it could not be remembered, when it could not (honest, no fallback). */
  reason: string | null;
}

/**
 * Persist a pairing that just succeeded and mark it active (S11/S12).
 *
 * This is the only writer of the registry on the pairing path: without it the
 * app would keep asking for the onboarding on every launch, because a flag
 * without a connection is not a connection.
 */
export async function rememberPairing(
  storage: ConnectionsStorage,
  facts: PairingFacts,
  options: { deviceKeyFingerprint?: string; log?: ConnectionsLog; now?: number } = {},
): Promise<RememberPairingResult> {
  const log = options.log ?? connectionsLog;
  const record = recordFromPair(facts, options.deviceKeyFingerprint ?? '', options.now);
  if (record === null) {
    const reason = 'el QR no traía host, puerto, usuario y huella válidos';
    log.failure('remember-pairing', new Error(reason), {
      host: facts?.host,
      port: facts?.port,
      user: facts?.user,
    });
    return { ok: false, id: null, reason };
  }

  const added = await addConnection(storage, record, log);
  if (!added.ok) {
    return { ok: false, id: null, reason: 'no se pudo guardar la conexión en este teléfono' };
  }

  const active = await setActiveConnection(storage, record.id, log);
  if (!active.ok) {
    return { ok: false, id: record.id, reason: active.reason };
  }

  log.info('connection remembered', { id: record.id, host: record.host, port: record.port });
  return { ok: true, id: record.id, reason: null };
}

export interface ReadActiveResult {
  ok: boolean;
  records: ConnectionRecord[];
  active: ConnectionRecord | null;
  /** True when the stored payload had to be repaired (damaged or not a list). */
  repaired: boolean;
}

/**
 * Reads the registry and its active record together (what the boot gate needs).
 *
 * A dangling active id — the record was removed, or the pair of keys got out of
 * sync — never resolves to another device: it is cleared, logged, and reported
 * as `active: null` so the boot gate can say the truth instead of connecting to
 * whatever happens to be first in the list.
 */
export async function readActiveConnection(
  storage: ConnectionsStorage,
  log: ConnectionsLog = connectionsLog,
): Promise<ReadActiveResult> {
  const read = await readConnections(storage, log);
  if (!read.ok) {
    return { ok: false, records: read.records, active: null, repaired: read.repaired };
  }

  const activeId = await readActiveId(storage, log);
  if (activeId === null) {
    return { ok: true, records: read.records, active: null, repaired: read.repaired };
  }

  const active = activeConnection(read.records, activeId);
  if (active === null) {
    log.failure(
      'read-active-connection',
      new Error('la conexión activa no está en la lista guardada'),
      { id: activeId, saved: read.records.map((record) => record.id) },
    );
    await clearActiveId(storage, log);
    return { ok: true, records: read.records, active: null, repaired: read.repaired };
  }

  return { ok: true, records: read.records, active, repaired: read.repaired };
}

/* ------------------------------------------------------------------ *
 * Connection menu model (S11)
 * ------------------------------------------------------------------ */

/** Why Reconectar cannot run: no saved device at all. */
export const NO_SAVED_CONNECTION_REASON =
  'no hay ninguna conexión guardada: emparejá un dispositivo';

/** Why Cambiar de conexión cannot run: there is only one device. */
export const NO_OTHER_CONNECTION_REASON =
  'no hay otra conexión guardada: emparejá otro dispositivo para cambiar';

/** Why Reconectar cannot run: records exist but none is active. */
export const NO_ACTIVE_CONNECTION_REASON =
  'ninguna conexión guardada está marcada como activa: elegí una en la lista';

/** The three real actions of the connection menu. */
export type ConnectionActionId = 'reconnect' | 'switch' | 'add-device';

/** One menu action, with the real reason it cannot run. */
export interface ConnectionAction {
  id: ConnectionActionId;
  label: string;
  enabled: boolean;
  /** Real reason when `enabled` is false; `null` when the action works. */
  reason: string | null;
}

/**
 * The menu S11 asks for, derived from what is really saved: Reconectar (the
 * active device), Cambiar de conexión (pick among the saved ones) and Agregar
 * otro dispositivo (the onboarding, which never deletes what is saved).
 */
export function connectionActions(
  records: readonly ConnectionRecord[],
  active: ConnectionRecord | null,
): ConnectionAction[] {
  const nothingSaved = records.length === 0;
  const noOther = records.length < 2;

  const reconnectReason = nothingSaved
    ? NO_SAVED_CONNECTION_REASON
    : active === null
      ? NO_ACTIVE_CONNECTION_REASON
      : null;

  return [
    {
      id: 'reconnect',
      label: 'Reconectar',
      enabled: reconnectReason === null,
      reason: reconnectReason,
    },
    {
      id: 'switch',
      label: 'Cambiar de conexión',
      enabled: !nothingSaved && !noOther,
      reason: nothingSaved ? NO_SAVED_CONNECTION_REASON : noOther ? NO_OTHER_CONNECTION_REASON : null,
    },
    {
      id: 'add-device',
      label: 'Agregar otro dispositivo',
      enabled: true,
      reason: null,
    },
  ];
}

/** One row of the saved-device list. */
export interface ConnectionRow {
  id: string;
  label: string;
  /** `user@host:port · aaaa…aaaa` — the real routing facts. */
  detail: string;
  active: boolean;
}

/** The saved devices, the active one marked (never re-sorted: stored order). */
export function connectionRows(
  records: readonly ConnectionRecord[],
  activeId: string | null,
): ConnectionRow[] {
  return records.map((record) => ({
    id: record.id,
    label: record.label,
    detail: `${record.user}@${record.host}:${record.port} · ${shortFingerprint(record.fingerprint)}`,
    active: activeId !== null && record.id === activeId,
  }));
}
