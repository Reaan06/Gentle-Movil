import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import { logger } from '../lib/logger';
import { finishSuiteStep } from '../lib/onboarding';
import {
  ALREADY_INSTALLED_NOTE,
  DEFAULT_SELECTION,
  PROBE_NOTE,
  REPROBE_LABEL,
  SUITE_COMPONENTS,
  type AppMode,
  type SuiteComponent,
  type SuiteSelection,
  type SuiteState,
  type SuiteStorage,
  primaryAction,
  readMode,
  recordProbe,
  rowLabel,
  rowNote,
  rowSelectable,
  runSuiteProbe,
  selectedComponents,
  toggleComponent,
} from '../lib/suite';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V21 — suite capability probe (artboard
 * `design/mobile-app-onboarding/05-suite-install.html`, `docs/mobile-views-plan.md`
 * §V21, task T7p).
 *
 * Reached from V4 whenever the chosen mode includes local (`ambos` | `local`)
 * and continues into the app at `/overview` (V5) once the person goes on.
 *
 * This file is only the rendering shell: the selection reducer (with the
 * `gentle-shell` ↔ `engram` dependency), the capability probe, the honest
 * per-answer log and the `gentle-movil:suite` record all live in
 * `mobile/lib/suite.ts` and are pinned by `mobile/test/suite-install.test.mjs`.
 *
 * ## What this screen really does
 *
 * It **probes**, it does not install. Each row settles on one of the three real
 * answers `rowLabel` knows — `instalado` / `no instalado` / `no disponible` —
 * with `rowNote` carrying the real reason. The progress bar exists only while a
 * probe for that row is really in flight (`state === 'probing'`), so it never
 * fakes work that is not happening.
 *
 * The primary CTA comes from `primaryAction` with `canInstall: false`, because
 * that is the truth today: the Rust core exposes no local installation, so the
 * button is the honest `Continuar igual →` (or `Continuar →` when everything
 * selected is really installed). It is never an «instalar» promise.
 */

/** This build has no local installer: the CTA must never promise one. */
const CAN_INSTALL = false as const;

/** Visible state of a row (`'idle'` until its probe runs). */
type RowState = SuiteState;

const IDLE_STATES: Record<SuiteComponent, RowState> = {
  'gentle-shell': 'idle',
  engram: 'idle',
  'gentle-ai': 'idle',
};

const NO_REASONS: Record<SuiteComponent, string | null> = {
  'gentle-shell': null,
  engram: null,
  'gentle-ai': null,
};

const EYEBROW_PREFIX = 'revisando tu teléfono · elegiste:';

const TITLE = 'Qué hay en tu móvil';

const LEDE =
  'Revisamos el teléfono y te decimos qué componentes ya están. Lo que ya está no se vuelve a instalar.';

/** Tiny icon shapes drawn with Views — no extra SVG dependency in this slice. */
function SuiteIcon({ state }: { state: RowState }) {
  const tint =
    state === 'installed'
      ? colors.ok
      : state === 'missing'
        ? colors.warning
        : state === 'probing'
          ? colors.accentInk
          : colors.accentText;

  if (state === 'probing') {
    return (
      <View style={[styles.icon, styles.iconBusy]}>
        <View style={[styles.promptChevron, { borderColor: colors.accentInk }]} />
        <View style={[styles.promptLine, { backgroundColor: colors.accentInk }]} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.icon,
        state === 'installed' && styles.iconInstalled,
        state === 'missing' && styles.iconMissing,
      ]}>
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
  reason: string | null;
  checked: boolean;
  locked: boolean;
  onToggle: (component: SuiteComponent) => void;
}

