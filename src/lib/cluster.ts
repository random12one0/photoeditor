import type { ClusterSettings, Group, Pair, Photo } from '../types'
import { COARSE_GRID, carSimilarity, similarity } from './hash'

/**
 * How photos get sorted into cars and paired up.
 *
 * This is the third design. The first two were built against drawn fixtures and
 * both fell over on real photographs; the measurements that killed them are in
 * test/diagnose-real.mjs and worth keeping in mind before changing anything
 * here.
 *
 * What was assumed, and what turned out to be true:
 *
 *   Assumed: a before and an after of the same shot are the same framing, so
 *   cross-correlation identifies pairs almost perfectly.
 *
 *   Actually: on real detailing photos, true pairs score between -0.10 and 0.43,
 *   while unrelated photos of different cars reach 0.27. The distributions
 *   overlap almost entirely. Nobody stands in exactly the same spot ninety
 *   minutes later, and the reshoot is often from a visibly different distance
 *   and angle.
 *
 * So visual similarity cannot decide anything on its own. What is reliable is
 * the clock, and the way people work:
 *
 *   1. Photos come in bursts — a walk around the car, a few minutes long.
 *   2. A car is a before burst and an after burst, separated by the job.
 *   3. People walk around a car the same way twice, so the Nth before shot and
 *      the Nth after shot are usually the same angle.
 *
 * Hence: two-level time segmentation for grouping, and pairing that combines
 * that walk-around order with whatever the visual signal is worth. Crucially,
 * suggestions are RANKED by confidence, never gated by a threshold — a gate
 * tuned on real data would either admit everything or reject everything.
 * The user confirms each one at a tap, and the ordering is what saves them time.
 */

export const DEFAULT_CLUSTER_SETTINGS: ClusterSettings = {
  /** A burst is one walk around the car. */
  burstGapMinutes: 20,
  /** Absolute ceiling on how far apart one car's two bursts can be. */
  carGapMinutes: 480,
  /** How much to trust walk-around order versus how the photos look. */
  orderWeight: 0.45,
}

let groupCounter = 0
let pairCounter = 0
const nextGroupId = () => `g${Date.now().toString(36)}_${(groupCounter++).toString(36)}`
const nextPairId = () => `pair${Date.now().toString(36)}_${(pairCounter++).toString(36)}`

/** Split a time-ordered list wherever the gap exceeds `gapMs`. */
function segmentByGap(photos: Photo[], gapMs: number): Photo[][] {
  if (photos.length === 0) return []
  const out: Photo[][] = [[photos[0]]]
  for (let i = 1; i < photos.length; i++) {
    if (photos[i].takenAt - photos[i - 1].takenAt > gapMs) out.push([photos[i]])
    else out[out.length - 1].push(photos[i])
  }
  return out
}

/**
 * Where one walk-around ends and the next begins.
 *
 * A fixed threshold breaks in both directions. Set it at twenty minutes and a
 * shop with a nineteen-minute turnaround has one car's after shots welded to
 * the next car's before shots — no amount of clever grouping downstream can
 * recover from bursts that are already wrong. Set it low and a photographer who
 * pauses to move a bin splits one walk-around in two.
 *
 * The gaps inside a burst are seconds to a couple of minutes, and every gap
 * that matters is far larger, so the roll's own median gap sets the scale.
 * Eight times that separates the two populations comfortably, and the user's
 * setting stays on as a ceiling.
 */
function burstThreshold(photos: Photo[], settings: ClusterSettings): number {
  const ceiling = settings.burstGapMinutes * 60_000
  if (photos.length < 3) return ceiling

  const gaps: number[] = []
  for (let i = 1; i < photos.length; i++) {
    gaps.push(photos[i].takenAt - photos[i - 1].takenAt)
  }
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]

  // Floor of three minutes so a rapid-fire burst doesn't shatter on a pause of
  // a few seconds.
  return Math.min(ceiling, Math.max(180_000, median * 8))
}

/**
 * Affinity between two bursts: how much they look like the same car.
 *
 * The best few cross-burst matches, averaged. Taking the mean over everything
 * would drown the signal — most shots in a burst are of different angles and
 * shouldn't match anything — while taking only the single best match is noisy.
 */
function burstAffinity(a: Photo[], b: Photo[]): number {
  const scores: number[] = []
  // carSimilarity, not similarity: this is the "same car?" question, and the
  // two are weighted differently on purpose.
  for (const pa of a) for (const pb of b) scores.push(carSimilarity(pa, pb))
  if (!scores.length) return 0
  scores.sort((x, y) => y - x)
  const k = Math.max(1, Math.min(3, Math.floor(scores.length / 3)))
  return scores.slice(0, k).reduce((x, y) => x + y, 0) / k
}

