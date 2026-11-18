import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GhostButton } from '../components/GhostButton';
import {
  type BufferState,
  type EditorBuffer,
  type EditorSource,
  type FileRow,
  type TreeState,
  DISCARD_CANCEL_LABEL,
  DISCARD_CONFIRM_LABEL,
  DISCARD_TITLE,
  EDITOR_TITLE,
  ERROR_TITLE,
  LARGE_FILE_COPY,
  LARGE_FILE_DETAIL,
  NO_FILE_COPY,
  NO_FS_COPY,
  OFFLINE_COPY,
  READ_ERROR_TITLE,
  RECONNECTING_COPY,
  RETRY_LABEL,
  RETRY_NOTE,
  SAVE_LABEL,
  TREE_EMPTY_COPY,
  TREE_EMPTY_NOTE,
  TreeCache,
  bridgeEditorSource,
  breadcrumb,
  closeBuffer,
  editBuffer,
  loadTree,
  readFile,
  renderCode,
  saveIntent,
  treeRows,
} from '../lib/local-editor';
import { logger } from '../lib/logger';
import { bridgeChannel } from '../lib/tunnel-store';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V15/V16 — Local editor (artboard
 * `design/mobile-app-core/08-local-editor.html`,
 * `docs/mobile-views-plan.md` §V15/§V16). Route `/local-editor`.
 *
 * Rendering shell only: the strict tree parse, dirs-first ordering, the buffer
 * diff that derives `dirty`, the confirm rule of a dirty close, the tab/line
 * number model with its real `truncado` cap and the `pending` save intent all
 * live in `mobile/lib/local-editor.ts`, pinned by
 * `mobile/test/local-editor.test.mjs`.
 *
 * Only real facts are drawn:
 *
 * - content comes from the injected source: `bridgeEditorSource(bridgeChannel())`
 *   asks the bridge when a tunnel is open. A `404`/`501` is an error card with
 *   the failure, never an empty file;
 * - with no tunnel the screen is `no-fs` and says why out loud (`sin acceso a
 *   archivos`: the Rust core has no fs FFI yet) — no blank buffer, no fake list;
 * - there is no syntax highlighting: the pane paints the real text on
 *   `colors.codeBg` with line numbers, and nothing else;
 * - save is not wired: the button logs `route pending` for `/api/fs/write` and
 *   shows the honest note, so the dirty dot stays on;
 * - a file over the display cap is read-only: editing truncated text would save
 *   an incomplete file, so the pane refuses instead.
 *
 * No `fontFamily` is set anywhere: this app bundles no font, so the platform
 * default is used with the token type scale (see `lib/theme.ts`).
 */

const log = logger.tag('local-editor');

/** Width from which the file list sits next to the pane instead of collapsing. */
const WIDE_LAYOUT = 720;

/** Line box of the mono pane: the gutter and the input share it exactly. */
const CODE_LINE_HEIGHT = 21;

/** A deferred action that needs the "discard changes" confirmation. */
type PendingAction = { kind: 'close' } | { kind: 'open'; row: FileRow };

function SkeletonRow() {
  return (
    <View style={styles.skeletonRow} accessibilityElementsHidden>
      <View style={[styles.skeletonBar, { width: '70%' }]} />
    </View>
  );
}

function SkeletonLines() {
  return (
    <View style={styles.skeletonPane} accessibilityElementsHidden>
      {[62, 48, 74, 55].map((width, index) => (
        <View key={index} style={[styles.skeletonBar, { width: `${width}%` }]} />
      ))}
    </View>
  );
}

