#!/usr/bin/env bash
# Bundle the phone runtime (T9a): a real Node + the real `gentle-ai` binary,
# shipped inside the APK as `lib*.so` so Android lets the app execute them.
#
# Why "as libraries": since targetSdk 29 SELinux refuses to execute anything the
# app writes to its own data dir (W^X), so the binaries cannot be copied out of
# the APK at runtime. The only executables an app may spawn are the ones the
# package manager put in `ApplicationInfo.nativeLibraryDir` — i.e. files packed
# under `lib/<abi>/` in the APK. Hence: every artefact here is a `lib*.so` file
# in this module's jniLibs folder, and `GcRuntimePackage.kt` runs it from that
# directory with `LD_LIBRARY_PATH` pointing at the very same directory.
#
# What lands in `mobile/modules/gentle-core/android/src/main/jniLibs/arm64-v8a/`:
#
#   libnode.so            node 24.22.3 (Termux `nodejs-lts`, aarch64)     [exec]
#   libgentle_ai.so       gentle-ai 4.6.0 (linux/arm64, static Go)        [exec]
#   libc++_shared.so      libc++ (Termux)                                  [needed by node+ICU]
#   libcares.so           c-ares 1.34.9                                    [needed by node]
#   libcrypto.so          openssl 3.6.5                                    [needed by node]
#   libssl.so             openssl 3.6.5                                    [needed by node]
#   libicuuc.so           ICU 79.1                                         [needed by node]
#   libicui18n.so         ICU 79.1                                         [needed by node]
#   libicudata.so         ICU 79.1                                         [needed by libicuuc]
#   libsqlite3.so         sqlite 3.54.1                                    [needed by node]
#   libz.so               zlib 1.4                                         [needed by node+sqlite]
#
# The Termux payloads are the *real* files (`libz.so.1.4`, `libicuuc.so.79.1`,
# …); Termux normally exposes them to the loader through symlinks named after
# each library's DT_SONAME (`libz.so.1`, `libicuuc.so.79`). An APK cannot carry
# symlinks, and Android's build tools drop any jniLibs file that does not end in
# `.so` (AGP's `MergeNativeLibsTask` includes only `**/*.so`), so this script
# rewrites every DT_NEEDED and DT_SONAME string to the unversioned name
# (`libz.so.1` -> `libz.so`, `libicuuc.so.79` -> `libicuuc.so`) and gives each
# file exactly that name. The rewrite only ever *shortens* the string inside
# `.dynstr` and NUL-pads the tail, so no ELF offset moves and the loader resolves
# each dependency by the plain filename it now asks for.
#
# Requirements: curl, ar, tar, xz, sha256sum, python3.
#
# Usage: bash scripts/fetch-runtime.sh
#   Idempotent: when the pinned versions and the SHA256 of every artefact still
#   match `runtime-manifest.json`, it only re-prints the versions and sizes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ABI="arm64-v8a"
OUT_DIR="$ROOT/mobile/modules/gentle-core/android/src/main/jniLibs/$ABI"
MANIFEST="$OUT_DIR/runtime-manifest.json"

# ── Pinned versions ─────────────────────────────────────────────────────────
GENTLE_AI_VERSION="4.6.0"
NODE_VERSION="24.22.3" # Termux `nodejs-lts` 24.22.3
TERMUX_REPO="https://packages.termux.dev/apt/termux-main"
# The Termux `stable` dist is rolling: the pinned files can disappear from the
# pool. A 404 or a checksum mismatch is a loud failure on purpose — re-pin
# deliberately (update version + SHA256 from
# https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages),
# nothing here guesses a version.
GENTLE_AI_TARBALL="gentle-ai_${GENTLE_AI_VERSION}_linux_arm64.tar.gz"
GENTLE_AI_URL="https://github.com/Gentleman-Programming/gentle-ai/releases/download/v${GENTLE_AI_VERSION}/${GENTLE_AI_TARBALL}"
# SHA256 published by the release itself (`checksums.txt` next to the asset) and
# mirrored by the GitHub API asset digest.
GENTLE_AI_SHA256="ab5a2f55ff41281bc41baea2ec730dcb05e8f55f3a9eea201c001693be490d32"

