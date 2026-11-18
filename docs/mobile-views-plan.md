# Gentle Movil — Full View Plan (product definition)

Status: v1.0 — 2026-11-17. **This document is the product definition.** Every view the app
ships is listed here with its elements, its states and what happens on every tap. If a view
is not in this document it is not in v1.

Sources of truth:

| Topic | Document |
|---|---|
| Stack, modes, OTA rule | `docs/mobile-app-stack.md` (frozen) |
| QR / handshake / tunnel / daemon upgrade | `docs/mobile-protocol-spec.md` (v0.1) |
| Visual tokens, type, shape | `design/system.md` (+ `design/system.html`) |
| Feature specs, tasks, log | `odd/tasks/mobile-app.md` |
| Artboards | `design/mobile-app-onboarding/`, `design/mobile-app-core/` |

Owner directive that produced this file (verbatim): «Primero tambien planea todas las vistas que necesita y como se va a ver cuando reaccione cada cosa y hazlas todas ese va a ser el producto» — S7 in `odd/tasks/mobile-app.md`.

---

## 1. Shared rules (apply to every view)

### 1.1 Navigation shell

- Root = tab bar with 4 tabs: **Overview** (V5), **Sessions** (V6), **Automations** (V10),
  **Settings** (V18). Tab bar hides on full-screen surfaces (V7 terminal, V15 editor) and
  returns on back.
- Modal stack: New session (V8), Answer inbox sheet (V9), Automation editor (V11),
  Pairing progress (V3), Confirm dialogs.
- Every view is deep-linkable (push notification → V7, notification of question → V9/V7).
- Back gesture never discards an unsent steer draft; drafts persist per session in SQLite.

### 1.2 State vocabulary (used identically in every view)

| State | Definition | Rendering |
|---|---|---|
| `loading` | first load, no cached data | skeleton rows (never a blank screen) |
| `refreshing` | cached data visible, re-fetch in flight | thin top progress line |
| `empty` | loaded, zero items | illustration + one primary action |
| `error` | fetch failed, no cached data | inline error block + **Reintentar** |
| `stale-error` | fetch failed, cached data visible | amber chip under the header, data stays |
| `offline` | no network / tunnel down | global banner (§ V20) + cached data |
| `success` | loaded with data | normal render |

Rules: cached data is always shown before network data (local-first SQLite). A failed
refresh never blanks a populated screen. Errors are inline; toasts only for actions.

### 1.3 Optimistic vs wait (reaction policy)

| Action class | Policy | On failure |
|---|---|---|
| Steer text, answer a prompt, approve/deny | **optimistic append** with a pending dot | dot turns red, tap to resend; text never lost |
| Create session, install daemon, pair | **wait** with a blocking progress step | step marked failed, retry stays on that step |
| Toggle (automation enabled, theme, bridge) | **optimistic flip** + revert on failure | toggle snaps back + toast |
| Git stage / commit / push | stage = optimistic; commit/push = wait | toast with git stderr summary |
| Destructive (revoke device, delete file) | **confirm dialog** then wait | toast, list unchanged |

### 1.4 Copy conventions

UI copy is Spanish (audience decision, see Open questions Q1). Standard strings:

| Use | Copy |
|---|---|
| Generic retry | `Reintentar` |
| Network failure | `Sin conexión. Revisa tu red o el túnel.` |
| Tunnel lost | `Túnel interrumpido. Reconectando…` |
| Reconnected | `Reconectado` |
| Daemon too old | `El daemon es antiguo. Actualízalo para continuar.` |
| Local-mode capability miss | `Requiere modo conectado` |
| Action timeout | `No respondió a tiempo. Inténtalo de nuevo.` |
| Permission denied (camera) | `Sin cámara no podemos leer el QR. Puedes escribir los datos a mano.` |

Toasts are 3 s, one line, never carry a whole stack trace; details go to a "Detalles" link.

---

## 2. Onboarding (first run)

### V1 — QR scan
Artboard: `design/mobile-app-onboarding/01-qr-scan`
Purpose: pair with a PC in one step, the password-in-the-QR path (stack doc §Modo conectado).

Elements: black camera viewport with a centered cut-out frame, torch toggle, "…" hint text
`Apunta al QR de Gentle Shell`, secondary buttons `Escribir datos manualmente` → V2,
`¿No tienes QR?` help sheet, manual-code field fallback (short code `XXXX-XXXX`).

States:

| State | Rendering |
|---|---|
| permission undetermined | explanation card first: why the camera is needed + **Permitir cámara** (browsers/OS require a tap) |
| permission denied | viewport replaced by lock illustration, copy `Sin cámara no podemos leer el QR. Puedes escribir los datos a mano.`, primary **Abrir ajustes**, secondary → V2 |
| camera unavailable (emulator / no hardware) | same as denied, without `Abrir ajustes` |
| scanning | live preview + frame pulse |
| invalid QR (not `gc://pair`) | red frame flash + toast `Ese código no es de Gentle Movil.`; scanning continues |
| valid QR | freeze frame, show summary sheet: host, port, user, fingerprint (mono, grouped hex) → continue to V3 |
| token expired / already burned | sheet shows `Invitación caducada o ya usada.` + **Pedir otro QR** |

Reactions:

