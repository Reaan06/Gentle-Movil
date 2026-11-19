import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import { logger } from '../lib/logger';
import {
  type ChartBar,
  type LoadOverview,
  type OverviewAction,
  type OverviewStateModel,
  type OverviewViewModel,
  type OverviewTile,
  buildOverview,
} from '../lib/overview';
import {
  bridgeOverviewProvider,
  stateFromSignal,
} from '../lib/overview-provider';
import { bridgeChannel } from '../lib/tunnel-store';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V5 — Overview dashboard (artboard `design/mobile-app-core/01-overview.html`,
 * `docs/mobile-views-plan.md` §V5).
 *
 * The 5-second answer to "what is my machine doing right now?" plus the entry
 * to everything: bento tiles (Trabajando / Esperando / Terminadas), the 7-day
 * token chart, quick actions and the tab dock.
 *
 * Rendering shell only — the §V5 state machine, tile/chart/action view models
 * and es-AR copies live in `mobile/lib/overview.ts` and are pinned by
 * `mobile/test/overview.test.mjs`.
 *
 * Data comes from the PC over the SSH tunnel (`GET /api/sessions` +
 * `/api/health`, see `lib/overview-provider.ts`). There is no demo dataset: with
 * no tunnel the screen says `Reconectando…`, and a PC that times out after a
 * good answer shows `Datos de hace N min` with the cached numbers.
 *
 * T7q: every tile, dock tab and quick action navigates to the screen that
 * really exists. A metric the extension does not report renders "sin datos"
 * with its reason — never 0, never an invented chart. The only affordance
 * still without a screen is `+ Nueva sesión` (V8), and it says exactly that.
 */

/** Swappable provider seam (tests inject a fake; the app uses the tunnel). */
let provider: LoadOverview = bridgeOverviewProvider(() => bridgeChannel());

/** Replace the data source (tests / later slices); returns the previous one. */
export function setOverviewProvider(next: LoadOverview): LoadOverview {
  const previous = provider;
  provider = next;
  return previous;
}

/** Bottom dock tabs — every route below has a real screen. */
const TABS: readonly { id: string; label: string; glyph: string; route: string }[] = [
  { id: 'overview', label: 'Overview', glyph: '▦', route: '/overview' },
  { id: 'sessions', label: 'Sessions', glyph: '›_', route: '/sessions-list' },
  { id: 'automations', label: 'Automations', glyph: '⟳', route: '/automations' },
  { id: 'local', label: 'Local', glyph: '▣', route: '/local-projects' },
];

function PairChip({ vm }: { vm: OverviewViewModel }) {
  const dotColor = vm.pairDot === 'green' ? colors.ok : colors.faint;
  // The host is the one `/api/health` reported; unknown is said out loud.
  const host = vm.data?.paired.host ?? 'sin datos';
  return (
    <View style={styles.pair}>
      <View style={[styles.pairDot, { backgroundColor: dotColor }]} />
      <Text style={styles.pairText} accessibilityLabel="túnel SSH">
        Live · {host}
      </Text>
    </View>
  );
}