/** One component row (artboard `.comp`): pick it, and see what the probe found. */
function SuiteRow({
  component,
  name,
  description,
  state,
  reason,
  checked,
  locked,
  onToggle,
}: SuiteRowProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const probing = state === 'probing';

  useEffect(() => {
    if (!probing) {
      progress.setValue(0);
      return undefined;
    }
    // Indeterminate fill: the probe is a real read that settles in milliseconds,
    // so the bar only exists while that read is in flight.
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: 420, useNativeDriver: false }),
        Animated.timing(progress, { toValue: 0, duration: 0, useNativeDriver: false }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [probing, progress]);

  const label = rowLabel(state);
  /** `rowLabel` answers '' while idle/probing; the probing row says so. */
  const displayLabel = label === '' && probing ? 'revisando' : label;
  const note = rowNote(state, reason);
  const installed = state === 'installed';

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: installed ? true : checked, disabled: locked }}
      accessibilityLabel={`${name}, ${description}`}
      accessibilityHint={
        installed
          ? 'Ya está instalado: no se vuelve a instalar'
          : locked
            ? 'Esperá a que termine la revisión'
            : 'Toca para incluir o quitar del grupo'
      }
      disabled={locked}
      onPress={() => onToggle(component)}
      style={({ pressed }) => [
        styles.row,
        checked && !installed && styles.rowPicked,
        probing && styles.rowProbing,
        installed && styles.rowInstalled,
        state === 'missing' && styles.rowMissing,
        pressed && !locked && styles.rowPressed,
      ]}>
      <SuiteIcon state={state} />
      <View style={styles.rowText}>
        <Text style={styles.rowName}>{name}</Text>
        <Text style={styles.rowDesc}>{description}</Text>
        {note !== null && (
          <Text style={[styles.rowNote, state === 'missing' && styles.rowNoteMissing]}>{note}</Text>
        )}
      </View>
      {displayLabel === '' ? (
        <View style={[styles.marker, checked && styles.markerChecked]}>
          <Text style={[styles.markerGlyph, checked && styles.markerGlyphChecked]}>✓</Text>
        </View>
      ) : (
        <Text
          style={[
            styles.stateLabel,
            installed && styles.stateInstalled,
            state === 'missing' && styles.stateMissing,
            probing && styles.stateProbing,
          ]}>
          {displayLabel}
        </Text>
      )}
      {probing ? (
        <View style={styles.progressTrack}>
          <Animated.View
            style={[
              styles.progressFill,
              {
                width: progress.interpolate({ inputRange: [0, 1], outputRange: ['12%', '100%'] }),
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

  const [mode, setMode] = useState<AppMode>('ambos');
  const [selection, setSelection] = useState<SuiteSelection>(DEFAULT_SELECTION);
  const [states, setStates] = useState<Record<SuiteComponent, RowState>>(IDLE_STATES);
  const [reasons, setReasons] = useState<Record<SuiteComponent, string | null>>(NO_REASONS);
  const [probing, setProbing] = useState(false);
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

  /**
   * Runs the real probe over every component. Each row goes `probing` while its
   * own answer is being read and settles on what the probe really answered; the
   * runner persists `gentle-movil:suite` after each one and logs every answer.
   */
  const probeAll = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setProbing(true);
    setReasons(NO_REASONS);

    const result = await runSuiteProbe({
      components: SUITE_COMPONENTS.map((row) => row.component),
      // A fresh probe per run: a later real install is never hidden by a cache.
      probe: recordProbe(storage, log),
      storage,
      log,
      onState: (component, state) => {
        setStates((previous) => ({ ...previous, [component]: state }));
      },
    });

    setReasons((previous) => {
      const next = { ...previous };
      for (const outcome of result.outcomes) {
        next[outcome.component] = outcome.reason;
      }
      return next;
    });
    setProbing(false);
    inFlight.current = false;
    log.info('revisión terminada', {
      installed: result.installed,
      missing: result.missing,
      unsupported: result.unsupported,
    });
  }, [log, storage]);

  useEffect(() => {
    void probeAll();
  }, [probeAll]);

  /** Leaves V21: the onboarding is done, so the app opens at `/overview` (V5). */
  const finish = useCallback(async () => {
    const target = await finishSuiteStep(storage, log);
    log.info('siguiente paso', { mode, target });
    try {
      router.push(target);
    } catch (error) {
      log.failure('navigate', error, { mode, target });
    }
  }, [log, mode, router, storage]);

  const toggle = useCallback(
    (component: SuiteComponent) => {
      if (probing || !rowSelectable(states[component])) {
        return;
      }
      setSelection((previous) => {
        const next = toggleComponent(previous, component);
        log.info(`selección: ${component}`, {
          component,
          checked: next[component],
          engram: next.engram,
        });
        return next;
      });
    },
    [log, probing, states],
  );

  const action = primaryAction(selection, { canInstall: CAN_INSTALL, states });

  const onPrimary = useCallback(() => {
    if (probing || !action.enabled) {
      return;
    }
    if (action.kind === 'install') {
      // Unreachable while `CAN_INSTALL` is false; if it ever becomes reachable
      // the wiring has to land with the real installer, never a fake one.
      log.warn('instalación pedida sin instalador', { targets: action.targets });
      return;
    }
    log.info('continuar', { label: action.label, honestContinue: action.honestContinue });
    void finish();
  }, [action, finish, log, probing]);

  const allSelectedInstalled =
    action.honestContinue === false && action.targets.length === 0 && action.enabled;

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
          <Text style={styles.chipText}>revisión del teléfono</Text>
        </View>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
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
              state={states[row.component]}
              reason={reasons[row.component]}
              checked={selection[row.component]}
              locked={probing || !rowSelectable(states[row.component])}
              onToggle={toggle}
            />
          ))}
        </View>

        <View style={styles.note}>
          <View style={styles.noteBullet}>
            <Text style={styles.noteGlyph}>i</Text>
          </View>
          <Text style={styles.noteText}>
            {PROBE_NOTE}
            {allSelectedInstalled ? ` ${ALREADY_INSTALLED_NOTE}` : ''}
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <PrimaryButton
          label={action.label}
          onPress={onPrimary}
          disabled={!action.enabled || probing}
          loading={probing}
          accessibilityHint={
            action.honestContinue
              ? 'Sigue con lo que el teléfono ya tiene; acá no se instala nada'
              : 'Continúa al panel de tu móvil'
          }
        />
        <GhostButton
          label={REPROBE_LABEL}
          onPress={() => {
            void probeAll();
          }}
          disabled={probing}
          accessibilityHint="Vuelve a revisar el teléfono con el registro actual"
        />
        <Text style={styles.fine}>
          Seleccionados: {selectedComponents(selection).length} · nada se instala ni se borra en este
          paso.
        </Text>
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
  rowProbing: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.accentSoft,
  },
  rowInstalled: {
    borderColor: colors.ok,
  },
  rowMissing: {
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
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
  iconInstalled: {
    borderColor: colors.ok,
  },
  iconMissing: {
    borderColor: colors.warning,
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
  rowNote: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.muted,
  },
  rowNoteMissing: {
    color: colors.warning,
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
  stateInstalled: {
    color: colors.ok,
  },
  stateMissing: {
    color: colors.warning,
  },
  stateProbing: {
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
  fine: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 18,
    color: colors.faint,
  },
});