# name|version|url path (already percent-encoded)|sha256 (from the Packages index)
TERMUX_PACKAGES=(
  "c-ares|1.34.9|pool/main/c/c-ares/c-ares_1.34.9_aarch64.deb|623d84855e176f3f2a415d24c0e1d2f529356f4b5439bb3313e6d7ff0da4585c"
  "libc++|30|pool/main/libc/libc++/libc++_30_aarch64.deb|53d0b84a7ba7459024257cb94d5b136fe13ef858567f65a8064b35950799f2ca"
  "libicu|79.1|pool/main/libi/libicu/libicu_79.1_aarch64.deb|83c980a010e957738e3567127801d66a1b9bd7e404a4fda98788048ee57d606c"
  "libsqlite|3.54.1-1|pool/main/libs/libsqlite/libsqlite_3.54.1-1_aarch64.deb|661fb995f7215845007b222a85266ae99d9443e87e0604f8677edfd738e6b81a"
  "nodejs-lts|$NODE_VERSION|pool/main/n/nodejs-lts/nodejs-lts_${NODE_VERSION}_aarch64.deb|80edcc73db025db0baa09be27e3d65a16e6f2a72ab925f1873a1b808ab857c28"
  # Debian epoch in the version: the filename carries a literal ':' -> %3A.
  "openssl|1:3.6.5|pool/main/o/openssl/openssl_1%3A3.6.5_aarch64.deb|a2fb7856875e63ef6b90442752e05974813372c3ca86d2513a78ea43c67a0f8b"
  "zlib|1.4|pool/main/z/zlib/zlib_1.4_aarch64.deb|e3027565ae50bcd8ba5113c988b589754ae192c9cc3e6afbe3e4ed7c06b2598e"
)

# Source path inside a Termux deb's `data.tar` (relative to
# `data/data/com.termux/files/usr/`) -> file name in jniLibs.
TERMUX_USR="data/data/com.termux/files/usr"
declare -a TERMUX_SOURCES=(
  "nodejs-lts|bin/node|libnode.so"
  "libc++|lib/libc++_shared.so|libc++_shared.so"
  "c-ares|lib/libcares.so|libcares.so"
  "zlib|lib/libz.so.1.4|libz.so"
  "libsqlite|lib/libsqlite3.so.3.54.1|libsqlite3.so"
  "openssl|lib/libcrypto.so.3|libcrypto.so"
  "openssl|lib/libssl.so.3|libssl.so"
  "libicu|lib/libicuuc.so.79.1|libicuuc.so"
  "libicu|lib/libicui18n.so.79.1|libicui18n.so"
  "libicu|lib/libicudata.so.79.1|libicudata.so"
)

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in curl ar tar xz sha256sum python3; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# Artefacts this script owns (never anything else that may live in jniLibs,
# e.g. the Rust core's libmobile_core.so).
OWNED_FILES=()
for entry in "${TERMUX_SOURCES[@]}"; do
  OWNED_FILES+=("${entry##*|}")
done
OWNED_FILES+=("libgentle_ai.so")

# ── Pins fingerprint: everything the check below depends on ─────────────────
pins_fingerprint() {
  {
    printf 'abi=%s\nnode=%s\ngentleAi=%s\ngentleAiSha256=%s\n' \
      "$ABI" "$NODE_VERSION" "$GENTLE_AI_VERSION" "$GENTLE_AI_SHA256"
    local entry
    for entry in "${TERMUX_PACKAGES[@]}"; do
      printf 'pkg=%s\n' "$entry"
    done
    local src
    for src in "${TERMUX_SOURCES[@]}"; do
      printf 'src=%s\n' "$src"
    done
  } | sha256sum | cut -d' ' -f1
}

# Prints "<version>\t<bytes>\t<name>" for every owned artefact that exists.
print_artefacts() {
  local name path bytes
  for name in "${OWNED_FILES[@]}"; do
    path="$OUT_DIR/$name"
    if [ -f "$path" ]; then
      bytes="$(stat -c %s "$path")"
      case "$name" in
        libnode.so) log "$(printf '  %-18s %10s  %s' "$name" "$(human_bytes "$bytes")" "node $NODE_VERSION")" ;;
        libgentle_ai.so) log "$(printf '  %-18s %10s  %s' "$name" "$(human_bytes "$bytes")" "gentle-ai $GENTLE_AI_VERSION")" ;;
        *) log "$(printf '  %-18s %10s  %s' "$name" "$(human_bytes "$bytes")" "Termux shared library")" ;;
      esac
    fi
  done
  local total=0
  for name in "${OWNED_FILES[@]}"; do
    if [ -f "$OUT_DIR/$name" ]; then
      total=$((total + $(stat -c %s "$OUT_DIR/$name")))
    fi
  done
  log "$(printf '  %-18s %10s' 'total' "$(human_bytes "$total")")"
}