function Tile({
  tile,
  greyed,
  onOpen,
}: {
  tile: OverviewTile;
  greyed: boolean;
  onOpen: (route: string, id: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${tile.label}: ${tile.count}`}
      onPress={() => onOpen(tile.route, tile.id)}
      style={[
        styles.tile,
        tile.wide && styles.tileWide,
        tile.attention && styles.tileAttention,
        greyed && styles.greyed,
      ]}>
      <Text style={styles.tileLabel}>{tile.label}</Text>
      <View style={styles.tileValueRow}>
        <Text style={styles.tileValue}>{tile.count}</Text>
        {tile.unit !== null && tile.unit !== undefined && (
          <Text style={styles.tileUnit}>{tile.unit}</Text>
        )}
      </View>
      {tile.hint !== null && tile.hint !== undefined && (
        <Text style={styles.tileHint}>{tile.hint}</Text>
      )}
    </Pressable>
  );
}

function TokenChart({ bars, greyed }: { bars: readonly ChartBar[]; greyed: boolean }) {
  return (
    <View style={styles.chart}>
      {bars.map((bar) => (
        <View key={bar.label} style={styles.chartColumn}>
          <View style={styles.chartBarArea}>
            <View
              style={[
                styles.chartBar,
                {
                  height: `${Math.max(bar.height * 100, 4)}%` as `${number}%`,
                  backgroundColor: bar.today ? colors.accent : colors.deepPink,
                },
                greyed && styles.greyed,
              ]}
            />
          </View>
          <Text style={[styles.chartLabel, bar.today && styles.chartLabelToday]}>
            {bar.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const log = logger.tag('overview');

export default function OverviewScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [state, setState] = useState<OverviewStateModel>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) {
      setRefreshing(true);
    }
    try {
      const data = await provider();
      setState({ kind: 'success', data });
    } catch (error) {
      // The provider signals the §V5 state (offline / stale / empty); anything
      // else is an honest log plus offline, never a fake payload.
      setState(stateFromSignal(error));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const vm = buildOverview(state);
  const greyed = vm.state === 'offline' || vm.state === 'loading';

  const today = new Date().toLocaleDateString('es-AR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  const openRoute = useCallback(
    (route: string, id: string) => {
      log.info('navigate', { id, route });
      router.push(route as Href);
    },
    [router],
  );

  const onAction = (action: OverviewAction) => {
    if (action.disabled) {
      log.warn('action disabled (offline)', { id: action.id });
      return;
    }
    if (action.pending) {
      // No screen yet: the tap says exactly why instead of navigating nowhere.
      log.warn('action unavailable', {
        id: action.id,
        route: action.route,
        reason: action.pendingReason,
      });
      return;
    }
    openRoute(action.route, action.id);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.appbar}>
        <View style={styles.brand} importantForAccessibility="no-hide-descendants">
          <Text style={styles.brandPi} accessibilityElementsHidden>
            π
          </Text>
        </View>
        <View style={styles.appbarTitle}>
          <Text style={styles.screenTitle}>Hola, Reaan</Text>
          <Text style={styles.meta}>{today}</Text>
        </View>
        <PairChip vm={vm} />
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
        {vm.staleChip !== null && (
          <View style={styles.staleChip}>
            <Text style={styles.staleChipText}>{vm.staleChip}</Text>
          </View>
        )}

        <Text style={typography.eyebrow}>Sesiones</Text>
        {vm.emptyCard !== null && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{vm.emptyCard}</Text>
          </View>
        )}
        <View style={styles.bento}>
          {vm.tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} greyed={greyed} onOpen={openRoute} />
          ))}
        </View>

        <View style={[styles.panel, greyed && styles.greyed]}>
          <View style={styles.panelHead}>
            <View style={styles.panelHeadText}>
              <Text style={typography.eyebrow}>Tokens · últimos 7 días</Text>
              {vm.tokens.available ? (
                <View style={styles.panelValueRow}>
                  <Text style={styles.panelValue}>{vm.tokens.total}</Text>
                  <Text style={styles.meta}>en {vm.tokens.sessions}</Text>
                </View>
              ) : (
                <Text style={styles.panelMissing}>
                  sin datos · {vm.tokens.reason}
                </Text>
              )}
            </View>
            {vm.tokens.available && (
              <Text style={styles.panelToday}>hoy · {vm.tokens.today}</Text>
            )}
          </View>
          {vm.tokens.chart.length > 0 && (
            <TokenChart bars={vm.tokens.chart} greyed={greyed} />
          )}
        </View>

        <View style={styles.actions}>
          {vm.actions.map((action) =>
            action.id === 'new-session' ? (
              <PrimaryButton
                key={action.id}
                label={action.label}
                disabled={action.disabled}
                reportDisabledPress
                onPress={() => onAction(action)}
                style={styles.actionButton}
              />
            ) : (
              <GhostButton
                key={action.id}
                label={action.label}
                disabled={action.disabled}
                onPress={() => onAction(action)}
                style={styles.actionButton}
              />
            ),
          )}
        </View>

        <View style={styles.syncline}>
          <Text style={[styles.syncCheck, vm.pairDot === 'green' && styles.syncCheckOk]}>
            ✓
          </Text>
          <Text style={styles.meta}>{vm.syncLine}</Text>
        </View>
      </ScrollView>

      <View style={styles.dock}>
        <View style={styles.tabbar}>
          {TABS.map((tab) => {
            const current = tab.id === 'overview';
            return (
              <Pressable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: current }}
                accessibilityLabel={tab.label}
                onPress={() => {
                  if (current) {
                    return;
                  }
                  openRoute(tab.route, tab.id);
                }}
                style={[styles.tab, current && styles.tabCurrent]}>
                <Text style={[styles.tabGlyph, current && styles.tabGlyphCurrent]}>
                  {tab.glyph}
                </Text>
                <Text style={[styles.tabLabel, current && styles.tabLabelCurrent]}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
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
  brand: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandPi: {
    color: colors.accent,
    fontSize: 20,
    fontWeight: '700',
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
    borderRadius: 3,
  },
  pairText: {
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
  staleChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  staleChipText: {
    ...typography.hint,
    color: colors.warning,
  },
  emptyCard: {
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  emptyText: {
    ...typography.lede,
    color: colors.muted,
  },
  bento: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  tile: {
    flexGrow: 1,
    flexBasis: '30%',
    minHeight: 112,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: 6,
    ...elevation.card,
  },
  tileWide: {
    flexBasis: '100%',
  },
  tileAttention: {
    borderColor: colors.warning,
  },
  tileLabel: {
    ...typography.legend,
    color: colors.muted,
  },
  tileValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 7,
  },
  tileValue: {
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '700',
    color: colors.text,
  },
  tileUnit: {
    ...typography.hint,
    color: colors.faint,
  },
  tileHint: {
    ...typography.hint,
    color: colors.faint,
    marginTop: 'auto',
  },
  greyed: {
    opacity: 0.45,
  },
  panel: {
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.md,
    ...elevation.card,
  },
  panelHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  panelValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginTop: 6,
  },
  panelValue: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
    color: colors.text,
  },
  panelHeadText: {
    flexShrink: 1,
  },
  panelMissing: {
    ...typography.hint,
    color: colors.faint,
    marginTop: 6,
  },
  panelToday: {
    ...typography.hint,
    color: colors.accentText,
  },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    height: 120,
  },
  chartColumn: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
    gap: 6,
  },
  chartBarArea: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  chartBar: {
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
    width: '100%',
  },
  chartLabel: {
    ...typography.hint,
    color: colors.faint,
    textAlign: 'center',
  },
  chartLabelToday: {
    color: colors.accentText,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionButton: {
    flex: 1,
  },
  syncline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  syncCheck: {
    ...typography.hint,
    color: colors.faint,
  },
  syncCheckOk: {
    color: colors.ok,
  },
  dock: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSunken,
  },
  tabbar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: 2,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    borderRadius: radius.md,
  },
  tabCurrent: {
    // The artboard marks the current tab with a top accent bar and accent text.
    borderTopWidth: 2,
    borderTopColor: colors.accent,
  },
  tabGlyph: {
    fontSize: 17,
    color: colors.faint,
  },
  tabGlyphCurrent: {
    color: colors.accentText,
  },
  tabLabel: {
    ...typography.hint,
    color: colors.faint,
  },
  tabLabelCurrent: {
    color: colors.accentText,
  },
});
