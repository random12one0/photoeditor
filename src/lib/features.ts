/**
 * Local feature matching — finding the same physical thing in two photographs.
 *
 * Every other measure in this codebase is *global*: it reduces a photo to a
 * handful of numbers and compares the summaries. That works until two different
 * subjects happen to summarise alike, and then it fails with confidence and
 * there is nothing more to ask it. A wheel photographed on grass and a car boot
 * photographed with the hatch open share a colour palette, a rough brightness
 * layout and a similar amount of edge — and no global descriptor separated them
 * reliably.
 *
 * This asks a different question, and it is the one a person actually answers
 * when they look at two photos: *are the same specific things in both, arranged
 * the same way?* Not "is this the same sort of picture" but "here is the wheel
 * nut, and there it is again, and the tread block above it is still above it".
 *
 * It works in three stages, which is the classical recipe:
 *
 *   1. **Find distinctive spots.** Corners — places where the image changes in
 *      two directions at once, so their position is unambiguous. A patch of sky
 *      or flat carpet has none; a wheel has hundreds.
 *   2. **Describe each one** by the pattern of brightness comparisons around it,
 *      rotated to the spot's own dominant direction so that tilting the camera
 *      doesn't change the description. 256 yes/no comparisons, one bit each.
 *   3. **Insist the matches agree with each other.** Individually, a few dozen
 *      spots will match by chance. The test is whether one single movement of
 *      the camera — a shift, a rotation, a step closer — explains them all at
 *      once. Random matches never agree on one story; real ones do.
 *
 * The last stage is what makes this different in kind rather than degree. It
 * doesn't produce a similarity, it produces evidence: "forty-one points agree
 * on the same camera movement" is not a score that can drift, it is a fact
 * about the two photographs.
 *
 * This is ORB (Rublee et al. 2011) — FAST corners, oriented BRIEF descriptors —
 * with RANSAC geometric verification. It is deliberately not machine learning:
 * no model to download, no cost, nothing to go stale, and every step can be
 * inspected when it gets something wrong.
 *
 * Known limitation, worth stating rather than discovering: dirt is texture. A
 * filthy panel has corners that a clean one does not, so the very act of
 * cleaning destroys some of what is being matched. This is strongest on shots
 * where the subject is mostly one dirty surface, and weakest — meaning best —
 * on wheels, trims and interiors, which keep their hard structure throughout.
 * That is the opposite bias to the global descriptors, which is exactly why
 * both are kept.
 */

/** Long edge the detector runs at. Bigger finds more corners and costs more. */
export const FEATURE_EDGE = 900

/**
 * Scale pyramid. Each level is 1.4x smaller than the one above.
 *
 * Without this the whole thing is only half built, and the first measurement
 * showed it: true pairs agreed on only seven or eight points where they should
 * agree on dozens. The reason is that a descriptor is a fixed-size patch. Step
 * two feet closer between the before and the after — which everybody does — and
 * the same wheel nut now fills twice as many pixels, so its patch contains
 * something else entirely and the descriptors no longer match. Geometry can
 * tolerate the zoom afterwards, but only if the descriptors survive to reach it.
 *
 * Describing every corner at four sizes means the far shot's level 0 can match
 * the near shot's level 2. Four levels covers a 2.7x range of subject size,
 * which is more than the difference between standing back and stepping in.
 */
const PYRAMID_LEVELS = 4
const PYRAMID_FACTOR = 1.4

/** Descriptor length in bits, and the bytes that takes. */
const DESC_BITS = 256
const DESC_BYTES = DESC_BITS / 8

/**
 * How many corners to keep per pyramid level.
 *
 * Four levels at 140 is around 500 descriptors per photo, which keeps a
 * brute-force match to a quarter of a million comparisons — a few milliseconds.
 * Going higher measurably improved nothing and multiplies the matching cost by
 * the square.
 */
const MAX_KEYPOINTS = 140

