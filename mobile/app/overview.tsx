import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import { logger } from '../lib/logger';
import {
  type ChartBar,
  type ConnectionChip,
  type LoadOverview,
  type OverviewAction,
  type OverviewStateModel,
  type OverviewViewModel,
  type OverviewTile,
  buildOverview,
  connectionChip,
} from '../lib/overview';
import {
  type ConnectionAction,
  type ConnectionRecord,
  type ConnectionsStorage,
  connectionActions,
  connectionRows,
  readActiveConnection,
  setActiveConnection,
} from '../lib/connections';
import {
  NO_RETRY_NOTE,
  type ReconnectFailureOutcome,
  reconnectFailureCopy,
  reconnectingCopy,
  reconnectFromSaved,
} from '../lib/reconnect';
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

/**
 * The connection chip: the state of the tunnel (S11) and the door to the
 * connection menu — Reconectar / Cambiar de conexión / Agregar otro
 * dispositivo. The copy comes from `connectionChip` in `lib/overview.ts`, so it
 * can never claim `Live` while the screen is offline.
 */
function PairChip({
  vm,
  host,
  onPress,
}: {
  vm: OverviewViewModel;
  host: string | null;
  onPress: () => void;
}) {
  const chip: ConnectionChip = connectionChip(vm, host);
  const dotColor = chip.dot === 'green' ? colors.ok : colors.faint;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={chip.accessibilityLabel}
      accessibilityHint={chip.accessibilityHint}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.pair, pressed && styles.pairPressed]}>
      <View style={[styles.pairDot, { backgroundColor: dotColor }]} />
      <Text style={styles.pairText}>{chip.text}</Text>
    </Pressable>
  );
}

/** What the menu is doing right now (one reconnect at a time). */
type MenuRun =
  | { kind: 'idle' }
  | { kind: 'running'; host: string }
  | { kind: 'failed'; outcome: ReconnectFailureOutcome }
  | { kind: 'done'; host: string };

/** The registry as the menu reads it (nothing is guessed locally). */
type MenuRegistry = {
  ok: boolean;
  records: ConnectionRecord[];
  active: ConnectionRecord | null;
  repaired: boolean;
};

/** Honest note under `Agregar otro dispositivo` (it never deletes what is saved). */
const ADD_DEVICE_NOTE =
  'Abre el onboarding SSH. Las conexiones guardadas no se borran: el dispositivo nuevo se suma.';

/**
 * The connection menu of S11. Three real actions over the persisted registry:
 * Reconectar (the active device, key-only), Cambiar de conexión (pick among the
 * saved devices, which saves the active id) and Agregar otro dispositivo (the
 * SSH onboarding, additive). An action that cannot run renders the real reason
 * instead of a disabled button with no explanation, and every state is the
 * outcome of a real `reconnectFromSaved` call.
 */
