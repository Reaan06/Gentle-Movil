/**
 * Self-contained QR Code encoder + terminal renderer.
 *
 * Why in-repo instead of the `qrcode` npm package: the repo has no
 * `package.json` (the daemon-era dependencies went away with S2), and the owner
 * asked for a CLI that runs with Node alone — no install step on the PC. This
 * implements just what `pair` needs: byte mode, error correction level L,
 * versions 1-10 (274 data bytes at most, enough for the `gc://pair` URI).
 *
 * Deliberately boring ISO/IEC 18004 machinery (GF(256) arithmetic, RS blocks,
 * format/version BCH bits, the 8 masks) so the QR stays scannable. Output is
 * half-block terminal art, shrunk (quiet zone 2 → 1 → 0) to the terminal width
 * so a narrow terminal never wraps the code; a width too narrow for the bare
 * matrix falls back to printing the payload as text. On a TTY the field is
 * painted white so black modules stay black on dark and light terminals.
 *
 * Pure: no I/O, no dependencies. `encodeQr` is exported so the contract test
 * can assert both the matrix and the renderer.
 */

const MODE_BYTE = 0b0100;
/** Level L is `01` in the format bits (ISO/IEC 18004 table 12). */
const ECC_L_FORMAT_BITS = 1;

/** Highest version this encoder emits (data 19…274 bytes). */
const MAX_VERSION = 10;

/** Total codewords (data + ECC) per version, L table (ISO/IEC 18004 table 9). */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** RS blocks for level L as `[dataCodewords, eccCodewordsPerBlock]`. */
const BLOCKS_L = [
  null,
  [[19, 7]],
  [[34, 10]],
  [[55, 15]],
  [[80, 20]],
  [[108, 26]],
  [[68, 18], [68, 18]],
  [[78, 20], [78, 20]],
  [[97, 24], [97, 24]],
  [[116, 30], [116, 30]],
  [[68, 18], [68, 18], [69, 18], [69, 18]],
];

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT_CENTERS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** GF(256) with the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed–Solomon generator polynomial coefficients, degree `n`. */
function generatorPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of `data * x^degree` divided by the generator polynomial. */
function eccCodewords(data, generator) {
  const eccCount = generator.length - 1;
  const work = new Array(data.length + eccCount).fill(0);
  for (let i = 0; i < data.length; i++) work[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const factor = work[i];
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j++) work[i + j] ^= gfMultiply(generator[j], factor);
  }
  return work.slice(data.length);
}

/** Bits available for data codewords in this version at level L. */
function dataCapacityBits(version) {
  const codewords = BLOCKS_L[version].reduce((total, [dataCount]) => total + dataCount, 0);
  return codewords * 8;
}

/** Character-count indicator length for byte mode (ISO/IEC 18004 table 3). */
function countIndicatorBits(version) {
  return version <= 9 ? 8 : 16;
}

/**
 * Mode + count + payload bit stream padded with the terminator and pad bytes.
 * Returns `null` when the payload does not fit this version.
 */
function dataCodewordsFor(bytes, version) {
  const capacity = dataCapacityBits(version);
  const needed = 4 + countIndicatorBits(version) + bytes.length * 8;
  if (needed > capacity) return null;

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(MODE_BYTE, 4);
  push(bytes.length, countIndicatorBits(version));
  for (const byte of bytes) push(byte, 8);

  // Terminator (up to 4 zero bits), then pad the current byte.
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  // Fill the remaining data codewords with the standard pad bytes.
  let pad = 0xec;
  while (codewords.length < capacity / 8) {
    codewords.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return codewords;
}

/** Split into RS blocks, add ECC and interleave (ISO/IEC 18004 §7.6). */
function interleaveCodewords(dataCodewords, version) {
  const blocks = BLOCKS_L[version];
  const eccPerBlock = blocks[0][1];
  const generator = generatorPoly(eccPerBlock);

  const dataBlocks = [];
  let offset = 0;
  for (const [dataCount] of blocks) {
    dataBlocks.push(dataCodewords.slice(offset, offset + dataCount));
    offset += dataCount;
  }
  if (offset !== dataCodewords.length) {
    throw new Error(`QR internal invariant: ${offset} data codewords, expected ${dataCodewords.length}.`);
  }

  const eccBlocks = dataBlocks.map((block) => eccCodewords(block, generator));
  const result = [];
  const longestBlock = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longestBlock; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const block of eccBlocks) result.push(block[i]);
  }
  if (result.length !== TOTAL_CODEWORDS[version - 1]) {
    throw new Error(
      `QR internal invariant: ${result.length} codewords, expected ${TOTAL_CODEWORDS[version - 1]}.`,
    );
  }
  return result;
}