/** Radius of the patch a descriptor is built from. */
const PATCH_RADIUS = 15

/** How much brighter or darker a ring pixel must be to count as differing. */
const FAST_THRESHOLD = 18

/** Contiguous differing pixels needed around the ring for a corner. FAST-9. */
const FAST_ARC = 9

export interface PhotoFeatures {
  /**
   * Keypoint positions, interleaved x,y, as fractions of the frame.
   *
   * Fractions rather than pixels because keypoints come from several pyramid
   * levels at different resolutions, and because two photos decoded at
   * different sizes still have to compare.
   */
  points: Float32Array
  /** One DESC_BYTES descriptor per keypoint, packed end to end. */
  descriptors: Uint8Array
}

/* The Bresenham circle of radius 3, in order around the ring. */
const CIRCLE_X = [0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3, -3, -3, -2, -1]
const CIRCLE_Y = [-3, -3, -2, -1, 0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3]

/** Deterministic RNG, so the descriptor pattern is identical everywhere. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * The BRIEF sampling pattern: 256 pairs of offsets inside the patch.
 *
 * Gaussian-distributed around the centre, as in the original — pairs near the
 * middle carry more information than pairs out at the corners, and clamping a
 * normal distribution is a cheap way to get that bias.
 */
const PATTERN = (() => {
  const rand = rng(0x5eed1234)
  const out = new Int8Array(DESC_BITS * 4)
  const gauss = () => {
    // Box-Muller, scaled so most samples land inside the patch.
    const u = Math.max(1e-9, rand())
    const v = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * (PATCH_RADIUS / 2.4)
  }
  const clamp = (v: number) => Math.max(-PATCH_RADIUS, Math.min(PATCH_RADIUS, Math.round(v)))
  for (let i = 0; i < DESC_BITS; i++) {
    out[i * 4] = clamp(gauss())
    out[i * 4 + 1] = clamp(gauss())
    out[i * 4 + 2] = clamp(gauss())
    out[i * 4 + 3] = clamp(gauss())
  }
  return out
})()

function toGray(img: ImageData): Float32Array {
  const { data } = img
  const out = new Float32Array(img.width * img.height)
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722
  }
  return out
}

/** Box blur, to take the edge off sensor noise before comparing pixels. */
function smooth(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      tmp[i] = (src[i - 1] + src[i] + src[i + 1]) / 3
    }
    tmp[y * w] = src[y * w]
    tmp[y * w + w - 1] = src[y * w + w - 1]
  }
  for (let x = 0; x < w; x++) {
    for (let y = 1; y < h - 1; y++) {
      const i = y * w + x
      out[i] = (tmp[i - w] + tmp[i] + tmp[i + w]) / 3
    }
    out[x] = tmp[x]
    out[(h - 1) * w + x] = tmp[(h - 1) * w + x]
  }
  return out
}

interface Corner {
  x: number
  y: number
  score: number
}

/**
 * FAST-9 corner detection.
 *
 * A pixel is a corner when at least nine consecutive pixels on a circle of
 * radius three around it are all clearly brighter, or all clearly darker, than
 * it is. That is a cheap test that fires on exactly the places whose position is
 * unambiguous — the corner of a wheel nut, the end of a tread block — and stays
 * quiet on flat paint and open sky.
 */
