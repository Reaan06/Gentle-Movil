# Gentle Movil CLI (`gentle-movil`)

CLI host-side para emparejar la app móvil con esta computadora. Base deliberadamente
pequeña y aburrida: un dispatcher, un archivo por comando, sin dependencias de framework.

## Instalación

```bash
npm install          # registra el bin (package.json → bin.gentle-movil)
npx gentle-movil --help
# o sin bin global:
node cli/gentle-movil.mjs <command>
npm run pair:movil   # alias de `gentle-movil pair`
npm run doctor       # alias de `gentle-movil doctor`
```

## Comandos

| Comando | Qué hace | Fuente |
|---|---|---|
| `pair` | Genera una invitación de un solo uso del daemon y muestra el QR `gc://pair?v=1` en la terminal, con host LAN, puerto SSH, usuario y huella ed25519 real del host (SHA-256 sobre `/etc/ssh/*_key.pub`). Escaneable por la app. | `cli/commands/pair.mjs` |
| `status` | Estado del daemon (pid, binario, superficie admin) y si la API de emparejamiento responde. Exit 1 si el daemon no corre. | `cli/commands/status.mjs` |
| `doctor` | Preflight del host: sshd activo, host key legible (fuente del TOFU), IP LAN detectada, daemon alcanzable. Exit 1 si algo falla — es la respuesta a "¿por qué no conecta la tablet?". | `cli/commands/doctor.mjs` |
| `help` | Ayuda. | inline |

## Arquitectura (cómo extenderla)

```
cli/
  gentle-movil.mjs      # dispatcher: parsea argv, carga el comando, imprime help/errores
  commands/
    <nombre>.mjs        # exporta async run(args) → exit code (0 ok, 1 fallo, 2 uso incorrecto)
```

**Agregar un comando = un archivo nuevo + una línea en `COMMANDS`** (en
`cli/gentle-movil.mjs`). Convenciones:

1. Cada comando imprime su propio resultado en stdout; los errores van a stderr
   con mensaje humano (no stack traces) — el dispatcher solo los reenvía.
2. Las checks reutilizables viven como funciones dentro del comando; si dos
   comandos la necesitan, subirla a `cli/lib/` (crearlo cuando el segundo lo
   pida, no antes).
3. JSON para scripts: cada comando que produzca salida consumible debe aceptar
   `--json` (pendiente; see Roadmap).
4. Los comandos reutilizan la lógica existente del repo (`src/pair-cli.ts`,
   `src/daemon.ts`) via import — la duplicación con el daemon es deliberadamente
   cero.

## Roadmap (para mejorar a futuro)

- [ ] `--json` global en todos los comandos (consumo desde scripts y CI).
- [ ] `pair --qr <png>`: además del terminal, escribir el QR a archivo para compartir.
- [ ] `pair --follow`: regenerar automáticamente al expirar mientras la tablet no empareje.
- [ ] `logs [--follow]`: leer el registro del daemon y el de la app (via túnel) desde la PC.
- [ ] `devices`: listar/revocar dispositivos emparejados (hoy solo desde la app).
- [ ] `daemon uninstall`: envolver las instrucciones manuales del README.
- [ ] `local-sign`: firmar el manifest de release del binario del daemon (§3.2) desde la PC para que el checksum que verifica la tablet sea real.
- [ ] Tests: los checks de `doctor` son funciones puras parcialmente mockeables — moverlos a `cli/lib/checks.mjs` cuando se testeen.

## Referencias

- Protocolo de emparejamiento: `docs/mobile-protocol-spec.md` §1–§3.
- Estilo y tokens de la app (no aplica al CLI, solo contexto): `design/system.md`.
- Feature doc: `odd/tasks/mobile-app.md` (T12+).

## Log (enmienda pivote 2026-11-18 — repo Reaan06/gentle-movil)

- Fuera daemon y web: server/, ui/, bridge/ eliminados del repo. El puente entre el teléfono y el agente lo hace el propio agente (Gentle Shell/Pi).
- El "puente oficial" es una extensión Pi que sirve HTTP/WS en loopback 43721/43722 en TS puro (la vieja `/remote-control` era cliente WS; el daemon Rust servía los puertos y fue borrado).
- Conectado: QR (host+puerto+usuario+pw+huella) → SSH russh → detectar extensión en loopback → registrar clave ed25519 en authorized_keys → túnel SSH forward. Sin sudo, sin SFTP, sin binarios.
- Ver `odd/tasks/gentle-movil-pivote.md` (S1-S10, T1-T6).
