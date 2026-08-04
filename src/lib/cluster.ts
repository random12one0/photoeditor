import type { ClusterSettings, Group, Pair, Photo } from '../types'
import { chromaDistance, ncc, similarity } from './hash'

/**
 * How photos get sorted into cars, and why it works this way.
 *
 * The obvious design — cluster into cars first, then look for before/after
 * pairs inside each car — was built, measured, and abandoned. Grouping is the
 * weak signal: every car is shot in the same bay from the same handful of
 * angles, so two different cars look far more alike than two angles of the same
 * car do. Cluster on that and the whole day fuses into one blob (measured: six
 * cars collapsing into a single group).
 *
 * Pairing is the strong signal. A before and an after of the same shot are the
 * same framing of the same scene, and normalised cross-correlation identifies
 * that with near-perfect precision (measured: 100% across most fixtures).
 *
 * So the order is inverted. Pairs are found first, across the entire roll, and
 * then they decide the grouping:
 *
 *   1. Cut the roll into sessions on time gaps.
 *   2. Match before/after pairs globally, using cross-correlation for framing,
 *      chromaticity to tell one car's paint from another's, and the clock to
 *      break ties.
 *   3. Join any two sessions that a pair bridges. A car's before batch and its
 *      after batch are joined by the shots that appear in both.
 *
 * Pair selection uses mutual-best matching plus a ratio test: a pair is only
 * accepted if each shot is the other's best candidate AND that candidate is
 * clearly better than the runner-up. When a shop details six silver cars in the
 * same bay, every candidate is ambiguous, the ratio test refuses them all, and
 * the app falls back to plain time segmentation and asks for manual pairing —
 * which is the honest answer, because nothing in those pixels distinguishes
 * those cars.
 */

/**
 * Thresholds come from measured distributions (test/diagnose.mjs), not taste:
 *
 *   same shot, before vs after      ncc 0.75 - 0.98,  chroma up to 0.22
 *   same car, a different angle     ncc up to 0.51
 *   different car, different angle  ncc up to 0.54
 *
 * An ncc gate in 0.55-0.70 cleanly separates "same framing" from "different
 * framing" with headroom on both sides, even with handheld drift.
 */
export const DEFAULT_CLUSTER_SETTINGS: ClusterSettings = {
  timeGapMinutes: 20,
  nccThreshold: 0.65,
  pairNccThreshold: 0.6,
  chromaThreshold: 0.28,
}

/**
 * A car arrives and leaves the same day. Nothing further apart than this is
 * ever considered a pair, however alike it looks.
 */
const MAX_PAIR_HOURS = 10

/**
 * How much better the best candidate must be than the runner-up before a pair
 * is accepted. This is what stops a row of identical silver cars being paired
 * with each other at random.
 */
const RATIO_TEST = 1.06

let groupCounter = 0
let pairCounter = 0
const nextGroupId = () => `g${Date.now().toString(36)}_${(groupCounter++).toString(36)}`
const nextPairId = () => `pair${Date.now().toString(36)}_${(pairCounter++).toString(36)}`

/** Step 1: cut the roll into sessions on time gaps. */
function segmentByTime(photos: Photo[], gapMinutes: number): Photo[][] {
  if (photos.length === 0) return []
  const gapMs = gapMinutes * 60_000

  const sessions: Photo[][] = [[photos[0]]]
  for (let i = 1; i < photos.length; i++) {
    if (photos[i].takenAt - photos[i - 1].takenAt > gapMs) sessions.push([photos[i]])
    else sessions[sessions.length - 1].push(photos[i])
  }
  return sessions
}

/**
 * Prefer the nearer-in-time candidate when two score alike.
 *
 * A car's own after shots are an hour or two away; the next car's are half a
 * day. When the pixels can't separate them, the clock can.
 */
function timeWeight(gapMs: number): number {
  return 1 / (1 + Math.abs(gapMs) / 3_600_000 / 3)
}

interface Candidate {
  ai: number
  bi: number
  /** Ranking score: similarity bent by the clock. Used to choose pairs. */
  score: number
  /** Raw visual similarity, untouched by time. This is what the user sees. */
  raw: number
}

/**
 * Step 2: every plausible before/after match in the roll, scored.
 *
 * O(n²), but n is one day's shooting — 150 photos is 11k comparisons of two
 * 256-value dot products, a few milliseconds in total.
 */