| Tap | Reaction | Call | Failure copy |
|---|---|---|---|
| **Permitir cámara** | OS prompt | — | `Permiso denegado.` → denied state |
| torch | toggles light | — | — |
| QR detected | parse locally, show summary before any network | `pairFromQr(uri)` (Rust FFI, §6) | parse error toast `QR incompleto. Pide uno nuevo.` |
| **Continuar** | push V3 step 1 | `sshConnect` | stays V1 summary, toast `No pudimos conectar. Revisa que el PC esté encendido.` |
| **Escribir datos manualmente** | push V2 | — | — |
| typed short code + Enter | resolve invite on the default LAN address | `GET /api/pairing/*` equivalent via typed code (same rules as PWA) | wrong code: counter message `Código incorrecto (3/10).` |

### V2 — Manual SSH entry
Artboard: `design/mobile-app-onboarding/02-manual-ssh`
Purpose: pair without a QR — IP/host, user, password or existing key (protocol spec §1 last
paragraph). Also the escape hatch when the camera is blocked.

Elements: fields `Host o IP`, `Puerto` (default 22), `Usuario`, segmented auth control
`Contraseña` / `Clave`, password field with reveal, key picker (import file / paste PEM),
advanced disclosure (fingerprint expected, custom daemon port), primary **Conectar**.

States:

| State | Rendering |
|---|---|
| pristine | primary disabled until host + user + credential present |
| validating | inline per-field errors on blur (`Formato de host no válido`, `Puerto 1–65535`) |
| connecting | button becomes spinner + step text `Conectando por SSH…`, fields locked |
| host fingerprint unknown | modal: first-use confirmation (TOFU) with full fingerprint + `Confiar y continuar` / `Cancelar` |
| fingerprint changed vs stored | **red** modal `La huella del host cambió.` + `Abortar` (default) / `Sé lo que hago` (requires long-press) |
| auth failed | inline banner `Credenciales rechazadas.` fields unlocked, credential field cleared |
| success | push V3 step 1 (skips token, daemon install runs) |

Reactions:

| Tap | Reaction | Call | Failure copy |
|---|---|---|---|
| **Conectar** | wait (blocking) | `sshConnect(host, port, user, cred)` | see states above |
| key import | native file picker, stored in Keychain/Keystore | `deviceKeyPublic` untouched (host key only) | `No pudimos leer esa clave.` |
| fingerprint `Confiar y continuar` | stores fingerprint, continues | — | — |
| `Sé lo que hago` | stores new fingerprint + permanent amber chip in V5 header | — | — |

### V3 — Pairing progress
Artboard: `design/mobile-app-onboarding/03-pairing-progress`
Purpose: one visible, honest pipeline from SSH to a live tunnel (protocol §2, §3, §4). Steps
run in order; a failed step stops the pipeline and stays retryable.

Elements: vertical 5-step list with per-step icon, title, one-line detail and duration;
expandable log (“Ver detalles”), step statuses pending / running / ok / warn / fail; primary
**Reintentar paso** on failure, `Continuar de todos modos` only where allowed.

| Step | Detail line | What runs | Failure reaction |
|---|---|---|---|
| 1 · Conectar | `SSH a <host>` | `sshConnect` | inline `SSH rechazado`; retry step; **Editar datos** → V2 |
| 2 · Confirmar huella | `Compara con la pantalla de tu PC` | fingerprint compare (TOFU) | modal abort / override (as V2) |
| 3 · Instalar daemon | `Comprobando versión…` → `Subiendo binario…` | `execOnce` uname + `~/.gentle-movil/daemon` check → SFTP put → `chmod +x` → start (§3.1–3.4) | `Firma del daemon no válida. Instalación abortada.` with **Ver detalles**; never continues |
| 4 · Registrar dispositivo | `Enviando clave pública…` | `REGISTER_DEVICE {deviceName, ed25519PublicKey, inviteToken?}` (§2.3) | token burned/expired: `Invitación caducada. Genera un QR nuevo.` + **Volver a V1** |
| 5 · Abrir túnel | `Canal seguro listo` | `sshDirectTcp` to `43722` + WS upgrade with `X-GC-Proto-App: 1` (§4) | `426` → daemon-upgrade prompt (V20); timeout `El túnel no abrió. Reintentar` |

States: `loading` (step spinner), `success` (all five green → auto-advance to V4 with a
`Listo` moment), `error` (failed step red, earlier steps stay green — resumable),
`offline` (step 1 fails fast, banner shows `Sin red`, no log spam).

Reactions: tap a step → expands its log; tap **Reintentar paso** → re-runs only that step
(earlier state reused: live SSH session, installed daemon); long-press the fingerprint →
copy. Every step transition is a real event, never a timer-driven fake progress.

### V4 — First-run mode choice
Artboard: `design/mobile-app-onboarding/04-mode-choice`
Purpose: make the two modes explicit on day one (stack doc §Los dos modos; S3).

Elements: three large cards — **Conectado** (`Controla tu PC desde el móvil`),
**Local** (`Desarrolla en el móvil, sin PC`), **Ambos** (default, `Lo mejor de los dos`) —
each with a one-line capability list; footer note `Puedes cambiarlo en Ajustes.`; primary
**Empezar**.

States: `pristine` (Ambos preselected), `saving` (button spinner), `error`
(`No pudimos guardar. Reintentar`), `success` (route by mode: includes Local → **V21 suite
installer** first, then the tunnel path; connected-only → V1 QR scan; local-only → V21 only,
no QR — owner amendment L10).

Reactions:

