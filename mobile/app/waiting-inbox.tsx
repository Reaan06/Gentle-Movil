import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import { logger } from '../lib/logger';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';
import { bridgeChannel } from '../lib/tunnel-store';
import {
  type InboxItem,
  type InboxState,
  type InboxViewModel,
  INBOX_ANSWER_PENDING_NOTE,
  answerIntent,
  buildInbox,
  loadInbox,
} from '../lib/waiting';

/**
 * V9 — Waiting-on-you inbox (artboard
 * `design/mobile-app-core/04-waiting-inbox.html`, `docs/mobile-views-plan.md`
 * §V9).
 *
 * One aggregated queue of everything blocked on the human: the sessions the PC
 * reports with a pending question and how long they have been waiting.
 * Rendering shell only — the §V9 state machine, the card view model and every
 * es-AR copy live in `mobile/lib/waiting.ts`, pinned by
 * `mobile/test/waiting.test.mjs`.
 *
 * Data is real: `GET /api/sessions` through the SSH tunnel the pairing flow
 * opened (`lib/waiting.ts` → `lib/bridge.ts`). No tunnel is `Reconectando…`
 * with the cached cards kept and answers muted; a broken answer is an inline
 * error card with `failure.message` plus the raw evidence in the log. §9.3
 * publishes no pending question yet, so the honest empty card is `Sin datos:
 * <reason>` — never zeros-as-data and never a claim that nobody is waiting.
 *
 * Answers are NOT wired yet: the answer action logs `route pending`
 * (`/waiting-inbox/<id>/answer`) and the footer note says so. The screen never
 * pretends an answer was sent.
 */

const log = logger.tag('waiting-inbox');

/** Back glyph; the app ships no icon font (see `lib/theme.ts` typography note). */
const BACK_GLYPH = '‹';

function StatusChip({ label, tone }: { label: string; tone: 'warning' | 'muted' }) {
  return (
    <View style={[styles.chip, tone === 'warning' ? styles.chipWarning : styles.chipMuted]}>
      <Text
        style={[
          styles.chipText,
          tone === 'warning' ? styles.chipTextWarning : styles.chipTextMuted,
        ]}>
        {label}
      </Text>
    </View>
  );
}

function Card({
  item,
  enabled,
  note,
  onAnswer,
}: {
  item: InboxItem;
  enabled: boolean;
  note: string | null;
  onAnswer: (item: InboxItem) => void;
}) {
  return (
    <View style={[styles.card, item.question !== null && styles.cardOpen]}>
      <View style={styles.cardHead}>
        <Text style={styles.cardSession} numberOfLines={1} accessibilityRole="header">
          {item.sessionLabel}
        </Text>
        <StatusChip label="Esperando" tone="warning" />
      </View>

      {item.question !== null ? (
        <Text style={styles.cardQuestion}>{item.question}</Text>
      ) : (
        <Text style={styles.cardTitleFallback}>{item.title}</Text>
      )}

      <Text style={styles.cardFoot}>{item.waitingFor}</Text>

      <View style={styles.cardActions}>
        <PrimaryButton
          label="Responder"
          disabled={!enabled}
          reportDisabledPress
          accessibilityHint={item.question ?? item.sessionLabel}
          onPress={() => onAnswer(item)}
          style={styles.answerButton}
        />
        <GhostButton
          label="Ir a la sesión"
          onPress={() => {
            // V7 has no screen yet: honest pending route, never a dead tap.
            log.warn('route pending', { route: `/terminal-control?session=${item.id}` });
          }}
          style={styles.openButton}
        />
      </View>

      {!enabled && note !== null && <Text style={styles.cardOffNote}>{note}</Text>}
    </View>
  );
}

function SkeletonCard() {
  return (
    <View style={styles.card} accessibilityLabel="Cargando una sesión esperándote">
      <View style={styles.skeletonHead} />
      <View style={styles.skeletonLine} />
      <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
    </View>
  );
}

