# Spec del protocolo móvil — Gentle Movil v1

Estado: borrador v0.1 (2026-11-17). Extiende el mecanismo de invitaciones de un
solo uso del daemon existente (`/api/pairing/start`, invites quemables con
throttle) al canal SSH. Base de las tareas de implementación. Cambios = entrada
en el Log.

## 0. Principios

1. **El QR nunca lleva claves privadas.** Solo ubicación + token de canje.
2. **El teléfono genera su identidad.** Par ed25519 creado en el dispositivo en
   el primer emparejamiento; el host registra la clave pública.
3. **Un solo canal:** todo pasa por SSH. Sin puertos extra abiertos en el host.
4. **Todo mensaje firmado o autenticado por claves**; el token de canje es la
   única excepción (un solo uso, corta vida, dentro del canal SSH ya autenticado).
5. **Versionado explícito** en cada capa; negociación al conectar.

## 1. Esquema del QR

```
gc://pair?v=1
  &host=<ip|hostname>            # LAN IP o hostname del host
  &port=<ssh-port>               # default 22 si se omite
  &user=<usuario-ssh>
  &token=<invite-token>          # canje de una sola vez, TTL 5 min (como hoy)
  &fp=<hex ed25519 fingerprint>  # huella de la clave pública del host
  &proto=<daemon-protocol-minor> # versión del protocolo del daemon
```

Generación: el daemon existente produce el invite (ya lo hace para la PWA);
un nuevo comando `gentle-movil qr` lo imprime como QR que muestra ese string.
La app móvil escanea, muestra resumen al usuario (host, usuario, huella) y
conecta. **Comparación de huella visible** en el primer uso (mitigación MITM,
con la contraseña en el QR: el usuario confirma que coincide con lo que su PC muestra).

Camino alternativo sin QR: la app acepta IP + usuario + credencial SSH
(contraseña o clave existente del usuario). Todo lo demás idéntico; el token
de canje se omite (el daemon se instala sin daemon previo).

## 2. Handshake de claves (primer emparejamiento)

1. La app tiene un par ed25519 persistente (`deviceKeyEnsure()`): el core Rust
   mintea la semilla UNA vez, Kotlin la sella con una clave AES-256/GCM no
   exportable del AndroidKeyStore y guarda solo el criptograma (iv‖ciphertext)
   en `filesDir`; JS nunca ve la semilla — recibe únicamente `publicHex` y la
   huella `SHA256:…`. La clave autorizada en `authorized_keys` es esta misma
   identidad, no una minteada por emparejamiento.
2. Conexión SSH con la credencial del usuario (contraseña, o clave ya
   autorizada si el QR proviene de un host ya configurado).
3. Sobre el canal autenticado, la app envía `REGISTER_DEVICE`:
   `{ deviceName, ed25519PublicKey, inviteToken? }`.
4. El daemon verifica el token (si viene) y persiste la clave pública del
   dispositivo (mismo registro de dispositivos que hoy usa la PWA).
5. El daemon responde `{ deviceId, daemonVersion, protocolVersion }`.
   Conexiones futuras usan la clave ed25519 del teléfono como credencial SSH —
   sin contraseña, sin token.

## 3. Aprovisionamiento del daemon (host sin Companion)

Cuando el SSH conecta y no hay daemon en el host:

1. Detección: `uname -m` + presencia de `~/.gentle-movil/daemon` (o el path de
   instalación elegido). Mapeo arch → binario (`aarch64`, `x86_64`, musl/glibc).
2. Descarga del binario firmado por la app (bundled o CDN propia) **o** uso del
   mismo mecanismo de release del proyecto. Verificación: checksum ed25519
   firmado por la clave de release embebida en la app. Fallo de firma = aborto.
3. Subida por SFTP a `~/.gentle-movil/daemon`, `chmod +x`.
4. Arranque: proceso user-level. Registro del dispositivo (paso 2 de §2) contra
   el daemon recién arrancado. Reintento en boot del host queda v2 (nota del
   Log L1: systemd --user como sugerencia, no requisito v1).

## 4. Canal app ↔ daemon por SSH