function detectCorners(gray: Float32Array, w: number, h: number): Corner[] {
  const corners: Corner[] = []
  const border = PATCH_RADIUS + 4

  for (let y = border; y < h - border; y++) {
    for (let x = border; x < w - border; x++) {
      const i = y * w + x
      const c = gray[i]
      const hi = c + FAST_THRESHOLD
      const lo = c - FAST_THRESHOLD

      /* Cheap rejection first: of the four compass points, at least three must
         already be on the same side. Almost every pixel dies here, and the ring
         test below is comparatively expensive. */
      const n = gray[i - 3 * w]
      const s = gray[i + 3 * w]
      const e = gray[i + 3]
      const west = gray[i - 3]
      const brighter = (n > hi ? 1 : 0) + (s > hi ? 1 : 0) + (e > hi ? 1 : 0) + (west > hi ? 1 : 0)
      const darker = (n < lo ? 1 : 0) + (s < lo ? 1 : 0) + (e < lo ? 1 : 0) + (west < lo ? 1 : 0)
      if (brighter < 3 && darker < 3) continue

      // Walk the ring twice so an arc wrapping past the start still counts.
      let runBright = 0
      let runDark = 0
      let bestBright = 0
      let bestDark = 0
      for (let k = 0; k < 32; k++) {
        const v = gray[i + CIRCLE_Y[k & 15] * w + CIRCLE_X[k & 15]]
        if (v > hi) {
          runBright++
          runDark = 0
          if (runBright > bestBright) bestBright = runBright
        } else if (v < lo) {
          runDark++
          runBright = 0
          if (runDark > bestDark) bestDark = runDark
        } else {
          runBright = 0
          runDark = 0
        }
      }
      if (bestBright < FAST_ARC && bestDark < FAST_ARC) continue

      // Strength: how much the ring differs from the centre overall.
      let score = 0
      for (let k = 0; k < 16; k++) {
        score += Math.abs(gray[i + CIRCLE_Y[k] * w + CIRCLE_X[k]] - c)
      }
      corners.push({ x, y, score })
    }
  }
  return corners
}

/**
 * Keep the strongest corners, but spread across the frame.
 *
 * Taking the global top few hundred puts every keypoint on whatever object
 * happens to have the harshest contrast — a chrome badge, a bright reflection —
 * and leaves the rest of the photograph undescribed. Bucketing by position and
 * taking the best few from each cell keeps the coverage that geometric
 * verification depends on: matches spread over the frame pin down a camera
 * movement, matches huddled in one corner do not.
 */
function selectSpread(corners: Corner[], w: number, h: number): Corner[] {
  const COLS = 8
  const ROWS = 6
  const perCell = Math.ceil(MAX_KEYPOINTS / (COLS * ROWS))
  const cells = new Map<number, Corner[]>()

  for (const c of corners) {
    const cx = Math.min(COLS - 1, Math.floor((c.x / w) * COLS))
    const cy = Math.min(ROWS - 1, Math.floor((c.y / h) * ROWS))
    const key = cy * COLS + cx
    const bucket = cells.get(key)
    if (bucket) bucket.push(c)
    else cells.set(key, [c])
  }

  const picked: Corner[] = []
  for (const bucket of cells.values()) {
    bucket.sort((a, b) => b.score - a.score)
    for (let i = 0; i < Math.min(perCell, bucket.length); i++) picked.push(bucket[i])
  }
  picked.sort((a, b) => b.score - a.score)
  return picked.slice(0, MAX_KEYPOINTS)
}

/**
 * Which way is "up" for this corner.
 *
 * The intensity centroid: the brightness-weighted centre of the patch. The
 * direction from the corner to that centre is stable for the same physical spot
 * however the camera is rolled, so describing the patch relative to it makes the
 * description rotation-invariant. Without this, tilting the phone thirty degrees
 * between the before and the after would change every descriptor.
 */
function orientation(gray: Float32Array, w: number, cx: number, cy: number): number {
  let m01 = 0
  let m10 = 0
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    const row = (cy + dy) * w + cx
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      if (dx * dx + dy * dy > PATCH_RADIUS * PATCH_RADIUS) continue
      const v = gray[row + dx]
      m01 += dy * v
      m10 += dx * v
    }
  }
  return Math.atan2(m01, m10)
}

