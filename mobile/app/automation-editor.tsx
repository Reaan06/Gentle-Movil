import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../components/ConnectionBanner';
import { FormField } from '../components/FormField';
import { GhostButton } from '../components/GhostButton';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  type AutomationDraft,
  type AutomationLoad,
  AUTOMATIONS_ROUTE,
  type EditorAutomation,
  buildEditorView,
  draftFromAutomation,
  emptyDraft,
  loadAutomation,
} from '../lib/automations';
import {
  type ConnectionCheck,
  type ConnectionCopy,
  checkConnection,
  connectionCopy,
  deriveConnection,
} from '../lib/connection';
import { logger } from '../lib/logger';
import { bridgeChannel, getActiveTunnel } from '../lib/tunnel-store';
import { colors, radius, spacing, typography } from '../lib/theme';

/**
 * V11 — Automation editor (artboard
 * `design/mobile-app-core/06-automation-editor.html`,
 * `docs/mobile-views-plan.md` §V11). Route `/automation-editor` (`?id=<id>`
 * when editing).
 *
 * Rendering shell only: the schedule parser and its human preview, the typed
 * per-field errors (name / schedule / steps), the dirty diff against the
 * original automation and the `pending: true` save intent live in
 * `mobile/lib/automations.ts`, pinned by `mobile/test/automations.test.mjs`.
 *
 * The PC does not serve the automations write endpoints yet (`POST/PATCH
 * /automations[/<id>]`, protocol §4 only guarantees `/api/health` and
 * `/api/sessions`), so pressing Guardar logs the route and shows the honest
 * note: nothing is saved, nothing is faked. Closing with unsaved changes asks
 * `Descartar cambios?` first.
 */

const log = logger.tag('automations');

/** Statuses the §V20 banner is worth showing for (silence while connected). */
const REPORTED = new Set(['stale', 'offline', 'incompatible', 'unauthorized']);

/** Statuses that mean saving cannot reach the PC. */
const OFFLINE = new Set(['offline', 'incompatible', 'unauthorized']);

interface TouchedFields {
  name: boolean;
  schedule: boolean;
  steps: boolean;
}

const UNTOUCHED: TouchedFields = { name: false, schedule: false, steps: false };