human_bytes() {
  local bytes="$1"
  if [ "$bytes" -ge 1048576 ]; then
    awk -v b="$bytes" 'BEGIN { printf "%.1f MiB", b / 1048576 }'
  elif [ "$bytes" -ge 1024 ]; then
    awk -v b="$bytes" 'BEGIN { printf "%.1f KiB", b / 1024 }'
  else
    printf '%s B' "$bytes"
  fi
}

# ── Idempotency: same pins + same bytes -> nothing to do ────────────────────
if [ -f "$MANIFEST" ]; then
  if PINS="$(pins_fingerprint)" python3 - "$MANIFEST" <<'PY'
import json, os, sys, hashlib, pathlib

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
if manifest.get('pins') != os.environ['PINS']:
    sys.exit(1)
out_dir = pathlib.Path(sys.argv[1]).parent
for name, entry in manifest.get('files', {}).items():
    path = out_dir / name
    if not path.is_file() or path.stat().st_size != entry['bytes']:
        sys.exit(1)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != entry['sha256']:
        sys.exit(1)
PY
  then
    log "runtime ${ABI} already up to date (node $NODE_VERSION, gentle-ai $GENTLE_AI_VERSION)"
    print_artefacts
    exit 0
  fi
  log "runtime ${ABI}: pins or artefacts changed — rebuilding"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. Download + verify the Termux packages ────────────────────────────────
log "── 1/4  Termux packages (${ABI}) ──────────────────────────────────────"
for entry in "${TERMUX_PACKAGES[@]}"; do
  IFS='|' read -r name version url_path sha256 <<<"$entry"
  deb="$WORK/$name.deb"
  log "  $name $version"
  curl -fsSL --retry 3 --max-time 300 -o "$deb" "$TERMUX_REPO/$url_path" \
    || die "download failed for $name $version ($TERMUX_REPO/$url_path) — the pinned file may have been dropped from the rolling Termux dist; re-pin it explicitly"
  actual="$(sha256sum "$deb" | cut -d' ' -f1)"
  [ "$actual" = "$sha256" ] \
    || die "checksum mismatch for $name $version: expected $sha256, got $actual"
  mkdir -p "$WORK/$name"
  ( cd "$WORK/$name" && ar x "$WORK/$name.deb" && { tar xf data.tar.xz 2>/dev/null || tar xf data.tar.* ; } ) \
    || die "could not extract $name.deb"
done

# ── 2. Download + verify gentle-ai ──────────────────────────────────────────
log "── 2/4  gentle-ai $GENTLE_AI_VERSION ──────────────────────────────────"
curl -fsSL --retry 3 --max-time 300 -o "$WORK/$GENTLE_AI_TARBALL" "$GENTLE_AI_URL" \
  || die "download failed for $GENTLE_AI_URL"
actual="$(sha256sum "$WORK/$GENTLE_AI_TARBALL" | cut -d' ' -f1)"
[ "$actual" = "$GENTLE_AI_SHA256" ] \
  || die "checksum mismatch for $GENTLE_AI_TARBALL: expected $GENTLE_AI_SHA256, got $actual (checksums.txt of the release publishes it)"
mkdir -p "$WORK/gentle-ai"
tar xzf "$WORK/$GENTLE_AI_TARBALL" -C "$WORK/gentle-ai" gentle-ai \
  || die "$GENTLE_AI_TARBALL does not contain the expected 'gentle-ai' binary"
log "  gentle-ai $GENTLE_AI_VERSION (static Go, arm64)"