| Tap | Reaction | Call | Notes |
|---|---|---|---|
| card | selects (optimistic) | — | Conectado is offered only if a device exists from V3 |
| **Empezar** | writes `mode` to local store, routes by mode | `sqliteOpen` | both → V21 → V1; PC-only → V1; local-only → V21 → V14, no scan |
| local-only selected | shows second note `El modo conectado se puede activar luego.` | — | no tunnel attempted |

### V21 — Suite installer (on the phone)
Artboard: `design/mobile-app-onboarding/05-suite-install`
Purpose: pick and install the Gentle suite components ON THE PHONE for local mode
(owner amendment L10: "elegir que instalar si quiere en el movil también"). Runs before
the QR scan whenever the chosen mode includes local.

Elements: three selectable component rows — **gentle-shell** (agent: chat, code,
automations), **engram** (persistent memory), **gentle-ai** (background jobs and
subagents) — each with icon, one-line description and a check marker; note
`gentle-shell necesita engram para recordar`; primary CTA `Instalar N componentes →`
(singular `Instalar 1 componente →`, disabled at 0); secondary `Instalar todo`.

States per component: `selected` (default: all three checked), `deselected` (stays for
later from Ajustes), `installing` (animated bar), `ok` (check + `instalado`), `fail`
(danger border + `Reintentar <componente>` primary CTA and `Continuar de todos modos`).

Flow order (owner amendment L10): mode choice (V4) → suite install (V21, only when local
is included) → QR scan (V1) → pairing progress (V3) → mode entry (V5/V14). Local-only:
V4 → V21 → V14, nothing scans. PC-only: V4 → V1 directly, no phone-side install.

Reactions:

| Tap | Reaction | Call | Notes |
|---|---|---|---|
| row | toggles selection | — | engram auto-checks when gentle-shell is checked |
| **Instalar N** | installs the picked set inside the app sandbox, per-component state | `fs_*` FFI | honest per-component failure, never blocks the others |
| **Continuar de todos modos** | proceeds with whatever succeeded | — | failures stay installable later from Ajustes |

Implementation (T7b part 1, `/suite-install`): the selection reducer with the
dependency rule, the per-component install runner (`installing` → `ok` | `fail`,
never blocking the others), the `{component, ok|fail, raw}` log and the record live
in `mobile/lib/suite.ts` and are pinned by `mobile/test/suite-install.test.mjs`;
`mobile/app/suite-install.tsx` is the rendering shell. Dependency is enforced in
state, not announced: checking gentle-shell checks engram, unchecking engram
unchecks gentle-shell (engram alone stays valid). Result persisted in
`AsyncStorage` under `gentle-movil:suite` as
`{ gentleShell, engram, gentleAi }`, written after every component settles (a
failure persists as `false`) so Ajustes can read it later. The installer is still
**simulated** (600–900 ms per row, logged as `simulado · …`): the real `fs_*`
sandbox install belongs to the local-mode slice (T9). Routing as implemented: V4
`ambos` | `local` → V21, `conectado` → V1; on completion `ambos` → V1, `local` stays
on V21 and logs `local route pending` honestly while the V14 root is still a stub.

---

## 3. Connected mode (control the PC)

### V5 — Overview dashboard
Artboard: `design/mobile-app-core/01-overview`
Purpose: 5-second answer to “what is my machine doing right now?” + entry to everything.

Elements: connection bar (host, tunnel dot, latency); count tiles **Trabajando** / **Esperándote**;
weekly tokens tile (7-day sparkline, total + delta vs previous week); **Acciones rápidas**
row: `Nueva sesión` (V8), `Inbox` (V9), `Automatizaciones` (V10), `Cambios` (V13);
“Reanudar” list of the 3 most recent working sessions; amber fingerprint-changed chip when
TOFU mismatch is active; daemon-upgrade chip when versions diverge.

States:

| State | Rendering |
|---|---|
| loading | skeleton tiles |
| empty (no sessions ever) | tiles show `0` + card `Aún no hay sesiones. Crea la primera.` → V8 |
| success | tiles + lists |
| stale-error | cached numbers + amber chip `Datos de hace <n> min` |
| offline (tunnel down) | numbers greyed + `Reconectando…` (§ V20); actions disabled except V13 cached diff = disabled too |
| daemon 426 | upgrade prompt banner (V20) replacing quick actions |

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| tile **Trabajando** | opens V6 with filter `Working` preselected | — | — |
| tile **Esperándote** | opens V9 | — | — |
| tokens tile | expands 7-day detail sheet (per-day bars, model split) | cached `usage` | `Sin datos de uso todavía.` |
| `Nueva sesión` | push V8 modal | — | — |
| `Inbox` | push V9 | — | — |
| `Automatizaciones` | switch tab V10 | — | — |
| `Cambios` | push V13 (workspace picker if several) | `git status` over tunnel | `No pudimos leer los cambios.` |
| pull to refresh | optimistic refresh, no layout jump | `/api/sessions` + usage | stale-error chip |

### V6 — Sessions list
Artboard: `design/mobile-app-core/02-sessions-list`
Purpose: see every session on the PC and jump into one.

Elements: filter segmented control **Todas / Trabajando / Esperándote / Terminadas**
(counts in labels), search, session rows (workspace, title, last activity, model chip,
status dot, pending-question badge), FAB **+** → V8, pull to refresh, swipe-left row actions
(`Archivar`), long-press → context sheet (Copiar id, Archivar, Ver en V13).

