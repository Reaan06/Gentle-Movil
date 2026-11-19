import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GhostButton } from '../components/GhostButton';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rememberPairing } from '../lib/connections';
import { httpChannelOf, setActiveTunnel } from '../lib/tunnel-store';
import { PrimaryButton } from '../components/PrimaryButton';
import { deviceKeyEnsure, type PairInfo, type SshCredential } from '../lib/core';
import { logger } from '../lib/logger';
import {
  PROVISION_ROWS,
  overallPercent,
  provisionFlow,
  rowForStep,
  type ProvisionRow,
  type ProvisionStep,
} from '../lib/provision';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V3 — Pairing progress (artboard
 * `design/mobile-app-onboarding/03-pairing-progress.html`, protocol §2–§4).
 *
 * The screen owns no state machine: `lib/provision.ts` runs
 * connect → fingerprint → detect → register → tunnel over SSH (pivote sin
 * daemon, `odd/tasks/gentle-movil-pivote.md` S4/S5), and this view only paints
 * the five visible rows, the step-based progress bar and the failure callout.
 * Every step transition is a real event of that pipeline — there is no
 * timer-driven fake progress.
 *
 * Failure path: the callout head is the verbatim reason the core returned,
 * `provision.ts` already recorded it with `logger.failure` (`{step, error,
 * raw}`), and **Reintentar** re-runs the pipeline.
 */

const EYEBROW = 'conexión · paso 2 de 2';
const TITLE = 'Emparejando tu computadora';

/** Live detail line of each step (artboard: one line per row). */
const STEP_COPY: Record<ProvisionStep, string> = {
  connect: 'Abriendo la conexión segura…',
  fingerprint: 'Comparando la huella del QR con la del host…',
  detect: 'Buscando la extensión de Pi en tu computadora…',
  register: 'Instalando tu clave ed25519 en el host…',
  tunnel: 'Abriendo el túnel a la extensión…',
};

type RowState = 'pending' | 'active' | 'done' | 'failed';
type Rows = Record<ProvisionRow, RowState>;
type Status = 'running' | 'ok' | 'failed' | 'missing';

const initialRows = (): Rows => ({
  connect: 'pending',
  fingerprint: 'pending',
  detect: 'pending',
  register: 'pending',
  tunnel: 'pending',
});

const ROW_TEXT: Record<ProvisionRow, { title: string; pending: string; done: string }> = {
  connect: { title: 'Conectado por SSH', pending: 'Abriendo la conexión segura', done: 'sesión SSH abierta' },
  fingerprint: {
    title: 'Huella verificada',
    pending: 'Compará con la que muestra tu computadora',
    done: 'ed25519 coincide',
  },
  detect: {
    title: 'Extensión Pi detectada',
    pending: 'Buscándola en el loopback de tu computadora',
    done: 'escuchando en 43721 y 43722',
  },
  register: {
    title: 'Registrar dispositivo',
    pending: 'Tu clave ed25519 se guarda en el host',
    done: 'clave registrada en el host',
  },
  tunnel: {
    title: 'Túnel listo',
    pending: 'Sesiones, automatizaciones y CLI',
    done: 'canal seguro abierto',
  },
};

/** First element of a route param (expo-router may hand an array). */
function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** `SHA256:9fK2mr7Q…qE1s`-style short fingerprint of the summary / artboard. */
function shortFingerprint(fp: string): string {
  if (fp.length === 0) {
    return 'ed25519';
  }
  const head = fp.slice(0, 8);
  const tail = fp.length > 12 ? fp.slice(-4) : '';
  return fp.length > 12 ? `SHA256:${head}…${tail}` : `SHA256:${head}`;
}