/** One file row of the tree column. */
function FileListRow({
  row,
  selected,
  onPress,
}: {
  row: FileRow;
  selected: boolean;
  onPress: () => void;
}) {
  const isDir = row.kind === 'dir';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={
        isDir ? `Carpeta ${row.path}` : `Archivo ${row.path}, ${row.sizeLabel}`
      }
      accessibilityHint={isDir ? 'Las carpetas no se abren todavía.' : 'Abre el archivo.'}
      onPress={onPress}
      style={({ pressed }) => [
        styles.fileRow,
        { paddingLeft: spacing.sm + row.depth * spacing.md },
        selected && styles.fileRowSelected,
        pressed && styles.fileRowPressed,
      ]}
      testID={`local-editor-file-${row.path}`}>
      <Text style={[styles.fileGlyph, isDir && styles.fileGlyphDir]}>{isDir ? '▾' : '·'}</Text>
      <Text
        style={[styles.fileName, isDir && styles.fileNameDir]}
        numberOfLines={1}
        ellipsizeMode="middle">
        {row.name}
      </Text>
      {!isDir && <Text style={styles.fileSize}>{row.sizeLabel}</Text>}
    </Pressable>
  );
}

/** Generic honest card: title, message, optional detail and action. */
function StateCard({
  tone,
  title,
  message,
  detail = null,
  action = null,
  testID,
}: {
  tone: 'warning' | 'danger' | 'neutral';
  title: string;
  message: string;
  detail?: string | null;
  action?: { label: string; onPress: () => void } | null;
  testID?: string;
}) {
  const palette =
    tone === 'danger'
      ? { border: colors.danger, background: colors.dangerSoft }
      : tone === 'warning'
        ? { border: colors.warning, background: colors.warningSoft }
        : { border: colors.border, background: colors.surface };

  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      testID={testID}
      style={[styles.card, { borderColor: palette.border, backgroundColor: palette.background }]}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardMessage}>{message}</Text>
      {detail !== null && <Text style={styles.cardDetail}>{detail}</Text>}
      {action !== null && <GhostButton label={action.label} onPress={action.onPress} />}
    </View>
  );
}