States: `loading` skeleton rows; `empty` per filter (`No hay sesiones terminadas.`);
`empty` overall (`Aún no hay sesiones.` + **Nueva sesión**); `stale-error` rows stay + amber
chip; `offline` rows readable from cache, status dots frozen (`Última vez hace 3 min`),
opening a row is allowed and shows V7 in read-only cache mode; `refreshing` top line.

Reactions:

| Tap | Reaction | Call | Error / optimistic |
|---|---|---|---|
| filter chip | local filter, no fetch; count badges stay | — | — |
| row | push V7, immediate cache render then resync | `GET /api/sessions/{id}/activity` | `No pudimos cargar la sesión. Reintentar` |
| FAB **+** | V8 modal | — | — |
| swipe **Archivar** | optimistic removal + undo toast `Sesión archivada. Deshacer` | `POST archive` | revert + `No se pudo archivar.` |
| pull | refresh list | `/api/sessions` | stale-error chip |
| search | client-side filter on cached titles | — | — |

### V7 — Session detail / terminal control
Artboard: `design/mobile-app-core/03-session-detail`
Purpose: the heart of connected mode — read the live transcript and drive the CLI from the
phone without a PC in front of you.

Elements: connection bar (host, tunnel dot, `Reconectado`); status chip (working/waiting/
ended); live transcript (mono, code blocks horizontally scrollable, tool calls collapsed with
expand, thinking blocks dimmed); pending prompt card docked above the input (question text +
option chips + free-text answer); tool-call approval card (`Comando a ejecutar: <cmd>` +
**Aprobar** / **Denegar**); steer input row (multiline text, send, attach file, keyboard-safe
padding); footer actions (`Archivar`, `Abrir cambios` → V13, `Copiar salida`).

States:

| State | Rendering |
|---|---|
| loading | skeleton of last 5 entries |
| running | streaming entries, auto-scroll pinned unless user scrolled up (`Ir al final` pill) |
| waiting (question) | prompt card with animated accent border; badge on tab bar |
| waiting (tool approval) | approval card; input enabled |
| ended | grey status, input replaced by `Sesión terminada.` + **Nueva sesión** |
| empty transcript | `Esperando la primera respuesta…` |
| error | inline block `No pudimos cargar la sesión.` + **Reintentar** |
| reconnect | banner `Túnel interrumpido. Reconectando…`; cached transcript stays; input allowed (queued) |
| read-only cache (no tunnel) | grey banner `Sin conexión. Solo lectura.` inputs disabled |
| daemon 426 | upgrade prompt; input disabled until resolved |

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| send steer | **optimistic append** user bubble with pending dot → on `ack` dot clears; input clears immediately, draft kept until ack | WS steer message | `No se envió. Toca para reintentar.`; after 3 retries `El túnel no responde.` |
| approve tool | card flips to `Aprobado`, tool entry continues streaming | WS approval `allow` | `No pudimos aprobar. Reintentar` (card stays actionable) |
| deny tool | card flips to `Denegado` + input focused | WS approval `deny` | same as above |
| answer option chip | chip selected, appended, prompts collapse | WS answer | pending dot → `No se envió. Reintentar` |
| answer free text | same as steer | WS answer | same |
| expand tool call | local expand, shows full command/output, no refetch | — | `Salida no disponible.` |
| attach | native picker; upload continues over plain HTTP while WS reconnects | upload endpoint | `Archivo demasiado grande.` / `Tipo no permitido.` |
| banner **Reconectar** (after auto-retry gives up) | manual retry of tunnel | `sshDirectTcp` + WS upgrade | `El túnel no abrió. Reintentar` |
| **Archivar** | confirm → optimistic pop to V6 | archive | revert + toast |
| pull at top of transcript | fetch older page (pagination) | activity log page | `No hay más historial.` |

Never auto-resend a steer after reconnection (matches current daemon policy: prompts/answers
are not resent automatically).

### V8 — New session (modal of V6)
Artboard: covered by `design/mobile-app-core/02-sessions-list` (modal state)
Purpose: start a CLI session from the phone (`tmux new`, stack doc §Modo conectado 4).

Elements: `Nombre` (optional, placeholder `Sesión sin título`), `Workspace` picker (recent
workspaces + `Otro path…` with validation), `Modelo` picker (daemon-provided list, default
`auto`), advanced (`Prompt inicial`, `Modo plan`), primary **Crear y abrir**.

States: `pristine` (disabled until workspace chosen), `creating` (blocking spinner with step
text `Creando sesión…`), `error` (`No pudimos crear la sesión.` inline + **Reintentar**,
form values kept), `offline` (modal opens read-only with `Sin conexión` and **Crear** disabled),
`success` (navigate to V7 and drop the modal from the stack).

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| workspace picker | sheet of recent + existing dirs | cached list | `No pudimos listar workspaces.` |
| `Otro path…` | inline text field, validates on submit | `execOnce([ -d path ])` | `Ese directorio no existe.` |
| **Crear y abrir** | wait; then push V7 (replace, so back returns to V6) | `tmux new-session` via tunnel API | `Nombre en uso.` / `Sin espacio en disco.` |
| cancel / swipe down | discard with confirm only if fields filled | — | — |

### V9 — Waiting-on-you inbox
Artboard: `design/mobile-app-core/04-inbox`
Purpose: one aggregated queue of everything blocked on the human (`Esperándote`).

