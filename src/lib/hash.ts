/**
 * Perceptual hashing. This is what lets us group photos of the same car and
 * spot before/after pairs without any AI or network calls.
 *
 * dHash works on relative brightness between neighbouring pixels, so it
 * survives the things that differ between a "before" and an "after" shot
 * (dirt, water spots, overall exposure) while staying sensitive to the things
 * that mean "different car" (composition, angle, background).
 */

const HASH_W = 9
const HASH_H = 8

/** Grayscale pixel data reduced to a fixed grid, for hashing. */
function toGrayGrid(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 709 luma
    out[p] = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722
  }
  return out
}

/**
 * Difference hash: compare each pixel to its right-hand neighbour on a 9x8
 * grid, yielding 64 bits.
 */
export function dhashFromImageData(img: ImageData): string {
  const gray = toGrayGrid(img.data, img.width, img.height)
  let bits = ''
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      bits += gray[y * HASH_W + x] < gray[y * HASH_W + x + 1] ? '1' : '0'
    }
  }
  // 64 bits -> 16 hex chars
  let hex = ''
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

/**
 * Contrast-normalised luminance grid — the workhorse structural descriptor.
 *
 * dHash alone is not enough here. It compares neighbouring pixels, which
 * survives a uniform brightness shift, but washing a car is not a uniform
 * shift: dirt lifts unevenly, paint starts reflecting, and enough neighbour
 * comparisons flip that a true before/after pair scores no better than two
 * unrelated shots. Measured on realistic fixtures, the two distributions
 * overlap almost completely.
 *
 * A normalised grid compared by cross-correlation holds up far better, because
 * subtracting the mean and dividing by the standard deviation makes the whole
 * comparison invariant to any linear change in brightness or contrast — which
 * is most of what cleaning a car does to the picture.
 */
export const LUMA_GRID = 16

export function lumaGridFromImageData(img: ImageData): number[] {
  const n = img.width * img.height
  const vals = new Float64Array(n)
  const d = img.data
  let sum = 0
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const v = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722
    vals[p] = v
    sum += v
  }

  const mean = sum / n
  let variance = 0
  for (let p = 0; p < n; p++) {
    const dv = vals[p] - mean
    variance += dv * dv
  }
  const std = Math.sqrt(variance / n) || 1

  // Two decimals is plenty of precision and keeps the saved session small.
  const out = new Array<number>(n)
  for (let p = 0; p < n; p++) {
    out[p] = Math.round(((vals[p] - mean) / std) * 100) / 100
  }
  return out
}

/**
 * Normalised cross-correlation of two luma grids: 1.0 is the same framing,
 * 0 is unrelated. Both inputs are already zero-mean and unit-variance, so this
 * is just their dot product over N.
 */
export function ncc(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return Math.max(-1, Math.min(1, dot / a.length))
}

const POPCOUNT = new Uint8Array(256)
for (let i = 0; i < 256; i++) {
  POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1]
}

/** Number of differing bits between two 16-char hex hashes. 0 = identical. */
export function hamming(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < 16; i++) {
    d += POPCOUNT[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xff]
  }
  return d
}

/**
 * Average RGB over a 4x4 grid — 48 numbers. A second, independent opinion on
 * similarity that catches cases where two different cars happen to share a
 * composition but not a colour.
 */
export function colorSignature(img: ImageData): number[] {
  const cells = 4
  const sig: number[] = new Array(cells * cells * 3).fill(0)
  const counts: number[] = new Array(cells * cells).fill(0)
  const { width: w, height: h, data } = img

  for (let y = 0; y < h; y++) {
    const cy = Math.min(cells - 1, Math.floor((y / h) * cells))
    for (let x = 0; x < w; x++) {
      const cx = Math.min(cells - 1, Math.floor((x / w) * cells))
      const cell = cy * cells + cx
      const p = (y * w + x) * 4
      sig[cell * 3] += data[p]
      sig[cell * 3 + 1] += data[p + 1]
      sig[cell * 3 + 2] += data[p + 2]
      counts[cell]++
    }
  }
  for (let c = 0; c < cells * cells; c++) {
    const n = counts[c] || 1
    sig[c * 3] /= n
    sig[c * 3 + 1] /= n
    sig[c * 3 + 2] /= n
  }
  return sig.map((v) => Math.round(v))
}

/**
 * Exposure-invariant colour signature: per-cell chromaticity, r/(r+g+b) and
 * g/(r+g+b), on a 4x4 grid.
 *
 * This is the one that separates cars. Raw RGB can't: a "before" shot is much
 * darker than its "after", so their raw colours diverge more than two different
 * cars' do. Chromaticity throws brightness away and keeps only the hue mix, so
 * a filthy red car and a gleaming red car still read as the same red — while a
 * blue car in the same bay, at the same angle, reads as clearly different.
 */
export function chromaSignature(img: ImageData): number[] {
  const cells = 4
  const sums = new Array(cells * cells * 3).fill(0)
  const counts = new Array(cells * cells).fill(0)
  const { width: w, height: h, data } = img

  for (let y = 0; y < h; y++) {
    const cy = Math.min(cells - 1, Math.floor((y / h) * cells))
    for (let x = 0; x < w; x++) {
      const cx = Math.min(cells - 1, Math.floor((x / w) * cells))
      const cell = cy * cells + cx
      const p = (y * w + x) * 4
      sums[cell * 3] += data[p]
      sums[cell * 3 + 1] += data[p + 1]
      sums[cell * 3 + 2] += data[p + 2]
      counts[cell]++
    }
  }

  const sig: number[] = []
  for (let c = 0; c < cells * cells; c++) {
    const n = counts[c] || 1
    const r = sums[c * 3] / n
    const g = sums[c * 3 + 1] / n
    const b = sums[c * 3 + 2] / n
    // Near-black cells have no meaningful hue; park them at neutral so noise
    // in the shadows doesn't drive the comparison.
    const total = r + g + b
    if (total < 24) {
      sig.push(85, 85)
    } else {
      sig.push(Math.round((r / total) * 255), Math.round((g / total) * 255))
    }
  }
  return sig
}

/** Normalised chroma distance, 0 (same colours) to 1 (completely different). */
export function chromaDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  // Chromaticity values cluster tightly around 85, so the useful range is small;
  // /24 spreads real differences across the 0-1 span.
  return Math.min(1, Math.sqrt(sum / a.length) / 24)
}

/** Normalised colour distance, 0 (identical) to 1 (maximally different). */
export function colorDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.min(1, Math.sqrt(sum / a.length) / 128)
}

export function meanLuma(img: ImageData): number {
  const d = img.data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) {
    sum += d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722
  }
  return sum / (d.length / 4)
}

/** The fields of a Photo that any similarity question needs. */
export interface Fingerprint {
  dhash: string
  chromaSig: number[]
  lumaGrid: number[]
}

/**
 * Combined similarity, 0-1 where 1 is "these are the same shot".
 *
 * Cross-correlation does the heavy lifting; chromaticity is the tie-breaker
 * that stops two different cars shot from the same spot in the same bay from
 * reading as a pair; dHash contributes a small amount of independent structural
 * evidence.
 */
export function similarity(a: Fingerprint, b: Fingerprint): number {
  const structure = (ncc(a.lumaGrid, b.lumaGrid) + 1) / 2
  const chroma = 1 - chromaDistance(a.chromaSig, b.chromaSig)
  const hash = 1 - hamming(a.dhash, b.dhash) / 64
  return structure * 0.6 + chroma * 0.28 + hash * 0.12
}
