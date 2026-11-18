import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../components/ConnectionBanner';
import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  type AutomationsState,
  type AutomationsViewModel,
  type AutomationRow,
  type AutomationSection,
  AutomationsCache,
  TOGGLE_PENDING_NOTE,
  buildAutomationsView,
  loadAutomations,
} from '../lib/automations';
import {
  type ConnectionCheck,
  type ConnectionCopy,
  checkConnection,
  connectionCopy,
  deriveConnection,
} from '../lib/connection';
import { logger } from '../lib/logger';
import { bridgeChannel, getActiveTunnel } from '../lib/tunnel-store';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V10 — Automations list (artboard `design/mobile-app-core/05-automations.html`,
 * `docs/mobile-views-plan.md` §V10). Route `/automations`.
 *
 * Rendering shell only: the strict payload parse, the enabled / paused split
 * (`Programadas` / `Pausadas`), the next-run order and countdowns, the last-run
 * tone and every honest state live in `mobile/lib/automations.ts`, pinned by
 * `mobile/test/automations.test.mjs`.
 *
 * Data is the real `GET /api/automations` over the SSH tunnel (protocol §4):
 * with no tunnel the screen says `Sin conexión — las automatizaciones corren en
 * tu PC.`, a timeout after a good answer keeps the cached rows under an amber
 * `Datos de hace N min` chip, and an extension that does not expose the
 * endpoint yet is an error card carrying the failure message — never an
 * invented automation or a fake run history.
 *
 * The enable/disable switch (`PATCH automation.enabled`) is not served by the
 * PC yet, so tapping it logs `route pending` and shows the honest note instead
 * of flipping a state the PC never accepted.
 */

const log = logger.tag('automations');

/** Last-run chip tones (artboard `chip--ok` / `chip--danger`). */
const CHIP_TONES = {
  ok: { background: colors.okSoft, border: colors.ok, text: colors.ok },
  fail: { background: colors.dangerSoft, border: colors.danger, text: colors.danger },
} as const;

/** Statuses the §V20 banner is worth showing for (silence while connected). */
const REPORTED = new Set(['stale', 'offline', 'incompatible', 'unauthorized']);

/** One §V10 row card: name, schedule, last run, next run and the switch. */
function RowCard({
  row,
  onOpen,
  onToggle,
}: {
  row: AutomationRow;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const chip = row.lastRun === null ? null : CHIP_TONES[row.lastRun.tone];
  return (
    <View style={[styles.card, row.frozen && styles.cardFrozen]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.name}, ${row.scheduleLabel}, ${row.nextRunLabel}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}>
        <Text style={styles.name} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.schedule} numberOfLines={1}>
          {row.scheduleLabel}
        </Text>
        <View style={styles.metaRow}>
          {row.lastRun !== null && chip !== null && (
            <View style={[styles.chip, { backgroundColor: chip.background, borderColor: chip.border }]}>
              <Text style={[styles.chipText, { color: chip.text }]} numberOfLines={1}>
                {row.lastRun.label}
              </Text>
            </View>
          )}
          <Text style={styles.nextRun} numberOfLines={1}>
            {row.nextRunLabel}
          </Text>
        </View>
      </Pressable>

      <View style={styles.side}>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={row.name}
          accessibilityState={{ checked: row.enabled, disabled: row.frozen }}
          onPress={onToggle}
          style={({ pressed }) => [styles.switch, pressed && styles.switchPressed]}>
          <View style={[styles.track, row.enabled && styles.trackOn]}>
            <View style={[styles.knob, row.enabled && styles.knobOn]} />
          </View>
        </Pressable>
        <Text style={styles.stateLabel}>{row.stateLabel}</Text>
      </View>
    </View>
  );
}

function SectionBlock({
  section,
  onOpen,
  onToggle,
}: {
  section: AutomationSection;
  onOpen: (row: AutomationRow) => void;
  onToggle: (row: AutomationRow) => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.legend}>{section.title}</Text>
        <Text style={styles.sectionCount}>{section.rows.length}</Text>
      </View>
      <View style={styles.cardList}>
        {section.rows.map((row) => (
          <RowCard
            key={row.id}
            row={row}
            onOpen={() => onOpen(row)}
            onToggle={() => onToggle(row)}
          />
        ))}
      </View>
    </View>
  );
}

function SkeletonRow() {
  return (
    <View style={[styles.card, styles.cardFrozen]} accessibilityElementsHidden>
      <View style={styles.cardMain}>
        <View style={[styles.skeletonBar, { width: '55%' }]} />
        <View style={[styles.skeletonBar, { width: '35%', height: 10 }]} />
        <View style={[styles.skeletonBar, { width: '45%', height: 10 }]} />
      </View>
      <View style={styles.side}>
        <View style={styles.skeletonSwitch} />
      </View>
    </View>
  );
}