Elements: cards — session title + workspace, question text, option chips or approval command,
timestamp, `Ir a la sesión` link; per-card inline answer; grouped by age (`Ahora`, `Hoy`,
`Antes`); header count.

States: `loading` skeletons; `empty` (`Nada esperándote. Todo en marcha.` + refresh);
`success`; `stale-error` cards kept + amber chip; `offline` cards visible from cache, answer
actions disabled with `Requiere conexión`; `answering` per-card spinner (non-blocking).

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| option chip | optimistic: card shows chosen answer + collapses after 600 ms with haptic | WS answer | card reopens + `No se envió. Reintentar` |
| free-text answer | same as steer | WS answer | same |
| `Ir a la sesión` | push V7 at the prompt entry | — | — |
| pull | resync questions | `/api/sessions` + activity | stale-error chip |
| swipe card | dismiss locally until next question (no server mutation) | — | — |

### V10 — Automations list
Artboard: `design/mobile-app-core/05-automations-list`
Purpose: see and control scheduled work.

Elements: automation rows (name, schedule summary, next-run countdown `en 2 h 14 min`,
last-run status dot, enabled switch), FAB **+** → V11, section `Pausadas`, empty state CTA.

States: `loading` skeleton; `empty` (`Aún no hay automatizaciones.` + **Crear la primera**);
`success` (countdowns tick locally each minute, no network); `error` (`No pudimos cargar
automatizaciones.` + **Reintentar**); `offline` countdowns continue from cached timestamps +
`Sin conexión` chip, toggles disabled; `toggling` row keeps switch position with inline
spinner.

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| enable switch | **optimistic flip** + countdown recalculates; `toast` only on failure | `PATCH automation.enabled` | revert + `No se pudo cambiar. Reintentar` |
| row | push V11 editor | — | — |
| row long-press → `Historial` | push V12 | — | — |
| **Ejecutar ahora** (row overflow) | optimistic `Programada` badge → `Ejecutando` with spinner | `POST run` | `No se pudo ejecutar.` |
| pull | resync | `/api/automations` | stale-error chip |

### V11 — Automation editor
Artboard: `design/mobile-app-core/06-automation-editor`
Purpose: create/edit an automation from the phone, including a natural-language schedule.

Elements: `Nombre`; `Cuándo` — segmented `Frecuencia` / `Cron` / `Natural`
(`todos los lunes a las 9` parsed to cron preview) with humanized result
(`Cada lunes 09:00 (America/Argentina/Buenos_Aires)`); `Prompt` multiline; `Workspace`
picker; `Zona horaria` picker defaulting to device tz; `Activa` switch; footer
**Guardar** / **Eliminar** (danger, editor only).

States: `pristine` (Save disabled until name + prompt + schedule valid), `validating`
(inline field errors, no network), `saving` (footer spinner), `error`
(`No se pudo guardar.` + **Reintentar**, values kept), `offline` (Save disabled +
`Requiere conexión`), `success` (pop to V10 with toast `Automatización guardada.`),
`dirty` (back gesture asks `Descartar cambios?`).

Validation copy: `Cron inválido.` · `La hora debe estar entre 00:00 y 23:59.` ·
`No entendimos la expresión. Prueba «cada día a las 8».` · `El prompt no puede estar vacío.`

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| schedule segmented | swaps input widget, keeps parsed value | — | — |
| natural text typing | debounced local parse → cron preview, no network | Rust/driver parser | inline `No entendimos la expresión.` |
| tz picker | sheet with device tz first | — | — |
| **Guardar** | wait, then pop + refresh list | `POST/PATCH automation` | `No se pudo guardar.` |
| **Eliminar** | confirm dialog (`¿Eliminar «<nombre>»?`) → wait → pop | `DELETE` | `No se pudo eliminar.` |
| `Historial` row | push V12 | — | — |

### V12 — Automation run history (state of V11)
Artboard: `design/mobile-app-core/06-automation-editor` (history state)
Purpose: verify that a schedule actually ran and what it produced.

Elements: run list (timestamp, duration, status icon ok/failed/cancelled/skipped), filter
chips `Todas / Fallidas`, run row expansion → output preview (first 20 lines, `Ver completo`
→ full-screen mono reader, copy, `Abrir sesión` → V7 when the run has one), empty state
(`Todavía no se ejecutó. Próxima: <fecha>.`).

States: `loading` skeleton; `empty`; `error` (`No pudimos cargar el historial.` +
**Reintentar**); `offline` cached runs + read-only chip; `success`.

Reactions: row tap → expand (local); `Ver completo` → push reader (local data already
fetched, no call); `Abrir sesión` → push V7; pull → resync runs
(`GET /api/automations/{id}/history`, failure = stale-error chip); copy output → toast
`Copiado`.

### V13 — Git changes browser
Artboard: `design/mobile-app-core/07-git-changes`
Purpose: review what the agent changed on the PC before committing from the desk.

Elements: workspace header + branch chip + ahead/behind counters; file list grouped
`Modificados / Nuevos / Borrados` with +/- line counts; file → diff view (unified, mono,
syntax-colored, collapse-by-hunk, `‹ Anterior` / `Siguiente ›` to walk files); actions
`Copiar diff`, `Abrir en sesión` (pushes V7 with a prefilled steer `Revisa este cambio`).