/** Bilinear downsample to an arbitrary smaller size. */
function resample(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh)
  const xr = sw / dw
  const yr = sh / dh
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1.001, (y + 0.5) * yr - 0.5)
    const y0 = Math.max(0, Math.floor(sy))
    const fy = sy - y0
    const y1 = Math.min(sh - 1, y0 + 1)
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1.001, (x + 0.5) * xr - 0.5)
      const x0 = Math.max(0, Math.floor(sx))
      const fx = sx - x0
      const x1 = Math.min(sw - 1, x0 + 1)
      const a = src[y0 * sw + x0]
      const b = src[y0 * sw + x1]
      const c = src[y1 * sw + x0]
      const d = src[y1 * sw + x1]
      out[y * dw + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
    }
  }
  return out
}

/**
 * Extract keypoints and descriptors from one image, across the scale pyramid.
 *
 * Positions come back as fractions of the frame, so a keypoint found on the
 * quarter-size level sits in the same coordinate system as one found at full
 * size — and a photograph decoded at any resolution compares with any other.
 */
export function detectAndDescribe(img: ImageData): PhotoFeatures {
  const w0 = img.width
  const h0 = img.height
  const full = smooth(toGray(img), w0, h0)

  const allPoints: number[] = []
  const chunks: Uint8Array[] = []
  let total = 0

  for (let level = 0; level < PYRAMID_LEVELS; level++) {
    const factor = PYRAMID_FACTOR ** level
    const w = Math.round(w0 / factor)
    const h = Math.round(h0 / factor)
    // Below this there is no room for a patch, let alone a useful one.
    if (w < PATCH_RADIUS * 4 || h < PATCH_RADIUS * 4) break

    const gray = level === 0 ? full : resample(full, w0, h0, w, h)
    const corners = selectSpread(detectCorners(gray, w, h), w, h)
    const n = corners.length
    if (n === 0) continue

    const descriptors = new Uint8Array(n * DESC_BYTES)
    for (let k = 0; k < n; k++) {
      const { x, y } = corners[k]
      allPoints.push(x / w, y / h)

      const angle = orientation(gray, w, x, y)
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const base = k * DESC_BYTES

      for (let b = 0; b < DESC_BITS; b++) {
        const p = b * 4
        // Steer the sample pair by the keypoint's own orientation.
        const ax = Math.round(PATTERN[p] * cos - PATTERN[p + 1] * sin)
        const ay = Math.round(PATTERN[p] * sin + PATTERN[p + 1] * cos)
        const bx = Math.round(PATTERN[p + 2] * cos - PATTERN[p + 3] * sin)
        const by = Math.round(PATTERN[p + 3] * cos + PATTERN[p + 2] * sin)

        const va = gray[(y + ay) * w + (x + ax)]
        const vb = gray[(y + by) * w + (x + bx)]
        if (va < vb) descriptors[base + (b >> 3)] |= 1 << (b & 7)
      }
    }
    chunks.push(descriptors)
    total += n
  }

  const descriptors = new Uint8Array(total * DESC_BYTES)
  let offset = 0
  for (const chunk of chunks) {
    descriptors.set(chunk, offset)
    offset += chunk.length
  }

  return { points: Float32Array.from(allPoints), descriptors }
}

const POPCOUNT = new Uint8Array(256)
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1]

function hammingAt(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
  let d = 0
  const ao = ai * DESC_BYTES
  const bo = bi * DESC_BYTES
  for (let i = 0; i < DESC_BYTES; i++) d += POPCOUNT[a[ao + i] ^ b[bo + i]]
  return d
}

export interface MatchResult {
  /** Points that agree on one single camera movement. The evidence. */
  inliers: number
  /** Candidate correspondences before geometry was considered. */
  candidates: number
  /** 0-1, the inlier count mapped onto a score the rest of the app can use. */
  score: number
}

/**
 * Match two feature sets, and keep only what a single camera movement explains.
 *
 * The ratio test comes first: a correspondence is only worth considering if the
 * best match is clearly better than the second best. A tread block looks like
 * every other tread block, so its nearest neighbour means nothing — that
 * ambiguity is precisely what the ratio catches and discards.
 *
 * Then RANSAC. Two correspondences define a shift, a rotation and a zoom; try
 * many random pairs, and keep whichever guess the most other correspondences
 * agree with. Real matches agree because there really was one camera and it
 * really did move once. Coincidental matches point in every direction and never
 * accumulate.
 */
