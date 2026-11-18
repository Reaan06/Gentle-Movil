#!/usr/bin/env bash
# Build (and optionally install) the Android release APK — Rust core FIRST.
#
# Why Rust always runs first: the app is useless without `libmobile_core.so`
# (every SSH/JNI call fails with `dlopen failed: library "libmobile_core.so"
# not found`). A Gradle-only build happily produces an APK without it, so this
# script rebuilds the native core before Gradle and then proves the library is
# inside the APK. It refuses to report success otherwise.
#
# Usage:
#   ./scripts/build-apk.sh              # build + verify
#   ./scripts/build-apk.sh --install    # build + install on the connected device
#   ./scripts/build-apk.sh --install --launch
#
# Requirements: rustup target aarch64-linux-android, Android NDK, JDK 17.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/mobile/android"
APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
ABI="arm64-v8a"

INSTALL=false
LAUNCH=false
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=true ;;
    --launch) INSTALL=true; LAUNCH=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# JDK: Gradle needs 17; the repo's toolchain lives outside the default PATH.
if [ -z "${JAVA_HOME:-}" ] && [ -d "/mnt/disco900/sonora-mobile-tools/jdks/temurin-17" ]; then
  export JAVA_HOME="/mnt/disco900/sonora-mobile-tools/jdks/temurin-17"
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -d "/mnt/disco900/sonora-mobile-tools/android-sdk" ]; then
  export ANDROID_HOME="/mnt/disco900/sonora-mobile-tools/android-sdk"
fi

echo "── 1/3  Rust core (${ABI}) ─────────────────────────────────────────"
"$ROOT/mobile-core/build-android.sh"

echo "── 2/3  Gradle assembleRelease ─────────────────────────────────────"
# --max-workers=1 is not cosmetic: this machine has 7 GB of RAM and the
# expo-modules-core C++ build (with -flto) gets OOM-killed with more parallel
# workers, which surfaces as a bare "ninja: build stopped" with no diagnostic.
(cd "$ANDROID_DIR" && ./gradlew assembleRelease \
  "-PreactNativeArchitectures=${ABI}" \
  --max-workers=1 --console=plain)

echo "── 3/3  Verifying the native core is inside the APK ────────────────"
if [ ! -f "$APK" ]; then
  echo "error: APK not found at $APK" >&2
  exit 1
fi
SO_ENTRY="lib/${ABI}/libmobile_core.so"
if ! unzip -l "$APK" | grep -q "$SO_ENTRY"; then
  echo "error: $SO_ENTRY is missing from the APK." >&2
  echo "       The app would fail at runtime with dlopen failed." >&2
  exit 1
fi
echo "ok: $SO_ENTRY present ($(unzip -l "$APK" | awk -v e="$SO_ENTRY" '$4==e {print $1}') bytes in the zip)"
echo "ok: $APK ($(stat -c%s "$APK") bytes)"

if [ "$INSTALL" = true ]; then
  DEVICE="${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')}"
  if [ -z "$DEVICE" ]; then
    echo "error: no device attached (adb devices is empty)." >&2
    exit 1
  fi
  echo "── installing on $DEVICE ───────────────────────────────────────────"
  adb -s "$DEVICE" install -r "$APK"
  if [ "$LAUNCH" = true ]; then
    adb -s "$DEVICE" shell am force-stop com.anonymous.gentlemovil
    adb -s "$DEVICE" shell am start -n com.anonymous.gentlemovil/.MainActivity
  fi
fi

echo "done."