/**
 * Decide which bursts belong to the same car.
 *
 * Timestamps alone genuinely cannot answer this. Given bursts A B C D, whether
 * the cars are (A,B) and (C,D) or A and (B,C) and D depends on facts the clock
 * doesn't carry. A shop with a 25-minute turnaround and a 60-minute job has a
 * *shorter* pause between cars than inside one, and a mobile detailer driving
 * across town has the opposite. Any fixed rule gets one of those backwards —
 * both were measured doing exactly that.
 *
 * So the decision is made visually, but relative rather than absolute. On real
 * photos a car's own before/after score 0.57-0.70 against each other while
 * unrelated cars score 0.41-0.74: hopelessly overlapping as an absolute
 * threshold, yet within a single roll a car reliably resembles itself more than
 * it resembles the car before it. Comparing each adjacent pair against a
 * baseline taken from bursts that are definitely different cars turns that into
 * a usable signal, and it self-calibrates to each roll.
 *
 * The merges themselves are chosen by dynamic programming over the sequence, so
 * the result is the best consistent set of pairings rather than whatever a
 * left-to-right greedy pass happened to grab first.
 */
function groupBursts(bursts: Photo[][], settings: ClusterSettings): Photo[][] {
  if (bursts.length <= 1) return bursts
  const ceiling = settings.carGapMinutes * 60_000

  const gapAfter = (i: number) =>
    bursts[i + 1][0].takenAt - bursts[i][bursts[i].length - 1].takenAt

  // With only two bursts there's nothing to calibrate against; if they're close
  // enough in time, one car is much the likelier reading.
  if (bursts.length === 2) {
    return gapAfter(0) <= ceiling ? [[...bursts[0], ...bursts[1]]] : bursts
  }

  const adjacent: number[] = []
  for (let i = 0; i < bursts.length - 1; i++) {
    adjacent.push(burstAffinity(bursts[i], bursts[i + 1]))
  }

  /* Each boundary is judged against its own neighbours rather than against a
     global cut-off.

     Bursts alternate: inside a car, between cars, inside the next car. So a
     boundary that belongs inside a car scores higher than the boundaries on
     either side of it, whatever the absolute numbers are. Local contrast
     captures that directly and needs no calibration, which matters because
     every global threshold tried here helped one scenario and broke another —
     a percentile strict enough for jobs with no after photo missed half the
     pairs on real photographs, and vice versa. */
  const localValue = (i: number): number => {
    const neighbours: number[] = []
    if (i > 0) neighbours.push(adjacent[i - 1])
    if (i + 1 < adjacent.length) neighbours.push(adjacent[i + 1])
    if (!neighbours.length) return 0
    const mean = neighbours.reduce((a, b) => a + b, 0) / neighbours.length
    return adjacent[i] - mean
  }

  /* A small time term, to break ties the pixels can't.

     Six silver cars through the same bay look identical to any descriptor, so
     every adjacent affinity lands on top of every other and the merges become
     arbitrary. The clock still has something to say there — a job is shorter
     than the wait for the next car — so a shorter-than-typical gap nudges
     toward "same car". It stays deliberately small: where the cars actually
     differ the visual term is far larger and wins, which matters because the
     sign of this hint flips in a busy shop, where the turnaround is shorter
     than the job. */
  const gapList = adjacent.map((_, i) => gapAfter(i)).sort((a, b) => a - b)
  const medianGap = gapList[Math.floor(gapList.length / 2)] || 1
  const TIME_HINT = 0.05

  const value = adjacent.map((_, i) => {
    const g = gapAfter(i)
    if (g > ceiling) return Number.NEGATIVE_INFINITY
    const timeScore = (medianGap - g) / (medianGap + g)
    return localValue(i) + timeScore * TIME_HINT
  })

  const n = bursts.length
  const dp = new Array<number>(n + 1).fill(0)
  const merged = new Array<boolean>(n + 1).fill(false)
  for (let i = 2; i <= n; i++) {
    const skip = dp[i - 1]
    const take = value[i - 2] > 0 ? dp[i - 2] + value[i - 2] : Number.NEGATIVE_INFINITY
    if (take > skip) {
      dp[i] = take
      merged[i] = true
    } else {
      dp[i] = skip
      merged[i] = false
    }
  }

  const out: Photo[][] = []
  let i = n
  while (i > 0) {
    if (merged[i]) {
      out.push([...bursts[i - 2], ...bursts[i - 1]])
      i -= 2
    } else {
      out.push(bursts[i - 1])
      i -= 1
    }
  }
  return out.reverse()
}