export function matchFeatures(a: PhotoFeatures, b: PhotoFeatures): MatchResult {
  const na = a.points.length / 2
  const nb = b.points.length / 2
  if (na < 8 || nb < 8) return { inliers: 0, candidates: 0, score: 0 }

  /* Nearest and second-nearest, with Lowe's ratio test. 0.8 is the usual
     value and is deliberately permissive here: geometry does the real
     filtering afterwards, so letting a few doubtful pairs through costs
     little and dropping a good one costs a lot. */
  const RATIO = 0.8
  const pairs: number[] = []
  for (let i = 0; i < na; i++) {
    let best = 999
    let second = 999
    let bestJ = -1
    for (let j = 0; j < nb; j++) {
      const d = hammingAt(a.descriptors, i, b.descriptors, j)
      if (d < best) {
        second = best
        best = d
        bestJ = j
      } else if (d < second) {
        second = d
      }
    }
    if (bestJ >= 0 && best < RATIO * second) pairs.push(i, bestJ)
  }

  const candidates = pairs.length / 2
  if (candidates < 4) return { inliers: 0, candidates, score: 0 }

  /* Positions are already fractions of the frame, from every pyramid level. */
  const ax = (i: number) => a.points[i * 2]
  const ay = (i: number) => a.points[i * 2 + 1]
  const bx = (j: number) => b.points[j * 2]
  const by = (j: number) => b.points[j * 2 + 1]

  const TOL = 0.045
  const ITERATIONS = 400
  const rand = rng(0xc0ffee)
  let bestInliers = 0

  for (let it = 0; it < ITERATIONS; it++) {
    const p = Math.floor(rand() * candidates)
    let q = Math.floor(rand() * candidates)
    if (q === p) q = (q + 1) % candidates

    const i1 = pairs[p * 2]
    const j1 = pairs[p * 2 + 1]
    const i2 = pairs[q * 2]
    const j2 = pairs[q * 2 + 1]

    const dpx = ax(i2) - ax(i1)
    const dpy = ay(i2) - ay(i1)
    const dqx = bx(j2) - bx(j1)
    const dqy = by(j2) - by(j1)
    const lp = Math.hypot(dpx, dpy)
    const lq = Math.hypot(dqx, dqy)
    // Two points on top of each other define nothing.
    if (lp < 0.05 || lq < 0.05) continue

    const scale = lq / lp
    // A before and an after are not shot from wildly different distances.
    if (scale < 0.55 || scale > 1.8) continue

    const theta = Math.atan2(dqy, dqx) - Math.atan2(dpy, dpx)
    const cos = Math.cos(theta) * scale
    const sin = Math.sin(theta) * scale
    const tx = bx(j1) - (cos * ax(i1) - sin * ay(i1))
    const ty = by(j1) - (sin * ax(i1) + cos * ay(i1))

    let inliers = 0
    for (let k = 0; k < candidates; k++) {
      const i = pairs[k * 2]
      const j = pairs[k * 2 + 1]
      const px = cos * ax(i) - sin * ay(i) + tx
      const py = sin * ax(i) + cos * ay(i) + ty
      if (Math.hypot(px - bx(j), py - by(j)) < TOL) inliers++
    }
    if (inliers > bestInliers) bestInliers = inliers
  }

  /* Two points always agree with themselves, so a "consensus" of two is no
     evidence at all. Only what those two brought with them counts. */
  const evidence = Math.max(0, bestInliers - 2)

  /* Saturating: the difference between 6 agreeing points and 20 is decisive,
     between 60 and 80 is not. Twelve puts the curve's knee where the real
     separation sits — see npm run test:diagnose:features. */
  return {
    inliers: bestInliers,
    candidates,
    score: 1 - Math.exp(-evidence / 12),
  }
}