La app abre un **túnel TCP directo** (SSH direct-tcpip) al listener del daemon:
`43722` (superficie de dispositivos, la misma que hoy sirve a la PWA). Sin
reenvío de puertos locales visible; el core Rust expone al runtime TS un
socket abstracto sobre ese canal.

**Protocolo de aplicación:** el mismo WebSocket-over-HTTP que la PWA ya habla
con el daemon (upgrade sobre el canal túnel). Consecuencia: la UI móvil reutiliza
el cliente de la PWA y el daemon no cambia para la v1.

Negociación de versión en el upgrade:
`GET /device/ws` con headers `X-GC-Proto-App: 1` y `X-GC-Proto-Daemon: <v>`.
Si el daemon es más nuevo: la app funciona con la versión mínima común
(daemon compatible hacia atrás). Si la app es más nueva: el daemon responde
`426` y la UI sugiere actualizar el daemon (§5).

### 4.1 Superficie de datos del puente (`proto 1`)

La sirve la extensión Pi de §9 sobre el túnel de §4. Las formas de abajo son
las que **ya parsean** los módulos móviles, campo por campo
(`mobile/lib/git.ts`, `mobile/lib/automations.ts`, `mobile/lib/terminal.ts`):
un campo de más se ignora, uno mal tipado convierte la pantalla en error. La
implementación vive en `pi-extension/src/{git,automations,exec,fs}.ts`.

Reglas comunes a todos los endpoints:

- Toda respuesta JSON —de `43721` y de `43722`— lleva el header de identidad
  `x-gentle-bridge: gentle-movil/1` (§9.2). Un proceso ajeno en el puerto puede
  fabricar un cuerpo parecido, no ese header: el impostor sigue siendo
  detectable.
- Todo error es `{"error":{"code":"<code>","message":"<frase>"}}` con el
  status indicado. Nunca hay 2xx vacío ni lista vacía que signifique «falló».
- **Workspace**: raíz = cwd de la extensión. `?workspace=<dir>` (opcional en
  `git/status`, `exec`, `fs/read` y `fs/tree`) elige un directorio existente
  **dentro** de la raíz; cualquier ruta que escape (`..`, absoluta de afuera,
  symlink hacia afuera) → `400 path_outside_workspace`. Si no existe →
  `400 workspace_not_found`; si es un archivo → `400 workspace_not_a_directory`.
- Ningún endpoint escribe en disco. El único que ejecuta algo es
  `POST /api/exec`, y solo con el opt-in explícito.

#### `GET /api/git/status`

`git status --porcelain=v1 -z --untracked-files=all` + `git diff --numstat -z` +
`git diff --cached --numstat -z`, spawn con array de argumentos (`execFile`,
nunca un shell). `200`:

```json
{"workspace":"/home/me/proj","branch":"feat/auth-login","ahead":2,"behind":0,
 "files":[{"path":"src/a.ts","status":"modified","additions":3,"deletions":1,"staged":true}]}
```

- `workspace`: la raíz usada (la pedida o la cwd).
- `branch`: rama actual; `null` con HEAD detached (nunca la palabra `HEAD`).
- `ahead` / `behind`: commits contra el upstream; `null` si la rama no tiene
  upstream (no se inventa `0`).
- `files[].status`: `added` (incluye untracked y copias), `modified` (incluye
  `T`/`U`), `deleted`, `renamed`.
- `files[].additions` / `files[].deletions`: enteros ≥ 0 del `numstat` (un
  binario cuenta `0`/`0`); en untracked `additions` es el conteo real de líneas
  del archivo y `deletions` es `0`.
- `files[].staged`: `true` si el cambio está en el índice.
- `files[].path`: relativo a la raíz del repo (lo que imprime `git status`, igual
  desde un subdirectorio). Un archivo tocado en índice y en worktree aparece dos
  veces, una por lado, como lo imprime git.

Errores: `409 not_a_git_repository` (el workspace no está en un work tree),
`501 git_unavailable` (el host no tiene el binario `git`), `400` de workspace
(arriba).

#### `GET /api/automations`

Lee `~/.pi/gentle-movil/automations.json` (o `GENTLE_MOVIL_AUTOMATIONS_FILE`),
un archivo que la extensión posee. `200`:

