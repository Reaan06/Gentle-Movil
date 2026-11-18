import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { logger } from '../lib/logger';
import { type OnboardingStorage, finishModeChoice } from '../lib/onboarding';
import { MODE_STORAGE_KEY, type AppMode } from '../lib/suite';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V4 — First-run mode choice (artboard
 * `design/mobile-app-onboarding/04-mode-choice.html`, `docs/mobile-views-plan.md`
 * §V4).
 *
 * Three radio cards (`Ambos` preselected) and one CTA that persists the choice
 * in `AsyncStorage` under `gentle-movil:mode` before routing. Where it goes is
 * `finishModeChoice` in `mobile/lib/onboarding.ts` (task T7p):
 *
 * - `conectado` → the onboarding is done here (that mode has no phone-side
 *   install): the `gentle-movil:onboarded` flag is written and the app opens at
 *   `/overview` (V5);
 * - `ambos` → V21 capability probe (`/suite-install`), which finishes the
 *   onboarding and continues to `/overview`;
 * - `local` → V21 too (same phone-side step), then `/overview`.
 *
 * The flag is what makes the next cold start skip the QR scan; Ajustes can
 * always send the owner back to it (`Volver a emparejar`).
 */

/** AsyncStorage key of the persisted mode (also read by V21). */
export { MODE_STORAGE_KEY };

/** The three modes of the artboard. */
export type { AppMode };

interface ModeCard {
  mode: AppMode;
  title: string;
  subtitle: string;
  description: string;
  secondary: string;
}

const CARDS: readonly ModeCard[] = [
  {
    mode: 'conectado',
    title: 'Conectado',
    subtitle: 'controlá tu PC',
    description: 'Sesiones, automatizaciones y CLI.',
    secondary: 'Tu PC encendida con SSH activo.',
  },
  {
    mode: 'local',
    title: 'Local',
    subtitle: 'desarrollá en el móvil',
    description: 'Editor, agente y git en el teléfono.',
    secondary: 'Funciona sin PC, incluso sin red.',
  },
  {
    mode: 'ambos',
    title: 'Ambos',
    subtitle: 'conectado + local',
    description: 'Conectado cerca de tu PC, o local.',
    secondary: 'El repo se sincroniza al volver.',
  },
];

/** Tiny icon shapes drawn with Views — no extra SVG dependency in this slice. */
function ModeIcon({ mode }: { mode: AppMode }) {
  if (mode === 'local') {
    return (
      <View style={styles.icon}>
        <View style={styles.phoneBody} />
      </View>
    );
  }
  if (mode === 'conectado') {
    return (
      <View style={styles.icon}>
        <View style={styles.screenBody} />
        <View style={styles.screenStand} />
      </View>
    );
  }
    return (
    <View style={styles.icon}>
      <View style={styles.bothTop} />
      <View style={styles.bothBottom} />
    </View>
  );
}

