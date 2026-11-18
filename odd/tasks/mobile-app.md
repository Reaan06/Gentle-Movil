# Gentle Movil — mobile app (Expo + Rust, dual mode)

Feature: the Gentle Shell mobile app. Two mandatory modes from day one, Android + iOS:
**connected** (control the PC over an SSH tunnel, QR pairing like moshi) and **local**
(editor + embedded pi agent + local git on the phone, no PC, no Termux). Phase: specs and
full view plan are written and the design artboards are in progress; implementation has not
started. Truth lives in `docs/mobile-app-stack.md` (frozen stack), `docs/mobile-protocol-spec.md`
(protocol v0.1), `docs/mobile-views-plan.md` (the product: every view, state and reaction) and
this file (specs, tasks, log).

## Specs

- **S1**: «Vamos a definir el stack. La aplicacion debe funcionar localmente para el usuario y debe poder conectarse mediante SSH escaneando un QR como en moshi. debe poder ver sus sessiones activas crear automatizaciones y controlar su cli desde el movil y poder inicialo tambien desde el telefono. Estaba pensando en Expo que opinas junto a rust con OTA EAS Update cosa que la gente compile y descargue una unica vez y yo les pueda mandar las actualizaciones sin necesidad de tenerlas en la tienda que opinas?»
  Decision taken: stack frozen in `docs/mobile-app-stack.md` — Expo (React Native) + TypeScript over a thin Rust core (UniFFI/cargo-ndk), EAS Update for the JS layer, native build only when the Rust core changes.
- **S2**: «Pero que la gente cuando lo instale directamente tambien lo pueda abrir dsede la aplicacion y desarrollar desde su movil tambien»
  Decision taken: onboarding is 100% from the phone — the app installs the host daemon over SSH/SFTP with a signed-checksum verification (moshi pattern); no desktop step.
- **S3**: «deben poder utilizar gentle-shell desde sus dispositivos y que se pueda conectar a sus pc tambien pero si no se quiere conectar y desarrollar desde el movil por cualquier motivo que tambien pueda.»
  Decision taken: dual mode is mandatory on Android + iOS from day one; local mode = editor + embedded agent + gitoxide, explicitly without Termux, toolchains or `exec` of external binaries.
- **S4**: «sube un issue con la propuesta al repositorio y pide que le cambien el nobmre del repo a gentle-movil y arranca con la spec del protocolo»
  Decision taken: issue published as #18 in `IAI-00-IAI/gentle-companion`; protocol v0.1 written in `docs/mobile-protocol-spec.md`. The rename itself is a follow-up task (T11), pending the owner's decision.
- **S5**: «Si continue con las specs guardelas y necesito los diseños utilice mi skill de diseño integrada a gentle-desing busquela en mi perfil hagalo practico facil y con la identidad de Gentleman Programming pero elegante y limpio»
  Decision taken: design work uses the owner's design skill and is synced into the repo design system (`design/system.md`, `design/system.html`): mono type, dark-rose tokens, clean and elegant Gentleman Programming identity.
- **S6**: «utilice subagentes»
  Decision taken: work is executed by dispatched workers (specs, view plan and the two design artboard sets run in parallel), with the parent orchestrating and reviewing.
- **S7**: «Primero tambien planea todas las vistas que necesita y como se va a ver cuando reaccione cada cosa y hazlas todas ese va a ser el producto»
  Decision taken: `docs/mobile-views-plan.md` is the product definition — 20 views (V1–V20) with purpose, elements, every state (empty/loading/error/success/offline) and every reaction; all of them are designed and implemented, nothing is optional.

## Tasks

