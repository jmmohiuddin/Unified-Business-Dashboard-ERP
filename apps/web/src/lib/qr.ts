import "server-only";

/**
 * Minimal QR code generator → inline SVG.
 *
 * Written from scratch rather than pulling in a library for one reason: the
 * app's Content-Security-Policy forbids external images and inline data: URIs
 * for images, so a QR must be server-rendered SVG that ships inside the page.
 * A dependency that emits a PNG data-URI would be blocked at render time.
 *
 * Supports byte mode at error-correction level M, which is all an otpauth://
 * URI needs. Not a general-purpose encoder — deliberately scoped to the one job.
 */

// ── Galois field arithmetic for Reed–Solomon ────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j]!, EXP[i]!);
      next[j + 1] ^= poly[j]!;
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i]!, factor);
  }
  return res;
}

/**
 * Version/EC tables for the handful of sizes an otpauth URI reaches.
 * [version, size, dataCodewords, ecCodewords] at error level M.
 */
const VERSIONS = [
  [2, 25, 28, 16],
  [3, 29, 44, 26],
  [4, 33, 64, 36],
  [5, 37, 86, 48],
  [6, 41, 108, 64],
  [7, 45, 124, 72],
  [8, 49, 154, 88],
  [9, 53, 182, 110],
  [10, 57, 216, 130],
] as const;

function pickVersion(byteLen: number) {
  // Byte-mode header: mode (4 bits) + length (8 or 16 bits). +2 bytes is safe.
  for (const v of VERSIONS) {
    if (byteLen + 2 <= v[2]) return v;
  }
  throw new Error("Payload too large for the supported QR versions.");
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const table: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  return table[version] ?? [];
}

/** Returns a grid of booleans (true = dark module). */
function buildMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const [version, size, dataCodewords, ecCodewords] = pickVersion(bytes.length);

  // ── Bit stream: byte mode ────────────────────────────────────────────────
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  push(0, 4); // terminator (truncated below if it overflows)

  // Pad to a byte boundary, then with the standard alternating bytes.
  while (bits.length % 8 !== 0) bits.push(0);
  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    dataBytes.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  const pad = [0xec, 0x11];
  let pi = 0;
  while (dataBytes.length < dataCodewords) dataBytes.push(pad[pi++ % 2]!);

  const ec = rsEncode(dataBytes, ecCodewords);
  const all = [...dataBytes, ...ec];

  // ── Place modules ─────────────────────────────────────────────────────────
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  const finder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing =
          dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        m[rr]![cc] = inRing;
        reserved[rr]![cc] = true;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6]![i]) { m[6]![i] = i % 2 === 0; reserved[6]![i] = true; }
    if (!reserved[i]![6]) { m[i]![6] = i % 2 === 0; reserved[i]![6] = true; }
  }

  // Alignment patterns.
  const aps = alignmentPositions(version);
  for (const ar of aps) {
    for (const ac of aps) {
      if (reserved[ar]?.[ac]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = ar + dr, cc = ac + dc;
          m[rr]![cc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          reserved[rr]![cc] = true;
        }
      }
    }
  }

  // Dark module + reserve format-info areas.
  m[size - 8]![8] = true;
  reserved[size - 8]![8] = true;
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { reserved[8]![i] = true; reserved[i]![8] = true; }
  }
  for (let i = size - 8; i < size; i++) { reserved[8]![i] = true; reserved[i]![8] = true; }

  // ── Zig-zag data placement with mask 0 ────────────────────────────────────
  let bitIndex = 0;
  const dataBits: number[] = [];
  for (const byte of all) for (let i = 7; i >= 0; i--) dataBits.push((byte >> i) & 1);

  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    const rows = upward ? [...Array(size).keys()].reverse() : [...Array(size).keys()];
    for (const row of rows) {
      for (const c of [col, col - 1]) {
        if (reserved[row]![c]) continue;
        let bit = dataBits[bitIndex++] ?? 0;
        if ((row + c) % 2 === 0) bit ^= 1; // mask pattern 0
        m[row]![c] = bit === 1;
      }
    }
    upward = !upward;
  }

  // Format info for EC level M, mask 0: precomputed 15-bit string.
  const format = "101010000010010";
  for (let i = 0; i <= 5; i++) m[8]![i] = format[i] === "1";
  m[8]![7] = format[6] === "1";
  m[8]![8] = format[7] === "1";
  m[7]![8] = format[8] === "1";
  for (let i = 9; i < 15; i++) m[14 - i]![8] = format[i] === "1";
  for (let i = 0; i < 8; i++) m[size - 1 - i]![8] = format[i] === "1";
  for (let i = 8; i < 15; i++) m[8]![size - 15 + i] = format[i] === "1";

  return m.map((row) => row.map((v) => v === true));
}

/** Render an otpauth URI as an inline SVG string, CSP-safe. */
export function qrSvg(text: string, pixelSize = 200): string {
  const matrix = buildMatrix(text);
  const n = matrix.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const scale = pixelSize / total;

  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r]![c]) {
        const x = ((c + quiet) * scale).toFixed(2);
        const y = ((r + quiet) * scale).toFixed(2);
        path += `M${x},${y}h${scale.toFixed(2)}v${scale.toFixed(2)}h-${scale.toFixed(2)}z`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" ` +
    `viewBox="0 0 ${pixelSize} ${pixelSize}" role="img" aria-label="Authenticator QR code">` +
    `<rect width="${pixelSize}" height="${pixelSize}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}
