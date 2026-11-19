import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FormField } from '../components/FormField';
import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  type LocalProject,
  type ProjectDiskFact,
  type ProjectRow,
  type ProjectsState,
  type ProjectsViewModel,
  activeProjectId,
  buildProjectsView,
  createProjectIntent,
  deleteConfirmMessage,
  deleteProjectIntent,
  loadProjectDisk,
  loadProjects,
  saveProjects,
} from '../lib/local-projects';
import { logger } from '../lib/logger';
import { colors, elevation, radius, spacing, typography } from '../lib/theme';

/**
 * V14 — Local projects (artboard
 * `design/mobile-app-core/07-local-projects.html`, `docs/mobile-views-plan.md`
 * §V14, task T7k).
 *
 * Rendering shell only: parsing, ordering, validation, the empty/corrupt states
 * and every honest reason live in `mobile/lib/local-projects.ts`, pinned by
 * `mobile/test/local-projects.test.mjs`.
 *
 * Only real facts are drawn:
 *
 * - the list is the `gentle-movil:local-projects` record the person created on
 *   this phone (AsyncStorage, read through the injected reader); an empty store
 *   is the empty state, and a corrupt one is the honest error card with
 *   `Reintentar`, never a silently shorter list;
 * - git facts do not exist yet (the core Rust does not expose gitoxide), so
 *   each row carries the `sin datos de git` badge with its reason — never a
 *   branch chip, a dirty dot or a `0 cambios` badge;
 * - what the device really has in each project folder (T18) comes from the
 *   core's `fsList` through `loadProjectDisk`: `N entradas`, `carpeta vacía`, or
 *   the honest reason — never an invented count;
 * - `+ Nuevo proyecto` opens a minimal inline name form that really validates
 *   and really persists the record; `git init` is gitoxide work and waits for
 *   the core, which the form says out loud;
 * - deleting a project (T15) is a two-step action: the row's `Eliminar` only
 *   opens the confirmation, and the copy states plainly that the phone's files
 *   are not touched (physical deletion is a separate action, not implemented);
 * - tapping a project opens `/local-editor` with the **path** the editor needs
 *   to resolve its real device root.
 */

const log = logger.tag('local-projects');

/** Why the app cannot resolve its own folder on the phone. */
const DOCUMENTS_MISSING_REASON =
  'la app no pudo resolver su carpeta en el teléfono, así que no hay raíz que leer.';

/** The app's documents dir, resolved at runtime (never guessed). */
async function resolveDocumentsDir(): Promise<string | null> {
  try {
    const { Paths } = await import('expo-file-system');
    const uri = Paths.document?.uri;
    if (typeof uri === 'string' && uri.trim() !== '') {
      return uri.trim();
    }
    log.failure('documents-dir', new Error(DOCUMENTS_MISSING_REASON), { uri });
    return null;
  } catch (error) {
    log.failure('documents-dir', error, { step: 'resolve-documents' });
    return null;
  }
}

/** Storage surface of the app (AsyncStorage satisfies the injected types). */
const readKey = (key: string): Promise<string | null> => AsyncStorage.getItem(key);
const writeKey = (key: string, value: string): Promise<void> => AsyncStorage.setItem(key, value);

/** The projects of a loaded state, else none (there is nothing to append to). */
function loadedProjects(state: ProjectsState): LocalProject[] {
  return state.kind === 'loaded' ? state.projects : [];
}

function SkeletonCard() {
  return (
    <View style={styles.card} accessibilityElementsHidden>
      <View style={styles.skeletonHead}>
        <View style={[styles.skeletonBar, { width: '45%' }]} />
        <View style={[styles.skeletonBar, { width: 88, height: 20, borderRadius: radius.pill }]} />
      </View>
      <View style={[styles.skeletonBar, { width: '70%' }]} />
      <View style={[styles.skeletonBar, { width: '35%' }]} />
    </View>
  );
}