function ConnectionMenu({
  visible,
  onClose,
  onConnected,
}: {
  visible: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const router = useRouter();
  const [registry, setRegistry] = useState<MenuRegistry | null>(null);
  const [run, setRun] = useState<MenuRun>({ kind: 'idle' });
  const [showList, setShowList] = useState(false);

  const load = useCallback(async (): Promise<MenuRegistry> => {
    const read = await readActiveConnection(AsyncStorage as unknown as ConnectionsStorage, log);
    setRegistry(read);
    return read;
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setRun({ kind: 'idle' });
    void (async () => {
      const read = await load();
      setShowList(read.records.length > 1);
    })();
  }, [load, visible]);

  const connect = useCallback(
    async (record: ConnectionRecord) => {
      setRun({ kind: 'running', host: record.host });
      const outcome = await reconnectFromSaved({
        storage: AsyncStorage as unknown as ConnectionsStorage,
        log,
      });
      if (outcome.kind === 'connected') {
        await load();
        setRun({ kind: 'done', host: outcome.record.host });
        onConnected();
        return;
      }
      setRun({ kind: 'failed', outcome });
    },
    [load, onConnected],
  );

  /** Cambiar de conexión: saves the active id, then really reconnects with it. */
  const choose = useCallback(
    async (record: ConnectionRecord) => {
      const active = await setActiveConnection(
        AsyncStorage as unknown as ConnectionsStorage,
        record.id,
        log,
      );
      if (!active.ok) {
        log.warn('no se pudo cambiar de conexión', { id: record.id, reason: active.reason });
        await load();
        return;
      }
      await load();
      await connect(record);
    },
    [connect, load],
  );

  const records = registry?.records ?? [];
  const active = registry?.active ?? null;
  const actions: ConnectionAction[] = connectionActions(records, active);
  const rows = connectionRows(records, active?.id ?? null);
  // One row per saved record, in stored order: the record itself is what the tap
  // activates (the row is only its presentation).
  const listed = records.map((record, index) => ({ record, row: rows[index] }));
  const failure = run.kind === 'failed' ? reconnectFailureCopy(run.outcome) : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle} accessibilityRole="header">
              Conexión
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cerrar el menú de conexión"
              onPress={onClose}
              hitSlop={10}>
              <Text style={styles.modalClose}>Cerrar</Text>
            </Pressable>
          </View>

          {registry === null && (
            <View style={styles.modalState}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.meta}>Leyendo las conexiones guardadas…</Text>
            </View>
          )}

          {registry !== null && !registry.ok && (
            <Text style={styles.modalMissing}>
              sin datos · no pudimos leer las conexiones guardadas de este teléfono
            </Text>
          )}

          {registry !== null && registry.ok && active === null && records.length === 0 && (
            <Text style={styles.modalMissing}>
              sin datos · no hay ninguna conexión guardada: emparejá un dispositivo
            </Text>
          )}

          {active !== null && (
            <View style={styles.modalActive}>
              <Text style={styles.modalActiveLabel}>Conexión activa</Text>
              <Text style={styles.modalActiveHost}>{active.label}</Text>
              <Text style={styles.meta}>
                {active.user}@{active.host}:{active.port}
              </Text>
              <Text style={styles.modalFingerprint}>huella host · {active.fingerprint}</Text>
              {active.deviceKeyFingerprint !== '' && (
                <Text style={styles.modalFingerprint}>
                  llave del teléfono · {active.deviceKeyFingerprint}
                </Text>
              )}
            </View>
          )}

          {registry !== null && registry.ok && active === null && records.length > 0 && (
            <Text style={styles.modalMissing}>
              sin datos · ninguna conexión está marcada como activa: elegí una de la lista
            </Text>
          )}

          {actions.map((action) =>
            action.enabled ? (
              <View key={action.id} style={styles.modalAction}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  onPress={() => {
                    if (action.id === 'reconnect' && active !== null) {
                      void connect(active);
                      return;
                    }
                    if (action.id === 'switch') {
                      setShowList((previous) => !previous);
                      return;
                    }
                    log.info('agregar otro dispositivo', { saved: records.length });
                    onClose();
                    router.push('/scan-qr');
                  }}
                  style={({ pressed }) => [
                    styles.modalActionRow,
                    styles.modalActionEnabled,
                    pressed && styles.modalActionPressed,
                  ]}>
                  <Text style={styles.modalActionLabel}>{action.label}</Text>
                </Pressable>
                {action.id === 'add-device' && (
                  <Text style={styles.modalReason}>{ADD_DEVICE_NOTE}</Text>
                )}
              </View>
            ) : (
              // Not a button with no explanation: the reason IS the answer.
              <View key={action.id} style={styles.modalAction}>
                <View style={[styles.modalActionRow, styles.modalActionUnavailable]}>
                  <Text style={styles.modalActionLabelOff}>{action.label}</Text>
                </View>
                <Text style={styles.modalReason}>{action.reason}</Text>
              </View>
            ),
          )}

          {run.kind === 'running' && (
            <View style={styles.modalState}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.meta}>{reconnectingCopy(run.host)}</Text>
            </View>
          )}

          {run.kind === 'done' && (
            <Text style={styles.modalDone}>Reconectado con {run.host}</Text>
          )}

          {failure !== null && (
            <View style={styles.modalFailure}>
              <Text style={styles.modalFailureTitle}>{failure.title}</Text>
              <Text style={styles.modalFailureText}>{failure.text}</Text>
              {failure.step !== null && (
                <Text style={styles.modalReason}>paso: {failure.step}</Text>
              )}
              {failure.retryEnabled ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={failure.retryLabel ?? 'Reintentar'}
                  onPress={() => {
                    if (active !== null) {
                      void connect(active);
                    }
                  }}
                  style={({ pressed }) => [styles.modalRetry, pressed && styles.modalActionPressed]}>
                  <Text style={styles.modalRetryLabel}>{failure.retryLabel ?? 'Reintentar'}</Text>
                </Pressable>
              ) : (
                <Text style={styles.modalReason}>{NO_RETRY_NOTE}</Text>
              )}
            </View>
          )}

          {showList && listed.length > 0 && (
            <View style={styles.modalList}>
              <Text style={typography.eyebrow}>Dispositivos guardados</Text>
              {listed.map(({ record, row }) =>
                row === undefined ? null : (
                  <Pressable
                    key={row.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: row.active }}
                    accessibilityLabel={`${row.label}${row.active ? ' · conexión activa' : ''}`}
                    accessibilityHint="Cambia la conexión activa y reconecta con su llave guardada"
                    onPress={() => void choose(record)}
                    style={({ pressed }) => [
                      styles.modalRow,
                      row.active && styles.modalRowActive,
                      pressed && styles.modalActionPressed,
                    ]}>
                    <View style={styles.modalRowText}>
                      <Text style={styles.modalRowLabel}>{row.label}</Text>
                      <Text style={styles.meta}>{row.detail}</Text>
                    </View>
                    {row.active && <Text style={styles.modalActiveMark}>activa</Text>}
                  </Pressable>
                ),
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
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
      accessibilityLabel={`${tile.label}: ${tile.count === null ? 'sin datos' : tile.count}`}
      onPress={() => onOpen(tile.route, tile.id)}
      style={[
        styles.tile,
        tile.wide && styles.tileWide,
        tile.attention && styles.tileAttention,
        greyed && styles.greyed,
      ]}>
      <Text style={styles.tileLabel}>{tile.label}</Text>
      <View style={styles.tileValueRow}>
        <Text style={styles.tileValue}>
          {tile.count === null ? '—' : tile.count}
        </Text>
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
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false);

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
        <PairChip
          vm={vm}
          host={vm.data?.paired.host ?? null}
          onPress={() => {
            log.info('abrir menú de conexión', { state: vm.state });
            setConnectionMenuOpen(true);
          }}
        />
      </View>

      <ConnectionMenu
        visible={connectionMenuOpen}
        onClose={() => setConnectionMenuOpen(false)}
        onConnected={() => void load(true)}
      />

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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(6,4,7,0.82)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.bento,
    borderTopRightRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    gap: spacing.sm,
    ...elevation.card,
  },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  modalTitle: {
    ...typography.h1,
    fontSize: 17,
    lineHeight: 22,
  },
  modalClose: {
    ...typography.hint,
    color: colors.accentText,
  },
  modalState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  modalMissing: {
    ...typography.hint,
    color: colors.faint,
  },
  modalActive: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: 2,
  },
  modalActiveLabel: {
    ...typography.legend,
    color: colors.muted,
  },
  modalActiveHost: {
    ...typography.h1,
    fontSize: 15,
    lineHeight: 20,
  },
  modalFingerprint: {
    ...typography.hint,
    color: colors.faint,
  },
  modalAction: {
    gap: 2,
  },
  modalActionRow: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  modalActionEnabled: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.accentSoft,
  },
  modalActionUnavailable: {
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  modalActionPressed: {
    opacity: 0.7,
  },
  modalActionLabel: {
    ...typography.lede,
    color: colors.text,
  },
  modalActionLabelOff: {
    ...typography.lede,
    color: colors.faint,
  },
  modalReason: {
    ...typography.hint,
    color: colors.faint,
  },
  modalDone: {
    ...typography.hint,
    color: colors.ok,
  },
  modalFailure: {
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  modalFailureTitle: {
    ...typography.lede,
    color: colors.text,
  },
  modalFailureText: {
    ...typography.hint,
    color: colors.muted,
  },
  modalRetry: {
    alignSelf: 'flex-start',
    marginTop: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  modalRetryLabel: {
    ...typography.hint,
    color: colors.text,
  },
  modalList: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
  },
  modalRowActive: {
    borderColor: colors.accent,
  },
  modalRowText: {
    flexShrink: 1,
    gap: 2,
  },
  modalRowLabel: {
    ...typography.lede,
    color: colors.text,
  },
  modalActiveMark: {
    ...typography.hint,
    color: colors.accentText,
  },
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
  pairPressed: {
    borderColor: colors.borderStrong,
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