export default function ModeChoiceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const log = useMemo(() => logger.tag('mode-choice'), []);
  const [mode, setMode] = useState<AppMode>('ambos');
  const [saving, setSaving] = useState(false);

  const select = useCallback((next: AppMode) => {
    setMode(next);
    log.info(`modo elegido: ${next}`);
  }, [log]);

  const handleContinue = useCallback(async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      await AsyncStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch (error) {
      // Persisting failed: the routing still happens, but the choice is not
      // remembered — say so instead of pretending it was saved.
      log.failure('persist-mode', error, null);
    }
    // `conectado` finishes the onboarding right here; `ambos` and `local` still
    // have the phone-side suite step (V21), which writes the flag itself.
    const exit = await finishModeChoice(
      AsyncStorage as unknown as OnboardingStorage,
      mode,
      log,
    );
    log.info('siguiente paso', { mode, target: exit.route, onboardedNow: exit.onboardedNow });
    try {
      router.push(exit.route);
    } catch (error) {
      log.failure('navigate', error, { mode, target: exit.route });
    } finally {
      setSaving(false);
    }
  }, [log, mode, router, saving]);

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
          <Text style={styles.chipText}>modo de uso</Text>
        </View>
      </View>

      <ScrollView style={styles.flex} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>último paso · 2 de 2</Text>
        <Text style={styles.h1} accessibilityRole="header">
          Elegí cómo usar Gentle Movil
        </Text>
        <Text style={styles.lede}>
          Podés cambiarlo cuando quieras desde Ajustes, sin volver a emparejar.
        </Text>

        <View style={styles.modes} accessibilityRole="radiogroup" accessibilityLabel="Modo de uso">
          {CARDS.map((card) => {
            const selected = mode === card.mode;
            return (
              <Pressable
                key={card.mode}
                accessibilityRole="radio"
                accessibilityState={{ selected, checked: selected }}
                accessibilityLabel={`${card.title}, ${card.subtitle}`}
                accessibilityHint={card.description}
                onPress={() => select(card.mode)}
                style={({ pressed }) => [
                  styles.card,
                  selected && styles.cardSelected,
                  pressed && styles.cardPressed,
                ]}
              >
                <View style={styles.cardTop}>
                  <ModeIcon mode={card.mode} />
                  <View style={styles.titles}>
                    <Text style={styles.title}>{card.title}</Text>
                    <Text style={[styles.subtitle, selected && styles.subtitleSelected]}>
                      {selected ? `elegido · ${card.subtitle}` : card.subtitle}
                    </Text>
                  </View>
                  <View style={[styles.marker, selected && styles.markerSelected]}>
                    <Text style={[styles.markerGlyph, selected && styles.markerGlyphSelected]}>✓</Text>
                  </View>
                </View>
                <View style={styles.desc}>
                  <Text style={styles.descStrong}>{card.description}</Text>
                  <Text style={styles.descFaint}>{card.secondary}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continuar"
          accessibilityState={{ busy: saving, disabled: saving }}
          disabled={saving}
          onPress={handleContinue}
          style={({ pressed }) => [styles.cta, pressed && !saving && styles.ctaPressed]}
        >
          {saving ? <ActivityIndicator size="small" color={colors.accentInk} /> : null}
          <Text style={styles.ctaLabel}>Continuar</Text>
          <Text style={styles.ctaArrow}>→</Text>
        </Pressable>
        <Text style={styles.fine}>
          El modo local incluye editor, agente y git — sin compiladores ni toolchains en el móvil.{' '}
          <Text style={styles.fineStrong}>Todo queda en tu dispositivo.</Text>
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
    justifyContent: 'center',
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
    marginTop: 10,
    color: colors.text,
  },
  lede: {
    ...typography.lede,
    marginTop: 10,
    maxWidth: 340,
    color: colors.muted,
  },
  modes: {
    gap: spacing.md,
    marginTop: spacing.xxl - 2,
  },
  card: {
    gap: 10,
    minHeight: 122,
    paddingVertical: spacing.lg,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.bento,
    backgroundColor: colors.surface,
  },
  cardSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    ...elevation.glow,
  },
  cardPressed: {
    borderColor: colors.borderStrong,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
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
  screenBody: {
    width: 18,
    height: 11,
    borderWidth: 1.5,
    borderColor: colors.accentText,
    borderRadius: 2,
  },
  screenStand: {
    width: 8,
    height: 1.5,
    backgroundColor: colors.accentText,
  },
  phoneBody: {
    width: 10,
    height: 19,
    borderWidth: 1.5,
    borderColor: colors.accentText,
    borderRadius: 2.5,
  },
  bothTop: {
    width: 12,
    height: 8,
    borderWidth: 1.4,
    borderColor: colors.accentText,
    borderRadius: 2,
    marginRight: 6,
  },
  bothBottom: {
    width: 11,
    height: 8,
    borderWidth: 1.4,
    borderColor: colors.accentText,
    borderRadius: 2,
    marginLeft: 6,
  },
  titles: {
    flex: 1,
    gap: 1,
  },
  title: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.text,
  },
  subtitle: {
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    fontWeight: '600',
    color: colors.faint,
  },
  subtitleSelected: {
    color: colors.accentText,
  },
  marker: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
  },
  markerSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  markerGlyph: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    color: 'transparent',
  },
  markerGlyphSelected: {
    color: colors.accentInk,
  },
  desc: {
    paddingLeft: 48,
  },
  descStrong: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
  },
  descFaint: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.faint,
  },
  dock: {
    gap: 10,
    paddingHorizontal: spacing.xxl,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 54,
    paddingHorizontal: spacing.xl,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    ...elevation.glow,
  },
  ctaPressed: {
    backgroundColor: colors.accentHover,
    borderColor: colors.accentHover,
  },
  ctaLabel: {
    ...typography.cta,
    color: colors.accentInk,
  },
  ctaArrow: {
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '700',
    color: colors.accentInk,
  },
  fine: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 18,
    color: colors.faint,
  },
  fineStrong: {
    fontWeight: '600',
    color: colors.muted,
  },
});