- T1 (S1) stack frozen → `docs/mobile-app-stack.md` [done]
- T2 (S4) protocol spec v0.1 → `docs/mobile-protocol-spec.md`, issue #18 in IAI-00-IAI/gentle-companion [done]
- T3 (S7) full view plan with reactions → `docs/mobile-views-plan.md` [done by this task]
- T4 (S5,S7) design system + onboarding artboards → `design/system.html`, `design/mobile-app-onboarding/` [in progress, parallel design worker]
- T5 (S5,S7) core product artboards → `design/mobile-app-core/` [in progress, parallel design worker]
- T6 (S1,S2) core Rust mobile: russh pairing + QR scan + device key → Expo app shell + Rust FFI crate (`pairFromQr`, `sshConnect`, `deviceKeyGenerate`) [pending]
- T7 (S1,S2) ~~daemon provisioning over SFTP~~ → enmienda pivote: detect extension on PC loopback + SSH tunnel + register device key → Rust FFI (`sshExec`, `sshForwardLocal`) [pending, rewritten by gentle-movil-pivote]
- T8 (S1,S3) connected mode UI: V5–V13 over SSH tunnel → Expo screens + tunnel client (`/device/ws`, `X-GC-Proto-App: 1`) [pending]
- T9 (S3) local mode: editor + embedded agent + gitoxide → Expo screens + nodejs-mobile runtime + `fs_*`/`git_*` FFI [pending]
- T10 (S2) onboarding flow 100% from phone, V1–V4 → Expo screens + Rust pairing flow [pending]
- T11 (S4) rename follow-up: repo gentle-movil + npm migration [done: Reaan06/gentle-movil]

## Log

- L1..L5: ver `gentle-movil-pivote.md` — T7 reescrita por la enmienda pivote (sin daemon, sin SFTP: detect-extensión + túnel SSH).

## Log

- L1 (2026-11-17): «Vamos a definir el stack. La aplicacion debe funcionar localmente para el usuario y debe poder conectarse mediante SSH escaneando un QR como en moshi. debe poder ver sus sessiones activas crear automatizaciones y controlar su cli desde el movil y poder inicialo tambien desde el telefono. Estaba pensando en Expo que opinas junto a rust con OTA EAS Update cosa que la gente compile y descargue una unica vez y yo les pueda mandar las actualizaciones sin necesidad de tenerlas en la tienda que opinas?»
- L2 (2026-11-17): «Pero que la gente cuando lo instale directamente tambien lo pueda abrir dsede la aplicacion y desarrollar desde su movil tambien»
- L3 (2026-11-17): «deben poder utilizar gentle-shell desde sus dispositivos y que se pueda conectar a sus pc tambien pero si no se quiere conectar y desarrollar desde el movil por cualquier motivo que tambien pueda.»
- L4 (2026-11-17): «sube un issue con la propuesta al repositorio y pide que le cambien el nobmre del repo a gentle-movil y arranca con la spec del protocolo»
- L5 (2026-11-17): «Si continue con las specs guardelas y necesito los diseños utilice mi skill de diseño integrada a gentle-desing busquela en mi perfil hagalo practico facil y con la identidad de Gentleman Programming pero elegante y limpio»
- L6 (2026-11-17): «utilice subagentes»
- L7 (2026-11-17): «Primero tambien planea todas las vistas que necesita y como se va a ver cuando reaccione cada cosa y hazlas todas ese va a ser el producto»
- L8 (2026-11-17): design system synced (`design/system.md`, `design/system.html`); view plan written (`docs/mobile-views-plan.md`, V1–V20 with states and reactions, declared the product); designs split into two parallel workers (onboarding `design/mobile-app-onboarding/`, core `design/mobile-app-core/`), mapping recorded in the view plan's "Artboard mapping" section; issue #18 https://github.com/IAI-00-IAI/gentle-companion/issues/18. Open owner decisions tracked in `docs/mobile-views-plan.md` §8: UI copy language, local-agent `exec` promise, V13 offline diffs, tokens data source.
- L9 (2026-11-17): Diseño vinculado — design/mobile-app-onboarding/ (4 artboards V1-V4) y design/system.html creados por worker de diseño; design.json con feature: odd/tasks/mobile-app.md. Pendiente: artboards del producto (worker en curso).
- L10 (2026-11-17): Reconciliación — artboards 09-git-changes, 10-settings y 11-global-states escritos inline por el orquestador (patrones de los 8 previos); manifiesto design/mobile-app-core/design.json con 11 artboards + feature; §7 del plan actualizado con nombres autoritativos y contrato de navegación (4 tabs con Local, Ajustes en el header). Verificación: tags balanceados, sin refs externas, solo tokens, renders 430x932 inspeccionados.
- L11 (2026-11-17): Handoff de diseño — implementado design/mobile-app-onboarding/01-qr-scan.html en el stack real como ruta ui/src/routes/pair/qr/+page.svelte (T12): escáner móvil con pipeline de cámara existente (device-permissions + jsQR), panel de permiso denegado con CTA y reintento, camino alternativo a /pair, claves i18n pairqr.* en en/es (Q1: i18n desde el día 1, de facto). Checks: svelte-check 0/0, ui:build OK.
  - T12 (S5,S7) V1 QR scan implemented in real stack → ui/src/routes/pair/qr/+page.svelte + i18n pairqr.* [done]
