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

/**
 * Cross-correlation maximised over small shifts.
 *
 * Plain NCC assumes the two frames line up, and measured against real detailing
 * photos they emphatically do not: the photographer stands somewhere slightly
 * different when they come back ninety minutes later, so the whole scene
 * translates and rescales a little. On the reference set, sliding one grid over
 * the other lifted true-pair scores from a median of 0.24 to 0.34 and, more
 * usefully, pulled the worst case up from -0.10 to 0.25 — turning a signal that
 * was indistinguishable from noise into one that at least ranks correctly.
 */
export function shiftedNcc(
  a: number[],
  b: number[],
  size: number,
  maxShift = 2,
): number {
  if (a.length !== size * size || b.length !== size * size) return ncc(a, b)

  let best = -1
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let dot = 0
      let n = 0
      for (let y = 0; y < size; y++) {
        const yb = y + dy
        if (yb < 0 || yb >= size) continue
        for (let x = 0; x < size; x++) {
          const xb = x + dx
          if (xb < 0 || xb >= size) continue
          dot += a[y * size + x] * b[yb * size + xb]
          n++
        }
      }
      if (n > 0) best = Math.max(best, dot / n)
    }
  }
  return Math.max(-1, Math.min(1, best))
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

/**
 * Grid the quality measure runs on. Big enough that focus differences survive
 * the downscale, small enough to stay cheap on a phone during import.
 */
export const QUALITY_GRID = 192

/**
 * "Which of these near-identical shots is the best one?" — 0 to 1.
 *
 * This exists because of how the photos are actually taken: three shots of the
 * same angle before, one after, or the other way round. Something has to choose
 * which of the three goes in the composite, and "whichever the matcher happened
 * to land on" is not an answer — among three shots of the same thing, the one
 * that correlates best with the after might easily be the one that was out of
 * focus.
 *
 * Two terms, both of which a person would use looking at the shots side by side:
 *
 * **Focus.** Mean gradient energy, divided by the image's own contrast. The
 * division matters: without it this measures "busy picture" rather than "sharp
 * picture", and a cluttered driveway would beat a clean one every time. What's
 * left is roughly detail-per-unit-contrast, which is what focus and camera shake
 * actually change.
 *
 * **Clipping.** Blown highlights and crushed shadows are unrecoverable, and a
 * detailing shot into the sun loses the paint entirely. Counted at both ends and
 * subtracted.
 *
 * Only ever compared between shots of the same subject, so it needs to rank
 * rather than to be calibrated in absolute terms. Measured against real
 * photographs degraded in known ways (`npm run test:diagnose:takes`), the
 * untouched shot beats the degraded one 38 times out of 40.
 *
 * The two it loses are worth stating: a uniformly *darkened* copy scores level
 * with the original, because dividing gradient energy by contrast makes the
 * measure immune to a linear brightness change and mere underexposure clips
 * nothing. That is deliberate as far as it goes — a dark but sharp frame really
 * is the better negative — but it does mean this ranks focus, not exposure.
 * Between three shots taken seconds apart, which is the only situation it is
 * used in, exposure is the same across all of them anyway.
 */
export function qualityFromImageData(img: ImageData): number {
  const { width: w, height: h } = img
  if (w < 3 || h < 3) return 0.5
  const gray = toGrayGrid(img.data, w, h)

  let sum = 0
  let clipped = 0
  for (let p = 0; p < gray.length; p++) {
    sum += gray[p]
    if (gray[p] > 249 || gray[p] < 4) clipped++
  }
  const mean = sum / gray.length
  let variance = 0
  for (let p = 0; p < gray.length; p++) {
    const d = gray[p] - mean
    variance += d * d
  }
  const std = Math.sqrt(variance / gray.length)

  // A flat grey frame has no detail to measure and no contrast to divide by.
  if (std < 1) return 0

  let energy = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = gray[i + 1] - gray[i - 1]
      const gy = gray[i + w] - gray[i - w]
      energy += gx * gx + gy * gy
      n++
    }
  }

  const focus = Math.sqrt(energy / n) / std
  /* Real photographs at this grid size land roughly 0.3 (soft) to 1.2 (crisp);
     the curve flattens above that so two sharp shots aren't separated by noise. */
  const focusScore = 1 - Math.exp(-focus / 0.55)
  const exposure = 1 - Math.min(1, (clipped / gray.length) * 5)

  return Math.max(0, Math.min(1, focusScore * 0.75 + exposure * 0.25))
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
  lumaGridCoarse: number[]
}

