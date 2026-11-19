import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import { logger } from '../lib/logger';
import {
  type BootDecision,
  type OnboardingStorage,
  bootDecision,
  readOnboarded,
} from '../lib/onboarding';
import {
  type ConnectionRecord,
  type ConnectionsStorage,
  readActiveConnection,
} from '../lib/connections';
import {
  NO_RETRY_NOTE,
  type ReconnectFailureOutcome,
  reconnectFailureCopy,
  reconnectingCopy,
  reconnectFromSaved,
} from '../lib/reconnect';
import { readChosenMode } from '../lib/suite';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * Entry route — the boot gate of S11/S12/S6 (task T17).
 *
 * | state | decision |
 * | --- | --- |
 * | first launch, no mode chosen, nothing saved | `/scan-qr` (V1) |
 * | `local` mode, nothing saved | `/overview`, no reconnect (local needs no PC, S6) |
 * | `conectado`/`ambos`, nothing saved | `/scan-qr` (V1) |
 * | onboarded, no saved connection | `/scan-qr`, the reason says the pairing is gone |
 * | onboarded, saved connection | `/overview` after a real reconnect with the stored key |
 * | paired, flag missing | `/overview` after a real reconnect (the pairing is the evidence) |
 * | saved connections, none active | `/overview`, no reconnect, the connection menu explains |
 * | reconnect failed | the real step + the real reason, a real `Reintentar`, never the onboarding |
 *
 * S12 is literal — «cuando uno ya terminó el onboarding que no pase»: the
 * onboarding is only shown when there is no saved connection at all, or when
 * the person explicitly asks to add another device. A failed reconnect is NOT a
 * reason to replay the onboarding: it keeps the person on this screen with the
 * failing step, the core's message and a working retry (the escape hatch to
 * pairing is an explicit tap, and it never deletes the saved devices).
 *
 * S6 is the other half of the product: a phone that chose `local` needs no PC,
 * so with nothing saved it enters the app and never reconnects — no fake
 * «Reconectando» without a PC, and never a QR screen in front of local projects.
 *
 * The decision itself lives in `lib/onboarding.ts` (`bootDecision`), the mode
 * reader in `lib/suite.ts` (`readChosenMode`) and the reconnect in
 * `lib/reconnect.ts`, both pure/injected; this screen is the shell.
 */

/** What the entry is doing right now. */
type BootState =
  | { kind: 'reading' }
  | { kind: 'onboarding'; route: string }
  | { kind: 'connecting'; record: ConnectionRecord }
  | { kind: 'failed'; record: ConnectionRecord; outcome: ReconnectFailureOutcome }
  | { kind: 'home' };

/** What is really happening while the key-only session opens. */
const CONNECTING_NOTE = 'Usando la llave guardada de este teléfono. No hace falta el QR.';

