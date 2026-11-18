# Gentle Movil

App móvil (Expo + core Rust con russh) que conecta la tablet del dueño con Gentle Shell/Pi corriendo en su PC. Dos modos:

## Modo conectado — la contraseña va en el QR

Escaneás un QR que genera `gentle-movil pair` en la PC (host, puerto SSH, usuario, contraseña, huella del host). La app se conecta por SSH (russh, sin sudo), detecta la extensión Gentle Shell corriendo en loopback (43721/43722), registra la clave ed25519 del teléfono en tus `authorized_keys` y abre un túnel SSH. Todo lo que la app habla con la extensión viaja por ese túnel. Tras el primer emparejamiento, las conexiones siguientes van solo con la clave ed25519 — sin contraseña.

Sin daemon. Sin SFTP. Sin binarios que instalar en la PC. El puente entre el teléfono y el agente lo hace el propio agente.

## Modo local — 100% en el móvil

Editor de código, agente embebido (nodejs-mobile corriendo el harness pi) y git local (gitoxide, compilado en mobile-core, sin exec). Todo en el sandbox de la app; lo que no se puede mapear a primitivas FFI responde honestamente "requiere modo conectado".

## Runtime embebido — Node y `gentle-ai` adentro del APK

La app lleva un **Node real** y el **binario real de `gentle-ai`** para que el modo local no dependa de una PC. Los dos viajan en el APK como *librerías* (`lib*.so`) y no como binarios sueltos: desde Android 10 (targetSdk 29) SELinux no deja ejecutar nada que la app haya escrito en su propio directorio de datos, así que el único lugar del que se puede lanzar un proceso es `ApplicationInfo.nativeLibraryDir` — o sea `lib/<abi>/` dentro del APK.

### Traer los binarios

```bash
bash scripts/fetch-runtime.sh     # idempotente: si ya está, solo lista versiones y tamaños
```

El script descarga, verifica el SHA256 de cada paquete y deja todo en
`mobile/modules/gentle-core/android/src/main/jniLibs/arm64-v8a/` (ignorado por git, ~107 MiB):

| Archivo | Origen | Versión fija |
| --- | --- | --- |
| `libnode.so` | Termux `nodejs-lts` (aarch64) | 24.22.3 |
| `libgentle_ai.so` | release `gentle-ai_4.6.0_linux_arm64.tar.gz` | 4.6.0 |
| `libc++_shared.so` | Termux `libc++` | 30 |
| `libcares.so` | Termux `c-ares` | 1.34.9 |
| `libcrypto.so` · `libssl.so` | Termux `openssl` | 3.6.5 |
| `libicuuc.so` · `libicui18n.so` · `libicudata.so` | Termux `libicu` | 79.1 |
| `libsqlite3.so` | Termux `libsqlite` | 3.54.1-1 |
| `libz.so` | Termux `zlib` | 1.4 |

Los pines son exactos (versión + SHA256 de los `Packages` de Termux, y el de
`checksums.txt` del release de `gentle-ai`). El `stable` de Termux rota: si el
archivo fijo ya no está en el pool, el script falla con `download failed` o
`checksum mismatch` a propósito — se re-pinea a mano, nunca adivina.

### Por qué los nombres no son los de Termux

Termux publica los archivos reales (`libz.so.1.4`, `libicuuc.so.79.1`) y expone
al loader symlinks con el `DT_SONAME` (`libz.so.1`, `libicuuc.so.79`). Un APK no
puede llevar symlinks, y las herramientas de Android descartan cualquier archivo
de `jniLibs` que no termine en `.so` (el `MergeNativeLibsTask` de AGP incluye
solo `**/*.so`). Por eso el script reescribe cada `DT_NEEDED`/`DT_SONAME`
versionado a su nombre corto y le pone ese nombre al archivo:

| SONAME de origen | `DT_NEEDED` reescrito | Archivo |
| --- | --- | --- |
| `libz.so.1` | `libz.so` | `libz.so` |
| `libcrypto.so.3` | `libcrypto.so` | `libcrypto.so` |
| `libssl.so.3` | `libssl.so` | `libssl.so` |
| `libicuuc.so.79` | `libicuuc.so` | `libicuuc.so` |
| `libicui18n.so.79` | `libicui18n.so` | `libicui18n.so` |
| `libicudata.so.79` | `libicudata.so` | `libicudata.so` |
| `libcares.so`, `libsqlite3.so`, `libc++_shared.so` | sin cambio | igual |

La reescritura solo **acorta** el string dentro de `.dynstr` y rellena con NUL el
resto de su lugar, así no se mueve ningún offset del ELF. Después el script
prueba el cierre completo: cada `DT_NEEDED` de cada archivo empaquetado tiene
que ser otro archivo empaquetado o una librería del sistema Android (`libc.so`,
`libm.so`, `libdl.so`, …); si falta una, falla con el nombre exacto.

### Cómo lo ejecuta la app

`GcRuntimePackage.kt` lanza `nativeLibraryDir/libnode.so` (o `libgentle_ai.so`)
con `ProcessBuilder` y `argv` puro — sin shell, así que nada se interpola —
y con estos ajustes:

```
LD_LIBRARY_PATH = <nativeLibraryDir>     # ahí están las 9 librerías compartidas
HOME            = <filesDir>             # sandbox de la app
TMPDIR          = <cacheDir>
PATH            = <nativeLibraryDir>:/system/bin:/system/xbin
LANG            = C.UTF-8
```

Cada llamada está acotada por un timeout (30 s por defecto, entre 1 s y 10 min,
se mata el proceso al vencer) y cada stream se corta a 1 MiB. La superficie TS
es `mobile/lib/runtime.ts` (`runNode`, `runGentleAi`, `nodeVersion`,
`gentleAiVersion`), con el mismo envelope JSON del resto del módulo:

```json
{"ok":true,"exitCode":0,"stdout":"v24.22.3\n","stderr":""}
{"ok":false,"exitCode":1,"stdout":"","stderr":"node: bad option","error":{"kind":"ExitCode","message":"…"}}
```

### Packaging: `extractNativeLibs` tiene que estar en `true`

Con `jniLibs.useLegacyPackaging = false` (el default de Expo) el APK guarda las
librerías sin extraer y `ApplicationInfo.nativeLibraryDir` queda como
`base.apk!/lib/arm64-v8a`: no hay ningún archivo en disco que se pueda ejecutar.
Por eso el proyecto empaqueta en modo legacy con `expo.useLegacyPackaging=true`,
que es lo que hace que el instalador extraiga cada `lib/<abi>/*.so` en
`nativeLibraryDir`.

Ese `android/gradle.properties` **es generado**: cada `expo prebuild` (y sobre
todo `expo prebuild --clean`) lo reescribe desde el template y el valor vuelve a
`false`. Así que la fuente de verdad es el config plugin
`mobile/plugins/with-legacy-packaging.js`, registrado en `app.json`:

```json
"plugins": ["expo-router", "./plugins/with-legacy-packaging"]
```

Usa el mod `gradleProperties` de Expo (`withGradleProperties` de
`expo/config-plugins`, la versión que trae `expo` 58.x): recibe la lista de
propiedades ya parseada y escribe `expo.useLegacyPackaging=true` de forma
idempotente — reescribe la clave si existe (aunque esté en `false`, y colapsa
duplicados) y la agrega solo si falta. Nunca duplica la línea, así que correr
prebuild dos veces deja el archivo igual.

Si el APK sale sin extracción, todo sigue andando pero `runNode`/`runGentleAi`
responden la falla tipada `not-extracted` con el path pseudo que resolvió
Android — nunca un resultado inventado.

Ojo al hacer `expo prebuild`: regenera `mobile/android/` entero, así que se
pierden los artefactos que viven ahí y no están versionados
(`mobile/android/app/src/main/jniLibs/libmobile_core.so`, los `build/` de
Gradle). Volver a correr `bash scripts/build-apk.sh` los recrea (compila el core
Rust primero). El runtime embebido **no** corre esa suerte: vive en
`mobile/modules/gentle-core/android/src/main/jniLibs/`, fuera de `mobile/android/`.

### Cómo se ve una librería faltante o mal nombrada

Nada explota: todo baja como falla tipada, con el path real en el mensaje.

| Situación | Respuesta nativa | Lo que ve la UI |
| --- | --- | --- |
| El APK no extrae las librerías | `{"error":{"kind":"NotExtracted",…}}` | `not-extracted`, con el path `…apk!/lib/…` |
| Falta `libnode.so`/`libgentle_ai.so` | `RuntimeMissing` + el path completo | `missing` |
| El archivo está pero sin bit de ejecución | `NotExecutable` | `not-executable` |
| Falla el `ProcessBuilder.start()` | `SpawnFailed` | `spawn` |
| El proceso no termina en el timeout | `Timeout` | `timeout` |
| El proceso sale con código ≠ 0 | `ExitCode` + código + stderr | `exit`, con stdout/stderr reales |
| Una librería compartida no se encuentra | el proceso arranca y muere: stderr trae `library "libz.so" not found` y el envelope es `ExitCode` | `exit`, con ese stderr en el log |

Para diagnosticar en el teléfono: `adb logcat -s GcRuntime` (una línea por
llamada, con `argc`, `exit` y tamaños) y `runtimeInfo()` del módulo, que devuelve
`nativeLibraryDir`, si el APK extrae las librerías y si cada binario existe y es
ejecutable.

## Repo

- `mobile/` — app Expo (TypeScript)
- `mobile-core/` — Rust: russh + C ABI + shim JNI (115 tests offline)
- `cli/` — `gentle-movil pair|status|doctor` (Node, sin dependencias del repo)
- `scripts/` — `build-apk.sh` (Rust + Gradle) y `fetch-runtime.sh` (runtime embebido)
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
cd mobile && npm test          # 336 tests offline
cd mobile-core && cargo test   # 115 tests offline
```

Historia previa (PRs #19/#20): [IAI-00-IAI/gentle-companion](https://github.com/IAI-00-IAI/gentle-companion).