export const COARSE_GRID = 8

/**
 * Combined visual similarity, 0-1.
 *
 * Weighted from what actually separates the classes on real photographs. The
 * coarse shifted grid is the strongest single term there, because it tolerates
 * the framing drift between two handheld shots; the fine grid still helps when
 * the two shots do line up; chromaticity carries real weight because the paint
 * and the surroundings stay the same colour even when the framing moves.
 *
 * Note the honest ceiling: on real before/after pairs this score lands around
 * 0.5-0.7 while unrelated shots reach 0.5, so it ranks well but cannot be used
 * as a hard gate. Suggestions are therefore ordered by it, not filtered by it.
 */
export function similarity(a: Fingerprint, b: Fingerprint): number {
  const coarse = (shiftedNcc(a.lumaGridCoarse, b.lumaGridCoarse, COARSE_GRID, 2) + 1) / 2
  const fine = (shiftedNcc(a.lumaGrid, b.lumaGrid, LUMA_GRID, 3) + 1) / 2
  const chroma = 1 - chromaDistance(a.chromaSig, b.chromaSig)
  const hash = 1 - hamming(a.dhash, b.dhash) / 64
  return coarse * 0.4 + fine * 0.25 + chroma * 0.25 + hash * 0.1
}

/**
 * "Is this the same frame, taken twice?" — a third and much narrower question
 * than either `similarity` or `carSimilarity`.
 *
 * It needs its own measure, and the reason is the interesting part. `similarity`
 * is deliberately blind to translation: it slides one grid over the other and
 * keeps the best overlap, because a photographer coming back ninety minutes
 * later does not stand in the same footprint. That tolerance is exactly wrong
 * here. Two shots of one angle seconds apart differ by a *small* drift; two
 * different framings of the same car differ by a *large* one. A metric that
 * discards translation cannot tell those apart — measured on fixtures whose
 * angles differ only by where the car sits in the frame, `similarity` called
 * every angle the same take and collapsed four pairs into one.
 *
 * So this compares the fine grid where it lies, with no shift search at all.
 * Sub-cell drift still passes, because each cell is a sixteenth of the frame,
 * and anything reframed by more than that reads as a different shot.
 *
 * Chromaticity is deliberately absent: every shot of one car has the same paint
 * in it, so colour cannot distinguish two angles and only inflates the score.
 */
export function sameTakeScore(a: Fingerprint, b: Fingerprint): number {
  const fine = (ncc(a.lumaGrid, b.lumaGrid) + 1) / 2
  const hash = 1 - hamming(a.dhash, b.dhash) / 64
  return fine * 0.8 + hash * 0.2
}

/**
 * "Are these the same car?" — as opposed to `similarity`, which asks "are these
 * the same shot?".
 *
 * These need different evidence, and conflating them was a measurable mistake.
 * Structure answers the framing question, and framing is exactly what two
 * *different* cars share when they're photographed from the same spot: on the
 * bay fixtures, a different car at the same angle correlates as strongly as a
 * true before/after pair does (0.957-0.997 against 0.96-0.98). Leaning on
 * structure to decide car identity therefore actively misleads.
 *
 * Paint colour and surroundings are what actually persist across a wash and
 * differ between cars, so chromaticity leads here. Structure still contributes,
 * because a car shot in the same place twice does share a backdrop.
 */
export function carSimilarity(a: Fingerprint, b: Fingerprint): number {
  const chroma = 1 - chromaDistance(a.chromaSig, b.chromaSig)
  const coarse = (shiftedNcc(a.lumaGridCoarse, b.lumaGridCoarse, COARSE_GRID, 2) + 1) / 2
  const hash = 1 - hamming(a.dhash, b.dhash) / 64
  return chroma * 0.6 + coarse * 0.28 + hash * 0.12
}