export default function Index() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const log = useMemo(() => logger.tag('entry'), []);
  const mounted = useRef(true);
  const [state, setState] = useState<BootState>({ kind: 'reading' });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Opens the real key-only session for one saved connection. */
  const attempt = useCallback(
    async (record: ConnectionRecord) => {
      setState({ kind: 'connecting', record });
      log.info('reconectando', { host: record.host, port: record.port, user: record.user });
      const outcome = await reconnectFromSaved({
        storage: AsyncStorage as unknown as ConnectionsStorage,
        log,
      });
      if (!mounted.current) {
        return;
      }
      if (outcome.kind === 'connected') {
        setState({ kind: 'home' });
        return;
      }
      setState({ kind: 'failed', record, outcome });
    },
    [log],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      const storage = AsyncStorage as unknown as OnboardingStorage;
      // The mode is a boot input like the flag and the saved device: it is what
      // tells a `local` phone it needs no PC at all (S6).
      const onboarded = await readOnboarded(storage, log);
      const mode = await readChosenMode(storage, log);
      const saved = await readActiveConnection(
        AsyncStorage as unknown as ConnectionsStorage,
        log,
      );
      if (!alive) {
        return;
      }
      const decision: BootDecision = bootDecision({
        onboarded,
        mode,
        connection: saved.active,
        saved: saved.records.length,
      });
      log.info('decisión de arranque', {
        kind: decision.kind,
        route: decision.route,
        reconnect: decision.reconnect,
        reason: decision.reason,
        onboarded,
        mode,
        saved: saved.records.length,
        active: saved.active?.id ?? null,
      });

      if (decision.kind === 'onboarding' || !decision.reconnect || decision.connection === null) {
        // No pairing at all (onboarding), a `local` phone (home, nothing to
        // reconnect to), or saved devices without an active one: the home screen
        // says so and the connection menu lets the person pick — the onboarding
        // never replays on its own (S12).
        setState(
          decision.kind === 'onboarding'
            ? { kind: 'onboarding', route: decision.route }
            : { kind: 'home' },
        );
        return;
      }

      // S12: a saved pairing reconnects by itself, on this screen, with the
      // honest in-flight copy — never by sending the person back to V1.
      void attempt(decision.connection as ConnectionRecord);
    })();
    return () => {
      alive = false;
    };
  }, [attempt, log]);

  if (state.kind === 'reading') {
    // One frame of nothing beats a visible redirect to the wrong screen.
    return <View style={[styles.screen, { backgroundColor: colors.bg }]} />;
  }
  if (state.kind === 'onboarding') {
    return <Redirect href={state.route} />;
  }
  if (state.kind === 'home') {
    return <Redirect href="/overview" />;
  }

  const record = state.record;
  const copy = state.kind === 'failed' ? reconnectFailureCopy(state.outcome) : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.card}>
        <View style={styles.brand} importantForAccessibility="no-hide-descendants">
          <Text style={styles.brandPi} accessibilityElementsHidden>
            π
          </Text>
        </View>

        {state.kind === 'connecting' ? (
          <>
            <Text style={typography.eyebrow}>conexión guardada</Text>
            <Text style={styles.title} accessibilityRole="header">
              {reconnectingCopy(record.host)}
            </Text>
            <View style={styles.spinnerRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.meta}>
                {record.user}@{record.host}:{record.port}
              </Text>
            </View>
            <Text style={styles.note}>{CONNECTING_NOTE}</Text>
          </>
        ) : (
          <>
            <Text style={typography.eyebrow}>conexión guardada</Text>
            <Text style={styles.title} accessibilityRole="header">
              {copy === null ? 'No pudimos reconectar' : copy.title}
            </Text>
            <Text style={styles.meta}>
              {record.user}@{record.host}:{record.port}
            </Text>
            <Text style={styles.body}>{copy?.text ?? ''}</Text>
            {copy?.step !== null && copy?.step !== undefined && (
              <View style={styles.stepChip}>
                <Text style={styles.stepChipText}>paso: {copy.step}</Text>
              </View>
            )}
            {copy?.retryEnabled === true ? (
              <PrimaryButton
                label={copy.retryLabel ?? 'Reintentar'}
                onPress={() => void attempt(record)}
                style={styles.action}
              />
            ) : (
              <Text style={styles.note}>{NO_RETRY_NOTE}</Text>
            )}
            <GhostButton
              label={copy?.escapeLabel ?? 'Agregar otro dispositivo'}
              accessibilityHint="Abre el onboarding SSH sin borrar las conexiones guardadas"
              onPress={() => {
                log.info('escape al onboarding', { host: record.host });
                router.push('/scan-qr');
              }}
              style={styles.action}
            />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
    justifyContent: 'center',
  },
  card: {
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.xl,
    gap: spacing.sm,
    ...elevation.card,
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
    marginBottom: spacing.sm,
  },
  brandPi: {
    color: colors.accent,
    fontSize: 20,
    fontWeight: '700',
  },
  title: {
    ...typography.h1,
    color: colors.text,
  },
  meta: {
    ...typography.hint,
    color: colors.muted,
  },
  body: {
    ...typography.lede,
    color: colors.text,
  },
  note: {
    ...typography.hint,
    color: colors.faint,
  },
  spinnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
  stepChipText: {
    ...typography.hint,
    color: colors.danger,
  },
  action: {
    marginTop: spacing.sm,
  },
});
