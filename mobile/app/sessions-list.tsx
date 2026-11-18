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

import { GhostButton } from '../components/GhostButton';
import { logger } from '../lib/logger';
import {
  type FilterChip,
  type SessionFilter,
  type SessionRowViewModel,
  type SessionsState,
  SessionsCache,
  buildSessionsView,
  loadSessions,
} from '../lib/sessions';
import { bridgeChannel } from '../lib/tunnel-store';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V6 — Sessions list (artboard `design/mobile-app-core/02-sessions-list.html`,
 * `docs/mobile-views-plan.md` §V6).
 *
 * Rendering shell only: the filter counts, the row view model (status pill,
 * hint, `hace N min`), the updated-desc order and every honest state live in
 * `mobile/lib/sessions.ts`, pinned by `mobile/test/sessions.test.mjs`.
 *
 * Data is the real `GET /api/sessions` over the SSH tunnel: with no tunnel the
 * screen shows `Reconectando…`, a timeout after a good answer keeps the cached
 * rows under an amber `Datos de hace N min` chip, and a broken answer is an
 * error card with the failure message — never an invented list.
 *
 * `/session/<id>` has no screen yet (V7), so tapping a row logs
 * `route pending` instead of navigating or failing silently.
 */

const log = logger.tag('sessions-list');

/** V7 does not exist yet: the row route is honest but not reachable. */
function openSession(row: SessionRowViewModel): void {
  log.info('row tap', { id: row.id, route: row.route });
  log.warn('route pending', { route: row.route });
}

const TONE_STYLES = {
  working: { background: colors.accentSoft, border: colors.accent, text: colors.accentText },
  waiting: { background: colors.warningSoft, border: colors.warning, text: colors.warning },
  ok: { background: colors.okSoft, border: colors.ok, text: colors.ok },
  muted: { background: colors.bgSunken, border: colors.border, text: colors.muted },
} as const;

