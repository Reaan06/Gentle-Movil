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
  type ChangesState,
  type ChangesViewModel,
  type FileGroup,
  type FileRow,
  ChangesCache,
  buildChangesView,
  loadChanges,
} from '../lib/git';
import { bridgeChannel, getActiveTunnel } from '../lib/tunnel-store';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V13 — Git changes (artboard `design/mobile-app-core/09-git-changes.html`,
 * `docs/mobile-views-plan.md` §V13).
 *
 * Rendering shell only: the staged/unstaged split, the `Modificados / Nuevos /
 * Borrados / Renombrados` sections, the path order, the `N archivos · +X −Y`
 * summary and every honest state live in `mobile/lib/git.ts`, pinned by
 * `mobile/test/git.test.mjs`.
 *
 * Data is the real `GET /api/git/status` over the SSH tunnel (protocol §4):
 * with no tunnel the screen says `Requiere conexión — git se ejecuta en tu
 * PC.`, a timeout after a good answer keeps the cached tree under an amber
 * `Datos de hace N min` chip, and an extension that does not expose the
 * endpoint yet is an error card — never an invented or empty change set.
 *
 * `/git-changes/<path>` has no screen yet (the diff view is planned), so
 * tapping a file logs `route pending` instead of navigating or failing
 * silently.
 */

const log = logger.tag('git-changes');

/** Glyph square tones (artboard `--mod` / `--add` / `--del` variants). */
const GLYPH_TONES = {
  warning: { background: colors.warningSoft, color: colors.warning },
  ok: { background: colors.okSoft, color: colors.ok },
  danger: { background: colors.dangerSoft, color: colors.danger },
  accent: { background: colors.accentSoft, color: colors.accentText },
} as const;

/** The diff view (V13 second half) does not exist yet. */
function openDiff(row: FileRow): void {
  log.info('file tap', { path: row.path, route: row.route });
  log.warn('route pending', { route: row.route, reason: 'diff-view-not-built' });
}

function FileRowView({ row, group }: { row: FileRow; group: FileGroup }) {
  const tone = GLYPH_TONES[row.tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.statusLabel}: ${row.path}, más ${row.additions}, menos ${row.deletions}, ${group.title}`}
      onPress={() => openDiff(row)}
      style={({ pressed }) => [styles.file, pressed && styles.filePressed]}>
      <View
        style={[styles.glyph, { backgroundColor: tone.background }]}
        accessibilityElementsHidden>
        <Text style={[styles.glyphText, { color: tone.color }]}>{row.glyph}</Text>
      </View>
      <Text style={styles.path} numberOfLines={1}>
        {row.path}
      </Text>
      <View style={styles.delta}>
        <Text style={styles.deltaAdd}>{`+${row.additions}`}</Text>
        <Text style={styles.deltaDel}>{`−${row.deletions}`}</Text>
      </View>
    </Pressable>
  );
}

function GroupSection({ group }: { group: FileGroup }) {
  return (
    <View style={styles.section}>
      <View style={styles.groupHead}>
        <Text style={styles.legend}>{group.title}</Text>
        <Text style={styles.groupCount}>{group.count}</Text>
      </View>
      {group.sections.map((section) => (
        <View key={`${group.id}-${section.id}`} style={styles.sectionBlock}>
          <Text style={styles.eyebrow}>{section.title}</Text>
          <View style={styles.fileList}>
            {section.rows.map((row) => (
              <FileRowView key={`${group.id}-${section.id}-${row.path}`} row={row} group={group} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function SkeletonRow() {
  return (
    <View style={[styles.file, styles.skeletonRow]} accessibilityElementsHidden>
      <View style={styles.skeletonGlyph} />
      <View style={[styles.skeletonBar, { flex: 1 }]} />
      <View style={[styles.skeletonBar, { width: 52 }]} />
    </View>
  );
}

/** Meta line when there is no workspace and no summary to join. */
function fallbackMeta(vm: ChangesViewModel): string {
  switch (vm.state) {
    case 'loading':
      return 'Leyendo los cambios…';
    case 'offline':
      return 'Sin conexión con la PC';
    case 'empty':
      return 'Sin cambios';
    case 'error':
      return 'Error al leer los cambios';
    default:
      return '—';
  }
}

/** Header meta line: workspace (as the PC reported it) or the paired host. */
function workspaceLine(vm: ChangesViewModel, host: string | null): string | null {
  const parts: string[] = [];
  if (vm.workspace !== null) {
    parts.push(vm.workspace);
  } else if (host !== null) {
    parts.push(host);
  }
  if (vm.summary !== null) {
    parts.push(vm.summary);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

export default function GitChangesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cache = useRef(new ChangesCache());
  const [state, setState] = useState<ChangesState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setState({ kind: 'loading' });
    }
    try {
      setState(await loadChanges(bridgeChannel(), { cache: cache.current }));
    } catch (error) {
      // loadChanges never throws by design; a throw here is unexpected, so it
      // is logged and rendered as offline instead of a fake change set.
      log.failure('load-changes', error, null);
      setState({ kind: 'offline', payload: null, minutes: null });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const vm = useMemo(() => buildChangesView(state), [state]);
  const host = getActiveTunnel()?.host ?? null;
  const meta = workspaceLine(vm, host);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    log.warn('route pending', { route: '/overview', reason: 'no-back-stack' });
    router.replace('/overview');
  }, [router]);

  const title = vm.branch === null ? 'Cambios' : `Cambios · ${vm.branch}`;

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
            {title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {meta ?? fallbackMeta(vm)}
          </Text>
          {((vm.ahead ?? 0) > 0 || (vm.behind ?? 0) > 0) && (
            <View style={styles.counters}>
              {(vm.ahead ?? 0) > 0 && <Text style={styles.counter}>{`↑${vm.ahead}`}</Text>}
              {(vm.behind ?? 0) > 0 && <Text style={styles.counter}>{`↓${vm.behind}`}</Text>}
            </View>
          )}
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
          <View style={styles.banner} accessibilityRole="summary">
            <ActivityIndicator size="small" color={colors.warning} />
            <View style={styles.bannerText}>
              <Text style={styles.bannerTitle}>{vm.banner}</Text>
              {vm.bannerHint !== null && <Text style={styles.meta}>{vm.bannerHint}</Text>}
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

        {vm.loading && (
          <View style={styles.fileList}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        )}

        {!vm.loading &&
          vm.groups.map((group) => (
            <GroupSection key={group.id} group={group} />
          ))}

        {vm.emptyMessage !== null && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{vm.emptyMessage}</Text>
            <GhostButton label="Actualizar" onPress={() => void load(true)} />
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
  counters: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  counter: {
    ...typography.hint,
    color: colors.muted,
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
  section: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  sectionBlock: {
    gap: 6,
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  legend: {
    ...typography.legend,
    color: colors.muted,
  },
  groupCount: {
    ...typography.hint,
    color: colors.faint,
  },
  eyebrow: {
    ...typography.eyebrow,
    fontSize: 10,
    lineHeight: 15,
    color: colors.faint,
  },
  fileList: {
    gap: spacing.sm,
  },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...elevation.card,
  },
  filePressed: {
    borderColor: colors.borderStrong,
  },
  glyph: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
  },
  path: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    color: colors.text,
  },
  delta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deltaAdd: {
    ...typography.hint,
    fontWeight: '700',
    color: colors.ok,
  },
  deltaDel: {
    ...typography.hint,
    fontWeight: '700',
    color: colors.danger,
  },
  skeletonRow: {
    opacity: 0.5,
  },
  skeletonGlyph: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
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