States: `loading` skeleton; `empty` (`Sin cambios en este workspace.` + refresh);
`error` (`No pudimos leer los cambios.`);
`offline` (`Requiere conexión — git se ejecuta en tu PC.`, no cached diff in v1);
`success`; `diff-error` for binary files (`Archivo binario, sin diff.`); `too-large`
(`Diff demasiado grande. Ver resumen.`).

Reactions: file tap → fetch diff once, then prev/next are local (no refetch); prev/next at
the boundary no-ops (no wrap); pull → refresh status; workspace chip → picker; error retry
re-runs the same call.

---

## 4. Local mode (develop from the phone, no PC)

### V14 — Local projects
Artboard: `design/mobile-app-core/08-local-projects`
Purpose: the local-mode home: open or obtain a repo inside the app sandbox.

Elements: project cards (name, path, branch, last opened, uncommitted-dot), primary
**Crear proyecto** (empty repo in sandbox) and **Clonar** (git URL + optional token/SSH key),
row overflow (`Renombrar`, `Eliminar`), storage footer (`1.2 GB de 4 GB`).

States: `loading` skeleton; `empty` (`Aún no hay proyectos. Clona un repositorio o crea uno.`);
`success`; `error` (`No pudimos abrir el proyecto.`);
`offline` fully functional (this is the offline mode — no banner, no network need);
`cloning` inline progress (`Recibiendo objetos 43%`) with cancel; `clone-error`
(`No pudimos clonar. Revisa la URL y la red.`); `disk-full`
(`Sin espacio. Libera espacio en Ajustes.`).

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| project card | push V15, restored tabs | `fs_*` open | `No pudimos leer los archivos.` |
| **Crear proyecto** | name dialog → wait | `git init` (gitoxide) | `Ya existe un proyecto con ese nombre.` |
| **Clonar** | form sheet → wait, cancellable | `git clone` via gitoxide | `Repositorio privado: faltan credenciales.` |
| overflow **Eliminar** | confirm `Se borrará del dispositivo.` | sandbox delete | — |
| pull | rescan sandbox | `fs_*` | — |

### V15 — Local editor
Artboard: `design/mobile-app-core/09-local-editor`
Purpose: the mobile IDE: file tree + tabs + editor + agent (V16) + git (V17), all offline.

Elements: collapsible file tree (tap to open, long-press menu `Renombrar`/`Eliminar`/`Copiar
ruta`), tab strip with unsaved dot `●`, editor with line numbers + syntax highlight + soft
wrap toggle, find-in-file, keyboard toolbar (Tab, arrows, `{`, `}`, undo), bottom sheet
`Agente` (V16) and `Git` (V17) as slide-up panels, breadcrumb path, save-state chip.

States: `loading` tree skeleton; `empty-project` (`Proyecto vacío. Crea un archivo.` + **Nuevo
archivo**); `no-file-open` (welcome pane with recent files); `editing`; `saving` (chip
`Guardando…`); `saved` (chip `Guardado` fades); `conflict`
(`El archivo cambió en disco. Recargar / Sobrescribir`); `error`
(`No pudimos abrir el archivo.`); `large-file` read-only warning
(`Archivo grande: abierto en solo lectura.`); `offline` normal (everything local).

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| file | open tab (replaces preview tab if not dirty) | `fs_read` | `No pudimos abrir el archivo.` |
| tab | switch; swipe tab to close; dirty tab asks `¿Descartar cambios?` | — | — |
| typing | debounced autosave 1.5 s after last keystroke, optimistic `Guardando…` | `fs_write` | `No se pudo guardar.` + keep buffer |
| tree long-press | context menu, delete confirm | `fs_*` | `No se pudo borrar.` |
| `Agente` | opens V16 sheet (session scoped to project) | — | — |
| `Git` | opens V17 sheet | — | — |
| back | closes sheet first, then leaves editor; unsaved buffers kept | — | — |

### V16 — Local agent chat (state of V15)
Artboard: `design/mobile-app-core/09-local-editor` (agent sheet state)
Purpose: same transcript component as V7, running the embedded harness locally (protocol §7).

Elements: **identical** transcript/prompt/approval components as V7 (shared React component),
project-scoped session header, model picker (local), tool-call cards, `Detener` while running.

States: identical to V7 minus tunnel states, plus `capability-blocked`: tool results that
need a shell return `Requiere modo conectado` inline card with a **Conectar** action → V1;
`runtime-unavailable` (`El agente local no está disponible en este dispositivo.` → link
to V0/V1 connected path); `offline` normal; `running`, `waiting`, `ended`, `error`
(`No pudimos cargar la conversación.`).

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| send | optimistic append + local enqueue | embedded harness | `El agente no respondió. Reintentar` |
| approve tool | runs via `fs_*` / `git_*` primitives | FFI | capability error → `Requiere modo conectado` |
| **Conectar** on capability card | starts V1 onboarding (leaves local context) | — | — |
| `Detener` | cancels current turn, transcript keeps partial output | — | — |

Local agent state is persisted in SQLite per project so the chat survives app restarts.

### V17 — Local git panel (state of V15)
Artboard: `design/mobile-app-core/09-local-editor` (git sheet state)
Purpose: stage/commit/push without a PC; local commits work offline.

Elements: branch chip + remote badge, changed-file list with stage toggles, `Stage all`,
commit message field + **Commit**, `Push` / `Pull` buttons (disabled without remote/network),
ahead/behind counters, diff preview link (reuses V13 diff component).