/** Meta line of the app bar when the payload has no summary. */
function fallbackMeta(vm: AutomationsViewModel): string {
  switch (vm.state) {
    case 'loading':
      return 'Leyendo las automatizaciones…';
    case 'offline':
      return 'Sin conexión con la PC';
    case 'empty':
      return 'Sin automatizaciones';
    case 'error':
      return 'Error al leer las automatizaciones';
    default:
      return '—';
  }
}

export default function AutomationsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cache = useRef(new AutomationsCache());
  const lastGood = useRef<number | null>(null);
  const [state, setState] = useState<AutomationsState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [toggleNote, setToggleNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setState({ kind: 'loading' });
    }
    try {
      setState(await loadAutomations(bridgeChannel(), { cache: cache.current }));
    } catch (error) {
      // loadAutomations never throws by design; a throw here is unexpected, so
      // it is logged and rendered as offline instead of a fake list.
      log.failure('load-automations', error, null);
      setState({ kind: 'offline', automations: null, minutes: null });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const inspectConnection = useCallback(async () => {
    const host = getActiveTunnel()?.host ?? null;
    try {
      const result = await checkConnection(bridgeChannel(), {
        host,
        lastGoodAt: lastGood.current,
      });
      if (result.model.status === 'live') {
        lastGood.current = result.at;
      }
      setCheck(result);
    } catch (error) {
      // checkConnection reports typed failures, so a throw is unexpected: it is
      // logged and shown as an unverifiable bridge, never as "connected".
      log.failure('check-connection', error, null);
      const model = deriveConnection({
        tunnel: getActiveTunnel() !== null,
        failure: {
          kind: 'bad-response',
          message: 'No pudimos verificar el puente.',
          raw: String(error),
        },
        lastGoodAt: lastGood.current,
      });
      setCheck({
        model,
        copy: connectionCopy(model, { host }),
        retry: {
          kind: 'recheck',
          pending: false,
          label: 'Reintentar',
          note: 'Reintentar vuelve a preguntarle al puente por /api/health.',
        },
        at: Date.now(),
      });
    }
  }, []);

  useEffect(() => {
    void load(false);
    void inspectConnection();
  }, [load, inspectConnection]);

  // §V10: countdowns tick locally every minute, with no network at all.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(() => {
    setToggleNote(null);
    void load(true);
    void inspectConnection();
  }, [load, inspectConnection]);

  const vm = useMemo(() => buildAutomationsView(state, now), [state, now]);
  const host = getActiveTunnel()?.host ?? null;

  /** §V20 banner copy, only for a status that has something to say. */
  const banner: ConnectionCopy | null =
    check !== null && REPORTED.has(check.model.status) ? check.copy : null;

  const openRow = useCallback(
    (row: AutomationRow) => {
      log.info('row tap', { id: row.id, route: row.route });
      router.push({ pathname: '/automation-editor', params: { id: row.id } });
    },
    [router],
  );

  const toggleRow = useCallback((row: AutomationRow) => {
    // The PATCH endpoint does not exist yet: no optimistic flip, no lie.
    log.warn('route pending', {
      route: row.route,
      reason: 'toggle-endpoint-not-built',
      enabled: row.enabled,
    });
    setToggleNote(TOGGLE_PENDING_NOTE);
  }, []);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/overview');
  }, [router]);

  const create = useCallback(() => {
    router.push('/automation-editor');
  }, [router]);

  const meta = vm.summary ?? fallbackMeta(vm);

  return (
    <View style={styles.screen}>
      <View style={[styles.appbar, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Volver"
          onPress={goBack}
          style={styles.back}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View style={styles.appbarTitle}>
          <Text style={styles.screenTitle} accessibilityRole="header" numberOfLines={1}>
            Automatizaciones
          </Text>
          <Text style={styles.metaText} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <View style={styles.pair} accessibilityRole="status">
          <View
            style={[
              styles.pairDot,
              { backgroundColor: check?.model.status === 'live' ? colors.ok : colors.faint },
            ]}
            accessibilityElementsHidden
          />
          <Text style={styles.pairText} numberOfLines={1}>
            {host ?? 'sin túnel'}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />
        }>
        {banner !== null && (
          <ConnectionBanner
            copy={banner}
            note={check !== null && check.retry.pending ? check.retry.note : null}
            onRetry={refresh}
            testID="automations-connection-banner"
          />
        )}

        {banner === null && vm.banner !== null && (
          <View style={styles.offlineStrip} accessibilityRole="status">
            <ActivityIndicator size="small" color={colors.warning} />
            <View style={styles.offlineText}>
              <Text style={styles.offlineTitle}>{vm.banner}</Text>
              {vm.bannerHint !== null && <Text style={styles.metaText}>{vm.bannerHint}</Text>}
            </View>
          </View>
        )}

        {vm.staleChip !== null && (
          <View style={styles.staleChip}>
            <Text style={styles.staleChipText}>{vm.staleChip}</Text>
          </View>
        )}

        {vm.error !== null && (
          <View style={styles.errorCard} accessibilityRole="alert">
            <Text style={styles.errorTitle}>{vm.error.title}</Text>
            <Text style={styles.errorMessage}>{vm.error.message}</Text>
            {vm.error.raw !== null && <Text style={styles.errorRaw}>{vm.error.raw}</Text>}
            <GhostButton label="Reintentar" onPress={() => void load(false)} />
          </View>
        )}

        {toggleNote !== null && (
          <View style={styles.noteCard} accessibilityRole="status">
            <Text style={styles.noteText}>{toggleNote}</Text>
          </View>
        )}

        {vm.loading && (
          <View style={styles.cardList}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        )}

        {!vm.loading &&
          vm.sections.map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              onOpen={openRow}
              onToggle={toggleRow}
            />
          ))}

        {vm.emptyMessage !== null && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{vm.emptyMessage}</Text>
            <PrimaryButton label="+ Nueva automatización" onPress={create} />
          </View>
        )}

        {!vm.loading && vm.sections.length > 0 && (
          <>
            <Text style={styles.hint}>
              Tocá una fila para editarla. Las automatizaciones corren en tu PC, aunque la app esté
              cerrada.
            </Text>
            <PrimaryButton label="+ Nueva automatización" onPress={create} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: {
    color: colors.muted,
    fontSize: 22,
    lineHeight: 24,
    marginTop: -3,
  },
  appbarTitle: {
    flex: 1,
    gap: 2,
  },
  screenTitle: {
    ...typography.h1,
    fontSize: 19,
    lineHeight: 24,
    letterSpacing: -0.3,
  },
  metaText: {
    ...typography.hint,
    color: colors.faint,
  },
  pair: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pairDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
  },
  pairText: {
    ...typography.chip,
    fontSize: 11,
    color: colors.muted,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  offlineStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  offlineText: {
    flex: 1,
    gap: 2,
  },
  offlineTitle: {
    ...typography.label,
    color: colors.text,
  },
  staleChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  staleChipText: {
    ...typography.hint,
    color: colors.warning,
  },
  errorCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
  errorTitle: {
    ...typography.label,
    color: colors.text,
  },
  errorMessage: {
    ...typography.body,
    color: colors.muted,
  },
  errorRaw: {
    ...typography.fine,
    color: colors.faint,
  },
  noteCard: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  noteText: {
    ...typography.body,
    color: colors.text,
  },
  section: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  legend: {
    ...typography.legend,
    color: colors.muted,
  },
  sectionCount: {
    ...typography.hint,
    color: colors.faint,
  },
  cardList: {
    gap: spacing.md,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md + 2,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...elevation.card,
  },
  cardFrozen: {
    opacity: 0.62,
  },
  cardMain: {
    flex: 1,
    gap: 5,
    minHeight: 44,
    justifyContent: 'center',
  },
  cardPressed: {
    opacity: 0.75,
  },
  name: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    color: colors.text,
  },
  schedule: {
    ...typography.hint,
    color: colors.muted,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: {
    ...typography.hint,
    fontSize: 10,
    lineHeight: 14,
  },
  nextRun: {
    ...typography.hint,
    fontSize: 10,
    lineHeight: 14,
    color: colors.faint,
  },
  side: {
    alignItems: 'center',
    gap: 3,
  },
  switch: {
    padding: 4,
  },
  switchPressed: {
    opacity: 0.7,
  },
  track: {
    width: 46,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  trackOn: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  knob: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: colors.faint,
  },
  knobOn: {
    backgroundColor: colors.accent,
    alignSelf: 'flex-end',
  },
  stateLabel: {
    ...typography.hint,
    fontSize: 10,
    lineHeight: 14,
    color: colors.faint,
  },
  skeletonBar: {
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
  },
  skeletonSwitch: {
    width: 46,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
  },
  emptyCard: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  emptyText: {
    ...typography.lede,
    color: colors.muted,
  },
  hint: {
    ...typography.fine,
    color: colors.faint,
  },
});