# ── 3. Install the artefacts under their loader-visible names ───────────────
log "── 3/4  Installing into ${OUT_DIR#$ROOT/} ────────────────────────────"
mkdir -p "$OUT_DIR"
for entry in "${TERMUX_SOURCES[@]}"; do
  IFS='|' read -r package source name <<<"$entry"
  src="$WORK/$package/$TERMUX_USR/$source"
  [ -f "$src" ] || die "expected $source inside $package.deb — the package layout changed, re-check the pin"
  install -m 0755 "$src" "$OUT_DIR/$name"
  log "  $source -> $name"
done
install -m 0755 "$WORK/gentle-ai/gentle-ai" "$OUT_DIR/libgentle_ai.so"
log "  gentle-ai -> libgentle_ai.so"

# ── 4. Make the whole set self-consistent and prove it ──────────────────────
log "── 4/4  DT_NEEDED/SONAME rewrite + ELF closure check ────────────────"
python3 - "$OUT_DIR" "${OWNED_FILES[@]}" <<'PY'
"""Rewrite versioned SONAMEs to their `.so` names and verify the loader closure.

Only *shortens* a string inside `.dynstr` and NUL-pads the rest of its slot, so
no offset in the ELF moves. Then it proves every DT_NEEDED of every shipped file
is either another shipped file, or one of the Android system libraries the NDK
always provides. Anything else is a hard error: the app would exec a binary that
dies with "cannot locate symbol".
"""
import pathlib
import re
import struct
import sys

SYSTEM_LIBS = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so', 'libstdc++.so', 'ld-android.so'}
AARCH64 = 183
DT_NULL, DT_NEEDED, DT_STRTAB, DT_SONAME = 0, 1, 5, 14
VERSIONED = re.compile(r'^(lib[\w+.-]*?\.so)\.\d+$')


