import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../components/ConnectionBanner';
import { GhostButton } from '../components/GhostButton';
import {
  type ConnectionCheck,
  type ConnectionCopy,
  checkConnection,
  connectionCopy,
  deriveConnection,
} from '../lib/connection';
import { logger } from '../lib/logger';
import {
  type CommandEntry,
  type ExitChip,
  type ExitTone,
  type HistoryRow,
  type HistoryState,
  type OutputView,
  type SendFailure,
  type TerminalViewModel,
  type TranscriptEvent,
  type TranscriptStatus,
  AGENT_NOTE,
  CLEAR_LABEL,
  CLEAR_NOTE,
  NOT_SENT_REASON,
  OUTPUT_DISPLAY_CAP,
  PANE_NO_OUTPUT_COPY,
  SENDING_COPY,
  SEND_BROKEN_COPY,
  SEND_LABEL,
  SEND_UNREACHABLE_TITLE,
  CommandHistory,
  HistoryCache,
  buildTerminalView,
  loadHistory,
  sendIntent,
} from '../lib/terminal';
import { bridgeChannel, getActiveTunnel } from '../lib/tunnel-store';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V7 — Terminal / control (artboard
 * `design/mobile-app-core/03-terminal-control.html`,
 * `docs/mobile-views-plan.md` §V7). Route `/terminal-control`.
 *
 * Rendering shell only: the capped command ring, the send descriptor, the ANSI
 * stripping, the `truncado` marker, the exit-code copy and every honest state
 * live in `mobile/lib/terminal.ts`, pinned by `mobile/test/terminal.test.mjs`.
 *
 * Data is the real `GET /api/exec/history` over the SSH tunnel (protocol §4):
 * with no tunnel the screen says `Requiere conexión — el terminal corre en tu
 * PC.`, a timeout after a good answer keeps the cached history under an amber
 * `Datos de hace N min` chip, and an extension that does not expose the
 * endpoint is an error card carrying the failure message — never an invented
 * command, exit code or output.
 *
 * Sending is a real `POST /api/exec` (protocol §4.1): the dock shows
 * `Enviando…` while the request is in flight, and the answer is either the real
 * exit chip plus output in the pane (a non-zero code is a result, not an error)
 * or the failure card with the PC's own message and its raw evidence. A `403
 * exec_disabled` says the **PC** refused because the extension needs
 * `GENTLE_MOVIL_ALLOW_EXEC=1`, not that the phone failed, and it never leaves a
 * row pretending the command ran.
 *
 * The transcript section (T7n) is derived from the same real history: its chip
 * is only ever `en curso` (newest entry `pending`, with the real elapsed time),
 * `terminado` (newest entry `sent`/`failed`, with its exit chip) or
 * `sin actividad` (no entry). There is no agent-stream endpoint, so the section
 * always carries the honest `sin eventos del agente` note with its reason
 * instead of a fabricated `waiting` state, and the pane header reads
 * `pi · <model>` only when the payload named a model (`shell` otherwise).
 *
 * No `fontFamily` is set anywhere: this app bundles no font, so the platform
 * default is used with the token type scale (see `lib/theme.ts`).
 */

const log = logger.tag('terminal');

/** Statuses the §V20 banner is worth showing for (silence while connected). */
const REPORTED = new Set(['stale', 'offline', 'incompatible', 'unauthorized']);

/** Exit-chip tones (artboard `--ok` / `--danger` / neutral border). */
const EXIT_TONES: Record<ExitTone, { background: string; border: string; text: string }> = {
  ok: { background: colors.okSoft, border: colors.ok, text: colors.ok },
  danger: { background: colors.dangerSoft, border: colors.danger, text: colors.danger },
  neutral: { background: colors.bgSunken, border: colors.border, text: colors.muted },
};

/** Transcript state chip tones (`en curso` accent, exit tone, `sin actividad`). */
const TRANSCRIPT_TONES: Record<
  TranscriptStatus['tone'],
  { background: string; border: string; text: string }
> = {
  running: { background: colors.accentSoft, border: colors.accent, text: colors.accentText },
  ok: EXIT_TONES.ok,
  danger: EXIT_TONES.danger,
  neutral: EXIT_TONES.neutral,
  muted: { background: colors.bgSunken, border: colors.border, text: colors.faint },
};

/** `en curso · hace 12 segundos` / `terminado · duró 4 minutos` / `sin actividad`. */
function transcriptChipLabel(transcript: TranscriptStatus): string {
  if (transcript.time === null || transcript.timeLabel === null) {
    return transcript.label;
  }
  return `${transcript.label} · ${transcript.timeLabel} ${transcript.time}`;
}

/** One small chip with a given tone (exit code / transcript state). */
function Chip({ label, tone }: { label: string; tone: TranscriptStatus['tone'] }) {
  const palette = TRANSCRIPT_TONES[tone];
  return (
    <View
      style={[styles.chip, { backgroundColor: palette.background, borderColor: palette.border }]}
      accessibilityLabel={label}>
      <Text style={[styles.chipText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

/** Pane / header state label of a §V7 state. */
function stateLabel(vm: TerminalViewModel): string {
  switch (vm.state) {
    case 'loading':
      return 'leyendo…';
    case 'empty':
      return 'sin comandos';
    case 'success':
      return 'historial';
    case 'stale':
      return 'sin respuesta';
    case 'offline':
      return 'sin conexión';
    case 'error':
      return 'error';
  }
}

function ExitChipView({ row }: { row: HistoryRow }) {
  const tone = EXIT_TONES[row.exit.tone];
  return (
    <View
      style={[styles.chip, { backgroundColor: tone.background, borderColor: tone.border }]}
      accessibilityLabel={`código de salida: ${row.exit.label}`}>
      <Text style={[styles.chipText, { color: tone.text }]}>{row.exit.label}</Text>
    </View>
  );
}

/** One row of the history list: command, time, status and exit code. */
function HistoryRowView({
  row,
  selected,
  onPress,
  frozen,
}: {
  row: HistoryRow;
  selected: boolean;
  onPress: () => void;
  frozen: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${row.command}, ${row.statusLabel}, ${row.exit.label}, ${row.atLabel}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        frozen && styles.rowFrozen,
        pressed && styles.rowPressed,
      ]}>
      <View style={styles.rowTop}>
        <Text style={styles.rowCommand} numberOfLines={1}>
          {`$ ${row.command}`}
        </Text>
        <ExitChipView row={row} />
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.rowStatus}>{row.statusLabel}</Text>
        <Text style={styles.rowDot}>·</Text>
        <Text style={styles.rowTime}>{row.atLabel}</Text>
        {row.output !== null && row.output.truncated && (
          <>
            <Text style={styles.rowDot}>·</Text>
            <Text style={styles.rowTime}>salida recortada</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

/** A command typed here that never left the phone (`no enviado`). */
function NotSentRowView({ row }: { row: HistoryRow }) {
  return (
    <View style={styles.notSent} accessibilityRole="summary">
      <View style={styles.rowTop}>
        <Text style={styles.notSentCommand} numberOfLines={1}>
          {`$ ${row.command}`}
        </Text>
        <View style={styles.notSentChip}>
          <Text style={styles.notSentChipText}>{row.statusLabel}</Text>
        </View>
      </View>
      <Text style={styles.notSentReason}>{row.reason ?? NOT_SENT_REASON}</Text>
      <Text style={styles.rowTime}>{row.atLabel}</Text>
    </View>
  );
}

function SkeletonRow() {
  return (
    <View style={[styles.row, styles.skeletonRow]} accessibilityElementsHidden>
      <View style={[styles.skeletonBar, { width: '55%' }]} />
      <View style={[styles.skeletonBar, { width: '35%' }]} />
    </View>
  );
}

/** What the pane paints: a real result, with its real exit chip. */
interface PaneModel {
  command: string;
  exit: ExitChip;
  /** `null` when the command ran and printed nothing (never invented). */
  output: OutputView | null;
}

/** The monospace output pane (artboard `.terminal`). */
function OutputPane({ vm, pane }: { vm: TerminalViewModel; pane: PaneModel | null }) {
  return (
    <View style={styles.terminal} accessibilityLabel="Salida del terminal">
      <View style={styles.terminalBar}>
        <Text style={styles.terminalTitle} numberOfLines={1}>
          {vm.transcript.agent.label}
        </Text>
        {pane !== null && <Chip label={pane.exit.label} tone={pane.exit.tone} />}
        <Text style={styles.terminalState} numberOfLines={1}>
          {stateLabel(vm)}
        </Text>
      </View>
      <View style={styles.terminalBody}>
        {pane === null ? (
          <Text style={styles.paneEmpty}>{vm.paneEmpty ?? ''}</Text>
        ) : (
          <>
            <Text style={styles.panePrompt} numberOfLines={1}>
              {`$ ${pane.command}`}
            </Text>
            {pane.output === null ? (
              <Text style={styles.paneEmpty}>{PANE_NO_OUTPUT_COPY}</Text>
            ) : (
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={styles.paneOutput} selectable>
                    {pane.output.text === '' ? ' ' : pane.output.text}
                  </Text>
                </ScrollView>
                {pane.output.truncated && (
                  <Text style={styles.paneNote}>
                    {`Salida recortada a ${OUTPUT_DISPLAY_CAP} caracteres (${pane.output.hidden} ocultos).`}
                  </Text>
                )}
              </>
            )}
          </>
        )}
      </View>
    </View>
  );
}

/** One transcript line: real time, kind glyph, and the streamed text. */
function TranscriptEventRow({ event }: { event: TranscriptEvent }) {
  return (
    <View
      style={styles.eventRow}
      accessibilityLabel={`${event.atLabel} ${event.kind}: ${event.text}`}>
      <Text style={styles.eventTime}>{event.atLabel}</Text>
      <Text
        style={[
          styles.eventGlyph,
          event.kind === 'command' && styles.eventGlyphCommand,
          event.kind === 'status' && styles.eventGlyphStatus,
        ]}>
        {event.glyph}
      </Text>
      <View style={styles.eventBody}>
        {event.kind === 'output' ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={styles.eventOutput} selectable>
              {event.text === '' ? ' ' : event.text}
            </Text>
          </ScrollView>
        ) : (
          <Text
            style={event.kind === 'command' ? styles.eventCommand : styles.eventStatus}
            numberOfLines={event.kind === 'command' ? 1 : undefined}>
            {event.text}
          </Text>
        )}
        {event.truncated && (
          <Text style={styles.eventNote}>{`Salida recortada (${event.hidden} ocultos).`}</Text>
        )}
        {event.kind === 'status' && event.exit !== null && (
          <View style={styles.eventChips}>
            <Chip label={event.exit.label} tone={event.exit.tone} />
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * The session transcript (T7n): derived state chip, the streamed lines from the
 * real history, and the honest note that the bridge serves no agent stream.
 * There is deliberately no `waiting` card here: nothing publishes that data.
 */
function TranscriptSection({ vm }: { vm: TerminalViewModel }) {
  const transcript = vm.transcript;
  return (
    <View style={styles.section} testID="terminal-transcript">
      <View style={styles.sectionHead}>
        <Text style={styles.legend}>{'Transcripción'}</Text>
        <View style={styles.eventChips}>
          <Chip label={transcriptChipLabel(transcript)} tone={transcript.tone} />
          {transcript.exit !== null && (
            <Chip label={transcript.exit.label} tone={transcript.exit.tone} />
          )}
        </View>
      </View>

      <View style={styles.agentNote} accessibilityRole="summary">
        <Text style={styles.agentNoteTitle}>{AGENT_NOTE}</Text>
        <Text style={styles.agentNoteReason}>{transcript.agentReason}</Text>
      </View>

      {vm.events.length === 0 ? (
        <Text style={styles.eventEmpty}>{'Sin comandos registrados para mostrar.'}</Text>
      ) : (
        <View style={styles.eventList}>
          {vm.events.map((event) => (
            <TranscriptEventRow key={event.id} event={event} />
          ))}
        </View>
      )}
    </View>
  );
}

export default function TerminalControlScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cache = useRef(new HistoryCache());
  const history = useRef(new CommandHistory());
  const lastGood = useRef<number | null>(null);

  const [state, setState] = useState<HistoryState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [local, setLocal] = useState<CommandEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendFailure, setSendFailure] = useState<SendFailure | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setState({ kind: 'loading' });
    }
    try {
      setState(await loadHistory(bridgeChannel(), { cache: cache.current }));
    } catch (error) {
      // loadHistory never throws by design; a throw here is unexpected, so it
      // is logged and rendered as offline instead of a fake history.
      log.failure('load-history', error, null);
      setState({ kind: 'offline', entries: null, minutes: null });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const inspectConnection = useCallback(async () => {
    const host = getActiveTunnel()?.host ?? null;
    try {
      const result = await checkConnection(bridgeChannel(), {
        host,
        lastGoodAt: lastGood.current,
      });
      if (result.model.status === 'live') {
        lastGood.current = result.at;
      }
      setCheck(result);
    } catch (error) {
      // checkConnection reports typed failures, so a throw is unexpected: it is
      // logged and shown as an unverifiable bridge, never as "connected".
      log.failure('check-connection', error, null);
      const model = deriveConnection({
        tunnel: getActiveTunnel() !== null,
        failure: {
          kind: 'bad-response',
          message: 'No pudimos verificar el puente.',
          raw: String(error),
        },
        lastGoodAt: lastGood.current,
      });
      setCheck({
        model,
        copy: connectionCopy(model, { host }),
        retry: {
          kind: 'recheck',
          pending: false,
          label: 'Reintentar',
          note: 'Reintentar vuelve a preguntarle al puente por /api/health.',
        },
        at: Date.now(),
      });
    }
  }, []);

  useEffect(() => {
    void load(false);
    void inspectConnection();
  }, [load, inspectConnection]);

  const vm = useMemo(() => buildTerminalView(state, local), [state, local]);
  const host = getActiveTunnel()?.host ?? null;

  /** §V20 banner copy, only for a status that has something to say. */
  const banner: ConnectionCopy | null =
    check !== null && REPORTED.has(check.model.status) ? check.copy : null;

  const refresh = useCallback(() => {
    setNote(null);
    void load(true);
    void inspectConnection();
  }, [load, inspectConnection]);

  /** Selected row wins the pane; otherwise the newest output is shown. */
  const pane: PaneModel | null = useMemo(() => {
    const selected = vm.rows.find((row) => row.id === selectedId) ?? null;
    if (selected !== null) {
      return { command: selected.command, exit: selected.exit, output: selected.output };
    }
    return vm.pane;
  }, [selectedId, vm]);

  const tapRow = useCallback((row: HistoryRow) => {
    if (row.output === null) {
      log.info('row tap without output', { id: row.id, command: row.command });
      return;
    }
    setSelectedId((current) => (current === row.id ? null : row.id));
  }, []);

  const send = useCallback(async () => {
    if (sending) {
      return;
    }
    setSendFailure(null);
    setSending(true);
    setNote(SENDING_COPY);
    try {
      // The real call: `POST /api/exec` over the tunnel (protocol §4.1).
      const result = await sendIntent(draft, {
        channel: bridgeChannel(),
        history: history.current,
        logger: log,
      });
      if (!result.ok) {
        setNote(null);
        if (result.reason === 'empty') {
          setNote(result.message);
          return;
        }
        // Nothing ran: the command stays in the dock as a `no enviado` row with
        // the PC's own reason, and the card carries message + raw evidence.
        setSendFailure(result);
        history.current.append({ command: draft.trim(), reason: result.message });
        setLocal(history.current.entries());
        return;
      }
      // A real result: the ring already kept the real exit code and output.
      setLocal(history.current.entries());
      setSelectedId(result.entry.id);
      setDraft('');
      setNote(null);
    } catch (error) {
      // sendIntent reports typed failures; a throw here is unexpected and is
      // never rendered as a successful send.
      log.failure('exec-send', error, null);
      setNote(null);
      setSendFailure({
        ok: false,
        reason: 'broken',
        title: SEND_UNREACHABLE_TITLE,
        blame: 'link',
        message: SEND_BROKEN_COPY,
        note: null,
        raw: String(error),
        status: null,
      });
    } finally {
      setSending(false);
    }
  }, [draft, sending]);

  const clear = useCallback(() => {
    history.current.clear();
    setLocal(history.current.entries());
    setSelectedId(null);
    setSendFailure(null);
    setDraft('');
    setNote(CLEAR_NOTE);
    log.info('clear', { scope: 'local-view' });
  }, []);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    log.warn('route pending', { route: '/sessions-list', reason: 'no-back-stack' });
    router.replace('/sessions-list');
  }, [router]);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.appbar, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Volver"
          onPress={goBack}
          style={styles.back}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View style={styles.appbarTitle}>
          <Text style={styles.screenTitle} accessibilityRole="header" numberOfLines={1}>
            Terminal
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {`${host ?? 'sin túnel'} · ${check?.model.status === 'live' ? 'túnel SSH' : 'sin verificar'}`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={CLEAR_LABEL}
          onPress={clear}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}>
          <Text style={styles.actionLabel}>{CLEAR_LABEL}</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />
        }>
        {banner !== null && (
          <ConnectionBanner
            copy={banner}
            note={check !== null && check.retry.pending ? check.retry.note : null}
            onRetry={refresh}
            testID="terminal-connection-banner"
          />
        )}

        {banner === null && vm.banner !== null && (
          <View style={styles.offlineStrip} accessibilityRole="summary">
            <ActivityIndicator size="small" color={colors.warning} />
            <View style={styles.offlineText}>
              <Text style={styles.offlineTitle}>{vm.banner}</Text>
              {vm.bannerHint !== null && <Text style={styles.meta}>{vm.bannerHint}</Text>}
            </View>
          </View>
        )}

        {vm.staleChip !== null && (
          <View style={styles.staleChip}>
            <Text style={styles.staleChipText}>{vm.staleChip}</Text>
          </View>
        )}

        {vm.error !== null && (
          <View style={styles.errorCard} accessibilityRole="alert">
            <Text style={styles.errorTitle}>{vm.error.title}</Text>
            <Text style={styles.errorMessage}>{vm.error.message}</Text>
            {vm.error.raw !== null && <Text style={styles.errorRaw}>{vm.error.raw}</Text>}
            <GhostButton label="Reintentar" onPress={() => void load(false)} />
          </View>
        )}

        {vm.loading ? (
          <View style={[styles.terminal, styles.skeletonTerminal]} accessibilityElementsHidden>
            <View style={styles.terminalBar}>
              <View style={[styles.skeletonBar, { width: 90 }]} />
              <View style={[styles.skeletonBar, { width: 60 }]} />
            </View>
            <View style={styles.terminalBody}>
              <View style={[styles.skeletonBar, { width: '70%' }]} />
              <View style={[styles.skeletonBar, { width: '85%' }]} />
              <View style={[styles.skeletonBar, { width: '45%' }]} />
            </View>
          </View>
        ) : vm.state === 'error' ? null : (
          <OutputPane vm={vm} pane={pane} />
        )}

        {!vm.loading && vm.transcriptVisible && <TranscriptSection vm={vm} />}

        {sendFailure !== null && (
          <View style={styles.errorCard} accessibilityRole="alert" testID="terminal-send-error">
            <Text style={styles.errorTitle}>{sendFailure.title}</Text>
            <Text style={styles.errorMessage}>{sendFailure.message}</Text>
            {sendFailure.note !== null && (
              <Text style={styles.errorNote}>{sendFailure.note}</Text>
            )}
            {sendFailure.raw !== null && <Text style={styles.errorRaw}>{sendFailure.raw}</Text>}
          </View>
        )}

        {note !== null && (
          <View style={styles.noteCard} accessibilityRole="summary">
            <Text style={styles.noteText}>{note}</Text>
          </View>
        )}

        {vm.notSent.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.legend}>{'No enviados'}</Text>
            <View style={styles.rowList}>
              {vm.notSent.map((row) => (
                <NotSentRowView key={row.id} row={row} />
              ))}
            </View>
          </View>
        )}

        {vm.loading && (
          <View style={styles.rowList}>
            <SkeletonRow />
            <SkeletonRow />
          </View>
        )}

        {!vm.loading && vm.rows.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={styles.legend}>{'Historial'}</Text>
              <Text style={styles.count}>{vm.rows.length}</Text>
            </View>
            <View style={styles.rowList}>
              {vm.rows.map((row) => (
                <HistoryRowView
                  key={row.id}
                  row={row}
                  selected={row.id === selectedId}
                  frozen={vm.frozen}
                  onPress={() => tapRow(row)}
                />
              ))}
            </View>
          </View>
        )}

        {vm.emptyMessage !== null && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{vm.emptyMessage}</Text>
            <Text style={styles.meta}>
              {'El historial lo escribe la PC cuando corre la extensión.'}
            </Text>
            <GhostButton label="Actualizar" onPress={() => void load(true)} />
          </View>
        )}
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: insets.bottom + spacing.md }]}>
        {!vm.canSend && (
          <Text style={styles.dockHint}>{'Requiere conexión — el terminal corre en tu PC.'}</Text>
        )}
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Comando"
            placeholder="Escribí un comando…"
            placeholderTextColor={colors.faint}
            value={draft}
            editable={vm.canSend && !sending}
            onChangeText={setDraft}
            onSubmitEditing={() => void send()}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            style={[styles.input, (!vm.canSend || sending) && styles.inputDisabled]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={SEND_LABEL}
            accessibilityState={{ disabled: !vm.canSend || sending, busy: sending }}
            disabled={!vm.canSend || sending}
            onPress={() => void send()}
            style={({ pressed }) => [
              styles.send,
              (!vm.canSend || sending) && styles.sendDisabled,
              pressed && vm.canSend && !sending && styles.sendPressed,
            ]}>
            {sending ? (
              <ActivityIndicator size="small" color={colors.accentInk} />
            ) : (
              <Text style={styles.sendGlyph}>→</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
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
    paddingHorizontal: spacing.lg,
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
  action: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
  },
  actionPressed: {
    borderColor: colors.accent,
  },
  actionLabel: {
    ...typography.hint,
    fontWeight: '600',
    color: colors.muted,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  offlineStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  offlineText: {
    flex: 1,
    gap: 2,
  },
  offlineTitle: {
    ...typography.label,
    color: colors.text,
  },
  staleChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  staleChipText: {
    ...typography.hint,
    color: colors.warning,
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
  errorMessage: {
    ...typography.body,
    color: colors.muted,
  },
  errorRaw: {
    ...typography.fine,
    color: colors.faint,
  },
  errorNote: {
    ...typography.fine,
    color: colors.text,
  },
  terminal: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
    overflow: 'hidden',
    ...elevation.card,
  },
  terminalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  terminalTitle: {
    ...typography.hint,
    color: colors.faint,
    flex: 1,
  },
  terminalState: {
    ...typography.hint,
    color: colors.accentText,
  },
  terminalBody: {
    minHeight: 132,
    padding: 14,
    gap: 6,
  },
  panePrompt: {
    ...typography.hint,
    fontWeight: '700',
    color: colors.accentText,
  },
  paneOutput: {
    ...typography.body,
    color: colors.text,
  },
  paneEmpty: {
    ...typography.body,
    color: colors.faint,
  },
  paneNote: {
    ...typography.fine,
    color: colors.warning,
  },
  eventList: {
    gap: 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 3,
  },
  eventTime: {
    ...typography.fine,
    color: colors.faint,
    minWidth: 34,
  },
  eventGlyph: {
    ...typography.fine,
    color: colors.muted,
    minWidth: 10,
    textAlign: 'center',
  },
  eventGlyphCommand: {
    color: colors.accentText,
    fontWeight: '700',
  },
  eventGlyphStatus: {
    color: colors.deepPink,
  },
  eventBody: {
    flex: 1,
    gap: 2,
  },
  eventCommand: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text,
  },
  eventStatus: {
    ...typography.fine,
    color: colors.muted,
  },
  eventOutput: {
    ...typography.body,
    color: colors.text,
  },
  eventNote: {
    ...typography.fine,
    color: colors.warning,
  },
  eventChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  eventEmpty: {
    ...typography.body,
    color: colors.faint,
  },
  agentNote: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
  },
  agentNoteTitle: {
    ...typography.label,
    color: colors.muted,
  },
  agentNoteReason: {
    ...typography.fine,
    color: colors.faint,
  },
  skeletonTerminal: {
    opacity: 0.5,
  },
  skeletonRow: {
    opacity: 0.5,
    gap: spacing.sm,
  },
  skeletonBar: {
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
  },
  noteCard: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  noteText: {
    ...typography.body,
    color: colors.text,
  },
  section: {
    gap: spacing.sm,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  legend: {
    ...typography.legend,
    color: colors.muted,
  },
  count: {
    ...typography.hint,
    color: colors.faint,
  },
  rowList: {
    gap: spacing.sm,
  },
  row: {
    gap: 6,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  rowFrozen: {
    opacity: 0.75,
  },
  rowPressed: {
    borderColor: colors.borderStrong,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowCommand: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.text,
  },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: {
    ...typography.hint,
    fontWeight: '700',
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowStatus: {
    ...typography.fine,
    color: colors.muted,
  },
  rowDot: {
    ...typography.fine,
    color: colors.faint,
  },
  rowTime: {
    ...typography.fine,
    color: colors.faint,
  },
  notSent: {
    gap: 6,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
  },
  notSentCommand: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.muted,
  },
  notSentChip: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  notSentChipText: {
    ...typography.hint,
    fontWeight: '700',
    color: colors.muted,
  },
  notSentReason: {
    ...typography.fine,
    color: colors.warning,
  },
  emptyCard: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  emptyText: {
    ...typography.lede,
    color: colors.muted,
  },
  dock: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSunken,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  dockHint: {
    ...typography.fine,
    color: colors.warning,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.input,
  },
  inputDisabled: {
    color: colors.faint,
    borderColor: colors.border,
  },
  send: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  sendPressed: {
    backgroundColor: colors.accentHover,
  },
  sendDisabled: {
    backgroundColor: colors.border,
  },
  sendGlyph: {
    fontSize: 19,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.accentInk,
  },
});
