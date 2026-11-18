import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../components/ConnectionBanner';
import { GhostButton } from '../components/GhostButton';
import {
  type ConnectionCheck,
  checkConnection,
  checkingConnection,
  connectionCopy,
  deriveConnection,
  previewConnection,
  retryIntent,
} from '../lib/connection';
import { logger } from '../lib/logger';
import {
  type AppInfo,
  type SettingsAction,
  type SettingsRow,
  type SettingsSection,
  type SettingsTone,
  type SettingsViewModel,
  type TunnelSnapshot,
  SETTINGS_TITLE,
  loadSettings,
} from '../lib/settings';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';
import { bridgeChannel, getActiveTunnel } from '../lib/tunnel-store';

/**
 * V18 — Settings (artboard `design/mobile-app-core/10-settings.html`,
 * `docs/mobile-views-plan.md` §V18, task T7i).
 *
 * Rendering shell only: the mode, the three suite components, the tunnel
 * identity, the diagnostics facts and the export copy are derived in
 * `mobile/lib/settings.ts` and pinned by `mobile/test/settings.test.mjs`.
 *
 * Everything on this screen is real state already on the phone:
 *
 * - `gentle-movil:mode` and `gentle-movil:suite` are read straight from
 *   AsyncStorage (written by V4 and V21) — an empty store is `Sin elegir` +
 *   `No instalado`, and a corrupt one renders the honest storage error with
 *   `Reintentar` instead of pretending nothing is installed;
 * - the tunnel row shows what `getActiveTunnel()` really holds (host, forwarded
 *   port, native session) and `Sin túnel` when the pairing flow opened none;
 * - the banner is the shared §V20 `ConnectionBanner` fed by a real
 *   `GET /api/health` over the current tunnel channel;
 * - the diagnostics row carries the real `logs/gentle-movil.log`, ring capacity
 *   and rotation limit of `lib/logger.ts`.
 *
 * Every action whose destination is not built yet is `pending: true` in the
 * model, so tapping it logs `route pending` and the row keeps the honest note —
 * it never navigates to a screen that would not do what the label promises.
 */

const log = logger.tag('settings');

/** Chip tones as tokens (never raw hex). */
const TONES: Record<SettingsTone, { border: string; background: string; text: string }> = {
  ok: { border: colors.ok, background: colors.okSoft, text: colors.ok },
  warning: { border: colors.warning, background: colors.warningSoft, text: colors.warning },
  danger: { border: colors.danger, background: colors.dangerSoft, text: colors.danger },
  muted: { border: colors.border, background: colors.bgSunken, text: colors.muted },
};

/** App/build info the screen can honestly know (`app.json` via expo-constants). */
function appInfo(): AppInfo {
  const config = Constants.expoConfig;
  const version = typeof config?.version === 'string' ? config.version.trim() : '';
  const iosBuild = config?.ios?.buildNumber;
  const androidBuild = config?.android?.versionCode;
  const build =
    typeof iosBuild === 'string' && iosBuild.trim() !== ''
      ? iosBuild.trim()
      : typeof androidBuild === 'number'
        ? String(androidBuild)
        : null;
  return { version: version === '' ? null : version, build };
}

/** The tunnel the pairing flow left open, as `lib/settings.ts` models it. */
function tunnelSnapshot(): TunnelSnapshot | null {
  const active = getActiveTunnel();
  if (active === null) {
    return null;
  }
  return {
    sessionId: active.sessionId,
    host: active.host,
    ports: [active.httpChannel.port],
  };
}

function SkeletonCard() {
  return (
    <View style={styles.skeletonCard} accessibilityElementsHidden>
      <View style={[styles.skeletonBar, { width: '45%' }]} />
      <View style={[styles.skeletonBar, { width: '75%' }]} />
    </View>
  );
}

