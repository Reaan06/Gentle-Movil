# Gentle Movil CLI (`gentle-movil`)

CLI host-side para emparejar la app móvil con esta computadora. Base deliberadamente
pequeña y aburrida: un dispatcher, un archivo por comando, sin dependencias de framework.

**Sin daemon, sin sudo, sin binarios que instalar.** El puente entre la tablet y el
agente lo hace el propio agente: la extensión de Gentle Shell/Pi que sirve loopback
`43721`/`43722`. El CLI solo arma el QR y diagnostica el host.

**Un puerto que responde no es el puente.** `status` y `doctor` le piden identidad a
la extensión (ver [Identidad del puente](#identidad-del-puente)): un daemon viejo
que quedó escuchando y contesta `HTTP 200` con una página cualquiera se reporta
como «no es el puente», nunca como éxito.

## Uso

No hay `package.json` ni paso de instalación: alcanza Node ≥ 22.

```bash
node cli/gentle-movil.mjs --help
node cli/gentle-movil.mjs pair
node cli/gentle-movil.mjs status
node cli/gentle-movil.mjs doctor
```

## Comandos

| Comando | Qué hace | Fuente |
|---|---|---|
| `pair` | Arma **localmente** el payload `gc://pair?v=1` y lo muestra como QR en la terminal (arte half-block, zona de silencio de 2 módulos). Campos: `host` (IP LAN leída de las interfaces), `port` (de `/etc/ssh/sshd_config`, 22 si falta), `user` (el usuario que corre el CLI), `fp` (huella ed25519, SHA-256 sobre `/etc/ssh/*_key.pub`), `token` (**generado en cada invocación**, prefijo `inv_`), `pw` (contraseña SSH en modo moshi, percent-encoded) y `dport=43722`. Modo `--invite-only` (o stdin no-TTY): sin `pw`, el QR lleva `code` (`AB12-CD34`, también local). Exit 0. | `cli/commands/pair.mjs` |
| `status` | Le pide identidad a la extensión Gentle Shell/Pi en loopback: `GET /api/health` en `127.0.0.1:43721` (superficie de control) y `127.0.0.1:43722` (superficie de dispositivos, blanco del túnel). Imprime una línea honesta por puerto en uno de tres estados: `reachable — bridge identity confirmed (app=gentle-shell bridge=gentle-movil proto=1, version …)`, `not the bridge — port answering, but it is not the Gentle Shell bridge — observed HTTP 200, content-type …, etag …, body starts …`, o `unreachable — ECONNREFUSED — nothing listening`. **Exit 0** solo si **todos** los puertos se identifican como el puente; **1** en cualquier otro caso (incluido el impostor); 2 si `GENTLE_MOVIL_PORTS` está mal formado. | `cli/commands/status.mjs` |
| `doctor` | Preflight del host con cuatro checks (S9): 1) `sshd` activo (systemd `sshd` y luego `ssh`), 2) host key ed25519 legible (`/etc/ssh/ssh_host_ed25519_key.pub`, fuente del TOFU), 3) IP LAN detectada (≠ `127.0.0.1`), 4) la extensión **se identifica** en loopback `43721`/`43722` (mismos tres estados que `status`: puente, impostor o nada escuchando). Sin sudo y sin red más allá de loopback. Exit 1 si algún check falla — es la respuesta a "¿por qué no conecta la tablet?". | `cli/commands/doctor.mjs` |
| `help` | Ayuda. | inline |

### Entorno

- `GENTLE_MOVIL_PORTS` — puertos de loopback a sondear, separados por coma
  (`43721,43722` por defecto). Existe para pruebas y para una extensión que
  escuche en otro puerto; valores inválidos fallan ruidosamente (exit 2) en vez
  de sondear defaults en silencio.

## Identidad del puente

El contrato lo fijan las dos puntas (extensión y CLI):

```http
GET http://127.0.0.1:<puerto>/api/health
```

```json
{"app":"gentle-shell","bridge":"gentle-movil","proto":1,"version":"0.4.1"}
```

Un puerto **cuenta como el puente solo cuando ese documento trae
`app:"gentle-shell"`, `bridge:"gentle-movil"` y `proto:1`**. `version` es
informativa (semver, se muestra pero no se valida). El sondeo vive una sola vez
en `cli/lib/loopback.mjs` (`identifiesAsBridge`) y distingue exactamente tres
estados, sin confundirlos:

| Estado | Cuándo | Línea de `status` | Exit |
|---|---|---|---|
| puente | el documento de `/api/health` coincide | `✓ 127.0.0.1:43721 reachable — bridge identity confirmed (app=gentle-shell bridge=gentle-movil proto=1, version 0.4.1), HTTP 200` | 0 (todos) |
| impostor | algo contestó, pero la identidad no coincide | `✗ 127.0.0.1:43722 not the bridge — port answering, but it is not the Gentle Shell bridge — observed HTTP 200, content-type text/html; charset=utf-8, etag camera-v2-preview-v1, body starts "<!doctype html>…"` | 1 |
| no escuchando | `ECONNREFUSED` (o el listener no responde) | `✗ 127.0.0.1:43722 unreachable — ECONNREFUSED — nothing listening` | 1 |

El caso impostor no es hipotético: en esta máquina un daemon Rust viejo quedaba
escuchando en `43722` y servía una página de preview de cámara (etag
`camera-v2-preview-v1`) con `HTTP 200`. El sondeo anterior — «¿contestó algo?» —
reportaba «extension reachable — HTTP 200» y mandaba a la tablet a tunelizar
contra otra cosa. Por eso la identidad es obligatoria y el estado impostor **nombra
lo observado** (status HTTP, `content-type`, `etag` y/o prefijo del cuerpo, o los
campos `app`/`bridge`/`proto` si el cuerpo era JSON), en vez de afirmar éxito o
quedarse en un genérico «no responde». Un listener TCP que no habla HTTP cuenta
como impostor (`port answering, but it is not the Gentle Shell bridge — TCP
listener, no HTTP answer`).