export default function WaitingInboxScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [state, setState] = useState<InboxState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  // Cards already on screen: a failed refresh keeps them (never a blank screen).
  const cached = useRef<InboxItem[]>([]);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) {
      setRefreshing(true);
    }
    try {
      const next = await loadInbox(bridgeChannel(), {
        cached: cached.current,
        now: Date.now(),
      });
      if (next.kind === 'error') {
        // Same app-wide log shape as the pairing flow: {step, error, raw}.
        log.failure('inbox', next.message, next.raw);
      } else if (next.kind === 'offline') {
        log.warn('offline', { step: 'inbox', error: 'sin túnel', raw: null });
      } else if (next.kind === 'stale') {
        log.warn('stale answer', { step: 'inbox', minutes: next.minutes });
      }
      if (next.kind !== 'loading' && next.items.length > 0) {
        cached.current = next.items;
      }
      setState(next);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const vm: InboxViewModel = buildInbox(state);

  const onAnswer = (item: InboxItem) => {
    const intent = answerIntent(item.id);
    if (!vm.answerEnabled) {
      log.warn('answer blocked (no tunnel)', { step: 'answer', route: intent.route });
      return;
    }
    log.info('answer tap', {
      step: 'answer',
      sessionId: intent.sessionId,
      pending: intent.pending,
    });
    // The route does not exist yet: log it, say so, send nothing.
    log.warn('route pending', { step: 'answer', route: intent.route });
  };

  const questionsLine = vm.countLine;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.appbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Volver"
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace('/overview');
          }}
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}>
          <Text style={styles.backGlyph}>{BACK_GLYPH}</Text>
        </Pressable>
        <View style={styles.appbarTitle}>
          <Text style={styles.screenTitle}>Esperándote</Text>
          <Text style={styles.meta}>{questionsLine}</Text>
        </View>
        <StatusChip label={vm.pendingChip} tone={vm.items.length > 0 ? 'warning' : 'muted'} />
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
          <View style={[styles.banner, styles.bannerWarning]}>
            <Text style={[styles.bannerText, styles.bannerTextWarning]}>{vm.staleChip}</Text>
          </View>
        )}
        {vm.offlineChip !== null && (
          <View style={[styles.banner, styles.bannerMuted]}>
            <Text style={[styles.bannerText, styles.bannerTextMuted]}>{vm.offlineChip}</Text>
          </View>
        )}

        {vm.errorCard !== null && (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>No pudimos leer la bandeja.</Text>
            <Text style={styles.errorMessage}>{vm.errorCard.message}</Text>
            {vm.errorCard.raw !== null && (
              <Text style={styles.errorRaw} numberOfLines={3}>
                {vm.errorCard.raw}
              </Text>
            )}
            <GhostButton label="Reintentar" onPress={() => void load(true)} />
          </View>
        )}

        <Text style={styles.intro}>{vm.intro}</Text>

        {vm.state === 'loading' && (
          <View style={styles.cards}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {vm.emptyCard !== null && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{vm.emptyCard}</Text>
            <PrimaryButton label="Actualizar" onPress={() => void load(true)} />
          </View>
        )}

        {vm.items.length > 0 && (
          <View style={styles.cards}>
            {vm.items.map((item) => (
              <Card
                key={item.id}
                item={item}
                enabled={vm.answerEnabled}
                note={vm.answerOffNote}
                onAnswer={onAnswer}
              />
            ))}
          </View>
        )}

        <Text style={styles.note}>{INBOX_ANSWER_PENDING_NOTE}</Text>
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
    gap: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  backPressed: {
    backgroundColor: colors.bgSunken,
    borderColor: colors.border,
  },
  backGlyph: {
    color: colors.muted,
    fontSize: 26,
    lineHeight: 28,
    fontWeight: '600',
  },
  appbarTitle: {
    flex: 1,
    minWidth: 0,
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
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipWarning: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
  },
  chipMuted: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  chipText: {
    ...typography.chip,
    fontSize: 11,
  },
  chipTextWarning: {
    color: colors.warning,
  },
  chipTextMuted: {
    color: colors.muted,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  banner: {
    alignSelf: 'flex-start',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  bannerWarning: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
  },
  bannerMuted: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  bannerText: {
    ...typography.hint,
  },
  bannerTextWarning: {
    color: colors.warning,
  },
  bannerTextMuted: {
    color: colors.muted,
  },
  errorCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  errorTitle: {
    ...typography.label,
    color: colors.text,
  },
  errorMessage: {
    ...typography.body,
    color: colors.muted,
  },
  errorRaw: {
    ...typography.fine,
    color: colors.faint,
  },
  intro: {
    ...typography.body,
    color: colors.muted,
  },
  cards: {
    gap: 14,
  },
  card: {
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.sm,
    ...elevation.card,
  },
  cardOpen: {
    borderColor: colors.borderStrong,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardSession: {
    flex: 1,
    ...typography.label,
    color: colors.accentText,
  },
  cardQuestion: {
    ...typography.lede,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.1,
  },
  cardTitleFallback: {
    ...typography.body,
    color: colors.muted,
  },
  cardFoot: {
    ...typography.fine,
    color: colors.faint,
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  answerButton: {
    flex: 1,
    minHeight: 44,
  },
  openButton: {
    flex: 1,
  },
  cardOffNote: {
    ...typography.fine,
    color: colors.warning,
  },
  skeletonHead: {
    height: 12,
    width: '45%',
    borderRadius: radius.sm,
    backgroundColor: colors.bgSunken,
  },
  skeletonLine: {
    height: 14,
    width: '92%',
    borderRadius: radius.sm,
    backgroundColor: colors.bgSunken,
  },
  skeletonLineShort: {
    width: '64%',
  },
  emptyCard: {
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.md,
    ...elevation.card,
  },
  emptyText: {
    ...typography.lede,
    color: colors.muted,
  },
  note: {
    marginTop: spacing.md,
    ...typography.fine,
    color: colors.faint,
  },
});