function RowView({
  row,
  first,
  onAction,
}: {
  row: SettingsRow;
  first: boolean;
  onAction: (action: SettingsAction) => void;
}) {
  const tone = TONES[row.tone];
  const action = row.action;

  return (
    <View style={[styles.row, first && styles.rowFirst]} testID={`settings-row-${row.id}`}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{row.title}</Text>
        {row.detail !== null && <Text style={styles.rowSub}>{row.detail}</Text>}
        {action !== null && action.pending && action.note !== null && (
          <Text style={styles.rowNote}>{action.note}</Text>
        )}
      </View>

      {row.value !== '' && (
        <View style={[styles.chip, { borderColor: tone.border, backgroundColor: tone.background }]}>
          <Text style={[styles.chipText, { color: tone.text }]} numberOfLines={1}>
            {row.value}
          </Text>
        </View>
      )}

      {action !== null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action.label}: ${row.title}`}
          onPress={() => onAction(action)}
          style={({ pressed }) => [styles.linkButton, pressed && styles.linkButtonPressed]}>
          <Text style={[styles.linkLabel, action.pending && styles.linkLabelPending]}>
            {action.label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function SectionView({
  section,
  onAction,
}: {
  section: SettingsSection;
  onAction: (action: SettingsAction) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.legend}>{section.title}</Text>
      <View style={styles.card}>
        {section.rows.map((row, index) => (
          <RowView
            key={`${section.id}-${row.id}`}
            row={row}
            first={index === 0}
            onAction={onAction}
          />
        ))}
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const lastGoodAt = useRef<number | null>(null);
  const [vm, setVm] = useState<SettingsViewModel | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadFailure(null);
    try {
      setVm(
        await loadSettings((key) => AsyncStorage.getItem(key), {
          tunnel: tunnelSnapshot(),
          app: appInfo(),
        }),
      );
    } catch (error) {
      // loadSettings never throws by design; an unexpected throw is still
      // rendered honestly instead of leaving the screen silently empty.
      log.failure('load-settings', error, null);
      setLoadFailure(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const runCheck = useCallback(async (reason: string) => {
    const tunnel = getActiveTunnel();
    const host = tunnel?.host ?? null;
    log.info('check-connection', { reason, host, tunnel: tunnel !== null });
    setBusy(true);
    try {
      const result = await checkConnection(bridgeChannel(), {
        host,
        lastGoodAt: lastGoodAt.current,
      });
      if (result.model.status === 'live') {
        lastGoodAt.current = result.at;
      }
      setCheck(result);
    } catch (error) {
      log.failure('check-connection', error, null);
      const model = deriveConnection({
        tunnel: bridgeChannel() !== null,
        failure: {
          kind: 'bad-response',
          message: 'No pudimos verificar el puente.',
          raw: String(error),
        },
      });
      setCheck({
        model,
        copy: connectionCopy(model, { host }),
        retry: retryIntent(model),
        at: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void runCheck('mount');
  }, [load, runCheck]);

  /** A pending destination says so; the wired one (storage retry) re-reads. */
  const onAction = useCallback(
    (action: SettingsAction) => {
      log.info('action tap', { label: action.label, route: action.route, pending: action.pending });
      if (action.pending) {
        log.warn('route pending', { route: action.route, reason: 'destination-not-built' });
        return;
      }
      void load();
    },
    [load],
  );

  const retryConnection = useCallback(() => {
    void runCheck('retry');
  }, [runCheck]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    log.warn('route pending', { route: '/overview', reason: 'no-back-stack' });
    router.replace('/overview');
  }, [router]);

  const host = getActiveTunnel()?.host ?? null;
  const liveCopy = busy
    ? connectionCopy(checkingConnection(), { host })
    : (check?.copy ?? connectionCopy(previewConnection('unknown'), { host }));
  const liveRetry = busy ? null : (check?.retry ?? null);
  const version = appInfo().version;

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
            {SETTINGS_TITLE}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {version === null ? 'Gentle Movil' : `Gentle Movil ${version}`}
          </Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <ConnectionBanner
          copy={liveCopy}
          busy={busy}
          note={liveRetry !== null && liveRetry.pending ? liveRetry.note : null}
          onRetry={busy ? undefined : retryConnection}
          testID="settings-connection-banner"
        />

        {vm !== null && vm.storageError !== null && (
          <View style={styles.errorCard} accessibilityRole="alert" testID="settings-storage-error">
            <Text style={styles.errorTitle}>{vm.storageError.title}</Text>
            <Text style={styles.errorBody}>{vm.storageError.detail}</Text>
            <GhostButton label={vm.storageError.action.label} onPress={() => void load()} />
          </View>
        )}

        {loadFailure !== null && (
          <View style={styles.errorCard} accessibilityRole="alert" testID="settings-load-error">
            <Text style={styles.errorTitle}>No pudimos leer los ajustes</Text>
            <Text style={styles.errorBody}>{loadFailure}</Text>
            <GhostButton label="Reintentar" onPress={() => void load()} />
          </View>
        )}

        {vm === null && loadFailure === null && (
          <View style={styles.section}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {vm !== null &&
          vm.sections.map((section) => (
            <SectionView key={section.id} section={section} onAction={onAction} />
          ))}

        {vm !== null && (
          <View style={styles.exportCard}>
            <Text style={styles.legend}>Texto del diagnóstico</Text>
            <Text style={styles.exportText} selectable testID="settings-export-text">
              {vm.exportText}
            </Text>
            <Text style={styles.meta}>Compartir todavía no está conectado (pending).</Text>
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
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  section: {
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  legend: {
    ...typography.legend,
    color: colors.muted,
  },
  card: {
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    ...elevation.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowFirst: {
    borderTopWidth: 0,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...typography.label,
    color: colors.text,
  },
  rowSub: {
    ...typography.fine,
    color: colors.faint,
  },
  rowNote: {
    ...typography.fine,
    color: colors.warning,
  },
  chip: {
    flexShrink: 1,
    paddingHorizontal: 10,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: {
    ...typography.hint,
    fontWeight: '600',
  },
  linkButton: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
  },
  linkButtonPressed: {
    borderColor: colors.accent,
  },
  linkLabel: {
    ...typography.hint,
    fontWeight: '600',
    color: colors.muted,
  },
  linkLabelPending: {
    color: colors.faint,
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
  errorBody: {
    ...typography.body,
    color: colors.muted,
  },
  skeletonCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    opacity: 0.5,
  },
  skeletonBar: {
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
  },
  exportCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
  },
  exportText: {
    ...typography.fine,
    color: colors.muted,
  },
});