/** 15-bit format info (BCH(15,5), generator 0x537) for level L + mask. */
function formatBits(mask) {
  const data = (ECC_L_FORMAT_BITS << 3) | mask; // 5 bits: ECC level + mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version info (BCH(18,6), generator 0x1F25), versions 7+. */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bitAt = (value, index) => (value >>> index) & 1;

/** Draw one finder pattern plus its separator ring (function modules). */
function drawFinder(modules, reserved, size, x0, y0) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark =
        inside &&
        (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      modules[y * size + x] = dark ? 1 : 0;
      reserved[y * size + x] = 1;
    }
  }
}

/** Reserve and draw the format-info modules (values are re-written per mask). */
function drawFormat(modules, reserved, size, mask) {
  const bits = formatBits(mask);
  const put = (x, y, bit) => {
    modules[y * size + x] = bit ? 1 : 0;
    reserved[y * size + x] = 1;
  };

  // First copy around the top-left finder.
  for (let i = 0; i <= 5; i++) put(8, i, bitAt(bits, i));
  put(8, 7, bitAt(bits, 6));
  put(8, 8, bitAt(bits, 7));
  put(7, 8, bitAt(bits, 8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bitAt(bits, i));

  // Second copy split between the other two finders.
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bitAt(bits, i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bitAt(bits, i));

  // The always-dark module.
  put(8, size - 8, 1);
}

/** Reserve and draw the 18-bit version info blocks (versions 7+). */
function drawVersionInfo(modules, reserved, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = bitAt(bits, i) ? 1 : 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b * size + a] = bit;
    reserved[b * size + a] = 1;
    modules[a * size + b] = bit;
    reserved[a * size + b] = 1;
  }
}

/** The base matrix: every function module drawn, format bits reserved. */
function buildBaseMatrix(version, codewords) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);

  drawFinder(modules, reserved, size, 0, 0);
  drawFinder(modules, reserved, size, size - 7, 0);
  drawFinder(modules, reserved, size, 0, size - 7);

  // Timing patterns: alternating modules on row and column 6.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0;
    modules[6 * size + i] = dark;
    reserved[6 * size + i] = 1;
    modules[i * size + 6] = dark;
    reserved[i * size + 6] = 1;
  }

  // Alignment patterns, skipping the three that would overlap finders.
  for (const centreY of ALIGNMENT_CENTERS[version]) {
    for (const centreX of ALIGNMENT_CENTERS[version]) {
      const corner =
        (centreX === 6 && centreY === 6) ||
        (centreX === 6 && centreY === size - 7) ||
        (centreX === size - 7 && centreY === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          modules[(centreY + dy) * size + centreX + dx] =
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0;
          reserved[(centreY + dy) * size + centreX + dx] = 1;
        }
      }
    }
  }

  drawFormat(modules, reserved, size, 0);
  drawVersionInfo(modules, reserved, size, version);

  // Data placement: two-column pairs right-to-left, alternating up/down.
  let bitIndex = 0;
  const bitLength = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y * size + x] || bitIndex >= bitLength) continue;
        modules[y * size + x] = bitAt(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
        bitIndex += 1;
      }
    }
  }
  return { size, modules, reserved };
}