function FilterChips({
  chips,
  onSelect,
}: {
  chips: readonly FilterChip[];
  onSelect: (id: SessionFilter) => void;
}) {
  return (
    <View
      style={styles.segmented}
      accessibilityRole="radiogroup"
      accessibilityLabel="Filtrar sesiones por estado">
      {chips.map((chip) => (
        <Pressable
          key={chip.id}
          accessibilityRole="radio"
          accessibilityState={{ checked: chip.active }}
          accessibilityLabel={`${chip.label}, ${chip.count}`}
          onPress={() => onSelect(chip.id)}
          style={[styles.segment, chip.active && styles.segmentActive]}>
          <Text style={[styles.segmentLabel, chip.active && styles.segmentLabelActive]}>
            {chip.label}
          </Text>
          <Text style={[styles.segmentCount, chip.active && styles.segmentCountActive]}>
            {chip.count}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function StatusPill({ row }: { row: SessionRowViewModel }) {
  const tone = TONE_STYLES[row.pill.tone];
  return (
    <View style={[styles.pill, { backgroundColor: tone.background, borderColor: tone.border }]}>
      <Text style={[styles.pillText, { color: tone.text }]}>{row.pill.label}</Text>
      {row.status === 'working' && (
        <View style={styles.dots} accessibilityElementsHidden>
          <View style={[styles.dot, { backgroundColor: tone.text }]} />
          <View style={[styles.dot, { backgroundColor: tone.text }]} />
          <View style={[styles.dot, { backgroundColor: tone.text }]} />
        </View>
      )}
    </View>
  );
}

function SessionRow({ row, onPress }: { row: SessionRowViewModel; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${row.pill.label}, ${row.relative}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.session,
        row.attention && styles.sessionAttention,
        row.frozen && styles.sessionFrozen,
        pressed && styles.sessionPressed,
      ]}>
      <View style={styles.sessionTop}>
        <Text style={styles.sessionName} numberOfLines={1}>
          {row.title}
        </Text>
        <StatusPill row={row} />
      </View>
      <View style={styles.sessionMeta}>
        <Text style={styles.sessionHint} numberOfLines={1}>
          {row.hint}
        </Text>
        <Text style={styles.sessionDot}>·</Text>
        <Text style={styles.sessionRelative}>{row.relative}</Text>
      </View>
    </Pressable>
  );
}

function SkeletonRow() {
  return (
    <View style={[styles.session, styles.skeletonRow]} accessibilityElementsHidden>
      <View style={styles.skeletonTop}>
        <View style={[styles.skeletonBar, { width: '45%' }]} />
        <View style={[styles.skeletonBar, { width: 84, borderRadius: radius.pill }]} />
      </View>
      <View style={[styles.skeletonBar, { width: '60%' }]} />
    </View>
  );
}

export default function SessionsListScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cache = useRef(new SessionsCache());
  const [state, setState] = useState<SessionsState>({ kind: 'loading' });
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setState({ kind: 'loading' });
    }
    try {
      setState(await loadSessions(bridgeChannel(), { cache: cache.current }));
    } catch (error) {
      // loadSessions never throws by design; a throw here is unexpected, so it
      // is logged and rendered as offline instead of a fake list.
      log.failure('load-sessions', error, null);
      setState({ kind: 'offline', sessions: null, minutes: null });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const vm = useMemo(() => buildSessionsView(state, filter), [state, filter]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    log.warn('route pending', { route: '/overview', reason: 'no-back-stack' });
    router.replace('/overview');
  }, [router]);

  const newSession = useCallback(() => {
    log.warn('route pending', { route: '/new-session' });
  }, []);

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
          <Text style={styles.screenTitle} accessibilityRole="header">
            Sesiones
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {vm.summary ?? (vm.state === 'offline' ? 'Sin conexión con la PC' : '—')}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor={colors.accent}
          />
        }>
        {vm.banner !== null && (
          <View style={styles.banner} accessibilityRole="status">
            <ActivityIndicator size="small" color={colors.warning} />
            <View style={styles.bannerText}>
              <Text style={styles.bannerTitle}>Túnel SSH reconectando…</Text>
              <Text style={styles.meta}>Deslizá para reintentar</Text>
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
            <Text style={styles.errorTitle}>No pudimos leer las sesiones</Text>
            <Text style={styles.errorMessage}>{vm.error.message}</Text>
            {vm.error.raw !== null && <Text style={styles.errorRaw}>{vm.error.raw}</Text>}
            <GhostButton label="Reintentar" onPress={() => void load(false)} />
          </View>
        )}

        {vm.chips.length > 0 && <FilterChips chips={vm.chips} onSelect={setFilter} />}

        {vm.loading && (
          <View style={styles.sessions}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        )}

        {!vm.loading && vm.rows.length > 0 && (
          <View style={styles.sessions}>
            {vm.rows.map((row) => (
              <SessionRow key={row.id} row={row} onPress={() => openSession(row)} />
            ))}
          </View>
        )}

        {vm.emptyMessage !== null && vm.rows.length === 0 && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{vm.emptyMessage}</Text>
            {vm.creatable && <GhostButton label="Nueva sesión" onPress={newSession} />}
          </View>
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
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  meta: {
    ...typography.hint,
    color: colors.faint,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  bannerText: {
    flex: 1,
    gap: 2,
  },
  bannerTitle: {
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
  segmented: {
    flexDirection: 'row',
    gap: spacing.xs,
    padding: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSunken,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  segmentActive: {
    backgroundColor: colors.accentSoft,
  },
  segmentLabel: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
  },
  segmentLabelActive: {
    color: colors.accentText,
    fontWeight: '600',
  },
  segmentCount: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.faint,
  },
  segmentCountActive: {
    color: colors.accentText,
  },
  sessions: {
    gap: 10,
  },
  session: {
    gap: spacing.sm,
    minHeight: 88,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...elevation.card,
  },
  sessionAttention: {
    borderColor: colors.warning,
  },
  /** Cached rows (offline/stale): muted, the status dots are frozen. */
  sessionFrozen: {
    opacity: 0.8,
  },
  sessionPressed: {
    borderColor: colors.borderStrong,
  },
  sessionTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  sessionName: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
    letterSpacing: -0.2,
    color: colors.text,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sessionHint: {
    flexShrink: 1,
    ...typography.hint,
    color: colors.muted,
  },
  sessionDot: {
    ...typography.hint,
    color: colors.faint,
  },
  sessionRelative: {
    ...typography.hint,
    color: colors.faint,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pillText: {
    ...typography.hint,
    fontWeight: '600',
  },
  dots: {
    flexDirection: 'row',
    gap: 2,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 2,
  },
  skeletonRow: {
    opacity: 0.5,
    minHeight: 88,
    justifyContent: 'space-between',
  },
  skeletonTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  skeletonBar: {
    height: 12,
    borderRadius: radius.sm,
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
});