export default function LocalEditorScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string; path?: string; project?: string }>();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_LAYOUT;

  const projectName = useMemo(() => {
    const raw = typeof params.name === 'string' ? params.name.trim() : '';
    return raw === '' ? EDITOR_TITLE : raw;
  }, [params.name]);
  const projectPath = typeof params.path === 'string' ? params.path.trim() : '';

  const [source, setSource] = useState<EditorSource>(() => bridgeEditorSource(bridgeChannel()));
  const [tree, setTree] = useState<TreeState>({ kind: 'loading' });
  const [bufferState, setBufferState] = useState<BufferState | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [lastReadPath, setLastReadPath] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);

  /** Last good tree: a later timeout shows it as `stale`, never as empty. */
  const treeCache = useMemo(() => new TreeCache(), []);

  const buffer: EditorBuffer | null = bufferState?.kind === 'success' ? bufferState.buffer : null;
  const code = useMemo(() => (buffer === null ? null : renderCode(buffer.text)), [buffer]);

  const load = useCallback(
    async (next: EditorSource) => {
      setTree({ kind: 'loading' });
      setTree(await loadTree(next, { cache: treeCache }));
    },
    [treeCache],
  );

  useEffect(() => {
    void load(source);
  }, [load, source]);

  const rows = useMemo(() => {
    if (tree.kind === 'success' || tree.kind === 'stale') {
      return treeRows(tree.entries);
    }
    if (tree.kind === 'offline') {
      return tree.entries === null ? [] : treeRows(tree.entries);
    }
    return [];
  }, [tree]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/local-projects');
  }, [router]);

  const readPath = useCallback(
    async (path: string) => {
      log.info('open file', { path, route: '/local-editor' });
      setLastReadPath(path);
      setOpeningPath(path);
      setBufferState({ kind: 'loading' });
      setSaveNote(null);
      const state = await readFile(source, path);
      setOpeningPath(null);
      setBufferState(state);
      setTreeOpen(false);
      if (state.kind !== 'success') {
        log.warn('file not opened', { path, why: state.kind });
      }
    },
    [source],
  );

  const requestOpen = useCallback(
    (row: FileRow) => {
      if (row.kind === 'dir') {
        log.info('dir tap', { path: row.path });
        return;
      }
      if (buffer !== null && buffer.dirty) {
        setPending({ kind: 'open', row });
        return;
      }
      void readPath(row.path);
    },
    [buffer, readPath],
  );

  const requestBack = useCallback(() => {
    if (buffer !== null && buffer.dirty) {
      setPending({ kind: 'close' });
      return;
    }
    goBack();
  }, [buffer, goBack]);

  const confirmDiscard = useCallback(() => {
    const action = pending;
    setPending(null);

    if (buffer !== null) {
      const closed = closeBuffer(buffer, true);
      log.info('discard changes', {
        path: buffer.path,
        discarded: closed.ok ? closed.discarded : false,
      });
    }
    setBufferState(null);
    setSaveNote(null);

    if (action !== null && action.kind === 'open') {
      void readPath(action.row.path);
      return;
    }
    goBack();
  }, [buffer, goBack, pending, readPath]);

  const onEdit = useCallback(
    (text: string) => {
      if (buffer === null) {
        return;
      }
      setBufferState({ kind: 'success', buffer: editBuffer(buffer, text) });
      setSaveNote(null);
    },
    [buffer],
  );

  const onSave = useCallback(() => {
    if (buffer === null) {
      return;
    }
    // Nothing is written: the intent is pending and the buffer stays dirty.
    const intent = saveIntent(buffer);
    log.warn('route pending', {
      route: intent.route,
      method: intent.method,
      path: intent.path,
      pending: intent.pending,
    });
    setSaveNote(intent.note);
  }, [buffer]);

  const retry = useCallback(() => {
    log.info('retry read', { route: '/local-editor', note: RETRY_NOTE });
    setSaveNote(null);
    const next = bridgeEditorSource(bridgeChannel());
    setSource(next);
    // A retry never throws away typed text: it only re-asks when the buffer is
    // closed or untouched.
    if (lastReadPath !== null && (buffer === null || !buffer.dirty)) {
      void readPath(lastReadPath);
    }
  }, [buffer, lastReadPath, readPath]);

  // On a narrow phone the list collapses unless it is the only thing there is
  // (no rows: loading, empty, no-fs, error), so a capability gap is never
  // hidden behind a toggle.
  const showList = wide || treeOpen || rows.length === 0;
  const showPane = wide || !treeOpen;
  const pieces = buffer === null ? [] : breadcrumb(buffer.path);

  /** Refusal of the dirty close, so the confirm sheet shows the real reason. */
  const discardRefusal = buffer !== null && pending !== null ? closeBuffer(buffer) : null;
  const discardMessage =
    discardRefusal !== null && !discardRefusal.ok ? discardRefusal.message : null;

  /** State chip of the tree column (never a fake "todo bien"). */
  const treeChip = useMemo(() => {
    switch (tree.kind) {
      case 'loading':
        return 'leyendo…';
      case 'empty':
        return 'proyecto vacío';
      case 'success':
        return `${rows.length} ${rows.length === 1 ? 'entrada' : 'entradas'}`;
      case 'stale':
        return `datos de hace ${tree.minutes} min`;
      case 'offline':
        return 'sin conexión';
      case 'no-fs':
        return 'sin archivos';
      case 'error':
        return 'error';
    }
  }, [tree, rows.length]);

  return (
    <View style={styles.screen}>
      <View style={[styles.appbar, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Volver a proyectos locales"
          accessibilityHint={buffer?.dirty === true ? 'Pregunta antes de descartar los cambios.' : undefined}
          onPress={requestBack}
          style={styles.back}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View style={styles.appbarTitle}>
          <Text style={styles.projectName} accessibilityRole="header" numberOfLines={1}>
            {projectName}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {projectPath === '' ? treeChip : `${projectPath} · ${treeChip}`}
          </Text>
        </View>
        {!wide && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: treeOpen }}
            accessibilityLabel={treeOpen ? 'Ocultar archivos' : 'Mostrar archivos'}
            onPress={() => setTreeOpen((open) => !open)}
            style={styles.iconButton}
            testID="local-editor-tree-toggle">
            <Text style={styles.iconGlyph}>{treeOpen ? '▤' : '☰'}</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={SAVE_LABEL}
          accessibilityHint={buffer === null ? 'Abrí un archivo primero.' : saveNote ?? 'Guardar todavía no está conectado.'}
          accessibilityState={{ disabled: buffer === null }}
          disabled={buffer === null}
          onPress={onSave}
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.saveButtonPressed,
            buffer === null && styles.saveButtonInactive,
          ]}
          testID="local-editor-save">
          <Text style={styles.saveLabel}>{SAVE_LABEL}</Text>
          {buffer?.dirty === true && (
            <View style={styles.dirtyDotInk} accessibilityElementsHidden />
          )}
        </Pressable>
      </View>

      <View style={styles.tabsRow}>
        {buffer !== null ? (
          <View style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: true }}>
            <Text style={styles.tabName} numberOfLines={1}>
              {pieces[pieces.length - 1] ?? buffer.path}
            </Text>
            {buffer.dirty && (
              <>
                <View style={styles.dirtyDot} accessibilityElementsHidden />
                <Text style={styles.tabMeta}>sin guardar</Text>
              </>
            )}
          </View>
        ) : (
          <Text style={styles.tabEmpty}>{NO_FILE_COPY}</Text>
        )}
        {openingPath !== null && <ActivityIndicator size="small" color={colors.accent} />}
      </View>

      <View style={[styles.body, wide && styles.bodyWide]}>
        {showList && (
          <View style={[styles.listColumn, wide && styles.listColumnWide]}>
            <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
              {rows.length > 0 && (
                <Text style={styles.legend}>
                  {pieces.length > 1 ? pieces.slice(0, -1).join(' / ') : 'Archivos'}
                </Text>
              )}

              {tree.kind === 'loading' && (
                <View style={styles.skeletonList} testID="local-editor-tree-skeleton">
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </View>
              )}

              {rows.length > 0 && (
                <View style={styles.fileList}>
                  {rows.map((row) => (
                    <FileListRow
                      key={row.path}
                      row={row}
                      selected={buffer?.path === row.path}
                      onPress={() => requestOpen(row)}
                    />
                  ))}
                </View>
              )}

              {tree.kind === 'no-fs' && (
                <StateCard
                  tone="warning"
                  title={NO_FS_COPY}
                  message={tree.message}
                  detail="En modo local los archivos saldrían del core del teléfono, que todavía no expone fs_read."
                  testID="local-editor-no-fs"
                />
              )}

              {tree.kind === 'empty' && (
                <StateCard
                  tone="neutral"
                  title={TREE_EMPTY_COPY}
                  message={TREE_EMPTY_NOTE}
                  testID="local-editor-empty"
                />
              )}

              {tree.kind === 'offline' && (
                <StateCard
                  tone="warning"
                  title={OFFLINE_COPY}
                  message={RECONNECTING_COPY}
                  detail={tree.entries === null ? RETRY_NOTE : 'La lista que ves es la última que llegó.'}
                  action={{ label: RETRY_LABEL, onPress: retry }}
                  testID="local-editor-offline"
                />
              )}

              {tree.kind === 'stale' && (
                <View style={styles.staleChip} testID="local-editor-stale">
                  <Text style={styles.staleChipText}>{`Datos de hace ${tree.minutes} min`}</Text>
                </View>
              )}

              {tree.kind === 'error' && (
                <StateCard
                  tone="danger"
                  title={ERROR_TITLE}
                  message={tree.message}
                  detail={tree.raw}
                  action={{ label: RETRY_LABEL, onPress: retry }}
                  testID="local-editor-tree-error"
                />
              )}
            </ScrollView>
          </View>
        )}

        {showPane && (
          <View style={styles.paneColumn}>
            {bufferState === null && (
              <View style={styles.welcome}>
                <Text style={styles.welcomeTitle}>{NO_FILE_COPY}</Text>
                <Text style={styles.meta}>
                  El árbol sale de la PC cuando hay túnel. Sin túnel, este editor no puede leer
                  archivos todavía.
                </Text>
              </View>
            )}

            {bufferState?.kind === 'loading' && <SkeletonLines />}

            {bufferState?.kind === 'no-fs' && (
              <StateCard
                tone="warning"
                title={READ_ERROR_TITLE}
                message={bufferState.message}
                detail={bufferState.raw}
                testID="local-editor-buffer-no-fs"
              />
            )}

            {bufferState?.kind === 'offline' && (
              <StateCard
                tone="warning"
                title={OFFLINE_COPY}
                message={bufferState.message}
                detail={RETRY_NOTE}
                action={{ label: RETRY_LABEL, onPress: retry }}
                testID="local-editor-buffer-offline"
              />
            )}

            {bufferState?.kind === 'error' && (
              <StateCard
                tone="danger"
                title={READ_ERROR_TITLE}
                message={bufferState.message}
                detail={bufferState.raw}
                action={{ label: RETRY_LABEL, onPress: retry }}
                testID="local-editor-buffer-error"
              />
            )}

            {buffer !== null && code !== null && (
              <>
                <View style={styles.pane} testID="local-editor-pane">
                  {code.truncated ? (
                    <ScrollView style={styles.paneScroll} contentContainerStyle={styles.codeContent}>
                      {code.lines.map((line) => (
                        <Text key={line.number} style={styles.codeLine}>
                          <Text style={styles.gutterText}>{`${line.number}`.padStart(3, ' ')}  </Text>
                          {line.text}
                        </Text>
                      ))}
                      <Text style={styles.truncatedMarker}>{code.marker}</Text>
                    </ScrollView>
                  ) : (
                    <ScrollView
                      style={styles.paneScroll}
                      contentContainerStyle={styles.codeContent}
                      keyboardShouldPersistTaps="handled">
                      <View style={styles.editorRow}>
                        {/* The gutter is real layout, so the numbers never drift
                            out of sync with the text while typing. */}
                        <Text style={styles.gutterText} accessibilityElementsHidden>
                          {code.lines.map((line) => `${line.number}`.padStart(3, ' ')).join('\n')}
                        </Text>
                        <TextInput
                          value={buffer.text}
                          onChangeText={onEdit}
                          multiline
                          scrollEnabled={false}
                          style={[
                            styles.codeInput,
                            { minHeight: code.lines.length * CODE_LINE_HEIGHT + spacing.sm },
                          ]}
                          accessibilityLabel={`Contenido de ${buffer.path}`}
                          accessibilityHint="Cada línea tiene su número a la izquierda. Guardar todavía no está conectado."
                          autoCapitalize="none"
                          autoCorrect={false}
                          spellCheck={false}
                          textAlignVertical="top"
                          testID="local-editor-input"
                        />
                      </View>
                    </ScrollView>
                  )}
                </View>

                {code.truncated && (
                  <StateCard
                    tone="warning"
                    title={LARGE_FILE_COPY}
                    message={LARGE_FILE_DETAIL}
                    testID="local-editor-large-file"
                  />
                )}
              </>
            )}

            {saveNote !== null && (
              <StateCard
                tone="warning"
                title="Guardar está pendiente"
                message={saveNote}
                testID="local-editor-save-note"
              />
            )}
          </View>
        )}
      </View>

      {pending !== null && buffer !== null && (
        <View style={styles.overlay}>
          <View style={styles.confirmCard} accessibilityRole="alert" testID="local-editor-confirm">
            <Text style={styles.confirmTitle}>{DISCARD_TITLE}</Text>
            {discardMessage !== null && <Text style={styles.cardMessage}>{discardMessage}</Text>}
            <Text style={styles.cardDetail}>
              {pending.kind === 'close'
                ? 'Salir del editor'
                : `Abrir ${pending.row.path}`}
              {' descarta los cambios de este archivo.'}
            </Text>
            <View style={styles.confirmActions}>
              <GhostButton label={DISCARD_CANCEL_LABEL} onPress={() => setPending(null)} />
              <GhostButton label={DISCARD_CONFIRM_LABEL} onPress={confirmDiscard} />
            </View>
          </View>
        </View>
      )}
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
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
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
    minWidth: 0,
  },
  projectName: {
    ...typography.h1,
    fontSize: 16,
    lineHeight: 21,
    letterSpacing: -0.2,
    color: colors.text,
  },
  meta: {
    ...typography.fine,
    color: colors.faint,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 18,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    ...elevation.glow,
  },
  saveButtonPressed: {
    backgroundColor: colors.accentHover,
  },
  saveButtonInactive: {
    backgroundColor: colors.border,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveLabel: {
    ...typography.chip,
    color: colors.accentInk,
  },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  dirtyDotInk: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentInk,
  },
  tabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 40,
    paddingRight: spacing.md,
    borderBottomWidth: 2,
    borderBottomColor: colors.accent,
  },
  tabName: {
    ...typography.label,
    color: colors.text,
  },
  tabMeta: {
    ...typography.hint,
    color: colors.faint,
  },
  tabEmpty: {
    ...typography.fine,
    flex: 1,
    color: colors.faint,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  bodyWide: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  listColumn: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  listColumnWide: {
    flexGrow: 0,
    flexBasis: 240,
    flexShrink: 0,
    paddingHorizontal: 0,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingRight: spacing.md,
  },
  listScroll: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  legend: {
    ...typography.legend,
    color: colors.muted,
    marginBottom: spacing.xs,
  },
  fileList: {
    gap: 2,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingRight: spacing.sm,
    borderRadius: radius.sm,
  },
  fileRowSelected: {
    backgroundColor: colors.accentSoft,
  },
  fileRowPressed: {
    backgroundColor: colors.surface,
  },
  fileGlyph: {
    ...typography.body,
    color: colors.faint,
  },
  fileGlyphDir: {
    color: colors.deepPink,
  },
  fileName: {
    ...typography.body,
    flex: 1,
    color: colors.text,
  },
  fileNameDir: {
    color: colors.muted,
    fontWeight: '600',
  },
  fileSize: {
    ...typography.hint,
    color: colors.faint,
    fontVariant: ['tabular-nums'],
  },
  skeletonList: {
    gap: spacing.md,
  },
  skeletonRow: {
    minHeight: 34,
    justifyContent: 'center',
  },
  skeletonBar: {
    height: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
  },
  skeletonPane: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
  },
  paneColumn: {
    flex: 1,
    minHeight: 0,
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  welcome: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  welcomeTitle: {
    ...typography.label,
    color: colors.text,
  },
  pane: {
    flex: 1,
    minHeight: 0,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
    ...elevation.card,
    overflow: 'hidden',
  },
  paneScroll: {
    flex: 1,
  },
  codeContent: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  codeLine: {
    fontSize: 12,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.text,
  },
  editorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  gutterText: {
    width: 40,
    paddingRight: spacing.sm,
    fontSize: 12,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.faint,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  codeInput: {
    flex: 1,
    padding: 0,
    margin: 0,
    fontSize: 12,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.text,
    backgroundColor: 'transparent',
  },
  truncatedMarker: {
    ...typography.body,
    color: colors.warning,
    marginTop: spacing.sm,
  },
  staleChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  staleChipText: {
    ...typography.chip,
    fontSize: 10,
    lineHeight: 14,
    color: colors.warning,
  },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  cardTitle: {
    ...typography.label,
    color: colors.text,
  },
  cardMessage: {
    ...typography.body,
    color: colors.muted,
  },
  cardDetail: {
    ...typography.fine,
    color: colors.faint,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  confirmCard: {
    width: '100%',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    ...elevation.card,
  },
  confirmTitle: {
    ...typography.label,
    fontSize: 15,
    lineHeight: 21,
    color: colors.text,
  },
  confirmActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
});