/** Mask predicate (ISO/IEC 18004 §7.8.2); `x` is the column, `y` the row. */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error(`QR internal invariant: mask ${mask} is not 0-7.`);
  }
}

/** Penalty score for one mask selection (ISO/IEC 18004 §7.8.3). */
function penaltyScore(modules, size) {
  let score = 0;

  const linePenalty = (getModule) => {
    let lineScore = 0;
    let runColor = -1;
    let runLength = 0;
    const line = [];
    for (let i = 0; i < size; i++) {
      const value = getModule(i);
      line.push(value);
      if (value === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) lineScore += 3 + (runLength - 5);
        runColor = value;
        runLength = 1;
      }
    }
    if (runLength >= 5) lineScore += 3 + (runLength - 5);

    // Finder-like 1:1:3:1:1 patterns with a 4-module light margin.
    for (let i = 0; i + 10 < line.length; i++) {
      const window = line.slice(i, i + 11);
      const finderForward = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
      const finderBackward = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      const matches = (pattern) => pattern.every((value, index) => value === window[index]);
      if (matches(finderForward) || matches(finderBackward)) lineScore += 40;
    }
    return lineScore;
  };

  for (let y = 0; y < size; y++) score += linePenalty((x) => modules[y * size + x]);
  for (let x = 0; x < size; x++) score += linePenalty((y) => modules[y * size + x]);

  // 2x2 blocks of one colour.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const value = modules[y * size + x];
      if (
        modules[y * size + x + 1] === value &&
        modules[(y + 1) * size + x] === value &&
        modules[(y + 1) * size + x + 1] === value
      ) {
        score += 3;
      }
    }
  }

  // Dark-module proportion, in 5% steps away from 50%.
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  score += Math.floor(Math.abs((dark * 20) / total - 10)) * 10;

  return score;
}

/**
 * Encode `text` as a QR matrix.
 *
 * Returns `{ version, size, modules }` where `modules` is a flat Uint8Array of
 * `size * size` entries (1 = dark). Byte mode, level L, versions 1-10.
 */
export function encodeQr(text) {
  const bytes = Array.from(new TextEncoder().encode(text));

  let version = 0;
  let dataCodewords = null;
  for (let candidate = 1; candidate <= MAX_VERSION; candidate++) {
    const codewords = dataCodewordsFor(bytes, candidate);
    if (codewords) {
      version = candidate;
      dataCodewords = codewords;
      break;
    }
  }
  if (!version) {
    throw new Error(
      `QR payload too long (${bytes.length} bytes, max ${dataCapacityBits(MAX_VERSION) / 8}); shorten the SSH password or use --invite-only.`,
    );
  }

  const codewords = interleaveCodewords(dataCodewords, version);
  const base = buildBaseMatrix(version, codewords);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const modules = base.modules.slice();
    for (let y = 0; y < base.size; y++) {
      for (let x = 0; x < base.size; x++) {
        if (base.reserved[y * base.size + x]) continue;
        if (maskBit(mask, x, y)) modules[y * base.size + x] ^= 1;
      }
    }
    drawFormat(modules, base.reserved, base.size, mask);
    const score = penaltyScore(modules, base.size);
    if (score < bestScore) {
      bestScore = score;
      best = { version, size: base.size, modules };
    }
  }
  return best;
}

/**
 * Is the active locale UTF-8?
 *
 * The QR art is made of `▀▄█`, so it is only drawn when the terminal can be
 * expected to render them. POSIX precedence is honoured: the first set of
 * `LC_ALL`, `LC_CTYPE`, `LANG` wins (their values override each other), and an
 * unset locale means the `C` default, which is not UTF-8.
 */
export function isUtf8Locale(env = process.env) {
  const chosen = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (!chosen) return false;
  return /utf-?8/i.test(chosen);
}

