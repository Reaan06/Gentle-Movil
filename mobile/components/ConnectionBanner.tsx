import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { ConnectionCopy, ConnectionTone } from '../lib/connection';
import { colors, radius, spacing, typography } from '../lib/theme';

/**
 * Reusable §V20 connection banner (artboard
 * `design/mobile-app-core/11-global-states.html`).
 *
 * It renders any status this app can derive — offline, reconnecting, stale,
 * incompatible, unauthorized, unknown and live — from the `ConnectionCopy`
 * built by `mobile/lib/connection.ts`. The banner owns no state and performs no
 * request: the screen decides the cadence, the copy carries the truth, and the
 * optional retry button is only drawn when the copy offers a label and the
 * caller passes a handler.
 *
 * Tone mapping (tokens, never raw hex): `ok` green, `warning` amber, `danger`
 * red, `muted` the neutral border for the pre-answer states.
 */

const TONES: Record<ConnectionTone, { border: string; background: string; text: string }> = {
  ok: { border: colors.ok, background: colors.okSoft, text: colors.ok },
  warning: { border: colors.warning, background: colors.warningSoft, text: colors.warning },
  danger: { border: colors.danger, background: colors.dangerSoft, text: colors.danger },
  muted: { border: colors.border, background: colors.bgSunken, text: colors.muted },
};

export interface ConnectionBannerProps {
  /** Status copy produced by `connectionCopy` (title, sentence, tone, retry label). */
  copy: ConnectionCopy;
  /** Spinner instead of the static dot: a check is in flight. */
  busy?: boolean;
  /** Retry handler; without it no button is rendered, whatever the copy says. */
  onRetry?: () => void;
  /** Extra fine print under the copy (e.g. the honest pending-retry note). */
  note?: string | null;
  style?: StyleProp<ViewStyle>;
  /** Test id for the QA gallery (`connection-state-<status>`). */
  testID?: string;
}

/** Status banner: dot (or spinner), title, sentence and an optional retry. */
export function ConnectionBanner({
  copy,
  busy = false,
  onRetry,
  note = null,
  style,
  testID,
}: ConnectionBannerProps) {
  const tone = TONES[copy.tone];
  const showRetry = copy.retryLabel !== null && onRetry !== undefined;

  return (
    <View
      accessibilityRole={copy.tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLabel={`${copy.title}. ${copy.text}`}
      testID={testID}
      style={[
        styles.banner,
        { borderColor: tone.border, backgroundColor: tone.background },
        style,
      ]}>
      {busy ? (
        <ActivityIndicator size="small" color={tone.text} style={styles.indicator} />
      ) : (
        <View style={[styles.dot, { backgroundColor: tone.text }]} accessibilityElementsHidden />
      )}

      <View style={styles.body}>
        <Text style={[styles.title, { color: tone.text }]}>{copy.title}</Text>
        <Text style={styles.text}>{copy.text}</Text>
        {note !== null && note !== '' && <Text style={styles.note}>{note}</Text>}
      </View>

      {showRetry && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.retryLabel ?? 'Reintentar'}
          onPress={onRetry}
          style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}>
          <Text style={[styles.retryLabel, { color: tone.text }]}>{copy.retryLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  indicator: {
    width: 15,
    height: 15,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...typography.label,
    fontWeight: '600',
  },
  text: {
    ...typography.body,
    color: colors.text,
  },
  note: {
    ...typography.fine,
    color: colors.faint,
  },
  retry: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
  },
  retryPressed: {
    borderColor: colors.accent,
  },
  retryLabel: {
    ...typography.hint,
    fontWeight: '600',
  },
});