```json
{"automations":[{"id":"nightly","name":"Limpieza nocturna","schedule":"0 3 * * *",
  "enabled":true,"lastRun":{"at":"2026-11-18T03:00:00.000Z","ok":true,"summary":"ok"},
  "nextRun":"2026-11-19T03:00:00.000Z"}]}
```

`lastRun` es `null` o `{at, ok, summary}` (`summary` string o `null`); `nextRun`
es ISO-8601 o `null`; `steps` (`string[]`) solo aparece si el archivo lo declara.
Archivo ausente → `200 {"automations":[]}` (no hay nada configurado).

Errores: `500 automations_unreadable` con el motivo real en `message` — el
error de `JSON.parse` incluido, o el campo exacto que no valida
(`automations[2].enabled is not a boolean`). Un archivo roto **no** se degrada a
lista vacía.

#### `GET /api/automations/<id>`

`200` con **el objeto solo**, sin wrapper (es lo que parsea el editor):

```json
{"id":"nightly","name":"Limpieza nocturna","schedule":"0 3 * * *","enabled":true,
 "lastRun":null,"nextRun":null,"steps":["bun run lint"]}
```

Errores: `404 automation_not_found` (mensaje con el id pedido),
`500 automations_unreadable` como arriba.

#### `GET /api/exec/history`

Ring en memoria del proceso, tope 50, más nuevo al final. `200`:

```json
{"commands":[{"id":"cmd-m9x1-1","command":"bun test","at":"2026-11-18T14:32:00.000Z",
  "status":"sent","exitCode":1,"output":"..."}]}
```

`status`: `pending` (encolado, hoy no se usa), `sent` (el proceso corrió, con
cualquier exit code), `failed` (no arrancó, timeout o señal). `exitCode` es
entero o `null`; `output` es el stream crudo combinado (stdout+stderr en orden de
llegada, escapes incluidos) o `null` si no produjo nada. El ring no se persiste:
un reinicio del puente empieza vacío, que es la verdad de lo que este proceso
corrió.

#### `POST /api/exec`

Body `{"command":"<línea de comando>"}`. **Solo corre** si el puente arrancó con
`GENTLE_MOVIL_ALLOW_EXEC=1` (o `createBridge({allowExec:true})`).

`200`:

```json
{"id":"cmd-m9x1-1","exitCode":0,"output":"hola"}
```