export default function AutomationEditorScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' && params.id !== '' ? params.id : null;

  const [draft, setDraft] = useState<AutomationDraft>(emptyDraft);
  const [automation, setAutomation] = useState<EditorAutomation | null>(null);
  const [load, setLoad] = useState<AutomationLoad | null>(null);
  const [loading, setLoading] = useState(id !== null);
  const [touched, setTouched] = useState<TouchedFields>(UNTOUCHED);
  const [attempted, setAttempted] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);

  const open = useCallback(async () => {
    if (id === null) {
      return;
    }
    setLoading(true);
    try {
      const result = await loadAutomation(bridgeChannel(), id);
      setLoad(result);
      if (result.kind === 'success') {
        setAutomation(result.automation);
        setDraft(draftFromAutomation(result.automation));
        setTouched(UNTOUCHED);
      }
    } catch (error) {
      // loadAutomation never throws by design; a throw is unexpected, so it is
      // logged and shown as an error instead of an empty form.
      log.failure('load-automation', error, id);
      setLoad({ kind: 'error', message: 'No pudimos abrir la automatización.', raw: null });
    } finally {
      setLoading(false);
    }
  }, [id]);

  const inspectConnection = useCallback(async () => {
    const host = getActiveTunnel()?.host ?? null;
    try {
      setCheck(await checkConnection(bridgeChannel(), { host }));
    } catch (error) {
      log.failure('check-connection', error, null);
      const model = deriveConnection({
        tunnel: getActiveTunnel() !== null,
        failure: {
          kind: 'bad-response',
          message: 'No pudimos verificar el puente.',
          raw: String(error),
        },
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
    void open();
    void inspectConnection();
  }, [open, inspectConnection]);

  const status = check?.model.status ?? null;
  const online = status === null || !OFFLINE.has(status);
  const vm = useMemo(
    () => buildEditorView(draft, { automation, online }),
    [draft, automation, online],
  );

  const banner: ConnectionCopy | null =
    check !== null && REPORTED.has(check.model.status) ? check.copy : null;

  const retry = useCallback(() => {
    void open();
    void inspectConnection();
  }, [open, inspectConnection]);

  const setName = useCallback((value: string) => {
    setDraft((current) => ({ ...current, name: value }));
    setTouched((current) => ({ ...current, name: true }));
  }, []);

  const setSchedule = useCallback((value: string) => {
    setDraft((current) => ({ ...current, schedule: value }));
    setTouched((current) => ({ ...current, schedule: true }));
  }, []);

  const setStep = useCallback((index: number, value: string) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, position) => (position === index ? value : step)),
    }));
    setTouched((current) => ({ ...current, steps: true }));
  }, []);

  const addStep = useCallback(() => {
    setDraft((current) => ({ ...current, steps: [...current.steps, ''] }));
    setTouched((current) => ({ ...current, steps: true }));
  }, []);

  const removeStep = useCallback((index: number) => {
    setDraft((current) =>
      current.steps.length <= 1
        ? current
        : { ...current, steps: current.steps.filter((_, position) => position !== index) },
    );
    setTouched((current) => ({ ...current, steps: true }));
  }, []);

  const close = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(AUTOMATIONS_ROUTE);
  }, [router]);

  const requestClose = useCallback(() => {
    if (!vm.dirty) {
      close();
      return;
    }
    Alert.alert(vm.discardPrompt, undefined, [
      { text: vm.discardCancel, style: 'cancel' },
      { text: vm.discardConfirm, style: 'destructive', onPress: close },
    ]);
  }, [vm.dirty, vm.discardPrompt, vm.discardConfirm, vm.discardCancel, close]);

  const save = useCallback(() => {
    setAttempted(true);
    if (!vm.canSave) {
      return;
    }
    // The endpoint does not exist yet: the intent is logged with its route and
    // the screen says so instead of pretending the automation was saved.
    log.info('save intent', {
      route: vm.save.route,
      method: vm.save.method,
      body: vm.save.body,
      changed: vm.changed,
    });
    log.warn('route pending', {
      route: vm.save.route,
      reason: 'save-endpoint-not-built',
      note: vm.save.note,
    });
    setSaveNote(vm.save.note);
  }, [vm]);

  const showError = useCallback(
    (field: keyof TouchedFields): string | null => {
      if (!attempted && !touched[field]) {
        return null;
      }
      return vm[field].error?.message ?? null;
    },
    [attempted, touched, vm],
  );

  const loadError =
    load !== null && (load.kind === 'error' || load.kind === 'not-found') ? load : null;

  return (
    <View style={styles.screen}>
      <View style={[styles.appbar, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Volver"
          onPress={requestClose}
          style={styles.back}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View style={styles.appbarTitle}>
          <Text style={styles.screenTitle} accessibilityRole="header" numberOfLines={1}>
            {vm.title}
          </Text>
          <Text style={styles.metaText} numberOfLines={1}>
            {vm.meta}
          </Text>
        </View>
        {vm.dirty && (
          <View style={styles.dirtyChip}>
            <Text style={styles.dirtyChipText}>Sin guardar</Text>
          </View>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled">
        {banner !== null && (
          <ConnectionBanner
            copy={banner}
            note={check !== null && check.retry.pending ? check.retry.note : null}
            onRetry={retry}
            testID="automation-editor-connection-banner"
          />
        )}

        {loading && (
          <View style={styles.loadingRow} accessibilityRole="progressbar">
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.metaText}>Cargando la automatización…</Text>
          </View>
        )}

        {loadError !== null && (
          <View style={styles.errorCard} accessibilityRole="alert">
            <Text style={styles.errorTitle}>
              {loadError.kind === 'not-found'
                ? 'No encontramos esa automatización'
                : 'No pudimos abrir la automatización'}
            </Text>
            <Text style={styles.errorMessage}>{loadError.message}</Text>
            {loadError.kind === 'error' && loadError.raw !== null && (
              <Text style={styles.errorRaw}>{loadError.raw}</Text>
            )}
            <GhostButton label="Reintentar" onPress={retry} />
          </View>
        )}

        {!loading && loadError === null && (
          <>
            <FormField
              label="Nombre"
              value={draft.name}
              onChangeText={setName}
              placeholder="Briefing diario"
              autoCapitalize="sentences"
              error={showError('name') ?? undefined}
            />

          <View style={styles.field}>
            <FormField
              label="Programación"
              hint="cron, «every 30m» o «disabled»"
              value={draft.schedule}
              onChangeText={setSchedule}
              placeholder="*/15 * * * *"
              error={showError('schedule') ?? undefined}
            />
            <View style={styles.preview}>
              <Text style={styles.previewLabel}>Se leerá como</Text>
              <Text
                style={[styles.previewValue, !vm.schedule.recognized && styles.previewUnknown]}
                numberOfLines={2}>
                {vm.schedule.label}
              </Text>
            </View>
          </View>

          <View style={styles.field}>
            <View style={styles.legendRow}>
              <Text style={styles.legend}>Pasos</Text>
              <Text style={styles.metaText}>{`${draft.steps.length || 0}`}</Text>
            </View>
            {vm.steps.values.length === 0 && (
              <Text style={styles.hint}>Todavía no hay pasos.</Text>
            )}
            <View style={styles.stepList}>
              {draft.steps.map((step, index) => (
                <View key={`step-${index}`} style={styles.stepRow}>
                  <Text style={styles.stepIndex}>{`${index + 1}`}</Text>
                  <TextInput
                    accessibilityLabel={`Paso ${index + 1}`}
                    value={step}
                    onChangeText={(value) => setStep(index, value)}
                    placeholder="Resumí los PRs abiertos"
                    placeholderTextColor={colors.faint}
                    autoCapitalize="sentences"
                    autoCorrect={false}
                    multiline
                    style={styles.stepInput}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Quitar el paso ${index + 1}`}
                    accessibilityState={{ disabled: !vm.steps.canRemove }}
                    disabled={!vm.steps.canRemove}
                    onPress={() => removeStep(index)}
                    style={({ pressed }) => [
                      styles.stepRemove,
                      !vm.steps.canRemove && styles.stepRemoveDisabled,
                      pressed && styles.stepRemovePressed,
                    ]}>
                    <Text style={styles.stepRemoveGlyph}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            <GhostButton label="+ Agregar paso" onPress={addStep} />
            {showError('steps') !== null && (
              <Text style={styles.fieldError} accessibilityRole="alert">
                {showError('steps')}
              </Text>
            )}
            {vm.stepsHint !== null && <Text style={styles.hint}>{vm.stepsHint}</Text>}
          </View>

          {saveNote !== null && (
            <View style={styles.noteCard} accessibilityRole="summary">
              <Text style={styles.noteTitle}>Guardar todavía no está conectado</Text>
              <Text style={styles.noteText}>{saveNote}</Text>
            </View>
          )}

          {attempted && !vm.canSave && vm.saveBlockedCopy !== null && (
            <Text style={styles.hint}>{vm.saveBlockedCopy}</Text>
          )}
          </>
        )}
      </ScrollView>

      {loadError === null && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          <PrimaryButton
            label={vm.saveLabel}
            onPress={save}
            disabled={!vm.canSave}
            reportDisabledPress
            accessibilityHint={
              vm.saveBlockedCopy ?? 'El endpoint de guardado todavía no existe en la PC.'
            }
          />
          <GhostButton label="Cancelar" onPress={requestClose} />
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
    paddingHorizontal: spacing.xl,
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
  },
  screenTitle: {
    ...typography.h1,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  metaText: {
    ...typography.hint,
    color: colors.faint,
  },
  dirtyChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  dirtyChipText: {
    ...typography.chip,
    fontSize: 10,
    color: colors.warning,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
  field: {
    gap: spacing.sm,
  },
  preview: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSunken,
  },
  previewLabel: {
    ...typography.eyebrow,
    fontSize: 10,
    lineHeight: 14,
    color: colors.faint,
  },
  previewValue: {
    ...typography.label,
    color: colors.accentText,
  },
  previewUnknown: {
    color: colors.warning,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  legend: {
    ...typography.legend,
    color: colors.muted,
  },
  hint: {
    ...typography.fine,
    color: colors.faint,
  },
  stepList: {
    gap: spacing.sm,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  stepIndex: {
    width: 22,
    height: 22,
    marginTop: 11,
    textAlign: 'center',
    ...typography.hint,
    color: colors.faint,
  },
  stepInput: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSunken,
    color: colors.text,
    ...typography.input,
  },
  stepRemove: {
    width: 36,
    height: 36,
    marginTop: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepRemoveDisabled: {
    opacity: 0.4,
  },
  stepRemovePressed: {
    borderColor: colors.danger,
  },
  stepRemoveGlyph: {
    color: colors.muted,
    fontSize: 18,
    lineHeight: 20,
  },
  fieldError: {
    ...typography.error,
    color: colors.danger,
  },
  noteCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  noteTitle: {
    ...typography.label,
    color: colors.text,
  },
  noteText: {
    ...typography.body,
    color: colors.muted,
  },
  footer: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSunken,
  },
});
