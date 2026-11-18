# Gentle Companion Móvil — Stack y decisiones (v1, congelado 2026-11-17)

Estado: decisión de arquitectura acordada con el dueño del producto. Este documento
es la fuente de verdad del stack; los cambios requieren una entrada en el Log.

## Stack elegido

| Capa | Elección | Razón |
|---|---|---|
| App móvil | **Expo (React Native)** + TypeScript | mismo ecosistema del proyecto; EAS Build/Update integrados |
| Core nativo | **Rust** vía FFI (UniFFI / cargo-ndk) | russh, gitoxide, criptografía; superficie FFI mínima |
| Actualizaciones | **EAS Update (OTA)** para la capa TS | sin tienda para cambios de UI/lógica de cliente |
| Runtime local | **nodejs-mobile** (o QuickJS como plan B) | agente embebido para el modo local, sin `exec` |
| Git local | **gitoxide** compilado en el core Rust | sin binarios externos, funciona en iOS |
| Datos | SQLite local-first + cola de sync | funciona offline, sincroniza al conectar |

## Regla de oro de la OTA

EAS Update solo actualiza el bundle JS. El core Rust (SSH/FFI) cambia = nueva build en
tienda. Por eso el core queda **delgado y estable** (`connect`, `read`, `write`,
`resize`, `pair`, `git_*`, `fs_*`) y toda la lógica de producto vive en TS.

## Los dos modos (ambos obligatorios desde el día 1, Android + iOS)

### Modo conectado — controlar su PC
1. Emparejamiento: QR con la contraseña del host o datos SSH manuales (IP/usuario/clave).
2. El QR NO lleva claves privadas: host/puerto/usuario + token de un solo uso.
   El teléfono genera su par ed25519 y el host registra su clave pública.
3. La app instala por SSH (SFTP) el binario del daemon si falta, verificando
   checksum firmado, y lo auto-actualiza en cada conexión.
4. Túnel SSH → el daemon companion existente: sesiones activas, automatizaciones,
   control del CLI, iniciar sesiones (`tmux new` por SSH), archivos.

### Modo local — desarrollar desde el móvil sin PC
- Editor de código + agente (harness pi embebido) + git local (gitoxide).
- Todo dentro del sandbox de la app, sin `exec` de binarios externos
  (requisito de iOS y de Play Store).
- Alcance explícito: **no** es Termux. Compiladores/toolchains en el móvil
  quedan fuera del alcance de v1; compilar/ejecutar = modo conectado
  (posible runner remoto en el futuro).
- El repo local puede sincronizarse (push/pull) cuando el modo conectado
  está disponible.

## Límites por plataforma (aceptados)

| Capacidad | Android | iOS |
|---|---|---|
| SSH, git, editor, agente local | ✅ | ✅ |
| Toolchains instalables en el móvil | ❌ (fuera de alcance) | ❌ (prohibido) |
| Procesos en background sostenidos | ⚠️ restricciones de batería | ❌ |

## Contrato del QR (a detalle en la spec de protocolo)

```
gc://pair?v=1&host=<ip|hostname>&port=<ssh>&user=<u>&token=<one-time>&fp=<huella ed25519 del host>
```
- `token`: un solo uso, corta vida; se canjea en la primera conexión.
- `fp`: huella del host para detectar MITM en el primer uso.
- El teléfono propone su clave pública ed25519; el host la registra.

## Distribución

- El usuario compila/descarga **una vez**; actualizaciones de UI/lógica por EAS
  Update; el daemon del host se auto-actualiza por el canal SSH.
- Nueva build nativa solo cuando cambia el core Rust (raro por diseño).

## Log

- L1 (2026-11-17): «Vamos a definir el stack. La aplicacion debe funcionar
  localmente para el usuario y debe poder conectarse mediante SSH escaneando un QR
  como con la contraseña en el QR. debe poder ver sus sessiones activas crear automatizaciones y
  controlar su cli desde el movil y poder inicialo tambien desde el telefono...
  Expo junto a rust con OTA EAS Update». Decisión: Expo + Rust + EAS Update.
- L2 (2026-11-17): «que la gente cuando lo instale directamente tambien lo pueda
  abrir desde la aplicacion y desarrollar desde su movil» → onboarding 100% móvil:
  la app instala el daemon por SSH (contraseña del host en el QR).
- L3 (2026-11-17): «deben poder utilizar gentle-shell desde sus dispositivos y que
  se pueda conectar a sus pc tambien pero si no se quiere conectar y desarrollar
  desde el movil por cualquier motivo que tambien pueda» → dual-mode obligatorio,
  Android+iOS desde el día 1; modo local = editor+agente+git, sin Termux.

## Log (enmienda pivote 2026-11-18 — repo Reaan06/gentle-movil)

- Fuera daemon y web: server/, ui/, bridge/ eliminados del repo. El puente entre el teléfono y el agente lo hace el propio agente (Gentle Shell/Pi).
- El "puente oficial" es una extensión Pi que sirve HTTP/WS en loopback 43721/43722 en TS puro (la vieja `/remote-control` era cliente WS; el daemon Rust servía los puertos y fue borrado).
- Conectado: QR (host+puerto+usuario+pw+huella) → SSH russh → detectar extensión en loopback → registrar clave ed25519 en authorized_keys → túnel SSH forward. Sin sudo, sin SFTP, sin binarios.
- Ver `odd/tasks/gentle-movil-pivote.md` (S1-S10, T1-T6).
