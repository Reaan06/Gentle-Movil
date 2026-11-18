#!/usr/bin/env bash
# Rebuild the Android arm64 library and drop it where Gradle expects it.
#
# Requirements (verified on this machine):
#   - rustup with the aarch64-linux-android target
#   - an Android NDK (28.2 pinned); set ANDROID_NDK_HOME or ANDROID_HOME if the
#     default lookup below does not find yours
#
# Usage: ./mobile-core/build-android.sh [--api 26]
set -euo pipefail

API="${2:-26}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/mobile/android/app/src/main/jniLibs/arm64-v8a/libmobile_core.so"
# The module copy is the one that survives `expo prebuild --clean`: autolinking
# re-injects a module's jniLibs into the regenerated android/ tree, while the
# app-level src/main/jniLibs directory is deleted with the rest of android/.
MODULE_OUT="$ROOT/mobile/modules/gentle-core/android/src/main/jniLibs/arm64-v8a"

find_ndk() {
  if [ -n "${ANDROID_NDK_HOME:-}" ]; then echo "$ANDROID_NDK_HOME"; return; fi
  if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
    ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1
    return
  fi
  ls -d "$HOME"/Android/Sdk/ndk/* 2>/dev/null | sort -V | tail -1
}

NDK="$(find_ndk)"
if [ -z "$NDK" ] || [ ! -d "$NDK" ]; then
  echo "error: Android NDK not found. Set ANDROID_NDK_HOME to your ndk directory." >&2
  exit 1
fi

TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
CLANG="$TC/aarch64-linux-android${API}-clang"
if [ ! -x "$CLANG" ]; then
  echo "error: $CLANG is missing (is API $API supported by this NDK?)" >&2
  exit 1
fi

echo "NDK:   $NDK"
echo "CLANG: $CLANG"

CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
[ -x "$CARGO" ] || CARGO=cargo

export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CLANG"
export CC_aarch64_linux_android="$CLANG"
export AR_aarch64_linux_android="$TC/llvm-ar"

# `jni-shim` is mandatory here: the shim module is cfg-gated behind it, so a build
# without the feature produces a library with **no** `Java_…` symbol at all and every
# GcNative call on the device throws UnsatisfiedLinkError.
"$CARGO" build --release --features jni-shim --target aarch64-linux-android --manifest-path "$ROOT/mobile-core/Cargo.toml"

LIB="$ROOT/mobile-core/target/aarch64-linux-android/release/libmobile_core.so"
JNI_SYMBOLS="$(strings -a "$LIB" | grep -o 'Java_com_gentlemovil_core_GcNative_[A-Za-z]*' | sort -u || true)"
if [ -z "$JNI_SYMBOLS" ]; then
  echo "error: $LIB exports no Java_com_gentlemovil_core_GcNative_ symbol." >&2
  echo "       The JNI shim was not compiled in: check that the build passes --features jni-shim." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")" "$MODULE_OUT"
cp "$ROOT/mobile-core/target/aarch64-linux-android/release/libmobile_core.so" "$OUT"
cp "$ROOT/mobile-core/target/aarch64-linux-android/release/libmobile_core.so" "$MODULE_OUT/"
echo "installed: $OUT ($(stat -c%s "$OUT") bytes)"
echo "installed: $MODULE_OUT/libmobile_core.so (survives expo prebuild --clean)"
echo "jni symbols: $(printf '%s\n' "$JNI_SYMBOLS" | wc -l)"