## Arquitectura (cómo extenderla)

```
cli/
  gentle-movil.mjs      # dispatcher: parsea argv, carga el comando, imprime help/errores
  commands/
    <nombre>.mjs        # exporta async run(args) → exit code (0 ok, 1 fallo, 2 configuración)
  lib/
    pairing.mjs         # datos locales del QR: token/code, huella, IP LAN, puerto SSH, URI
    qr.mjs              # encoder QR propio (byte mode, ECC L, v1-v10) + render de terminal
    loopback.mjs        # sondeo 127.0.0.1: identidad del puente (GET /api/health) + fallback TCP
  test/
    cli.test.mjs        # `node --test cli/test/`
```

**Agregar un comando = un archivo nuevo + una línea en `COMMANDS`** (en
`cli/gentle-movil.mjs`). Convenciones:

1. Cada comando imprime su propio resultado en stdout; los errores van a stderr
   con mensaje humano (no stack traces) — el dispatcher solo los reenvía.
2. Las checks reutilizables viven en `cli/lib/` cuando las piden dos comandos
   (hoy: identidad del puente en `status` y `doctor`).
3. JSON para scripts: `--json` queda pendiente (ver Roadmap).
4. **Prohibido importar `src/`, `tools/` o `server/`:** esos módulos murieron
   con el pivote. Si un comando necesita un dato del host, lo lee localmente
   (`cli/lib/pairing.mjs`) — el CLI corre offline solo con Node.

## Tests

```bash
node --test cli/test/
```

Cubren, sin red más allá de loopback: la forma del payload del QR (host, port,
user, pw, fp, dport, token/code), token/code frescos por invocación, huella
SHA-256 sobre el blob del host key, la matriz/render del encoder QR, y los tres
estados del sondeo contra stubs `node:http` que el propio test levanta en un
puerto efímero de `127.0.0.1` y cierra al terminar: identidad válida → `status` 0
y check ✓ de `doctor`; stub que contesta `200` con un cuerpo ajeno (etag
`camera-v2-preview-v1`) → «not the bridge» y exit 1; documento con identidad
incompleta (`proto:2`, `bridge:"other-bridge"`) → impostor; nada escuchando →
«nothing listening», exit 1. También se fija que `GENTLE_MOVIL_PORTS` mal formado
sigue saliendo con 2 y mensaje en stderr.

## Roadmap (para mejorar a futuro)

- [ ] `--json` global en todos los comandos (consumo desde scripts y CI).
- [ ] `pair --qr <png>`: además del terminal, escribir el QR a archivo para compartir.
- [ ] `pair --follow`: regenerar automáticamente al expirar mientras la tablet no empareje.
- [ ] `logs [--follow]`: leer el registro de la extensión Gentle Shell desde la PC.
- [ ] `devices`: listar/revocar dispositivos emparejados (hoy solo desde la app).

## Referencias

- Protocolo de emparejamiento: `docs/mobile-protocol-spec.md` §1–§3.
- Estilo y tokens de la app (no aplica al CLI, solo contexto): `design/system.md`.
- Feature doc del pivote: `odd/tasks/gentle-movil-pivote.md` (S9, T4).

## Log (enmienda pivote 2026-11-18 — repo Reaan06/gentle-movil)

- Fuera daemon y web: server/, ui/, bridge/ eliminados del repo. El puente entre
  el teléfono y el agente lo hace el propio agente (Gentle Shell/Pi).
- El "puente oficial" es una extensión Pi que sirve HTTP/WS en loopback
  43721/43722 en TS puro (la vieja `/remote-control` era cliente WS; el daemon
  Rust servía los puertos y fue borrado).
- Conectado: QR (host+puerto+usuario+pw+huella) → SSH russh → detectar extensión
  en loopback → registrar clave ed25519 en authorized_keys → túnel SSH forward.
  Sin sudo, sin SFTP, sin binarios.
- T2a (esta enmienda): `pair`, `status` y `doctor` reescritos sin importar
  `src/`. `pair` arma el QR solo con datos locales (token/code aleatorios por
  invocación; nada se persiste ni se quema: la extensión valida el token en el
  primer emparejamiento). `status`/`doctor` sondean loopback 43721/43722.
  Se eliminó la dependencia `qrcode` de npm porque ya no existe `package.json`:
  `cli/lib/qr.mjs` implementa el encoder QR (byte mode, ECC L) y verificó sus
  matrices versiones 1-10 con `zbarimg`. El CLI corre offline solo con Node.
- Ver `odd/tasks/gentle-movil-pivote.md` (S1-S10, T1-T6).
- T3b (esta enmienda, S2/S9): el sondeo de loopback dejó de aceptar «cualquier
  `HTTP 200`» y ahora exige la identidad del puente
  (`GET /api/health` → `app:"gentle-shell"`, `bridge:"gentle-movil"`, `proto:1`).
  Motivo: en esta máquina `doctor` reportó «extension reachable — HTTP 200»
  mientras el puerto lo servía un daemon Rust viejo con una página de preview de
  cámara (etag `camera-v2-preview-v1`). `status`/`doctor` distinguen puente,
  impostor (nombrando lo observado: status, `content-type`, `etag`, prefijo del
  cuerpo) y nada escuchando; `status` sale 0 solo si **ambos** puertos se
  identifican. Tests nuevos con stubs `node:http` propios en puertos efímeros.