States: `clean` (`Sin cambios.`); `changed`; `staging` (optimistic toggle); `committing`
(spinner, message kept on failure); `pushing` (progress); `conflict`
(**warning state**: amber panel `Conflictos en 2 archivos.` + file list + `Abrir conflicto`
read-only view — no merge editor in v1); `offline` (commit enabled, push/pull disabled with
`Necesitas red para sincronizar.`); `auth-error` (`El remoto rechazó las credenciales.` →
credential sheet); `error` (`No se pudo completar la operación.`).

Reactions:

| Tap | Reaction | Call | Error copy |
|---|---|---|---|
| stage toggle | optimistic flip | `git_add` | revert + `No se pudo preparar el archivo.` |
| **Commit** | wait; on success clears message + refresh status | `git_commit` | `Falta el mensaje de commit.` / `Nada preparado para commitear.` |
| **Push** | wait with progress; on 401 opens credential sheet | `git_push` | `Push rechazado: hay cambios remotos. Pull primero.` |
| **Pull** | wait; may produce `conflict` state | `git_pull` | `No pudimos sincronizar.` |
| `Abrir conflicto` | read-only conflict markers view | `fs_read` | — |

---

## 5. Cross-cutting

### V18 — Settings
Artboard: `design/mobile-app-core/10-settings`
Purpose: one page for identity, connection, appearance and security state.

Sections and rows:

| Section | Row | Content | Reactions |
|---|---|---|---|
| Cuenta / dispositivo | Este dispositivo | name (editable), `deviceId`, model | rename → local save |
| | Clave del dispositivo | `ed25519` public key (short), **Ver huella** | copy (long-press), fingerprint sheet |
| Dispositivos emparejados | per device: name, host, last seen, `Revocar` | confirm dialog → revoke (§8, close code 4003) | revoke = wait; toast `Dispositivo revocado.`; failure `No se pudo revocar.` |
| Conexión | Modo | Conectado / Local / Ambos (mirrors V4) | change is instant, no restart |
| | Bridge | on/off (same semantics as daemon bridge) | optimistic flip + revert toast |
| | Túnel | status dot + host + `Reconectar` | manual retry |
| | Daemon | version + `Actualizar` when newer | upgrade flow (§5) |
| Apariencia | Tema | Oscuro / Claro / Sistema (default Sistema) | instant, per-device |
| Notificaciones | Permiso | allowed / blocked / undetermined + **Activar** | OS prompt (V19) |
| Almacenamiento local | uso | X de Y GB + `Liberar caché` | confirm → frees temp only |
| Acerca de | versión, build, `Actualizaciones OTA` | last OTA check | `Buscar actualizaciones` |
| Avanzado | logs, exportar diagnóstico | share sheet | — |

States: `loading`; `success`; `error` (per-row, not page-level: `No pudimos cargar los
dispositivos.`); `offline` — local sections fully usable, tunnel/daemon/bridge rows disabled +
`Requiere conexión`; `revoking` row spinner; `upgrading` (V20 flow).

### V19 — Notification permission priming
Artboard: `design/mobile-app-core/01-overview` (banner) + `10-settings` (permission row)
Purpose: get push/local notification permission with context, not cold.

Elements: one-time Overview banner `Entérate cuando algo te espera` + secondary
`Ahora no`; settings row; explains exactly which events fire (question asked, turn finished,
session ended) and that nothing is sent while you are viewing that session.

States: `undetermined` (banner visible), `granted` (banner gone, settings shows `Permitido`),
`denied` (`Bloqueado en el sistema` + **Abrir ajustes**), `unavailable`
(`Este dispositivo no admite notificaciones.` — e.g. iOS without Home Screen install),
`success-toast` (`Notificaciones activadas.`).

Reactions: banner **Activar** → OS prompt (single tap, never on app launch); `Ahora no`
dismisses for good (stored locally); notification tap → deep link to V9 or V7 (never to V5).

### V20 — Global states

| Global state | Where it appears | Rendering | Reaction |
|---|---|---|---|
| **Offline banner** | top of every connected view | amber bar `Sin conexión`, cached data marked `Última vez …` | tap → `Reintentar`; inputqueued actions show pending dots |
| **Tunnel reconnecting** | connection bar in V5/V6/V7/V9 | spinner dot + `Túnel interrumpido. Reconectando…` with bounded backoff; on success flash `Reconectado` | tap → immediate manual retry |
| **Daemon upgrade prompt (426)** | modal sheet over the current view when WS upgrade returns `426` (§4) | `El daemon es antiguo. Actualízalo para continuar.` with version pair | **Actualizar ahora** → download+verify (§5.1) → SFTP `daemon.new` → atomic rename → restart → reconnect; **Ahora no** → read-only mode with write actions disabled |
| **Daemon upgrade in progress** | modal progress | steps `Descargando… / Verificando firma… / Subiendo… / Reiniciando…` | non-dismissible; cancel allowed only before the rename |
| **Daemon upgrade failed** | modal | `El reinicio no respondió. Volvimos a la versión anterior.` after the 10 s window (§5) | **Reintentar**, **Ver detalles** |
| **Signature failure** | modal (abort) | `La firma del daemon no es válida. Instalación abortada.` | only **Cerrar** — never offers a bypass |
| **Fingerprint changed** | persistent chip in V5 + banner in V7 | amber `La huella del host cambió.` | tap → compare sheet, `Abortar` default (§8 TOFU) |
| **Forced update** | app launch | full-screen `Esta versión de la app ya no es compatible. Actualiza desde la tienda.` | store link (only when the Rust core changed — OTA cannot fix it) |
| **Fatal error boundary** | any view | error illustration + **Volver al inicio** + copy diagnostics | restart navigation stack |

