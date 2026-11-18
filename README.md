# Gentle Movil

App móvil (Expo + core Rust con russh) que conecta la tablet del dueño con Gentle Shell/Pi corriendo en su PC. Dos modos:

## Modo conectado — la contraseña va en el QR

Escaneás un QR que genera `gentle-movil pair` en la PC (host, puerto SSH, usuario, contraseña, huella del host). La app se conecta por SSH (russh, sin sudo), detecta la extensión Gentle Shell corriendo en loopback (43721/43722), registra la clave ed25519 del teléfono en tus `authorized_keys` y abre un túnel SSH. Todo lo que la app habla con la extensión viaja por ese túnel. Tras el primer emparejamiento, las conexiones siguientes van solo con la clave ed25519 — sin contraseña.

Sin daemon. Sin SFTP. Sin binarios que instalar en la PC. El puente entre el teléfono y el agente lo hace el propio agente.

## Modo local — 100% en el móvil

Editor de código, agente embebido (nodejs-mobile corriendo el harness pi) y git local (gitoxide, compilado en mobile-core, sin exec). Todo en el sandbox de la app; lo que no se puede mapear a primitivas FFI responde honestamente "requiere modo conectado".

## Repo

- `mobile/` — app Expo (TypeScript)
- `mobile-core/` — Rust: russh + C ABI + shim JNI (115 tests offline)
- `cli/` — `gentle-movil pair|status|doctor` (Node, sin dependencias del repo)
- `docs/` — CLI, protocolo, plan de vistas, stack
- `odd/` — tracking Organic Driven Development
- `design/` — design system y artboards (no versionado)

## CLI

```bash
gentle-movil pair     # genera el QR de emparejamiento en la terminal
gentle-movil status   # estado del puente en la PC
gentle-movil doctor   # sshd, host key, IP LAN, extensión en loopback
```

## Tests

```bash
cd mobile && npm test          # 58 tests offline
cd mobile-core && cargo test   # 115 tests offline
```

Historia previa (PRs #19/#20): [IAI-00-IAI/gentle-companion](https://github.com/IAI-00-IAI/gentle-companion).
