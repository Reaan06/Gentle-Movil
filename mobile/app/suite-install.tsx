import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import { logger } from '../lib/logger';
import {
  DEFAULT_SELECTION,
  EMPTY_SUITE_RECORD,
  SUITE_COMPONENTS,
  type AppMode,
  type SuiteComponent,
  type SuiteInstaller,
  type SuiteRecord,
  type SuiteSelection,
  type SuiteState,
  type SuiteStorage,
  installLabel,
  readMode,
  retryLabel,
  routeAfterSuite,
  runSuiteInstall,
  selectedComponents,
  selectedCount,
  toggleComponent,
} from '../lib/suite';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V21 — suite installer (artboard
 * `design/mobile-app-onboarding/05-suite-install.html`, `docs/mobile-views-plan.md`
 * §V21, owner amendment L10).
 *
 * Reached from V4 whenever the chosen mode includes local (`ambos` | `local`) and
 * leaves towards the QR scan (V1) — or stays put for `local`, whose root entry is
 * still a stub and is logged as `local route pending`.
 *
 * This file is only the rendering shell: the selection reducer (with the
 * `gentle-shell` ↔ `engram` dependency), the install runner, the honest
 * `{component, ok, raw}` log and the `gentle-movil:suite` record all live in
 * `mobile/lib/suite.ts` and are covered by `mobile/test/suite-install.test.mjs`.
 *
 * The installer below is a **simulation**: no `fs_*`/FFI primitive of the local
 * mode exists yet, so each component just takes 600–900 ms and reports `ok`. The
 * log says so (`raw: 'simulado · …'`) instead of pretending the suite landed on
 * the device; wiring the real sandbox install is a later slice (T9).
 */

/** Visible state of a row in the picker. */
type RowState = 'picked' | 'idle' | SuiteState;

const IDLE_STATES: Record<SuiteComponent, SuiteState> = {
  'gentle-shell': 'idle',
  engram: 'idle',
  'gentle-ai': 'idle',
};

/** Duration of the simulated install of one component (ms). */
const SIMULATED_MS = { min: 600, max: 900 } as const;

/** Duration of the row progress bar (ms); matches the simulated install. */
const PROGRESS_MS = 750;

const EYEBROW_PREFIX = 'preparando tu teléfono · elegiste:';

const TITLE = 'Instalar Gentle en tu móvil';

const LEDE = 'Elegí qué querés adentro del teléfono para el modo local. Todo queda en el sandbox de la app.';

const NOTE =
  'Podés instalar todo o solo una parte; lo que desmarques queda para después, desde Ajustes. ' +
  'gentle-shell necesita engram para recordar.';

/** Simulated installer: honest about being a placeholder until the local FFI lands. */
function simulatedInstaller(): SuiteInstaller {
  return async (component) => {
    const span = SIMULATED_MS.max - SIMULATED_MS.min;
    const delay = SIMULATED_MS.min + Math.round(Math.random() * span);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    });
    return { ok: true, raw: `simulado · ${component} en el sandbox (instalación real: T9)` };
  };
}

/** Tiny icon shapes drawn with Views — no extra SVG dependency in this slice. */
function SuiteIcon({ state }: { state: RowState }) {
  const tint =
    state === 'ok' ? colors.ok : state === 'fail' ? colors.danger : state === 'installing' ? colors.accentInk : colors.accentText;

  if (state === 'installing') {
    return (
      <View style={[styles.icon, styles.iconBusy]}>
        <View style={[styles.promptChevron, { borderColor: colors.accentInk }]} />
        <View style={[styles.promptLine, { backgroundColor: colors.accentInk }]} />
      </View>
    );
  }

  return (
    <View style={[styles.icon, state === 'ok' && styles.iconOk, state === 'fail' && styles.iconFail]}>
      <View style={[styles.promptChevron, { borderColor: tint }]} />
      <View style={[styles.promptLine, { backgroundColor: tint }]} />
      <View style={[styles.iconPips, { backgroundColor: tint }]} />
    </View>
  );
}

interface SuiteRowProps {
  component: SuiteComponent;
  name: string;
  description: string;
  state: RowState;
  checked: boolean;
  locked: boolean;
  onToggle: (component: SuiteComponent) => void;
}