---

## 6. Implementation notes (bindings for the implementers)

1. **One transcript component** for V7 and V16 (`Transcript`), one for diffs (V13 and V17),
   one for the question card (V7, V9) — differences are props, not forks.
2. **One connection state machine** (`idle → connecting → up → degraded → reconnecting →
   down`) drives V20, V5 bar, V6 row freshness and V7 write-enabled state.
3. **One local store** (SQLite) with tables for sessions, transcript entries, automations,
   runs, projects, drafts, notifications — every view renders cache first, then syncs.
4. **Optimistic queue** is a single durable outbox: pending steers/answers/approvals survive
   app restarts and are retried on reconnect; never auto-sent twice (idempotency key per
   entry).
5. **Mode gate**: every connected action is wrapped by `requireConnected()` which shows
   `Requiere modo conectado` with the correct call to action instead of a dead button.
6. **Countdowns and durations render locally** from server timestamps; never fetch every
   second.

---

## 7. Artboard mapping

Reconciled (2026-11-17) with the artboards actually produced by the two design workers:
`design/mobile-app-onboarding/` (4 files) and `design/mobile-app-core/` (11 files, manifest
in `design/mobile-app-core/design.json`, `feature: odd/tasks/mobile-app.md`). Artboard
filenames below are the authoritative ones.

Navigation contract (decided): the tab bar has **4 tabs — Overview · Sessions · Automations ·
Local**; **Settings lives in the header** (gear affordance on Overview), not in the tab bar.

| View | Artboard |
|---|---|
| V1 QR scan | `design/mobile-app-onboarding/01-qr-scan.html` |
| V2 Manual SSH entry | `design/mobile-app-onboarding/02-manual-ssh.html` |
| V3 Pairing progress | `design/mobile-app-onboarding/03-pairing-progress.html` |
| V4 First-run mode choice | `design/mobile-app-onboarding/04-mode-choice.html` |
| V5 Overview | `design/mobile-app-core/01-overview.html` |
| V6 Sessions list | `design/mobile-app-core/02-sessions-list.html` |
| V7 Session detail / terminal | `design/mobile-app-core/03-terminal-control.html` |
| V8 New session | modal state of `02-sessions-list.html` (no separate artboard) |
| V9 Inbox | `design/mobile-app-core/04-waiting-inbox.html` |
| V10 Automations list | `design/mobile-app-core/05-automations.html` |
| V11 Automation editor | `design/mobile-app-core/06-automation-editor.html` |
| V12 Run history | state of `06-automation-editor.html` (no separate artboard) |
| V13 Git changes browser | `design/mobile-app-core/09-git-changes.html` (reachable from V5 «Ver cambios») |
| V14 Local projects | `design/mobile-app-core/07-local-projects.html` |
| V15 Local editor | `design/mobile-app-core/08-local-editor.html` |
| V16 Local agent chat | state of `08-local-editor.html` (agent strip) |
| V17 Local git panel | state of `08-local-editor.html` (git chip row) |
| V18 Settings | `design/mobile-app-core/10-settings.html` (header affordance, not a tab) |
| V19 Notification priming | `design/mobile-app-core/11-global-states.html` card + settings row |
| V20 Global states | `design/mobile-app-core/11-global-states.html` (gallery) |
| Design system | `design/system.html`, `design/system.md` |

Rule for both workers: an artboard must show, for its view, at least the `success` state plus
one `empty`/`error` variant, and one annotated interaction from the Reactions table. Variants
beyond that are optional.

---

## 8. Open questions (need an owner decision, tracked in the ODD doc)

- **Q1 — UI copy language.** This plan writes Spanish copy (owner's audience). The existing
  web UI ships English strings. Decide: Spanish-only v1, or es/en with i18n from day one.
- **Q2 — Local agent scope.** Stack doc and protocol §7 say "no `exec`"; V16 therefore shows
  capability errors. Confirm that "build/run = connected mode only" is the accepted v1
  promise, since it is the most visible limitation of local mode.
- **Q3 — V13 offline.** No cached diffs in v1 (git runs on the PC). Accept, or cache the last
  viewed diff?
- **Q4 — Tokens source.** V5's weekly token figure depends on the daemon's usage surface;
  confirm which endpoint is authoritative for the mobile client.

---

## Log

- L1 (2026-11-17): created from the owner directive S7. 20 views (V1–V20) inventoried with
  states and reactions; artboards split into two parallel workers; the document is declared
  the product definition.

## Log (enmienda pivote 2026-11-18 — repo Reaan06/gentle-movil)

- Fuera daemon y web: server/, ui/, bridge/ eliminados del repo. El puente entre el teléfono y el agente lo hace el propio agente (Gentle Shell/Pi).
- El "puente oficial" es una extensión Pi que sirve HTTP/WS en loopback 43721/43722 en TS puro (la vieja `/remote-control` era cliente WS; el daemon Rust servía los puertos y fue borrado).
- Conectado: QR (host+puerto+usuario+pw+huella) → SSH russh → detectar extensión en loopback → registrar clave ed25519 en authorized_keys → túnel SSH forward. Sin sudo, sin SFTP, sin binarios.
- Ver `odd/tasks/gentle-movil-pivote.md` (S1-S10, T1-T6).
