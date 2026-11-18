/**
 * V10 + V11 — Automations tests (artboards
 * `design/mobile-app-core/05-automations.html` /
 * `06-automation-editor.html`, `docs/mobile-views-plan.md` §V10/§V11).
 *
 * `lib/automations.ts` reads the REAL bridge over the SSH tunnel
 * (`GET /api/automations`, protocol §4). Every case here speaks the real
 * HTTP/1.1 wire format through a fake channel (same helpers as
 * `mobile/test/git.test.mjs`) and pins:
 *
 * - the strict payload parse and the enabled / paused split of §V10;
 * - the next-run order inside each section, the countdown copy and the
 *   last-run tone (ok / fail);
 * - the schedule parser: cron-ish, interval, `disabled`, and the honest
 *   `Programación no reconocida` fallback that never guesses;
 * - the §V11 editor model: typed per-field errors, the dirty diff against the
 *   original automation and the `pending: true` save intent;
 * - one honest state per outcome (`loading | empty | success | stale |
 *   offline | error`) — an extension that does not expose the endpoint yet is
 *   an ERROR carrying the failure, never an empty "no automations" success.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utf8Encode } from '../lib/core.ts';
import {
  AUTOMATIONS_PATH,
  AutomationsCache,
  EMPTY_COPY,
  ERROR_TITLE,
  MISSING_ENDPOINT_COPY,
  OFFLINE_COPY,
  SCHEDULE_UNKNOWN_COPY,
  TOGGLE_PENDING_NOTE,
  automationRoute,
  buildAutomationsView,
  buildEditorView,
  countdownLabel,
  draftDiff,
  draftFromAutomation,
  emptyDraft,
  loadAutomation,
  loadAutomations,
  parseAutomations,
  parseSchedule,
  saveIntent,
  validateDraft,
} from '../lib/automations.ts';

/** A full HTTP/1.1 response in one frame (the peer closes right after). */
function okChannel(body, status = 200) {
  const wire = `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
  return {
    async write() {
      return 1;
    },
    async read() {
      return { bytes: utf8Encode(wire), eof: true };
    },
    async close() {},
  };
}

/** Raw bytes on the wire, for malformed answers. */
function rawChannel(text) {
  return {
    async write() {
      return 1;
    },
    async read() {
      return { bytes: utf8Encode(text), eof: true };
    },
    async close() {},
  };
}

/** Tunnel that is up but never answers (the timeout path). */
function silentChannel() {
  return {
    async write() {
      return 1;
    },
    read: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 50),
      ),
    async close() {},
  };
}

/** Tunnel that refuses the write (the core reports no channel). */
function refusedChannel() {
  return {
    async write() {
      return 0;
    },
    async read() {
      return { bytes: new Uint8Array(), eof: true };
    },
    async close() {},
  };
}

/** Records the request line the module wrote, so the path is pinned. */
function recordingChannel(body, status = 200) {
  const channel = okChannel(body, status);
  const writes = [];
  const write = channel.write;
  channel.write = async (payload) => {
    writes.push(new TextDecoder().decode(payload));
    return write(payload);
  };
  channel.writes = writes;
  return channel;
}

/** Collects the `{step, error, raw}` failures instead of hitting the file sink. */
function collectingLogger() {
  const failures = [];
  return {
    failures,
    failure(step, error, raw) {
      failures.push({ step, error, raw });
    },
  };
}

/** Fixed clock of every ordering/countdown case. */
const NOW = Date.parse('2026-11-18T12:00:00.000Z');

const auto = (id, name, schedule, enabled, lastRun = null, nextRun = null) => ({
  id,
  name,
  schedule,
  enabled,
  lastRun,
  nextRun,
});

const PAYLOAD = {
  automations: [
    auto(
      'a1',
      'Briefing diario',
      '0 8 * * *',
      true,
      { at: '2026-11-18T02:00:00.000Z', ok: true, summary: 'briefing listo' },
      '2026-11-19T11:00:00.000Z',
    ),
    auto(
      'a2',
      'PR review nocturno',
      '0 23 * * 1-5',
      false,
      { at: '2026-11-17T20:00:00.000Z', ok: false, summary: 'falló el merge' },
      null,
    ),
    auto(
      'a3',
      'Resumen de cambios',
      'every 30m',
      true,
      { at: '2026-11-18T11:30:00.000Z', ok: true, summary: 'resumen' },
      '2026-11-18T12:45:00.000Z',
    ),
    auto('a4', 'Tests de gentle-movil', '*/15 * * * *', true, null, '2026-11-19T02:14:00.000Z'),
  ],
};

const ids = (rows) => rows.map((row) => row.id);

test('AUTOMATIONS_PATH is the endpoint the bridge is expected to expose (protocol §4)', () => {
  assert.equal(AUTOMATIONS_PATH, '/api/automations');
});

test('(a) a real payload splits enabled and paused automations, with honest counts', async () => {
  const channel = recordingChannel(PAYLOAD);
  const state = await loadAutomations(channel, { logger: collectingLogger() });
  assert.equal(state.kind, 'success');
  assert.match(channel.writes[0], /^GET \/api\/automations HTTP\/1\.1/);

  const vm = buildAutomationsView(state, NOW);
  assert.equal(vm.state, 'success');
  assert.deepEqual(vm.counts, { all: 4, enabled: 3, disabled: 1 });
  assert.equal(vm.summary, '4 definiciones · 3 activas · 1 pausada');

  assert.deepEqual(
    vm.sections.map((section) => [section.id, section.title, ids(section.rows)]),
    [
      ['enabled', 'Programadas', ['a3', 'a4', 'a1']],
      ['disabled', 'Pausadas', ['a2']],
    ],
  );

  // The row carries the human schedule, the state label and the switch label.
  const [first] = vm.sections[0].rows;
  assert.equal(first.name, 'Resumen de cambios');
  assert.equal(first.schedule, 'every 30m');
  assert.equal(first.scheduleLabel, 'Cada 30 min');
  assert.equal(first.enabled, true);
  assert.equal(first.stateLabel, 'Activa');
  assert.equal(first.route, '/automation-editor?id=a3');
  assert.equal(automationRoute('a3'), '/automation-editor?id=a3');
  assert.equal(vm.sections[1].rows[0].stateLabel, 'Pausada');
});

test('(a) parseAutomations refuses incomplete entries instead of inventing rows', () => {
  for (const bad of [
    { id: '', name: 'x', schedule: '0 9 * * *', enabled: true, lastRun: null, nextRun: null },
    { id: 'a', schedule: '0 9 * * *', enabled: true, lastRun: null, nextRun: null },
    { id: 'a', name: 'x', enabled: true, lastRun: null, nextRun: null },
    { id: 'a', name: 'x', schedule: '0 9 * * *', enabled: 'yes', lastRun: null, nextRun: null },
    { id: 'a', name: 'x', schedule: '0 9 * * *', enabled: true, lastRun: { at: 'nope', ok: true, summary: null }, nextRun: null },
    { id: 'a', name: 'x', schedule: '0 9 * * *', enabled: true, lastRun: null, nextRun: 'mañana' },
    { id: 'a', name: 'x', schedule: '0 9 * * *', enabled: true },
  ]) {
    const parsed = parseAutomations({ automations: [bad] });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.message, 'La PC devolvió automatizaciones incompletas.');
    assert.match(parsed.raw, /\"id\"|\"name\"|\"schedule\"|\"enabled\"|\"lastRun\"|\"nextRun\"/);
  }
  assert.equal(parseAutomations({}).ok, false);
  assert.equal(parseAutomations(null).ok, false);
  const empty = parseAutomations({ automations: [] });
  assert.deepEqual(empty, { ok: true, payload: { automations: [] } });
});

test('(b) each section is ordered by next run, soonest first, unknown last', async () => {
  const state = await loadAutomations(
    okChannel({
      automations: [
        auto('late', 'Tarde', '0 20 * * *', true, null, '2026-11-18T20:00:00.000Z'),
        auto('none', 'Sin próxima', '0 20 * * *', true, null, null),
        auto('soon', 'Pronto', '0 20 * * *', true, null, '2026-11-18T12:10:00.000Z'),
        auto('paused-b', 'Pausada B', '0 20 * * *', false, null, null),
        auto('paused-a', 'Pausada A', '0 20 * * *', false, null, null),
      ],
    }),
    { logger: collectingLogger() },
  );
  const vm = buildAutomationsView(state, NOW);
  assert.deepEqual(ids(vm.sections[0].rows), ['soon', 'late', 'none']);
  // Paused rows have no next run: the name keeps the order stable.
  assert.deepEqual(ids(vm.sections[1].rows), ['paused-a', 'paused-b']);
});

test('(b) countdown copy is derived from the real next-run timestamp', async () => {
  const state = await loadAutomations(okChannel(PAYLOAD), { logger: collectingLogger() });
  const vm = buildAutomationsView(state, NOW);
  const byId = new Map(vm.sections.flatMap((s) => s.rows).map((row) => [row.id, row]));

  assert.equal(byId.get('a3').nextRunLabel, 'Próxima en 45 min');
  assert.equal(byId.get('a1').nextRunLabel, 'Próxima en 23 h');
  assert.equal(byId.get('a4').nextRunLabel, 'Próxima en 14 h 14 min');
  assert.equal(byId.get('a2').nextRunLabel, 'Pausada · sin próxima ejecución');

  assert.equal(countdownLabel(null, true, NOW), 'Sin próxima ejecución');
  assert.equal(countdownLabel(null, false, NOW), 'Pausada · sin próxima ejecución');
  assert.equal(countdownLabel('2026-11-18T11:55:00.000Z', true, NOW), 'Próxima vencida hace 5 min');
  assert.equal(countdownLabel('2026-11-18T12:00:30.000Z', true, NOW), 'Próxima en menos de 1 min');
  assert.equal(countdownLabel('2026-11-20T12:00:00.000Z', true, NOW), 'Próxima en 2 días');
});

test('(c) the last-run chip shows ok / fail tone from the real evidence', async () => {
  const state = await loadAutomations(okChannel(PAYLOAD), { logger: collectingLogger() });
  const vm = buildAutomationsView(state, NOW);
  const byId = new Map(vm.sections.flatMap((s) => s.rows).map((row) => [row.id, row]));

  assert.deepEqual(byId.get('a1').lastRun, { label: 'ok · hace 10 horas', tone: 'ok' });
  assert.deepEqual(byId.get('a2').lastRun, { label: 'falló hace 16 horas', tone: 'fail' });
  assert.deepEqual(byId.get('a3').lastRun, { label: 'ok · hace 30 min', tone: 'ok' });
  // Never ran: no chip at all, instead of an invented "ok".
  assert.equal(byId.get('a4').lastRun, null);
});

test('(d) schedules are parsed and humanized, never guessed', () => {
  const cases = [
    ['*/15 * * * *', 'cron', 'Cada 15 min'],
    ['0 9 * * 1-5', 'cron', 'Lunes a viernes a las 09:00'],
    ['0 9 * * *', 'cron', 'Todos los días a las 09:00'],
    ['30 8 * * 1', 'cron', 'Los lunes a las 08:30'],
    ['0 9 * * 0', 'cron', 'Los domingos a las 09:00'],
    ['0 18 * * 1,3,5', 'cron', 'Lunes, miércoles y viernes a las 18:00'],
    ['0 18 * * 0,6', 'cron', 'Sábados y domingos a las 18:00'],
    ['5 * * * *', 'cron', 'Cada hora a los :05'],
    ['* * * * *', 'cron', 'Cada minuto'],
    ['every 30m', 'interval', 'Cada 30 min'],
    ['  Every   2h ', 'interval', 'Cada 2 horas'],
    ['every 1d', 'interval', 'Cada 1 día'],
    ['disabled', 'disabled', 'Desactivada'],
  ];
  for (const [input, kind, label] of cases) {
    const parsed = parseSchedule(input);
    assert.equal(parsed.kind, kind, input);
    assert.equal(parsed.label, label, input);
    assert.equal(parsed.known, true, input);
  }

  for (const input of [
    'todos los lunes a las 9',
    'cada día a las 8',
    '0 25 * * *',
    '*/0 * * * *',
    '5/10 * * * *',
    '0 9 * * 1-5 2026',
    '0 0 1 * *',
    'every 0m',
    'every 30',
    '',
    '   ',
  ]) {
    const parsed = parseSchedule(input);
    assert.equal(parsed.kind, 'unknown', input);
    assert.equal(parsed.label, SCHEDULE_UNKNOWN_COPY, input);
    assert.equal(parsed.known, false, input);
  }
  assert.equal(SCHEDULE_UNKNOWN_COPY, 'Programación no reconocida');
});

test('(e) the editor validates name, schedule and steps per field', () => {
  const invalid = validateDraft({ name: '   ', schedule: 'cada día a las 8', steps: ['   '] });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors.name, {
    code: 'name-required',
    message: 'El nombre no puede estar vacío.',
  });
  assert.deepEqual(invalid.errors.schedule, {
    code: 'schedule-unrecognized',
    message: 'No entendimos la expresión. Probá «*/15 * * * *» o «every 30m».',
  });
  assert.deepEqual(invalid.errors.steps, {
    code: 'steps-required',
    message: 'Agregá al menos un paso.',
  });

  const valid = validateDraft({ name: 'Briefing', schedule: '0 8 * * *', steps: ['resumí'] });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, { name: null, schedule: null, steps: null });

  const view = buildEditorView(invalid2(), { automation: null });
  assert.equal(view.name.error.code, 'name-required');
  assert.equal(view.schedule.error.code, 'schedule-unrecognized');
  assert.equal(view.steps.error.code, 'steps-required');
  assert.equal(view.canSave, false);
  assert.equal(view.title, 'Nueva automatización');
});

/** An empty draft with one blank step, used by the (e) view assertions. */
function invalid2() {
  return { name: '', schedule: 'cada día', steps: [' '] };
}

test('(e) the editor preview renders the parsed schedule and the honest fallback', () => {
  const known = buildEditorView(
    { name: 'Briefing', schedule: '0 9 * * 1-5', steps: ['resumí'] },
    { automation: null },
  );
  assert.equal(known.schedule.value, '0 9 * * 1-5');
  assert.equal(known.schedule.label, 'Lunes a viernes a las 09:00');
  assert.equal(known.schedule.recognized, true);
  assert.equal(known.schedule.error, null);
  assert.equal(known.canSave, true);

  const unknown = buildEditorView(
    { name: 'Briefing', schedule: 'todos los lunes', steps: ['resumí'] },
    { automation: null },
  );
  assert.equal(unknown.schedule.label, 'Programación no reconocida');
  assert.equal(unknown.schedule.recognized, false);
  assert.equal(unknown.canSave, false);
});

test('(f) the dirty diff compares the normalized draft against the original', () => {
  const original = {
    id: 'a9',
    name: 'PR review nocturno',
    schedule: '0 23 * * 1-5',
    steps: ['revisá los PRs', 'dejá el veredicto'],
    stepsKnown: true,
  };
  const base = draftFromAutomation(original);
  assert.deepEqual(base, {
    name: 'PR review nocturno',
    schedule: '0 23 * * 1-5',
    steps: ['revisá los PRs', 'dejá el veredicto'],
  });
  assert.deepEqual(draftDiff(base, base), { dirty: false, changed: [] });

  const renamed = { ...base, name: '  PR review  ' };
  assert.deepEqual(draftDiff(renamed, base), { dirty: true, changed: ['name'] });

  const rescheduled = { ...base, schedule: 'every 2h' };
  assert.deepEqual(draftDiff(rescheduled, base), { dirty: true, changed: ['schedule'] });

  const stepped = { ...base, steps: ['revisá los PRs', 'dejá el veredicto', 'avisá'] };
  assert.deepEqual(draftDiff(stepped, base), { dirty: true, changed: ['steps'] });

  // A new automation only counts as dirty once it has something to save.
  assert.deepEqual(draftDiff(emptyDraft(), null), { dirty: false, changed: [] });
  assert.deepEqual(draftDiff({ name: 'x', schedule: '', steps: [] }, null), {
    dirty: true,
    changed: ['name'],
  });
});

test('(g) the save intent is honest: pending, with the route the PC does not serve yet', () => {
  const existing = saveIntent(
    { name: ' PR review ', schedule: '0 23 * * 1-5', steps: ['revisá', ' '] },
    'a9',
  );
  assert.equal(existing.pending, true);
  assert.equal(existing.method, 'PATCH');
  assert.equal(existing.route, '/automations/a9');
  assert.deepEqual(existing.body, {
    name: 'PR review',
    schedule: '0 23 * * 1-5',
    steps: ['revisá'],
  });
  assert.match(existing.note, /\/automations\/a9/);

  const created = saveIntent({ name: 'Nueva', schedule: 'every 30m', steps: ['paso'] }, null);
  assert.equal(created.pending, true);
  assert.equal(created.method, 'POST');
  assert.equal(created.route, '/automations');
  assert.match(created.note, /POST \/automations/);

  // The editor view carries the same intent, and only allows it when valid + dirty.
  const draft = { name: 'Nueva', schedule: 'every 30m', steps: ['paso'] };
  const view = buildEditorView(draft, { automation: null });
  assert.equal(view.save.pending, true);
  assert.equal(view.dirty, true);
  assert.equal(view.canSave, true);
  assert.equal(view.saveLabel, 'Guardar');

  const pristine = buildEditorView(emptyDraft(), { automation: null });
  assert.equal(pristine.dirty, false);
  assert.equal(pristine.canSave, false);
  assert.equal(pristine.discardPrompt, 'Descartar cambios?');
});

test('(g) editing an automation the PC reported without steps says so instead of inventing them', () => {
  const view = buildEditorView(
    { name: 'Vieja', schedule: '0 8 * * *', steps: [] },
    { automation: { id: 'a1', name: 'Vieja', schedule: '0 8 * * *', steps: [], stepsKnown: false } },
  );
  assert.equal(view.title, 'Editar automatización');
  assert.equal(view.meta, 'Vieja · se guarda en tu PC');
  assert.equal(view.stepsHint, 'La PC no informó los pasos de esta automatización.');
  assert.equal(view.steps.error.code, 'steps-required');
  assert.equal(view.saveLabel, 'Guardar cambios');
});

test('(h) 404 from the bridge is an honest error naming the missing endpoint', async () => {
  const logger = collectingLogger();
  const channel = recordingChannel({ error: 'not found' }, 404);
  const state = await loadAutomations(channel, { logger });

  assert.equal(state.kind, 'error');
  assert.equal(state.message, MISSING_ENDPOINT_COPY);
  assert.equal(state.message, 'La extensión no expone las automatizaciones todavía');
  assert.match(state.raw, /status=404 \/api\/automations/);
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'automations-request');
  assert.equal(logger.failures[0].raw, state.raw);

  const vm = buildAutomationsView(state, NOW);
  assert.equal(vm.state, 'error');
  assert.deepEqual(vm.error, {
    title: ERROR_TITLE,
    message: MISSING_ENDPOINT_COPY,
    raw: state.raw,
  });
  assert.equal(ERROR_TITLE, 'No pudimos cargar automatizaciones');
  // The failure is an error card, never an empty "no automations" screen.
  assert.deepEqual(vm.sections, []);
  assert.equal(vm.emptyMessage, null);
});

test('(h) any other rejected status keeps its own honest message and raw', async () => {
  const logger = collectingLogger();
  const state = await loadAutomations(okChannel({ error: 'boom' }, 500), { logger });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC respondió 500.');
  assert.equal(state.raw, 'status=500 /api/automations');
  assert.equal(logger.failures.at(0).raw, 'status=500 /api/automations');
});

test('(i) no tunnel is offline with the §V10 copy, never an empty success', async () => {
  const logger = collectingLogger();
  const state = await loadAutomations(null, { logger });
  assert.equal(state.kind, 'offline');
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'tunnel');

  const vm = buildAutomationsView(state, NOW);
  assert.equal(vm.state, 'offline');
  assert.equal(vm.banner, OFFLINE_COPY);
  assert.equal(OFFLINE_COPY, 'Sin conexión — las automatizaciones corren en tu PC.');
  assert.equal(vm.bannerHint, 'Reconectando…');
  assert.deepEqual(vm.sections, []);
  assert.equal(vm.emptyMessage, null);
  assert.equal(vm.togglePending, true);
  assert.equal(vm.toggleNote, TOGGLE_PENDING_NOTE);
  assert.match(TOGGLE_PENDING_NOTE, /una automatización todavía no está conectado/);
});

test('(i) offline after a good answer keeps the cached rows readable and frozen', async () => {
  const cache = new AutomationsCache();
  const logger = collectingLogger();
  const good = await loadAutomations(okChannel(PAYLOAD), { cache, logger });
  assert.equal(good.kind, 'success');

  const state = await loadAutomations(null, { cache, logger });
  assert.equal(state.kind, 'offline');
  const vm = buildAutomationsView(state, NOW);
  assert.equal(vm.frozen, true);
  assert.equal(vm.staleChip, 'Última vez hace 1 min');
  assert.equal(vm.sections.flatMap((s) => s.rows).length, 4);
  assert.equal(vm.banner, OFFLINE_COPY);
});

test('(i) a refused channel write is offline too, not an empty list', async () => {
  const logger = collectingLogger();
  const state = await loadAutomations(refusedChannel(), { logger });
  assert.equal(state.kind, 'offline');
  assert.equal(state.automations, null);
  assert.equal(logger.failures.at(0).step, 'automations-request');
  assert.equal(logger.failures.at(0).raw, 'write=0');
});

test('(j) broken JSON is an error with the raw body prefix, never an empty list', async () => {
  const logger = collectingLogger();
  const state = await loadAutomations(rawChannel('HTTP/1.1 200 OK\r\n\r\n{"automations": ['), {
    logger,
  });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC devolvió un JSON roto.');
  assert.match(state.raw, /\{"automations"/);
  assert.equal(logger.failures.at(0).raw, state.raw);
  assert.equal(buildAutomationsView(state, NOW).error.raw, state.raw);
});

test('(j) a body without an automations array is an error, never an empty list', async () => {
  const state = await loadAutomations(okChannel({ ok: true }), { logger: collectingLogger() });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC devolvió automatizaciones incompletas.');
  assert.match(state.raw, /ok/);
});

test('empty is a real empty PC: the §V10 CTA copy and no invented rows', async () => {
  const cache = new AutomationsCache();
  const state = await loadAutomations(okChannel({ automations: [] }), {
    cache,
    logger: collectingLogger(),
  });
  assert.equal(state.kind, 'empty');
  const vm = buildAutomationsView(state, NOW);
  assert.equal(vm.state, 'empty');
  assert.equal(vm.emptyMessage, EMPTY_COPY);
  assert.equal(EMPTY_COPY, 'Aún no hay automatizaciones.');
  assert.deepEqual(vm.sections, []);
  assert.deepEqual(vm.counts, { all: 0, enabled: 0, disabled: 0 });
  assert.equal(cache.snapshot(), null);
});

test('timeout after a good answer is stale with the cached rows and minutes', async () => {
  const cache = new AutomationsCache();
  const logger = collectingLogger();
  await loadAutomations(okChannel(PAYLOAD), { cache, logger });

  const state = await loadAutomations(silentChannel(), { cache, logger, timeoutMs: 20 });
  assert.equal(state.kind, 'stale');
  const vm = buildAutomationsView(state, NOW);
  assert.equal(vm.state, 'stale');
  assert.equal(vm.staleChip, 'Datos de hace 1 min');
  assert.equal(vm.frozen, true);
  assert.equal(vm.sections.length, 2);
});

test('loading renders skeletons, not an empty list', () => {
  const vm = buildAutomationsView({ kind: 'loading' }, NOW);
  assert.equal(vm.state, 'loading');
  assert.equal(vm.loading, true);
  assert.deepEqual(vm.sections, []);
  assert.equal(vm.emptyMessage, null);
  assert.equal(vm.error, null);
});

test('loadAutomation reads one real automation over the same tunnel', async () => {
  const channel = recordingChannel({
    id: 'a 1',
    name: 'Briefing diario',
    schedule: '0 8 * * *',
    steps: ['resumí el repo', 'avisá'],
  });
  const logger = collectingLogger();
  const load = await loadAutomation(channel, 'a 1', { logger });
  assert.equal(load.kind, 'success');
  assert.match(channel.writes[0], /^GET \/api\/automations\/a%201 HTTP\/1\.1/);
  assert.equal(load.automation.name, 'Briefing diario');
  assert.deepEqual(load.automation.steps, ['resumí el repo', 'avisá']);
  assert.equal(load.automation.stepsKnown, true);
  assert.equal(logger.failures.length, 0);

  // No steps field: the editor is told the PC did not report them.
  const partial = await loadAutomation(
    okChannel({ id: 'a2', name: 'Vieja', schedule: '0 8 * * *' }),
    'a2',
    { logger },
  );
  assert.equal(partial.kind, 'success');
  assert.deepEqual(partial.automation.steps, []);
  assert.equal(partial.automation.stepsKnown, false);
});

test('loadAutomation maps 404, no tunnel and a broken body honestly', async () => {
  const logger = collectingLogger();
  const missing = await loadAutomation(okChannel({ error: 'nope' }, 404), 'a9', { logger });
  assert.equal(missing.kind, 'not-found');
  assert.match(missing.message, /No encontramos esa automatización/);
  assert.equal(logger.failures.at(0).step, 'automation-request');

  const offline = await loadAutomation(null, 'a9', { logger });
  assert.equal(offline.kind, 'offline');
  assert.equal(logger.failures.at(-1).step, 'tunnel');

  const broken = await loadAutomation(
    okChannel({ id: 'a9', name: '', schedule: '0 8 * * *' }),
    'a9',
    { logger },
  );
  assert.equal(broken.kind, 'error');
  assert.equal(broken.message, 'La PC devolvió automatizaciones incompletas.');
  assert.match(broken.raw, /"name"/);
});
