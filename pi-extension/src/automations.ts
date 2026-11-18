/**
 * Automations the bridge owns, read from one JSON file.
 *
 * Location: `GENTLE_MOVIL_AUTOMATIONS_FILE`, or
 * `~/.pi/gentle-movil/automations.json` by default. The file is the source of
 * truth — the bridge never schedules anything and never invents a run:
 *
 * ```json
 * {
 *   "automations": [
 *     { "id": "nightly", "name": "Limpieza nocturna", "schedule": "0 3 * * *",
 *       "enabled": true,
 *       "lastRun": { "at": "2026-11-18T03:00:00.000Z", "ok": true, "summary": "ok" },
 *       "nextRun": "2026-11-19T03:00:00.000Z",
 *       "steps": ["bun run lint"] }
 *   ]
 * }
 * ```
 *
 * Honest outcomes, the same rule the rest of the bridge follows:
 *  - a missing file is `{automations: []}` (nothing configured, not an error);
 *  - invalid JSON, an unreadable file or an entry with the wrong shape is a 500
 *    carrying the real reason — never an empty list that would read as "you
 *    have no automations";
 *  - `lastRun` / `nextRun` default to `null` only when the file omits them.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Environment variable that overrides the automations file path. */
export const AUTOMATIONS_FILE_ENV = "GENTLE_MOVIL_AUTOMATIONS_FILE";

/** Ceiling of the file we are willing to parse. */
export const MAX_AUTOMATIONS_BYTES = 1024 * 1024;

export interface AutomationRun {
  at: string;
  ok: boolean;
  summary: string | null;
}

export interface Automation {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRun: AutomationRun | null;
  nextRun: string | null;
  /** Steps of the editor payload, present only when the file declares them. */
  steps?: string[];
}

export type AutomationsResult =
  | { ok: true; automations: Automation[] }
  | { ok: false; code: "automations_unreadable"; message: string };

/** `~/.pi/gentle-movil/automations.json`, or the path the environment names. */
export function defaultAutomationsFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[AUTOMATIONS_FILE_ENV];
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  const home = env.HOME ?? safeHome();
  return home === null ? null : join(home, ".pi", "gentle-movil", "automations.json");
}

function safeHome(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

function unreadable(message: string): AutomationsResult {
  return { ok: false, code: "automations_unreadable", message };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
}

/** One `lastRun` entry, `null` when absent or explicitly null. */
function parseRun(value: unknown, where: string): AutomationRun | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return `${where}.lastRun is not an object`;
  const record = value as Record<string, unknown>;
  if (!isTimestamp(record.at)) return `${where}.lastRun.at is not an ISO-8601 timestamp`;
  if (typeof record.ok !== "boolean") return `${where}.lastRun.ok is not a boolean`;
  if (record.summary !== undefined && record.summary !== null && typeof record.summary !== "string") {
    return `${where}.lastRun.summary is neither a string nor null`;
  }
  return { at: record.at, ok: record.ok, summary: typeof record.summary === "string" ? record.summary : null };
}

/** One automation entry, or the sentence that says why it is unusable. */
function parseAutomation(value: unknown, where: string): Automation | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `${where} is not an object`;
  const record = value as Record<string, unknown>;
  if (!isText(record.id)) return `${where}.id is not a non-empty string`;
  if (!isText(record.name)) return `${where}.name is not a non-empty string`;
  if (!isText(record.schedule)) return `${where}.schedule is not a non-empty string`;
  if (typeof record.enabled !== "boolean") return `${where}.enabled is not a boolean`;

  const run = parseRun(record.lastRun, where);
  if (typeof run === "string") return run;

  let nextRun: string | null = null;
  if (record.nextRun !== undefined && record.nextRun !== null) {
    if (!isTimestamp(record.nextRun)) return `${where}.nextRun is not an ISO-8601 timestamp`;
    nextRun = record.nextRun;
  }

  const automation: Automation = {
    id: record.id,
    name: record.name,
    schedule: record.schedule,
    enabled: record.enabled,
    lastRun: run,
    nextRun,
  };

  if (record.steps !== undefined && record.steps !== null) {
    if (!Array.isArray(record.steps)) return `${where}.steps is not an array`;
    const steps: string[] = [];
    for (const [index, step] of record.steps.entries()) {
      if (typeof step !== "string") return `${where}.steps[${index}] is not a string`;
      if (step.trim() !== "") steps.push(step.trim());
    }
    automation.steps = steps;
  }

  return automation;
}

/**
 * Reads and validates the automations file.
 *
 * A missing path is an empty list; every other problem is reported with the
 * real reason (including the `JSON.parse` complaint) so the phone can show it
 * instead of a silent "no automations".
 */
export function readAutomations(file: string | null): AutomationsResult {
  if (file === null) return { ok: true, automations: [] };
  if (!existsSync(file)) return { ok: true, automations: [] };

  let raw: string;
  try {
    if (!statSync(file).isFile()) return unreadable(`${file} is not a regular file`);
    if (statSync(file).size > MAX_AUTOMATIONS_BYTES) {
      return unreadable(`${file} is larger than ${MAX_AUTOMATIONS_BYTES} bytes`);
    }
    raw = readFileSync(file, "utf8");
  } catch (error) {
    return unreadable(`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unreadable(`${file} is not valid JSON: ${detail}`);
  }

  // The file is a wrapper `{automations: [...]}`; a bare array is refused
  // instead of guessed, so a mistyped file never reads as an empty list.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadable(`${file} must contain a {"automations": [...]} object`);
  }
  const list = (parsed as Record<string, unknown>).automations;
  if (!Array.isArray(list)) return unreadable(`${file} has no "automations" array`);

  const automations: Automation[] = [];
  for (const [index, entry] of list.entries()) {
    const candidate = parseAutomation(entry, `automations[${index}]`);
    if (typeof candidate === "string") return unreadable(`${file}: ${candidate}`);
    automations.push(candidate);
  }
  return { ok: true, automations };
}

/** One automation by id, or null when the file does not declare it. */
export function findAutomation(automations: Automation[], id: string): Automation | null {
  return automations.find((automation) => automation.id === id) ?? null;
}