Un exit code distinto de 0 **no** es un error HTTP: es un resultado (200, con el
código real). Sin shell nunca: la línea se parte en argv (comillas y `\` como un
shell, sin expansión) y se ejecuta con `spawn(file, args)`.

Errores: `403 exec_disabled` (falta el opt-in; el comando **no** se ejecuta ni
entra al historial), `400 shell_unsupported` (la línea necesita shell: `|`, `&&`,
`;`, `>`, `$`, backticks, globs, `#`, salto de línea, comilla sin cerrar),
`400 invalid_command` (vacío o > 4096 bytes), `400 invalid_body`, `400 invalid_json`,
`413 payload_too_large`, `400` de workspace, y `502 command_spawn_failed` cuando el
proceso no llegó a arrancar (binario inexistente, permisos): ese comando queda
`failed` en el historial, nunca un 200 con exit code `null`.

Límites: timeout 30 s (se mata con SIGKILL y se registra `failed` con la marca
en `output`), salida combinada ≤ 64 KiB por comando (se corta con
`… [cortado: N bytes ocultos]`, nunca en silencio).

#### `GET /api/fs/read?path=<rel>`

Lee un archivo de texto dentro del workspace. `200`:

```json
{"path":"src/a.ts","size":1234,"encoding":"utf8","content":"export {};\n"}
```

`path` es relativo al workspace con `/`, `size` son los bytes leídos.

Errores: `400 path_outside_workspace`, `404 not_found`, `400 not_a_file`
(es un directorio), `413 file_too_large` (> 512 KiB), `415 binary_file`
(byte NUL o UTF-8 inválido).

#### `GET /api/fs/tree?path=<rel>`

Un nivel de listado. `200`:

```json
{"path":"","truncated":false,"entries":[
  {"name":"src","path":"src","type":"dir","size":null},
  {"name":"README.md","path":"README.md","type":"file","size":812}]}
```

`type`: `dir` | `file` | `symlink` | `other`; `size` solo para archivos regulares
(`null` en el resto, nunca estimado). Orden: directorios primero, después por
nombre. `path` vacío = la raíz del workspace. Errores: los mismos que
`fs/read` más `400 not_a_directory`; el listado se corta a 500 entradas con
`truncated: true`.

## 5. Auto-actualización del daemon

En cada conexión: `GET /api/version` por el túnel → si difiere de la versión
que la app conoce como última estable (descriptor firmado), la app:
1. descarga el binario nuevo (firma verificada, §3.2),
2. sube por SFTP (`daemon.new`), renombra atómicamente,
3. reinicia el proceso (`daemon restart` interno),
4. reconecta el túnel.
Ventana de fallo: si el reinicio no responde en 10 s, la app revierte al
binario previo (guardado como `daemon.prev`) y reporta al usuario.

## 6. Superficie del core Rust (FFI — ABI 2, 2026-11-18)

```
pairFromQr(uri: string) -> PairInfo
sshConnect(host, port, user, cred) -> SessionId
sshDirectTcp(sessionId, targetHost, targetPort) -> ChannelId
channelRead(channelId) -> bytes        # async, streaming
channelWrite(channelId, bytes)
sftpPut(sessionId, localPath, remotePath)
execOnce(sessionId, cmd) -> {exitCode, stdout, stderr}
deviceKeyGenerate() -> PublicKey        # legado: mintea SIEMPRE una clave nueva (no usar para emparejar)
deviceKeyPublic() -> PublicKey          # derivada de la semilla persistida
sshConnectSeed(host, port, user, seed, expectedFp) -> SessionId  # solo-llave, pin OBLIGATORIO
sshClose(sessionId)                     # saca la sesión y sus canales del registro
fsList(root, path, maxEntries) -> {entries:[{path,size,kind}]}
fsRead(root, path, maxBytes) -> {path,text,size,truncated}
cryptoVerify(releasePubkey, payload, signature) -> bool
sqliteOpen/openStore(...)               # store local-first
```

Contrato de §6 que no es obvio:

- **Pin de host key**: `sshConnectSeed` exige `expectedFp` (la huella del QR). El
  pin se aplica dentro del handshake y se vuelve a verificar después, para todo
  transporte; la ruta de llave sin pin se rechaza en vez de aceptar TOFU. La
  conexión con contraseña conserva TOFU y reporta la huella observada.
- **Errores tipados** de `fs_*`: `not_found | permission_denied | too_large |
  binary | invalid_path | outside_root`. `path` es relativo a `root`; se rechazan
  rutas absolutas, segmentos vacíos y `..`; se canonicaliza y se verifica
  `starts_with(root)` para que un symlink no escape del proyecto.
- **Topes de lectura**: 512 KiB por defecto, 8 MiB duro (espeja el tope del
  puente). Nunca se decodifica un binario con pérdida: se responde `binary`.
- **Alcance de archivos**: `fs_*` lee lo que el proceso de la app puede leer. El
  sandbox de la app (documentos/proyectos) siempre; el almacenamiento compartido
  requiere el permiso del sistema o el picker SAF, que **no** está implementado
  todavía — la UI lo dice con el path real en vez de mostrar una lista vacía.
- **`fsList` lista archivos y directorios**; sockets, dispositivos y symlinks
  colgantes se omiten a propósito (el contrato no inventa un `kind`).

Todo lo demás (UI, parsing del protocolo del daemon, automatizaciones,
lógica de modos) vive en TS — regla de oro OTA.

## 7. Modo local: interfaz del agente embebido

El agente (harness pi sobre nodejs-mobile) recibe del core Rust:
- `fs_*`: E/S de archivos restringida al sandbox del proyecto abierto.
- `git_*`: operaciones gitoxide (status, diff, add, commit, push/pull remoto).
- Sin `exec` de procesos arbitrarios: los comandos que el harness ejecutaría
  como shell se mapean a primitivas FFI; lo no mapeable devuelve un error
  de capacidad ("requiere modo conectado").

## 8. Consideraciones de seguridad

- Token de canje: un solo uso, TTL 5 min, quemado en el primer REGISTER_DEVICE
  (reutiliza el throttle y burn de invites existentes del daemon).
- Huella del host visible y confirmable en el primer uso; warning persistente
  si cambia en conexiones siguientes (TOFU + alerta).
- El binario del daemon nunca se acepta sin firma de release.
- Rate-limit de intentos de REGISTER_DEVICE por IP (ya existe para códigos).
- El túnel SSH no expone el daemon a la red: el listener 43722 sigue siendo el
  del daemon; el SSH es la única puerta.

## 9. Puente en loopback: extensión Pi (`proto: 1`)

Reemplaza al daemon de §3-§5. Ya no hay binario, ni instalación, ni `sudo`: el
**propio agente** (Pi / Gentle Shell) sirve los dos puertos en TS puro
(`pi-extension/`). El teléfono los alcanza exclusivamente por el túnel SSH de §4.

### 9.1 Superficie

| Puerto | Bind | Superficie |
|---|---|---|
| 43721 | `127.0.0.1` | API HTTP: identidad, sesiones y datos (git, automatizaciones, exec, fs) para el CLI, `doctor` y el teléfono |
| 43722 | `127.0.0.1` | Canal de dispositivos: WebSocket en `/ws/device` |

Los endpoints de datos de `43721` están documentados en §4.1. Toda respuesta
JSON de los dos puertos lleva el header `x-gentle-bridge: gentle-movil/1`
(`<bridge>/<proto>` de §9.2): junto con el payload de identidad, es la prueba de
que quien escucha es esta extensión.

Nunca se bindea `0.0.0.0` ni ninguna otra interfaz; el host no es configurable.
Los puertos sí, por entorno: `GENTLE_MOVIL_API_PORT` y
`GENTLE_MOVIL_DEVICE_PORT` (valores inválidos caen al default documentado).

- Extensión (dentro del agente): `pi -e ./pi-extension/src/extension.ts`, o el path
exacto en `extensions` de `settings.json`.
- Proceso suelto (sin agente, para `curl`, `doctor` y tests):
`node pi-extension/server.mjs`. En este modo no hay agente al que inyectar
entrada: `input` se devuelve como eco (`deliver: "echo"`).

### 9.2 Identidad — `GET /api/health`

```json
{"app":"gentle-shell","bridge":"gentle-movil","proto":1,"version":"<semver>"}
```

`content-type: application/json`. Es la prueba de qué está escuchando: otro
servidor en el mismo puerto no puede producir este payload. **Ambos puertos
responden la misma identidad** (`43721` y `43722`): el CLI verifica los dos, de
modo que un proceso ajeno ocupando el puerto de dispositivos se reporta como
impostor en vez de pasar por el puente. La identidad no es un secreto: la
autenticación real es el túnel SSH que el teléfono ya estableció. Cualquier otra
ruta HTTP plana en 43722 responde `404 {"error":"not_found"}`.

### 9.3 Sesiones — `GET /api/sessions`

Array JSON (posiblemente vacío). Cada elemento:

```json
{"id":"<uuid>","title":"<nombre o primero del usuario>","status":"idle|busy|unknown","cwd":"<path>","updatedAt":"<ISO>","current":true}
```

Honesto por contrato: si la plataforma no expone sesiones (sin directorio de
sesiones, host sin agente), la lista es `[]` — nunca se inventan sesiones ni se
rompe el endpoint. `status` es `unknown` para toda sesión cuyo estado la
plataforma no publica; solo la sesión viva del agente reporta `idle`/`busy`.

### 9.4 Canal de dispositivos — `ws://127.0.0.1:43722/ws/device`

WebSocket de texto (RFC 6455, sin dependencias), `proto: 1`. Subprotocolo
opcional: si el cliente ofrece `gentle-movil.v1` se acepta. Cada frame es un
objeto JSON con discriminante `type`; un `id` opcional en el pedido se repite en
la respuesta o el error correspondiente.

**Cliente → puente**

| `type` | Campos | Respuesta |
|---|---|---|
| `hello` | `proto`, `client?` | `hello`; `proto` distinto → `error unsupported_proto` |
| `sessions.list` | `id?` | `sessions.list` con `sessions` |
| `session.attach` | `id?`, `sessionId` | `session.attached` con `session`; desconocida → `unknown_session` |
| `session.detach` | `id?` | `session.detached`; sin sesión adjunta → `not_attached` |
| `input` | `id?`, `text` | `input.accepted`, después uno o más `output` |
| `ping` | `id?` | `pong` |

**Puente → cliente**

| `type` | Campos |
|---|---|
| `hello` | `proto`, `bridge`, `version` |
| `sessions.list` | `id?`, `sessions[]` (forma de §9.3) |
| `session.attached` | `id?`, `sessionId`, `session` |
| `session.detached` | `id?`, `sessionId` |
| `input.accepted` | `id?`, `sessionId`, `deliver`: `agent` (llegó al agente) o `echo` (no hay agente) |
| `output` | `sessionId`, `text`, `source`: `agent` o `echo`, `seq` (entero creciente por conexión, empieza en 1) |
| `pong` | `id?` |
| `error` | `code`, `message`, `id?`, `sessionId?` |

**Códigos de error:** `bad_frame` (JSON inválido o campo faltante),
`unsupported_proto`, `unsupported_type`, `not_attached`, `unknown_session`,
`input_too_large`, `input_failed` (el agente rechazó la entrada),
`internal_error`. Un error nunca cierra la conexión: el cliente puede corregir y
seguir.

**Límites y cierre:** solo frames de texto (binario → close `1003`), payload
máximo 1 MiB (`1009`), `input.text` máximo 64 KiB (`input_too_large`). Un frame
que declara más bytes de los permitidos se rechaza al leer el header, sin
almacenar el cuerpo. Si el cliente desaparece a mitad de frame, el puente tira
el socket, registra `ws.client_disconnected_mid_frame` en una línea JSON y sigue
sirviendo ambos puertos: nunca crashea ni deja el puerto tomado.

**Enrutamiento de `output`:** el texto del agente (mensajes del asistente en la
sesión adjunta) se emite como un frame `output` completo por mensaje; el
streaming token a token queda para `proto: 2`. En modo proceso suelto (`echo`),
el mismo texto vuelve con `source: "echo"` para probar el round-trip sin agente.

**Sin autenticación propia:** igual que §8, el puente solo escucha en loopback y
el túnel SSH autenticado es la puerta. Si un tercero puede alcanzar 43721/43722
en el host, ya tiene la sesión del usuario.

## Log

- L1 (2026-11-17): «sube un issue con la propuesta al repositorio y pide que le
  cambien el nombre al repo a gentle-movil y arranca con la spec del protocolo».
  Issue #18 en IAI-00-IAI/gentle-companion. Spec v0.1 creada.
- Nota v2 (fuera de alcance v1): re-registro del daemon en boot del host;
  runner de compilación remoto para el modo local.
- L1 (2026-11-18): Implementación de §6 (crate mobile-core) reveló dos huecos de la superficie congelada: (1) sin teardown, sesiones/canales viven hasta el drop — se añaden `sessionClose(sessionId)` y `channelClose(channelId)` a la superficie FFI; (2) §8 exige huella confirmable pero §6 no la exponía — se ratifican `sessionFingerprint(sessionId)` / `sessionFingerprintCompact(sessionId)` como accesores aditivos. Ambos ya implementados en mobile-core/src/ffi.rs; uniFFI los expondrá en T14.
- L2 (2026-11-18): QR-only pairing — el dueño pidió «únicamente escaneando el QR ya lo empareje». Enmienda a §1: el QR generado por `gentle-movil pair` incluye `code=<pairing code>` y `dport=<43722>`. Con invite+code juntos (ambos de un solo uso, TTL 5 min) la app reclama el emparejamiento por HTTP contra la superficie de dispositivos del daemon (`POST /api/pairing/claim`), sin SSH ni credencial. Trade-off aceptado explícitamente: durante la validez del QR, quien lo vea puede emparejar — igual que con la contraseña en el QR. El camino SSH+credencial (V2 prellenada) queda como fallback para hosts sin daemon corriendo. Implementado en cli/commands/pair.mjs, mobile/lib/qr-parse.ts (code/dport), mobile/app/pairing-progress.tsx (fast path runClaim), mobile/app/scan-qr.tsx (Continuar → V3 directo).
- L3 (2026-11-18): Contraseña en el QR adoptada por el dueño (opción A). Enmienda a §1: el QR de `gentle-movil pair` lleva `pw` (contraseña SSH, percent-encoded) además de invite/code — escanear basta para provisionar una PC fresca vía SSH (V3 completo: connect→detect→install→register→tunnel). Trade-off aceptado: quien vea la pantalla durante la validez del QR tiene acceso SSH — mitigaciones: single-use, TTL 5 min, y tras el primer emparejamiento la clave ed25519 del dispositivo reemplaza a la contraseña. El pipeline TS (lib/provision.ts) quedó cableado a los schemas reales del core (payloads por paso según cabi.rs, device key antes de register, probe de LAN para saltar install si el daemon ya corre, túnel como probe LAN). El upload desde el teléfono requiere el binario embebido/descargado (T7) — hoy falla honesto si el host no tiene daemon.

## Log (enmienda pivote 2026-11-18 — repo Reaan06/gentle-movil)

- Fuera daemon y web: server/, ui/, bridge/ eliminados del repo. El puente entre el teléfono y el agente lo hace el propio agente (Gentle Shell/Pi).
- El "puente oficial" es una extensión Pi que sirve HTTP/WS en loopback 43721/43722 en TS puro (la vieja `/remote-control` era cliente WS; el daemon Rust servía los puertos y fue borrado).
- Conectado: QR (host+puerto+usuario+pw+huella) → SSH russh → detectar extensión en loopback → registrar clave ed25519 en authorized_keys → túnel SSH forward. Sin sudo, sin SFTP, sin binarios.
- Ver `odd/tasks/gentle-movil-pivote.md` (S1-S10, T1-T6).
- L4 (T3a, `proto: 1`): §9 documenta el puente real. `pi-extension/` sirve 43721
  (HTTP: `/api/health` con identidad `gentle-shell`/`gentle-movil`, `/api/sessions`)
  y 43722 (`/ws/device`) en `127.0.0.1` únicamente, en TS puro sin dependencias ni
  instalación. Identidad semver `0.1.0`; frames de §9.4 verificados por tests
  offline (`node --test pi-extension/test/`, 18 verdes) incluido el cliente que
  desaparece a mitad de frame. El modo proceso suelto devuelve `deliver: "echo"`:
  sin agente no se finge una sesión viva.
- L5 (T8b, `proto: 1`): §4.1 documenta la superficie de datos que las pantallas
  conectadas ya llamaban: `GET /api/git/status` (status porcelana + numstat
  reales), `GET /api/automations` y `GET /api/automations/<id>` (archivo
  `~/.pi/gentle-movil/automations.json`), `GET /api/exec/history` y
  `POST /api/exec` (ring de 50 en memoria; el comando solo corre con
  `GENTLE_MOVIL_ALLOW_EXEC=1`, sin shell, con timeout y tope de salida) y
  `GET /api/fs/{read,tree}` (lectura y listado dentro del workspace). Las formas
  son las que parsean `mobile/lib/{git,automations,terminal}.ts`; todo error es
  `{"error":{"code","message"}}` con el status real (`409` no-repo, `501` sin
  git, `500` automatizaciones ilegibles con el error de parseo, `403` exec sin
  opt-in, `413`/`415` de fs). Se agrega el header `x-gentle-bridge` a toda
  respuesta JSON. Tests: `node --test pi-extension/test/` 32 verdes.
- L2 (2026-11-18, ABI 2): §6 quedaba en v1 y describía una superficie que no era la real. Se documenta ABI 2: identidad ed25519 persistente sellada por el AndroidKeyStore (§2.1 reescrito), `sshConnectSeed` con pin obligatorio, `sshClose` (el teardown que L1 daba por hecho pero que no existía en el crate), `fsList`/`fsRead` con errores tipados, reglas de path/symlink, topes de lectura y el límite honesto de permisos (sin SAF todavía). Tests del core: 113 lib + 31 ffi_surface + 66 provision = 210 verdes.