def dynamic_info(data):
    is64 = data[4] == 2
    endian = '<' if data[5] == 1 else '>'
    if is64:
        phoff, = struct.unpack_from(endian + 'Q', data, 0x20)
        phentsize, phnum = struct.unpack_from(endian + 'HH', data, 0x36)
        machine, = struct.unpack_from(endian + 'H', data, 0x12)
    else:
        phoff, = struct.unpack_from(endian + 'I', data, 0x1c)
        phentsize, phnum = struct.unpack_from(endian + 'HH', data, 0x2a)
        machine, = struct.unpack_from(endian + 'H', data, 0x12)
    loads, dynamic, interp = [], None, None
    for index in range(phnum):
        off = phoff + index * phentsize
        if is64:
            p_type, _, p_offset, p_vaddr, _, p_filesz, _, _ = struct.unpack_from(endian + 'IIQQQQQQ', data, off)
        else:
            p_type, p_offset, p_vaddr, _, p_filesz, _, _, _ = struct.unpack_from(endian + 'IIIIIIII', data, off)
        if p_type == 1:
            loads.append((p_offset, p_vaddr, p_filesz))
        elif p_type == 2:
            dynamic = (p_offset, p_filesz)
        elif p_type == 3:
            interp = data[p_offset:p_offset + p_filesz].split(b'\0', 1)[0].decode('utf-8', 'replace')
    if dynamic is None:
        return {'machine': machine, 'entries': [], 'strtab': None, 'interp': interp}
    entsize = 16 if is64 else 8
    fmt = endian + ('qQ' if is64 else 'iI')
    entries = []
    for index in range(dynamic[1] // entsize):
        tag, value = struct.unpack_from(fmt, data, dynamic[0] + index * entsize)
        if tag == DT_NULL:
            break
        entries.append((tag, value))
    strtab = None
    for tag, value in entries:
        if tag == DT_STRTAB:
            for p_offset, p_vaddr, p_filesz in loads:
                if p_vaddr <= value < p_vaddr + p_filesz:
                    strtab = p_offset + (value - p_vaddr)
            if strtab is None:
                strtab = value
    return {'machine': machine, 'entries': entries, 'strtab': strtab, 'interp': interp}


def read_string(data, offset):
    end = data.index(b'\0', offset)
    return offset, end, data[offset:end].decode('utf-8', 'replace')


def main():
    out_dir = pathlib.Path(sys.argv[1])
    owned = sys.argv[2:]
    failures = []

    # 1. Rewrite DT_NEEDED / DT_SONAME to the unversioned `.so` name.
    for name in owned:
        path = out_dir / name
        data = bytearray(path.read_bytes())
        info = dynamic_info(bytes(data))
        if info['strtab'] is None or not info['entries']:
            continue
        rewrote = 0
        for tag, value in info['entries']:
            if tag not in (DT_NEEDED, DT_SONAME):
                continue
            start, end, current = read_string(data, info['strtab'] + value)
            match = VERSIONED.match(current)
            if not match:
                continue
            wanted = match.group(1)
            if len(wanted) > end - start:
                failures.append(f'{name}: cannot shorten {current!r} -> {wanted!r} in place')
                continue
            slot = bytearray(wanted.encode() + b'\0' * (end - start - len(wanted)))
            data[start:end] = slot
            rewrote += 1
            print(f'  {name}: {current} -> {wanted}')
        if rewrote:
            path.write_bytes(bytes(data))

    # 2. Prove the closure, the architecture and the interpreter.
    shipped = set(owned)
    for name in owned:
        path = out_dir / name
        data = path.read_bytes()
        info = dynamic_info(data)
        if info['machine'] != AARCH64:
            failures.append(f'{name}: e_machine={info["machine"]}, expected AArch64 ({AARCH64})')
        if info['interp'] not in (None, '/system/bin/linker64'):
            failures.append(f'{name}: PT_INTERP is {info["interp"]!r}, Android needs /system/bin/linker64')
        needed = []
        for tag, value in info['entries']:
            if tag != DT_NEEDED:
                continue
            _, _, target = read_string(data, info['strtab'] + value)
            needed.append(target)
        for target in needed:
            if target in shipped or target in SYSTEM_LIBS:
                continue
            failures.append(f'{name}: needs {target!r}, which is neither shipped nor an Android system library')
        missing = [target for target in needed if target in shipped and not (out_dir / target).is_file()]
        if missing:
            failures.append(f'{name}: ships no file for {missing}')
        soname = None
        for tag, value in info['entries']:
            if tag == DT_SONAME:
                _, _, soname = read_string(data, info['strtab'] + value)
        if soname is not None and soname != name:
            failures.append(f'{name}: DT_SONAME is {soname!r}; the loader resolves by file name')
        print(f'  {name}: ok (needs {", ".join(needed) if needed else "nothing"})')

    if failures:
        print('\nruntime is NOT loadable:', file=sys.stderr)
        for failure in failures:
            print(f'  - {failure}', file=sys.stderr)
        return 1
    return 0


sys.exit(main())
PY

# Versions are also proven from the bytes we are about to ship: no host can
# execute an aarch64 binary here, so the version string must be inside it.
grep -aqF "$NODE_VERSION" "$OUT_DIR/libnode.so" \
  || die "libnode.so does not contain the pinned node version $NODE_VERSION"
grep -aqF "$GENTLE_AI_VERSION" "$OUT_DIR/libgentle_ai.so" \
  || die "libgentle_ai.so does not contain the pinned gentle-ai version $GENTLE_AI_VERSION"

# ── Manifest (the idempotency check above reads it) ─────────────────────────
PINS="$(pins_fingerprint)" python3 - "$OUT_DIR" "$MANIFEST" "$NODE_VERSION" "$GENTLE_AI_VERSION" "${OWNED_FILES[@]}" <<'PY'
import hashlib, json, os, pathlib, sys

out_dir = pathlib.Path(sys.argv[1])
manifest_path = pathlib.Path(sys.argv[2])
node_version, gentle_ai_version = sys.argv[3], sys.argv[4]
names = sys.argv[5:]
files = {}
for name in names:
    path = out_dir / name
    data = path.read_bytes()
    files[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
manifest_path.write_text(json.dumps({
    'pins': os.environ['PINS'],
    'abi': 'arm64-v8a',
    'node': node_version,
    'gentleAi': gentle_ai_version,
    'files': files,
}, indent=2, sort_keys=True) + '\n', encoding='utf-8')
PY

log "runtime ${ABI} ready (node $NODE_VERSION, gentle-ai $GENTLE_AI_VERSION)"
print_artefacts
log ""
log "Android only extracts these when the APK is packaged with"
log "  android:extractNativeLibs=\"true\"  (Gradle: jniLibs.useLegacyPackaging = true);"
log "with extractNativeLibs=false nativeLibraryDir is an 'apk!/lib/…' path and"
log "nothing can be executed from it. See README.md § Runtime embebido."