function pairCandidates(photos: Photo[], settings: ClusterSettings): Candidate[] {
  const maxGap = MAX_PAIR_HOURS * 3_600_000
  const out: Candidate[] = []

  /**
   * A before and an after are separated by the actual work — they are never two
   * frames from the same burst. Without this, two angles shot ten seconds apart
   * that happen to look alike get proposed as a before/after pair, which is both
   * wrong and confusing to review. Requiring the two shots to come from
   * different bursts rules that out using the gap the user already controls.
   *
   * Skipped when the whole roll is one burst — photos with no usable timestamps
   * at all would otherwise yield no suggestions whatsoever.
   */
  const sessions = segmentByTime(photos, settings.timeGapMinutes)
  const sessionOf = new Map<string, number>()
  sessions.forEach((s, i) => s.forEach((p) => sessionOf.set(p.id, i)))
  const enforceSeparateBursts = sessions.length > 1

  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const a = photos[i]
      const b = photos[j]
      const gap = Math.abs(a.takenAt - b.takenAt)
      if (gap > maxGap) continue
      if (enforceSeparateBursts && sessionOf.get(a.id) === sessionOf.get(b.id)) continue
      if (ncc(a.lumaGrid, b.lumaGrid) < settings.pairNccThreshold) continue
      if (chromaDistance(a.chromaSig, b.chromaSig) > settings.chromaThreshold) continue

      const raw = similarity(a, b)
      // Rank by a time-bent score so the nearer candidate wins a close call,
      // but report the raw similarity — a perfect match shown as "60%" because
      // the shots were two hours apart is just confusing.
      out.push({ ai: i, bi: j, score: raw * timeWeight(gap), raw })
    }
  }
  return out
}

/**
 * Mutual-best matching with a ratio test.
 *
 * Both halves matter. Mutual-best stops one photo being claimed by several
 * partners; the ratio test stops a pair being accepted when the runner-up was
 * nearly as good — exactly the situation when several near-identical cars pass
 * through the same bay.
 */
function selectPairs(photos: Photo[], candidates: Candidate[]): Candidate[] {
  const best = new Array<number>(photos.length).fill(-1)
  const bestScore = new Array<number>(photos.length).fill(-Infinity)
  const secondScore = new Array<number>(photos.length).fill(-Infinity)

  const consider = (self: number, other: number, score: number) => {
    if (score > bestScore[self]) {
      secondScore[self] = bestScore[self]
      bestScore[self] = score
      best[self] = other
    } else if (score > secondScore[self]) {
      secondScore[self] = score
    }
  }

  for (const c of candidates) {
    consider(c.ai, c.bi, c.score)
    consider(c.bi, c.ai, c.score)
  }

  const unambiguous = (i: number) =>
    secondScore[i] === -Infinity || bestScore[i] >= secondScore[i] * RATIO_TEST

  return candidates.filter(
    (c) =>
      best[c.ai] === c.bi &&
      best[c.bi] === c.ai &&
      unambiguous(c.ai) &&
      unambiguous(c.bi),
  )
}

function toPair(a: Photo, b: Photo, score: number): Pair {
  // Earlier photo is the "before". Timestamps are trustworthy here; only when
  // they're identical do we fall back to "the dirtier one is darker".
  let before = a
  let after = b
  if (a.takenAt === b.takenAt) {
    if (a.luma > b.luma) {
      before = b
      after = a
    }
  } else if (a.takenAt > b.takenAt) {
    before = b
    after = a
  }

  return {
    id: nextPairId(),
    beforeId: before.id,
    afterId: after.id,
    confidence: Math.max(0, Math.min(1, score)),
    confirmed: false,
  }
}

/**
 * Before/after pairs within a set of photos. Used directly when the user
 * merges, splits or moves photos by hand and the suggestions need redoing.
 */
export function findPairs(photos: Photo[], settings: ClusterSettings): Pair[] {
  const ordered = [...photos].sort((a, b) => a.takenAt - b.takenAt)
  const accepted = selectPairs(ordered, pairCandidates(ordered, settings))
  return accepted.map((c) => toPair(ordered[c.ai], ordered[c.bi], c.raw))
}

class UnionFind {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(a: number): number {
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a]]
      a = this.parent[a]
    }
    return a
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[rb] = ra
  }
}

