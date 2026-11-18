import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../components/ConnectionBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  type ConnectionCheck,
  type ConnectionStatus,
  CONNECTION_STATUSES,
  checkConnection,
  checkingConnection,
  connectionCopy,
  deriveConnection,
  evidenceLine,
  previewConnection,
  retryIntent,
} from '../lib/connection';
import { logger } from '../lib/logger';
import { colors, radius, spacing, typography } from '../lib/theme';
import { bridgeChannel, getActiveTunnel } from '../lib/tunnel-store';

/**
 * V20 — Global connection states (artboard
 * `design/mobile-app-core/11-global-states.html`, `docs/mobile-views-plan.md`
 * §V20).
 *
 * Rendering shell only. The status derivation, the es-AR copy and the retry
 * descriptor live in `mobile/lib/connection.ts` (pinned by
 * `mobile/test/connection.test.mjs`); the banner is
 * `mobile/components/ConnectionBanner.tsx`, the same one every connected screen
 * will embed once it is wired.
 *
 * This screen is the QA harness for the states until then:
 *
 * - the *live* banner runs one real `GET /api/health` over the current tunnel
 *   channel (`bridgeChannel()`), so `offline`, `live`, `incompatible`,
 *   `unauthorized` and `stale` here are conclusions from real evidence, never a
 *   simulation;
 * - the *vista previa* strip below renders the documented copy of all seven
 *   §V20 states so the copy can be reviewed without breaking a real connection;
 * - `Reintentar` re-runs `checkConnection` — the SSH reconnect itself is not
 *   built yet, and the retry descriptor says so (`pending: true`);
 * - every failure is logged under the `connection` tag.
 */

const log = logger.tag('connection');

/** One documented preview case of the QA strip. */
function PreviewCase({ status }: { status: ConnectionStatus }) {
  const model = useMemo(() => previewConnection(status), [status]);
  const copy = useMemo(() => connectionCopy(model), [model]);
  const retry = useMemo(() => retryIntent(model), [model]);
  const evidence = evidenceLine(model);

  return (
    <View style={styles.case} testID={`connection-preview-${status}`}>
      <Text style={styles.caseLabel}>
        vista previa · <Text style={styles.caseStatus}>{status}</Text>
      </Text>
      <ConnectionBanner copy={copy} busy={status === 'connecting'} testID={`connection-state-${status}`} />
      <Text style={styles.caseNote}>
        {`reintento: ${retry.kind} · pendiente: ${retry.pending ? 'sí' : 'no'}`}
      </Text>
      {evidence !== null && <Text style={styles.caseEvidence}>{evidence}</Text>}
    </View>
  );
}

export default function ConnectionStatesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const lastGoodAt = useRef<number | null>(null);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (reason: string) => {
    const tunnel = getActiveTunnel();
    const host = tunnel?.host ?? null;
    log.info('check-connection', { reason, host, tunnel: tunnel !== null });
    setBusy(true);
    try {
      const result = await checkConnection(bridgeChannel(), {
        host,
        lastGoodAt: lastGoodAt.current,
      });
      // Only a real identity answer moves the stale baseline.
      if (result.model.status === 'live') {
        lastGoodAt.current = result.at;
      }
      setCheck(result);
    } catch (error) {
      // checkConnection never throws by design; an unexpected throw is still
      // logged and rendered honestly instead of pretending to be online.
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
    void run('mount');
  }, [run]);

  const tunnel = getActiveTunnel();
  const host = tunnel?.host ?? null;
  const liveCopy = busy
    ? connectionCopy(checkingConnection(), { host })
    : (check?.copy ?? connectionCopy(previewConnection('unknown'), { host }));
  const liveModel = busy ? checkingConnection() : (check?.model ?? previewConnection('unknown'));
  const liveEvidence = evidenceLine(liveModel);
  const liveRetry = busy ? null : (check?.retry ?? null);

  const retry = useCallback(() => {
    void run('retry');
  }, [run]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    log.warn('route pending', { route: '/overview', reason: 'no-back-stack' });
    router.replace('/overview');
  }, [router]);

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
            Estados globales
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            galería de referencia · V20
          </Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.section}>
          <Text style={styles.eyebrow}>Estado actual</Text>
          <ConnectionBanner
            copy={liveCopy}
            busy={busy}
            note={liveRetry !== null && liveRetry.pending ? liveRetry.note : null}
            onRetry={busy ? undefined : retry}
            testID="connection-live-banner"
          />
          <View style={styles.evidenceCard}>
            <Text style={styles.evidenceLine}>
              {liveEvidence ?? 'Sin evidencia todavía: no hay identidad del puente.'}
            </Text>
            <Text style={styles.caseNote}>
              {tunnel === null
                ? 'sin túnel abierto en esta sesión de la app'
                : `túnel abierto hacia ${host ?? 'la PC'}`}
            </Text>
          </View>
          <PrimaryButton label="Reintentar" loading={busy} onPress={retry} />
        </View>

        <View style={styles.section}>
          <Text style={styles.eyebrow}>Vista previa de cada estado</Text>
          <Text style={styles.meta}>
            Copy documentado de los siete estados §V20. El banner de arriba es el único que
            responde a evidencia real del túnel.
          </Text>
          {CONNECTION_STATUSES.map((status) => (
            <PreviewCase key={status} status={status} />
          ))}
        </View>

        <Text style={styles.footer}>
          Cada pantalla conectada (V5, V6, V7, V9, V13, V18) embebe este mismo banner cuando exista
          el canal de reconexión: el estado viene de `checkConnection` y el `Reintentar` de la
          reconexión todavía está pendiente.
        </Text>
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
    gap: spacing.xl,
  },
  section: {
    gap: spacing.md,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.faint,
  },
  evidenceCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
  },
  evidenceLine: {
    ...typography.fine,
    color: colors.muted,
  },
  case: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
  },
  caseLabel: {
    ...typography.eyebrow,
    color: colors.faint,
  },
  caseStatus: {
    color: colors.accentText,
  },
  caseNote: {
    ...typography.fine,
    color: colors.faint,
  },
  caseEvidence: {
    ...typography.fine,
    color: colors.muted,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.codeBg,
  },
  footer: {
    ...typography.fine,
    color: colors.faint,
  },
});
