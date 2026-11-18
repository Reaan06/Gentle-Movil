# Gentle Movil — pivote sin daemon: puente SSH + modo local

App móvil Expo (tablet Samsung SM-X110) que habla con Gentle Shell/Pi en la PC.
Repo nuevo: Reaan06/gentle-movil. El repo viejo (IAI-00-IAI/gentle-companion, PRs #19/#20) queda como historia.

## Specs

- S1: "REPO PROPIO nuevo llamado `gentle-movil` — no el repo viejo. Crealo en GitHub (cuenta Reaan06, `gh repo create Reaan06/gentle-movil --private`), migrá lo que sigue y push inicial. El repo viejo queda como historia (PRs #19/#20), no se borra."
- S2: "Fuera el daemon y la web — el dueño lo rechaza ('no funciona, se siente pailas, necesita sudo'): borrar server/ (daemon Rust), ui/ (PWA SvelteKit), bridge/, y los scripts daemon:*/pair HTTP/client:publish. El puente entre el teléfono y el agente lo hace el **propio agente**."
- S3: "Solo queda lo mobile en el repo nuevo: mobile/, mobile-core/, cli/, design/, docs/ (cli.md, mobile-views-plan.md, mobile-protocol-spec.md — actualizá su Log con esta enmienda), odd/ (reconciliá T7/T8: 'instalar daemon' pasa a 'detectar la extensión corriendo'), README nuevo."
- S4: "El QR de la PC (`gentle-movil pair`, cli/commands/pair.mjs, ya genera `pw`) lleva host+puerto+usuario+contraseña SSH+huella. Escanear → SSH (russh, ya funciona) → detectar la extensión Pi corriendo en loopback (43721/43722) → registrar dispositivo (clave ed25519 del teléfono al authorized_keys del usuario) → túnel SSH forward a los puertos loopback → la app habla con la extensión por el túnel. Sin sudo, sin SFTP, sin binarios que instalar. Tras el primer emparejamiento, las conexiones siguientes son solo con la clave ed25519."
- S5: "V3 (pantalla de progreso) se reutiliza con pasos: connect → fingerprint → detect extensión → register → tunnel. provision.ts pierde upload/verify/start (SFTP); mobile-core/provision.rs igual (ssh.rs, cabi, jni_shim intactos)."
- S6: "Modo local — 100% en el móvil (NO se elimina, es la otra mitad del producto): editor de código + agente embebido (nodejs-mobile corriendo el harness pi, QuickJS como plan B) + git local con gitoxide (compilado en mobile-core, sin exec). Todo en el sandbox de la app; los comandos no mapeables a primitivas FFI devuelven 'requiere modo conectado' (honesto). V14-V17 del views plan."
- S7: "Tests offline RED→GREEN (los mocks existen: 58 TS + 115 Rust). El logger (mobile/lib/logger.ts) registra cada error con {step, error, raw}. La app nunca crashea si SSH/túnel fallan: estado honesto + log."
- S8: "Commits acotados por unidad en ramas feat/*; PRs al repo nuevo. Device test final en la tablet: gradle `-PreactNativeArchitectures=arm64-v8a` (NDK 28.2 pinned)."
- S9: "`gentle-movil doctor` reescrito: sshd, host key, IP LAN, extensión Pi en loopback."
- S10: "Documentar cada desvío en el Log del feature doc."

## Tasks

- T1 [S1,S2,S3] migración: árbol solo-mobile + README + push inicial a movil/main — (route: inline, commit: migración)
- T2 [S4,S5,S7] purga deps daemon de cli/ y provision; flujo V3 detect-extensión + túnel; tests RED→GREEN — (route: worker, commit: feat/*)
- T3 [S2] puente oficial: extensión Pi que sirve loopback 43721/43722 en TS (reemplaza al daemon Rust) — (route: worker, commit: feat/*)
- T4 [S9] doctor reescrito (sshd, host key, LAN, extensión loopback) — (route: worker, commit: feat/*)
- T5 [S8] device test tablet: QR → SSH → túnel → sesiones reales — (route: inline+device)
- T6 [S6] modo local: gitoxide → editor → agente embebido → V14-V17 — (route: worker por unidad)

## Log

- L1 (pedido original, verbatim): "# Gentle Movil — repo propio, pivote sin daemon, puente SSH + modo local — [ver prompt del dueño 2026-11-18: contexto, decisión 1-3, arquitectura dual-mode, requisitos de calidad, orden de trabajo 1-6]".
- L2 (desvío arquitectónico, S10): la extensión `/remote-control` vieja NO servía 43721/43722: era cliente WS (`src/bridge.ts:297`) y el daemon Rust servía los puertos (`server/src/main.rs:57-60`). El "puente oficial" (T3) se implementa como extensión Pi nueva que sirve HTTP/WS loopback en TS puro, sin daemon. Decisión del dueño intacta: el propio agente hace el puente, sin sudo, sin binarios.
- L3: exploración evidenció 58 tests TS = suite de mobile/ (logger 20, qr-parse 15, provision 14, manual-ssh 9); 115 Rust en mobile-core. cli/ importaba src/daemon.ts (pair.mjs:14, status.mjs:5, doctor.mjs:76) → se reescribe en T2/T4.
- L4: `/tmp` lleno (EDQUOT -122) bloqueaba subagentes; limpiado. Modelos de agentes: prefijo `nan/` confirmado válido por el dueño.
- L5: remoto Reaan06/gentle-movil ya existía: main huérfano (solo LICENSE MIT, b819477) + feat/* con el árbol viejo completo. La migración parte de ese main huérfano para no force-push.
- L6 (revisión nativa del core, linaje review-c7692ace53659683, base c4f4f15, candidato 6730182): lente reliability → 3 findings CRITICAL corroborados por el refutador, todos `introduced`:
  R3-001 `ssh.rs` — un read pendiente mantenía el mutex del canal y bloqueaba write/close (deadlock en el túnel, que lee y escribe concurrente);
  R3-002 `provision.rs` — el loop de readiness awaiteaba `direct_tcp` sin cota y no chequeaba START_TIMEOUT;
  R3-003 `provision.rs` — al vencer el timeout quedaba un `nohup` detachado vivo: rollback restauraba el binario anterior pero el proceso seguía corriendo.
- L7 (corrección 1, commit 8fe122b en worktree del linaje, 153 líneas de diff): split reader/writer del canal russh (R3-001 resuelto y aceptado por el validador); readiness acotado; kill del pid en toda salida fallida. El validador RECHAZÓ la corrección: quedaban dos regresiones (kill sin cota, sleep con `remaining` viejo) y el kill no verificaba que el pid hubiera muerto. Linaje terminó en `escalated` (terminal, informativo).
- L8 (corrección 2, residuales del validador): `bounded_exec` con deadline único (TERMINATE_TIMEOUT 2s) para todo exec del camino de fallo; retorno inmediato al vencer la ventana, `remaining` recalculado antes de dormir; verificación del pid con `kill -0` acotado y mensaje honesto cuando la terminación no se confirma (S7). Tests: 78 lib + 10 ffi + 32 provision = 120 verdes, 0 fallos.