function labelFor(photos: Photo[], index: number): string {
  const d = new Date(photos[0].takenAt)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Car ${index + 1} — ${date}, ${time}`
}

/**
 * Step 3: turn accepted pairs into cars.
 *
 * Two pairs belong to the same car when their before shots were taken close
 * together AND their after shots were too. Requiring both is what makes this
 * hold up in a busy shop: when the next car rolls in fifteen minutes after the
 * last one's after shots, a single time-gap segmentation puts one car's afters
 * and the next car's befores in the same session, and anything that merges
 * whole sessions then chains the entire day into one group. Comparing befores
 * to befores and afters to afters keeps them apart, because those batches are
 * an hour or more away from each other even when the sessions touch.
 */
function clusterPairs(
  ordered: Photo[],
  accepted: Candidate[],
  gapMs: number,
): Candidate[][] {
  const uf = new UnionFind(accepted.length)

  const times = accepted.map((c) => {
    const a = ordered[c.ai]
    const b = ordered[c.bi]
    return a.takenAt <= b.takenAt
      ? { before: a.takenAt, after: b.takenAt }
      : { before: b.takenAt, after: a.takenAt }
  })

  for (let i = 0; i < accepted.length; i++) {
    for (let j = i + 1; j < accepted.length; j++) {
      const closeBefore = Math.abs(times[i].before - times[j].before) <= gapMs
      const closeAfter = Math.abs(times[i].after - times[j].after) <= gapMs
      if (closeBefore && closeAfter) uf.union(i, j)
    }
  }

  const buckets = new Map<number, Candidate[]>()
  accepted.forEach((c, i) => {
    const root = uf.find(i)
    const bucket = buckets.get(root) ?? []
    bucket.push(c)
    buckets.set(root, bucket)
  })
  return [...buckets.values()]
}

/** Full pipeline: a loose camera roll in, grouped-and-paired cars out. */
export function buildGroups(photos: Photo[], settings: ClusterSettings): Group[] {
  if (photos.length === 0) return []

  const ordered = [...photos].sort((a, b) => a.takenAt - b.takenAt)
  const gapMs = settings.timeGapMinutes * 60_000

  const accepted = selectPairs(ordered, pairCandidates(ordered, settings))
  const pairClusters = clusterPairs(ordered, accepted, gapMs)

  // Each cluster of pairs is one car, seeded with the photos those pairs cover.
  interface Car {
    photos: Photo[]
    pairs: Pair[]
  }
  const cars: Car[] = pairClusters.map((cluster) => {
    const members = new Map<string, Photo>()
    const pairs: Pair[] = []
    for (const c of cluster) {
      const a = ordered[c.ai]
      const b = ordered[c.bi]
      members.set(a.id, a)
      members.set(b.id, b)
      pairs.push(toPair(a, b, c.raw))
    }
    return {
      photos: [...members.values()].sort((x, y) => x.takenAt - y.takenAt),
      pairs,
    }
  })

  // Everything the pairing didn't touch — extra angles, detail shots, jobs that
  // never got an after — joins whichever car it was shot alongside.
  const claimed = new Set(cars.flatMap((c) => c.photos.map((p) => p.id)))
  const leftovers = ordered.filter((p) => !claimed.has(p.id))
  const orphans: Photo[] = []

  for (const photo of leftovers) {
    let bestCar = -1
    let bestGap = Infinity
    cars.forEach((car, i) => {
      for (const member of car.photos) {
        const gap = Math.abs(member.takenAt - photo.takenAt)
        if (gap < bestGap) {
          bestGap = gap
          bestCar = i
        }
      }
    })

    if (bestCar >= 0 && bestGap <= gapMs) {
      cars[bestCar].photos.push(photo)
    } else {
      orphans.push(photo)
    }
  }

  // Photos that belong to no paired car at all still get grouped by time, so a
  // job that never got an after photo still lands in its own folder.
  for (const session of segmentByTime(orphans, settings.timeGapMinutes)) {
    cars.push({ photos: session, pairs: [] })
  }

  return cars
    .map((car) => ({
      ...car,
      photos: car.photos.sort((a, b) => a.takenAt - b.takenAt),
    }))
    .sort((a, b) => a.photos[0].takenAt - b.photos[0].takenAt)
    .map((car, i) => ({
      id: nextGroupId(),
      name: labelFor(car.photos, i),
      photoIds: car.photos.map((p) => p.id),
      pairs: car.pairs,
    }))
}