/** Row mark: done check, active spinner, pending empty circle, failed cross. */
function StepMark({ state }: { state: RowState }) {
  if (state === 'active') {
    return (
      <View style={[styles.mark, styles.markActive]}>
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }
  if (state === 'failed') {
    return (
      <View style={[styles.mark, styles.markFailed]}>
        <Text style={[styles.markGlyph, styles.markGlyphFailed]}>✕</Text>
      </View>
    );
  }
  if (state === 'done') {
    return (
      <View style={[styles.mark, styles.markDone]}>
        <Text style={[styles.markGlyph, styles.markGlyphDone]}>✓</Text>
      </View>
    );
  }
  return <View style={styles.mark} />;
}

/** Top-bar status chip with the pulsing dot of the artboard. */
function StatusChip({ label, pulse }: { label: string; pulse: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, pulse]);

  return (
    <View style={styles.chip}>
      <Animated.View style={[styles.chipDot, { opacity }]} accessible={false} />
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

export default function PairingProgressScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    host?: string;
    port?: string;
    user?: string;
    token?: string;
    fp?: string;
    proto?: string;
    auth?: string;
    secret?: string;
    passphrase?: string;
    code?: string;
    pw?: string;
  }>();

  const host = single(params.host);
  const portParam = single(params.port);
  const user = single(params.user);
  const token = single(params.token);
  const fp = single(params.fp);
  const proto = single(params.proto);
  const auth = single(params.auth);
  const secret = single(params.secret);
  const passphrase = single(params.passphrase);
  // Pairing code from the QR (`gc://pair?…&code=…`). The pivot flow pairs over
  // SSH only (`connect → fingerprint → detect → register → tunnel`), so the
  // invite/code travel inside `PairInfo` for the protocol but no HTTP claim is
  // attempted: the app reaches the extension exclusively through the tunnel.
  const codeParam = single(params.code);
  const pwParam = single(params.pw);

  const log = useMemo(() => logger.tag('pairing-progress'), []);

  const pair = useMemo<PairInfo>(
    () => ({
      host,
      port: portParam === '' ? 22 : Number(portParam),
      user,
      token,
      fp,
      code: codeParam,
      // Extension device-surface port (protocol §4); the app only reaches it
      // through the SSH forward, never over the LAN.
      dport: 43722,
      pw: pwParam,
      proto,
    }),
    [codeParam, fp, host, portParam, proto, pwParam, token, user],
  );

  const credential = useMemo<SshCredential | null>(() => {
    if (secret === '') {
      return null;
    }
    if (auth === 'password') {
      return { kind: 'password', value: secret };
    }
    if (auth === 'key') {
      return { kind: 'key', path: secret, passphrase: passphrase === '' ? undefined : passphrase };
    }
    return null;
  }, [auth, passphrase, secret]);

  const [rows, setRows] = useState<Rows>(initialRows);
  const [status, setStatus] = useState<Status>('running');
  const [subLine, setSubLine] = useState('Preparando el emparejamiento…');
  const [failure, setFailure] = useState<{ label: string; reason: string; kind: string } | null>(null);
  const running = useRef(false);

  const missing = host === '' || user === '';

  const run = useCallback(async () => {
    if (running.current || missing) {
      return;
    }
    running.current = true;
    setStatus('running');
    setFailure(null);
    setRows(initialRows());
    setSubLine('Abriendo la conexión segura…');

    // The flow owns every step, connect included (S4): the core's SSH session,
    // the QR fingerprint, the extension on loopback, the phone identity in
    // `authorized_keys` and the forward to the extension ports. The identity is
    // the PERSISTED one (`deviceKeyEnsure`, seed sealed in the Keystore): the key
    // registered on the PC is the same one T17's reconnect authenticates with.
    const result = await provisionFlow(
      pair,
      credential,
      {
        onStepStart(step) {
          setRows((previous) => ({ ...previous, [rowForStep(step)]: 'active' }));
          setSubLine(STEP_COPY[step]);
        },
        onStepDone(step) {
          setRows((previous) => ({ ...previous, [rowForStep(step)]: 'done' }));
        },
        onStepError(step, error) {
          setRows((previous) => ({ ...previous, [rowForStep(step)]: 'failed' }));
          setFailure({ label: ROW_TEXT[rowForStep(step)].title, reason: error.message || error.kind, kind: error.kind });
        },
      },
      { logger: log, deviceKeyEnsure },
    );

    if (result.ok) {
      // S11/S12: a finished pairing is what makes the next launch reconnect
      // instead of asking for the QR again. Only what a key-only reconnect
      // needs is stored — the password never reaches storage.
      const remembered = await rememberPairing(
        AsyncStorage,
        { host: pair.host, port: pair.port, user: pair.user, fp: pair.fp },
        // Without this the record cannot tell "this phone no longer holds the key
        // it paired with" from "same key" — reconnect's guard stays inert.
        { deviceKeyFingerprint: result.registration?.deviceKeyFingerprint ?? '' },
      );
      if (!remembered.ok) {
        log.failure(
          'remember-connection',
          new Error(remembered.reason ?? 'no se pudo recordar la conexión'),
          { host: pair.host, port: pair.port },
        );
      }

      // Keep the handles the tunnel step left open: every connected screen
      // (Overview first) speaks HTTP through them. They are native state, so
      // a restart honestly reports "no tunnel" instead of faking one.
      const httpChannel = httpChannelOf(result.tunnel);
      if (httpChannel === null) {
        log.warn('tunnel has no HTTP channel', {
          ports: result.tunnel.channels.map((channel) => channel.port),
        });
      } else {
        setActiveTunnel({ sessionId: result.tunnel.sessionId, httpChannel, host: pair.host });
        log.info('tunnel stored', { host: pair.host, port: httpChannel.port });
      }
      setStatus('ok');
      setSubLine('Túnel listo');
    } else {
      setStatus('failed');
      setFailure({
        label: ROW_TEXT[rowForStep(result.failedStep)].title,
        reason: result.error.message || result.error.kind,
        kind: result.error.kind,
      });
    }
    running.current = false;
  }, [credential, log, missing, pair]);

  useEffect(() => {
    void run();
  }, [run]);

  // `success` state of the artboard: a short "Listo" moment, then V4.
  useEffect(() => {
    if (status !== 'ok') {
      return;
    }
    const timer = setTimeout(() => {
      router.push('/mode-choice');
    }, 1_200);
    return () => {
      clearTimeout(timer);
    };
  }, [router, status]);

  const doneRows = PROVISION_ROWS.filter((row) => rows[row] === 'done').length;
  const activeRow = PROVISION_ROWS.find((row) => rows[row] === 'active');
  const partial = activeRow === undefined ? 0 : 0.5;
  const percent = overallPercent(doneRows, PROVISION_ROWS.length, status === 'ok' ? 0 : partial);

  const chipLabel = status === 'ok' ? 'listo' : status === 'running' ? 'emparejando' : 'revisar';

  if (missing) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + spacing.xl }]}>
        <View style={styles.missing}>
          <Text style={styles.h1} accessibilityRole="header">
            Faltan los datos del emparejamiento
          </Text>
          <Text style={styles.lede}>
            No recibimos el host y el usuario de tu computadora. Volvé a escanear el QR o a escribir
            los datos.
          </Text>
          <PrimaryButton label="Escanear el QR" onPress={() => router.replace('/scan-qr')} />
          <GhostButton label="Escribir los datos" onPress={() => router.replace('/manual-ssh')} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.bar, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.brand} accessible accessibilityLabel="gentle movil">
          <View style={styles.piTile} importantForAccessibility="no-hide-descendants">
            <Text style={styles.pi} accessibilityElementsHidden>
              π
            </Text>
          </View>
          <Text style={styles.wordmark} importantForAccessibility="no">
            gentle <Text style={styles.wordmarkAccent}>movil</Text>
          </Text>
        </View>
        <StatusChip label={chipLabel} pulse={status === 'running'} />
      </View>

      <ScrollView style={styles.flex} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>{EYEBROW}</Text>
        <Text style={styles.h1} accessibilityRole="header">
          {TITLE}
        </Text>
        <View style={styles.target} accessible accessibilityLabel={`${user}@${host} · puerto ${pair.port}`}>
          <View style={styles.targetIcon} accessible={false} importantForAccessibility="no">
            <View style={styles.monitor} />
            <View style={styles.monitorStand} />
          </View>
          <Text style={styles.targetText}>
            {user}@{host} · puerto {pair.port}
          </Text>
        </View>

        <View style={styles.overall}>
          <View style={styles.overallRow}>
            <Text style={styles.overallKey}>Progreso total</Text>
            <Text style={styles.overallValue}>
              {percent}% · {doneRows} de {PROVISION_ROWS.length} pasos
            </Text>
          </View>
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityLabel="Progreso total del emparejamiento"
            accessibilityValue={{ min: 0, max: 100, now: percent }}
          >
            <View style={[styles.trackFill, { width: `${percent}%` }]} />
          </View>
        </View>

        <View style={styles.steps}>
          {PROVISION_ROWS.map((row, index) => {
            const state = rows[row];
            return (
              <View
                key={row}
                style={[
                  styles.step,
                  index === 0 && styles.stepFirst,
                  state === 'active' && styles.stepActive,
                ]}
                accessible
                accessibilityLabel={`${ROW_TEXT[row].title}: ${state === 'done' ? 'hecho' : state === 'active' ? 'en curso' : state === 'failed' ? 'falló' : 'pendiente'}`}
              >
                <StepMark state={state} />
                <View style={styles.stepBody}>
                  <Text style={[styles.stepTitle, state === 'pending' && styles.stepTitlePending]}>
                    {ROW_TEXT[row].title}
                  </Text>
                  <Text style={[styles.stepSub, row !== 'fingerprint' && styles.stepSubMono]}>
                    {state === 'active'
                      ? subLine
                      : state === 'done' && row === 'connect'
                        ? `${host}:${pair.port} · SSH`
                        : state === 'done' && row === 'fingerprint'
                          ? `${shortFingerprint(fp)} coincide`
                          : state === 'done'
                            ? ROW_TEXT[row].done
                            : ROW_TEXT[row].pending}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.stepState,
                    state === 'done' && styles.stepStateDone,
                    state === 'active' && styles.stepStateActive,
                    state === 'failed' && styles.stepStateFailed,
                  ]}
                >
                  {state === 'done' ? 'hecho' : state === 'active' ? 'en curso' : state === 'failed' ? 'falló' : 'pendiente'}
                </Text>
              </View>
            );
          })}
        </View>

        {status === 'ok' ? (
          <View style={styles.success} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Text style={styles.successTitle}>Túnel listo — emparejamiento completo</Text>
            <Text style={styles.failedBody}>
              Tu dispositivo quedó registrado en el host. Te llevamos al último paso.
            </Text>
            <PrimaryButton label="Continuar" onPress={() => router.push('/mode-choice')} />
          </View>
        ) : null}

        {failure !== null ? (
          <View style={styles.failed} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <Text style={styles.failedHead}>
              <Text style={styles.failedGlyph}>✕ </Text>
              {failure.reason}
            </Text>
            <Text style={styles.failedBody}>
              El paso «{failure.label}» se abortó y el emparejamiento quedó detenido ahí. El detalle
              completo está en el registro de la app.
            </Text>
            <View style={styles.failedActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reintentar"
                onPress={() => {
                  void run();
                }}
                style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
              >
                <Text style={styles.retryGlyph}>↺</Text>
                <Text style={styles.retryLabel}>Reintentar</Text>
              </Pressable>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Revisar el host"
                onPress={() => router.push('/manual-ssh')}
                style={styles.detailLink}
              >
                <Text style={styles.detailLinkLabel}>Revisar el host</Text>
              </Pressable>
            </View>
            {failure.kind === 'CoreUnavailable' ? (
              // Allowed "Continuar de todos modos" (`docs/mobile-views-plan.md`
              // §V3): the host is fine, the core is simply not in this build.
              <GhostButton
                label="Continuar sin emparejar"
                onPress={() => {
                  log.warn('continuando sin núcleo: el emparejamiento se retoma cuando el .so esté empaquetado');
                  router.push('/mode-choice');
                }}
                accessibilityHint="Sigue al modo de uso; el emparejamiento se completa con el núcleo"
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <GhostButton
          label="Cancelar emparejamiento"
          onPress={() => router.replace('/scan-qr')}
          accessibilityHint="Vuelve al escaneo del QR sin cerrar la sesión"
        />
        <Text style={styles.fine}>Podés salir: seguimos si volvés a esta pantalla.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.md,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
  },
  piTile: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accentSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  pi: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.accent,
  },
  wordmark: {
    ...typography.wordmark,
    fontSize: 13,
    color: colors.text,
  },
  wordmarkAccent: {
    color: colors.accentText,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 26,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.accentSoft,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentText,
  },
  chipText: {
    ...typography.chip,
    color: colors.accentText,
  },
  content: {
    paddingHorizontal: spacing.xxl,
    paddingTop: 6,
    paddingBottom: spacing.md,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.faint,
  },
  h1: {
    ...typography.h1,
    marginTop: spacing.sm,
    color: colors.text,
  },
  target: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 6,
  },
  targetIcon: {
    alignItems: 'center',
    gap: 1,
  },
  monitor: {
    width: 12,
    height: 8,
    borderWidth: 1.4,
    borderColor: colors.accentText,
    borderRadius: 2,
  },
  monitorStand: {
    width: 6,
    height: 1.4,
    backgroundColor: colors.accentText,
    borderRadius: 1,
  },
  targetText: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  overall: {
    gap: 7,
    marginTop: spacing.lg,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  overallRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  overallKey: {
    fontSize: 11,
    letterSpacing: 0.7,
    color: colors.muted,
  },
  overallValue: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text,
  },
  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.bgSunken,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  steps: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.bento,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    ...elevation.card,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  stepFirst: {
    borderTopWidth: 0,
  },
  stepActive: {
    backgroundColor: colors.accentSoft,
  },
  mark: {
    width: 24,
    height: 24,
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
  },
  markDone: {
    borderColor: colors.ok,
  },
  markActive: {
    borderColor: colors.accent,
  },
  markFailed: {
    borderColor: colors.danger,
  },
  markGlyph: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    color: colors.faint,
  },
  markGlyphDone: {
    color: colors.ok,
  },
  markGlyphFailed: {
    color: colors.danger,
  },
  stepBody: {
    flex: 1,
    gap: 2,
  },
  stepTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.text,
  },
  stepTitlePending: {
    color: colors.muted,
    fontWeight: '500',
  },
  stepSub: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.faint,
  },
  stepSubMono: {
    letterSpacing: 0.2,
  },
  stepState: {
    paddingTop: 2,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: colors.faint,
  },
  stepStateDone: {
    color: colors.ok,
  },
  stepStateActive: {
    color: colors.accentText,
  },
  stepStateFailed: {
    color: colors.danger,
  },
  failed: {
    gap: 7,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  failedHead: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
    color: colors.text,
  },
  failedGlyph: {
    color: colors.danger,
  },
  failedBody: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
  },
  failedActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 2,
  },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  retryPressed: {
    backgroundColor: colors.accent,
  },
  retryGlyph: {
    fontSize: 13,
    color: colors.accentText,
  },
  retryLabel: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
    color: colors.accentText,
  },
  detailLink: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  detailLinkLabel: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.muted,
    textDecorationLine: 'underline',
  },
  success: {
    gap: spacing.md,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.ok,
    borderRadius: radius.md,
    backgroundColor: colors.okSoft,
  },
  successTitle: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
    color: colors.text,
  },
  dock: {
    gap: 6,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  fine: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 17,
    color: colors.faint,
  },
  missing: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xxl,
  },
  lede: {
    ...typography.lede,
    color: colors.muted,
  },
});