function ProjectCard({
  row,
  onOpen,
  onDelete,
}: {
  row: ProjectRow;
  onOpen: (row: ProjectRow) => void;
  onDelete: (row: ProjectRow) => void;
}) {
  return (
    <View style={styles.card} testID={`local-project-${row.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.name}. ${row.path}. ${row.lastOpenedLabel}. ${row.disk.label}. ${row.gitFactsReason}`}
        accessibilityHint={row.open.note}
        onPress={() => onOpen(row)}
        style={({ pressed }) => [styles.cardBody, pressed && styles.cardPressed]}>
        <View style={styles.cardHead}>
          <Text style={styles.projectName} numberOfLines={1}>
            {row.name}
          </Text>
          {/* Honest arc: the git facts do not exist on the device yet. */}
          <View style={styles.gitBadge} testID={`local-project-${row.id}-git`}>
            <Text style={styles.gitBadgeText}>{row.gitFactsReason}</Text>
          </View>
        </View>

        <Text style={styles.projectPath} numberOfLines={1}>
          {row.path}
        </Text>
        <Text style={styles.meta}>{row.lastOpenedLabel}</Text>
        <Text style={styles.gitDetail}>{row.gitFactsDetail}</Text>
      </Pressable>

      {/* T18: what the device really has, or the honest reason. */}
      <View style={styles.diskRow} testID={`local-project-${row.id}-disk`}>
        <Text style={styles.diskLabel}>{row.disk.label}</Text>
        {row.disk.reason !== null && (
          <Text style={styles.diskReason} numberOfLines={3}>
            {row.disk.reason}
          </Text>
        )}
      </View>

      {/* T15: the tap opens the confirmation — it never deletes by itself. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Eliminar ${row.name} de la lista`}
        accessibilityHint="Abre una confirmación. Los archivos del teléfono no se tocan."
        onPress={() => onDelete(row)}
        style={({ pressed }) => [styles.deleteButton, pressed && styles.deleteButtonPressed]}
        testID={`local-project-${row.id}-delete`}>
        <Text style={styles.deleteLabel}>Eliminar</Text>
      </Pressable>
    </View>
  );
}

export default function LocalProjectsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [state, setState] = useState<ProjectsState>({ kind: 'loading' });
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** What each project folder really has on the device (T18). */
  const [disk, setDisk] = useState<Record<string, ProjectDiskFact>>({});
  /** Active project: the last one opened/read from this screen. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Row waiting for the delete confirmation (never deleted on one tap). */
  const [pendingDelete, setPendingDelete] = useState<ProjectRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Reads the real device facts of every project folder, never invented ones. */
  const loadDisk = useCallback(async (projects: readonly LocalProject[]) => {
    if (projects.length === 0) {
      setDisk({});
      return;
    }
    const documentsDir = await resolveDocumentsDir();
    const facts = await loadProjectDisk(projects, { documentsDir, logger: log });
    setDisk(facts);
  }, []);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    setSaveError(null);
    const next = await loadProjects(readKey);
    setState(next);
    setActiveId(activeProjectId(loadedProjects(next)));
    await loadDisk(loadedProjects(next));
  }, [loadDisk]);

  useEffect(() => {
    void load();
  }, [load]);

  const vm: ProjectsViewModel = useMemo(() => buildProjectsView(state, { disk }), [state, disk]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/overview');
  }, [router]);

  const openProject = useCallback(
    (row: ProjectRow) => {
      log.info('project tap', { projectId: row.id, route: row.open.route, path: row.path });
      setActiveId(row.id);
      try {
        router.push({
          pathname: row.open.route,
          // `path` is what the editor resolves its real device root from.
          params: { project: row.id, name: row.name, path: row.path },
        });
      } catch (error) {
        log.failure('navigate', error, { route: row.open.route, projectId: row.id });
      }
    },
    [router],
  );

  /** First step of the delete: only opens the confirmation. */
  const requestDelete = useCallback((row: ProjectRow) => {
    log.info('delete tap', { projectId: row.id, path: row.path });
    setDeleteError(null);
    setPendingDelete(row);
  }, []);

  const cancelDelete = useCallback(() => {
    log.info('delete cancelled', { projectId: pendingDelete?.id ?? null });
    setPendingDelete(null);
    setDeleteError(null);
  }, [pendingDelete]);

  const confirmDelete = useCallback(async () => {
    const row = pendingDelete;
    if (row === null) {
      return;
    }
    const result = deleteProjectIntent(row.id, loadedProjects(state), {
      confirm: true,
      activeId,
    });
    if (!result.ok) {
      log.failure('delete-project', new Error(result.message), {
        projectId: row.id,
        needsConfirm: result.needsConfirm,
      });
      setDeleteError(result.message);
      return;
    }

    setSaving(true);
    const saved = await saveProjects(writeKey, result.projects);
    setSaving(false);

    if (!saved.ok) {
      log.failure('delete-project-save', new Error(saved.message), { projectId: row.id });
      setDeleteError(saved.message);
      return;
    }

    log.info('project deleted', {
      projectId: row.id,
      path: row.path,
      activeCleared: result.activeCleared,
      filesTouched: false,
    });
    setState({ kind: 'loaded', projects: result.projects });
    setActiveId(result.activeId);
    setPendingDelete(null);
    setDeleteError(null);
    await loadDisk(result.projects);
  }, [activeId, loadDisk, pendingDelete, state]);

  const submit = useCallback(async () => {
    const result = createProjectIntent(name, loadedProjects(state));
    if (!result.ok) {
      const error = result.errors.find((entry) => entry.field === 'name') ?? result.errors[0];
      setFieldError(error.message);
      log.info('create rejected', { code: error.code });
      return;
    }

    setFieldError(null);
    setSaving(true);
    const next = [...loadedProjects(state), result.project];
    const saved = await saveProjects(writeKey, next);
    setSaving(false);

    if (!saved.ok) {
      setSaveError(saved.message);
      log.failure('save-projects', new Error(saved.message), { projectId: result.project.id });
      return;
    }

    log.info('project created', { projectId: result.project.id, path: result.project.path });
    setState({ kind: 'loaded', projects: next });
    setName('');
    setFormOpen(false);
    setSaveError(null);
    await loadDisk(next);
  }, [loadDisk, name, state]);

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
          <Text style={styles.screenTitle} accessibilityRole="header" numberOfLines={1}>
            {vm.title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {vm.countLabel}
          </Text>
        </View>
        <View style={styles.noPcChip}>
          <Text style={styles.noPcChipText}>{vm.chip}</Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.modeBanner} accessibilityRole="summary">
          <View style={styles.modeIcon}>
            <Text style={styles.modeIconGlyph}>▤</Text>
          </View>
          <View style={styles.modeText}>
            <Text style={styles.modeTitle}>Modo local · editor + agente + git</Text>
            <Text style={styles.meta}>Corre en el teléfono. No necesita la PC ni el túnel SSH.</Text>
          </View>
        </View>

        {vm.loading && (
          <View style={styles.list} testID="local-projects-skeletons">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {vm.error !== null && (
          <View style={styles.errorCard} accessibilityRole="alert" testID="local-projects-error">
            <Text style={styles.errorTitle}>{vm.error.title}</Text>
            <Text style={styles.errorMessage}>{vm.error.message}</Text>
            <Text style={styles.errorDetail}>{vm.error.detail}</Text>
            <GhostButton
              label={vm.error.action.label}
              onPress={() => {
                log.info('retry read', { route: vm.error?.action.route });
                void load();
              }}
            />
          </View>
        )}

        {saveError !== null && (
          <View style={styles.errorCard} accessibilityRole="alert">
            <Text style={styles.errorTitle}>No pudimos guardar el proyecto</Text>
            <Text style={styles.errorDetail}>{saveError}</Text>
          </View>
        )}

        {vm.empty !== null && (
          <View style={styles.emptyCard} testID="local-projects-empty">
            <Text style={styles.emptyTitle}>{vm.empty.title}</Text>
            <Text style={styles.emptyMessage}>{vm.empty.message}</Text>
            {vm.empty.note !== null && <Text style={styles.emptyNote}>{vm.empty.note}</Text>}
          </View>
        )}

        {vm.rows.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.legend}>Proyectos</Text>
            <View style={styles.list}>
              {vm.rows.map((row) => (
                <ProjectCard key={row.id} row={row} onOpen={openProject} onDelete={requestDelete} />
              ))}
            </View>
          </View>
        )}

        {deleteError !== null && (
          <View style={styles.errorCard} accessibilityRole="alert" testID="local-projects-delete-error">
            <Text style={styles.errorTitle}>No pudimos eliminar el proyecto</Text>
            <Text style={styles.errorDetail}>{deleteError}</Text>
          </View>
        )}

        {vm.status !== 'error' &&
          (formOpen ? (
            <View style={styles.formCard} testID="local-projects-form">
              <FormField
                label={vm.create.fieldLabel}
                value={name}
                onChangeText={(value) => {
                  setName(value);
                  if (fieldError !== null) {
                    setFieldError(null);
                  }
                }}
                placeholder={vm.create.placeholder}
                error={fieldError ?? undefined}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
                editable={!saving}
                accessibilityHint="El nombre no puede repetirse, sin importar mayúsculas."
              />
              <Text style={styles.formNote}>{vm.create.note}</Text>
              <View style={styles.formActions}>
                <GhostButton
                  label="Cancelar"
                  onPress={() => {
                    setFormOpen(false);
                    setFieldError(null);
                    setName('');
                  }}
                  disabled={saving}
                />
                <PrimaryButton
                  label={vm.create.submitLabel}
                  onPress={() => void submit()}
                  loading={saving}
                />
              </View>
            </View>
          ) : (
            <PrimaryButton label={vm.create.label} onPress={() => setFormOpen(true)} />
          ))}

        <View style={styles.note}>
          <Text style={styles.noteGlyph}>i</Text>
          <Text style={styles.noteText}>{vm.gitNote}</Text>
        </View>

        {vm.status !== 'error' && (
          <Text style={styles.meta}>
            {vm.countLabel} en el teléfono · sin datos inventados
          </Text>
        )}
      </ScrollView>

      {/* T15: the confirmation step. The phone's files are not touched. */}
      {pendingDelete !== null && (
        <View style={styles.overlay}>
          <View style={styles.confirmCard} accessibilityRole="alert" testID="local-projects-delete-confirm">
            <Text style={styles.confirmTitle}>{vm.delete.confirmTitle}</Text>
            <Text style={styles.errorMessage}>{deleteConfirmMessage(pendingDelete.name)}</Text>
            <Text style={styles.errorDetail}>{vm.delete.filesNote}</Text>
            <View style={styles.confirmActions}>
              <GhostButton
                label={vm.delete.cancelLabel}
                onPress={cancelDelete}
                disabled={saving}
              />
              <GhostButton
                label={vm.delete.confirmLabel}
                onPress={() => void confirmDelete()}
                disabled={saving}
              />
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
  noPcChip: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  noPcChipText: {
    ...typography.chip,
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
  modeBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.lg - 2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.accentSoft,
  },
  modeIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeIconGlyph: {
    color: colors.accentText,
    fontSize: 15,
    lineHeight: 18,
  },
  modeText: {
    flex: 1,
    gap: 3,
  },
  modeTitle: {
    ...typography.label,
    fontSize: 13,
    lineHeight: 19,
    color: colors.text,
  },
  section: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  legend: {
    ...typography.legend,
    color: colors.muted,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    gap: 8,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...elevation.card,
  },
  cardBody: {
    gap: 8,
  },
  cardPressed: {
    borderColor: colors.borderStrong,
  },
  diskRow: {
    gap: 2,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  diskLabel: {
    ...typography.chip,
    color: colors.muted,
  },
  diskReason: {
    ...typography.fine,
    color: colors.faint,
  },
  deleteButton: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
  deleteButtonPressed: {
    borderColor: colors.danger,
    opacity: 0.8,
  },
  deleteLabel: {
    ...typography.chip,
    color: colors.danger,
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
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  projectName: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
    letterSpacing: -0.15,
    color: colors.text,
  },
  projectPath: {
    ...typography.fine,
    color: colors.muted,
  },
  gitBadge: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  gitBadgeText: {
    ...typography.chip,
    fontSize: 10,
    lineHeight: 14,
    color: colors.warning,
  },
  gitDetail: {
    ...typography.fine,
    color: colors.faint,
  },
  skeletonHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  skeletonBar: {
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
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
  errorDetail: {
    ...typography.fine,
    color: colors.faint,
  },
  emptyCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  emptyTitle: {
    ...typography.label,
    color: colors.text,
  },
  emptyMessage: {
    ...typography.lede,
    color: colors.muted,
  },
  emptyNote: {
    ...typography.fine,
    color: colors.faint,
  },
  formCard: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.bento,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  formNote: {
    ...typography.fine,
    color: colors.faint,
  },
  formActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  noteGlyph: {
    ...typography.hint,
    color: colors.deepPink,
  },
  noteText: {
    ...typography.fine,
    flex: 1,
    color: colors.faint,
  },
});