/** One selectable component row (artboard `.comp`). */
function SuiteRow({ component, name, description, state, checked, locked, onToggle }: SuiteRowProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const installing = state === 'installing';
  const picked = state === 'picked';

  useEffect(() => {
    if (installing) {
      progress.setValue(0);
      const animation = Animated.timing(progress, {
        toValue: 1,
        duration: PROGRESS_MS,
        useNativeDriver: false,
      });
      animation.start();
      return () => {
        animation.stop();
      };
    }
    progress.setValue(state === 'ok' ? 1 : 0);
    return undefined;
  }, [installing, progress, state]);

  const stateLabel =
    state === 'ok' ? 'instalado' : state === 'fail' ? 'falló' : installing ? 'instalando' : '';
  const showBar = installing || state === 'ok' || state === 'fail';

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: state === 'ok' ? true : checked, disabled: locked }}
      accessibilityLabel={`${name}, ${description}`}
      accessibilityHint={picked || state === 'idle' ? 'Toca para incluir o quitar del grupo' : stateLabel}
      disabled={locked}
      onPress={() => onToggle(component)}
      style={({ pressed }) => [
        styles.row,
        picked && styles.rowPicked,
        installing && styles.rowInstalling,
        state === 'ok' && styles.rowOk,
        state === 'fail' && styles.rowFail,
        pressed && !locked && styles.rowPressed,
      ]}
    >
      <SuiteIcon state={state} />
      <View style={styles.rowText}>
        <Text style={styles.rowName}>{name}</Text>
        <Text style={styles.rowDesc}>{description}</Text>
      </View>
      {stateLabel === '' ? (
        <View style={[styles.marker, picked && styles.markerChecked]}>
          <Text style={[styles.markerGlyph, picked && styles.markerGlyphChecked]}>✓</Text>
        </View>
      ) : (
        <Text
          style={[
            styles.stateLabel,
            state === 'ok' && styles.stateOk,
            state === 'fail' && styles.stateFail,
            installing && styles.stateInstalling,
          ]}
        >
          {stateLabel}
        </Text>
      )}
      {showBar ? (
        <View style={styles.progressTrack}>
          <Animated.View
            style={[
              styles.progressFill,
              state === 'fail' && styles.progressFail,
              {
                width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
              },
            ]}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

export default function SuiteInstallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const storage = AsyncStorage as unknown as SuiteStorage;
  const log = useMemo(() => logger.tag('suite-install'), []);
  const install = useMemo(() => simulatedInstaller(), []);

  const [mode, setMode] = useState<AppMode>('ambos');
  const [selection, setSelection] = useState<SuiteSelection>(DEFAULT_SELECTION);
  const [states, setStates] = useState<Record<SuiteComponent, SuiteState>>(IDLE_STATES);
  const [record, setRecord] = useState<SuiteRecord>(EMPTY_SUITE_RECORD);
  const [failed, setFailed] = useState<SuiteComponent[]>([]);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    void readMode(storage, log).then((stored) => {
      if (alive) {
        setMode(stored);
      }
    });
    return () => {
      alive = false;
    };
  }, [log, storage]);

  /** Leaves V21: QR scan for `ambos`, honest stay for `local`. */
  const finish = useCallback(() => {
    const target = routeAfterSuite(mode);
    if (target === null) {
      log.warn('local route pending', { mode });
      return;
    }
    try {
      router.push(target);
    } catch (error) {
      log.failure('navigate', error, { mode, target });
    }
  }, [log, mode, router]);

  const start = useCallback(
    async (components: readonly SuiteComponent[]) => {
      if (inFlight.current || components.length === 0) {
        return;
      }
      inFlight.current = true;
      setBusy(true);
      setSettled(false);
      setFailed([]);
      // Only the components of this run go back to idle: a retry keeps the rows
      // that already installed showing `ok`.
      setStates((previous) => {
        const next = { ...previous };
        for (const component of components) {
          next[component] = 'idle';
        }
        return next;
      });

      const result = await runSuiteInstall({
        components,
        install,
        storage,
        log,
        onState: (component, state) => {
          setStates((previous) => ({ ...previous, [component]: state }));
        },
      });

      setRecord(result.record);
      setFailed(result.failed);
      setSettled(true);
      setBusy(false);
      inFlight.current = false;

      if (result.failed.length === 0) {
        finish();
      }
    },
    [finish, install, log, storage],
  );

  const toggle = useCallback(
    (component: SuiteComponent) => {
      if (busy || settled) {
        return;
      }
      setSelection((previous) => {
        const next = toggleComponent(previous, component);
        log.info(`selección: ${component}`, { component, checked: next[component], engram: next.engram });
        return next;
      });
    },
    [busy, log, settled],
  );

  const count = selectedCount(selection);
  const retrying = settled && failed.length > 0;
  const primaryLabel = retrying ? retryLabel(failed) : installLabel(count);

  const onPrimary = useCallback(() => {
    if (busy) {
      return;
    }
    if (retrying) {
      void start(failed);
      return;
    }
    void start(selectedComponents(selection));
  }, [busy, failed, retrying, selection, start]);

  const onSecondary = useCallback(() => {
    if (busy) {
      return;
    }
    if (retrying) {
      log.warn('continuar de todos modos', { failed, record });
      finish();
      return;
    }
    setSelection(DEFAULT_SELECTION);
    void start(SUITE_COMPONENTS.map((row) => row.component));
  }, [busy, failed, finish, log, record, retrying, start]);

  const rowState = (component: SuiteComponent): RowState => {
    const state = states[component];
    if (state !== 'idle' || settled) {
      return state === 'idle' ? 'idle' : state;
    }
    return selection[component] ? 'picked' : 'idle';
  };

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
        <View style={styles.chip}>
          <Text style={styles.chipText}>suite en el móvil</Text>
        </View>
      </View>

      <ScrollView style={styles.flex} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>{`${EYEBROW_PREFIX} ${mode}`}</Text>
        <Text style={styles.h1} accessibilityRole="header">
          {TITLE}
        </Text>
        <Text style={styles.lede}>{LEDE}</Text>

        <View style={styles.rows} accessibilityLabel="Componentes de la suite">
          {SUITE_COMPONENTS.map((row) => (
            <SuiteRow
              key={row.component}
              component={row.component}
              name={row.name}
              description={row.description}
              state={rowState(row.component)}
              checked={selection[row.component]}
              locked={busy || settled}
              onToggle={toggle}
            />
          ))}
        </View>

        <View style={styles.note}>
          <View style={styles.noteBullet}>
            <Text style={styles.noteGlyph}>i</Text>
          </View>
          <Text style={styles.noteText}>{NOTE}</Text>
        </View>
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <PrimaryButton
          label={primaryLabel}
          onPress={onPrimary}
          disabled={busy || (!retrying && count === 0)}
          accessibilityHint={
            retrying
              ? 'Vuelve a intentar solo los componentes que fallaron'
              : 'Instala los componentes marcados en el sandbox de la app'
          }
        />
        <GhostButton
          label={retrying ? 'Continuar de todos modos →' : 'Instalar todo'}
          onPress={onSecondary}
          disabled={busy}
          accessibilityHint={
            retrying
              ? 'Sigue con lo que sí se instaló; el resto queda para Ajustes'
              : 'Marca los tres componentes e instálalos'
          }
        />
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
    borderColor: colors.border,
    borderRadius: radius.sm + 2,
    backgroundColor: colors.surface,
  },
  pi: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.accentText,
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
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 26,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  chipText: {
    ...typography.chip,
    color: colors.muted,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.faint,
  },
  h1: {
    ...typography.h1,
    marginTop: 6,
    color: colors.text,
  },
  lede: {
    ...typography.lede,
    marginTop: 10,
    maxWidth: 340,
    color: colors.muted,
  },
  rows: {
    gap: spacing.md,
    marginTop: 22,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.bento,
    backgroundColor: colors.surface,
  },
  rowPicked: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    ...elevation.glow,
  },
  rowInstalling: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.accentSoft,
  },
  rowOk: {
    borderColor: colors.ok,
  },
  rowFail: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
  rowPressed: {
    borderColor: colors.borderStrong,
  },
  icon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bgSunken,
  },
  iconBusy: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  iconOk: {
    borderColor: colors.ok,
  },
  iconFail: {
    borderColor: colors.danger,
  },
  promptChevron: {
    width: 8,
    height: 8,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    transform: [{ rotate: '-45deg' }],
  },
  promptLine: {
    width: 10,
    height: 1.5,
  },
  iconPips: {
    width: 4,
    height: 1.5,
    borderRadius: radius.pill,
    opacity: 0.7,
  },
  rowText: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  rowName: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.text,
  },
  rowDesc: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.faint,
  },
  marker: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
  },
  markerChecked: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  markerGlyph: {
    fontSize: 11,
    lineHeight: 12,
    fontWeight: '700',
    color: 'transparent',
  },
  markerGlyphChecked: {
    color: colors.accentInk,
  },
  stateLabel: {
    ...typography.chip,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.faint,
  },
  stateOk: {
    color: colors.ok,
  },
  stateFail: {
    color: colors.danger,
  },
  stateInstalling: {
    color: colors.accentText,
  },
  progressTrack: {
    width: '100%',
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.bgSunken,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  progressFail: {
    backgroundColor: colors.danger,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 18,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bgSunken,
  },
  noteBullet: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.pill,
    marginTop: 1,
  },
  noteGlyph: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    color: colors.warning,
  },
  noteText: {
    flex: 1,
    ...typography.body,
    color: colors.muted,
  },
  dock: {
    gap: 10,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
});