/**
 * Split one car's photos into the before batch and the after batch.
 *
 * The job itself is the longest pause in the car's photos, so the widest
 * internal gap is the divider. If there's no meaningful gap the whole thing is
 * a single burst — someone photographing a car they didn't detail — and there
 * is nothing to pair.
 */
function splitBeforeAfter(
  photos: Photo[],
  burstGapMs: number,
): { before: Photo[]; after: Photo[] } | null {
  if (photos.length < 2) return null

  let widest = 0
  let at = -1
  for (let i = 1; i < photos.length; i++) {
    const gap = photos[i].takenAt - photos[i - 1].takenAt
    if (gap > widest) {
      widest = gap
      at = i
    }
  }
  if (at < 0 || widest < burstGapMs) return null

  return { before: photos.slice(0, at), after: photos.slice(at) }
}

/**
 * Pair up a car's before batch with its after batch.
 *
 * Two pieces of evidence, deliberately combined rather than gated:
 *
 *   - Walk-around order. Position within the batch, normalised, because the
 *     first shot of the after batch usually answers the first shot of the
 *     before batch.
 *   - Visual similarity, which on real photos ranks usefully even though it
 *     can't decide on its own.
 *
 * Assignment is greedy on the combined score, highest first, each photo claimed
 * once. Everything proposed is left unconfirmed for the user to wave through.
 */
function pairBatches(
  before: Photo[],
  after: Photo[],
  settings: ClusterSettings,
): Pair[] {
  interface Candidate {
    a: Photo
    b: Photo
    score: number
    visual: number
  }

  const candidates: Candidate[] = []
  for (let i = 0; i < before.length; i++) {
    for (let j = 0; j < after.length; j++) {
      const visual = similarity(before[i], after[j])

      /* Walk-around order, by absolute position in each batch. Normalising to
         0-1 first looks tidier but misaligns the moment the batches differ in
         size — six before shots against seven after shots then rates the 6th
         against the 7th as a perfect match, which is how stray detail shots
         start stealing partners. */
      const spread = Math.max(2, Math.floor(Math.max(before.length, after.length) / 2))
      const order = Math.max(0, 1 - Math.abs(i - j) / spread)

      candidates.push({
        a: before[i],
        b: after[j],
        visual,
        score: visual * (1 - settings.orderWeight) + order * settings.orderWeight,
      })
    }
  }

  candidates.sort((x, y) => y.score - x.score)

  const claimed = new Set<string>()
  const pairs: Pair[] = []
  for (const c of candidates) {
    if (claimed.has(c.a.id) || claimed.has(c.b.id)) continue
    claimed.add(c.a.id)
    claimed.add(c.b.id)
    pairs.push({
      id: nextPairId(),
      beforeId: c.a.id,
      afterId: c.b.id,
      // Report the visual score: it's what the user is being asked to judge.
      confidence: Math.max(0, Math.min(1, c.visual)),
      confirmed: false,
    })
  }

  // Present the strongest suggestions first so the easy yeses come early.
  return pairs.sort((x, y) => y.confidence - x.confidence)
}

/**
 * Suggest pairs inside an arbitrary set of photos.
 *
 * Used when the user merges, splits or moves photos by hand and the suggestions
 * need redoing for the new arrangement.
 */
export function findPairs(photos: Photo[], settings: ClusterSettings): Pair[] {
  const ordered = [...photos].sort((a, b) => a.takenAt - b.takenAt)
  const split = splitBeforeAfter(ordered, burstThreshold(ordered, settings))
  if (!split) return []
  return pairBatches(split.before, split.after, settings)
}

function labelFor(photos: Photo[], index: number): string {
  const d = new Date(photos[0].takenAt)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Car ${index + 1} — ${date}, ${time}`
}

/** Full pipeline: a loose camera roll in, grouped-and-paired cars out. */
export function buildGroups(photos: Photo[], settings: ClusterSettings): Group[] {
  if (photos.length === 0) return []

  const ordered = [...photos].sort((a, b) => a.takenAt - b.takenAt)

  // Bursts first — each one a walk around a car — then bursts get assembled
  // into cars by the shape of the pauses between them.
  const bursts = segmentByGap(ordered, burstThreshold(ordered, settings))
  const cars = groupBursts(bursts, settings)

  return cars.map((carPhotos, i) => ({
    id: nextGroupId(),
    name: labelFor(carPhotos, i),
    photoIds: carPhotos.map((p) => p.id),
    pairs: findPairs(carPhotos, settings),
  }))
}

/** Exposed so the diagnostics can report on the same descriptor the app uses. */
export { COARSE_GRID }