/** Width assumed when neither the TTY nor `COLUMNS` declares one. */
export const FALLBACK_COLUMNS = 80;

/**
 * How many columns the terminal gives us: the live TTY width, then `COLUMNS`.
 *
 * `process.stdout.columns` is `undefined` for pipes and files (where `pair` is
 * normally pasted from a script or CI), so `COLUMNS` is the only way to declare
 * a width there. Neither one is trusted blindly: a non-positive or unparsable
 * value falls through to the `FALLBACK_COLUMNS` default.
 */
export function terminalColumns({ stream = process.stdout, env = process.env } = {}) {
  const live = stream?.columns;
  if (Number.isInteger(live) && live > 0) return live;
  const declared = Number.parseInt(String(env.COLUMNS ?? ''), 10);
  if (Number.isInteger(declared) && declared > 0) return declared;
  return FALLBACK_COLUMNS;
}

/**
 * Render a QR as terminal art, shrunk to fit `columns`.
 *
 * One character is one module column, so the drawn code is exactly
 * `size + 2 * quietModules` columns wide: a wrapped line is an unscannable
 * code, never a wide one. The ladder is 2 quiet modules (the spec's margin,
 * 4 modules, is halved because the terminal art uses one character per
 * module), then 1, then 0. If even the bare matrix does not fit, no art is
 * drawn at all and the payload is printed as text — the same honest fallback
 * as a non-UTF-8 locale.
 *
 * Returns `{ art, note }`: `art` is what to print, `note` is a single line
 * explaining a shrink (or `null` when the preferred layout fits).
 */
export function renderQrBlock(
  text,
  {
    isTTY = Boolean(process.stdout.isTTY),
    quietModules = 2,
    utf8 = isUtf8Locale(),
    columns = terminalColumns(),
  } = {},
) {
  if (!utf8) {
    return {
      art: [
        'QR art needs a UTF-8 locale (LC_ALL/LC_CTYPE/LANG) — printing the payload as text:',
        text,
      ].join('\n'),
      note: null,
    };
  }

  const { size, modules } = encodeQr(text);

  let quiet = null;
  for (let candidate = quietModules; candidate >= 0; candidate--) {
    if (size + candidate * 2 <= columns) {
      quiet = candidate;
      break;
    }
  }

  if (quiet === null) {
    return {
      art: [
        `Terminal too narrow for the QR: the ${size}-module code needs ${size} columns and this one has ${columns} — printing the payload as text instead:`,
        text,
      ].join('\n'),
      note: null,
    };
  }

  const total = size + quiet * 2;
  const isDark = (x, y) => {
    const mx = x - quiet;
    const my = y - quiet;
    if (mx < 0 || my < 0 || mx >= size || my >= size) return false;
    return modules[my * size + mx] === 1;
  };

  const lines = [];
  for (let y = 0; y < total; y += 2) {
    let line = '';
    for (let x = 0; x < total; x++) {
      const top = isDark(x, y);
      const bottom = y + 1 < total && isDark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }

  const art = isTTY
    ? lines.map((line) => `\x1b[30;47m${line}\x1b[0m`).join('\n')
    : lines.join('\n');

  const note =
    quiet === quietModules
      ? null
      : `QR shrunk to fit ${columns} columns: quiet zone ${quietModules} → ${quiet}, art ${total} columns wide.`;

  return { art, note };
}

/**
 * Render a QR as terminal art (half blocks, quiet zone shrunk to fit).
 *
 * On a TTY the field is painted white (`30;47`) so black modules read as black
 * on both dark and light terminal themes. Off a TTY the same art is emitted
 * without escapes (files, tests, logs). Outside a UTF-8 locale the art would be
 * mojibake, so the payload is printed as plain text instead (`utf8: false`).
 * `renderQrBlock` is the same render plus the one-line shrink note.
 */
export function renderTerminalQr(text, options = {}) {
  return renderQrBlock(text, options).art;
}