- L12 (2026-11-17): Organización de entrega — el dueño pidió «cada vista va en un PR acotado independiente y el back por módulos». Estructura acordada: PRs de vistas sobre mobile/ (PR-A feat/onboarding-v2-manual-ssh = scaffold+V2+contrato core; PR-B feat/onboarding-v1-qr = escáner expo-camera + pairFromQr + panel denegado nativo con Linking.openSettings); PRs de backend por módulo de mobile-core (PR-M1 = qr/fingerprint/device_key puros con tests offline; PR-M2 = ssh.rs russh + facade ffi). Los workers no commitean: el orquestador commitea cada unidad en su rama y abre el PR con gh (autorización explícita del dueño). V1-QR en Expo se despacha en cuanto termine el worker de scaffold (superficie mobile/ ocupada).
- L13 (2026-11-17): PR-A commiteado en feat/onboarding-v2-manual-ssh (1711fb4, slice 1822 líneas authored sin lockfile — excede 400: es el scaffold completo, slice único justificado por creación de app nueva; registrado como boundary). Worker V2 pass: tsc 0, 9/9 tests, expo export OK, doctor 20/20. V1-QR (PR-B) despachado sobre la misma rama, superficie acotada a scan-qr + componentes nuevos + qr-parse con tests RED→GREEN.
- L14 (2026-11-17): Core Rust entregado (worker pass, task mwlg0p4y). El crate completo va en UN PR feat/mobile-core (un crate = un PR; la organización por módulos vive en los módulos internos qr/fingerprint/device_key/ssh/ffi con 77 tests). Decisiones de spec ratificadas por evidencia de implementación (ver L15 en docs/mobile-protocol-spec.md): sessionClose/channelClose añadidos a §6, accesores session_fingerprint ratificados. ODD bookkeeping reconciliado: T6 marcado done (el worker buscaba "T13" que no existía). Commit del PR diferido hasta que el worker V1-QR libere el worktree (un checkout ahora destruiría mobile/ en el árbol).
- L15 (2026-11-18): PRs abiertos — #19 feat/mobile-core (crate Rust, base main) y #20 feat/onboarding-v2-manual-ssh (scaffold Expo + V2 + V1, base main; commits 1711fb4 y 338be8d). RDD assess: riesgo medio, review no debida, self-verification del writer aplica. Push desbloqueado tras assess. Botón «Escanear el QR en su lugar» de V2 ahora navega a /scan-qr (fix post-worker); .npmrc legacy-peer-deps por conflicto de peers pre-existente. Cascabel desactivado por el dueño (~/.pi/cascabel → cascabel.disabled).
- L16 (2026-11-18): CLI base `gentle-movil` (cli/gentle-movil.mjs + commands pair/status/doctor, docs/cli.md con roadmap; bin en package.json). Fix raíz del fallo de emparejamiento: el QR nunca lleva credenciales (spec §1) — scan-qr «Continuar» ahora prellena V2 (host/puerto/usuario del QR + token/fp) y V2 manda la credencial real a V3; gc_ssh_connect deja de recibir `credential: null`. Verificación: tsc 0, 55/55 tests, pair QR en terminal OK, doctor 4/4 checks OK.
- L17 (2026-11-18): Modelo moshi implementado (elección A del dueño). QR con pw → V3 SSH completo sin tipear. Pipeline provision.ts alineado a cabi.rs (bug real corregido: connectPair exigía sessionId string, el core manda número). Tests 58/58. Fast path daemon-corriendo mantiene el claim HTTP. CLEARTEXT + PI_COMPANION_ALLOWED_ORIGINS=documentados (necesarios para claim HTTP desde app nativa).
