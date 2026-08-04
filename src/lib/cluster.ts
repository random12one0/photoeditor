import type { ClusterSettings, Group, Pair, Photo } from '../types'
import { assignMax } from './assign'
import { COARSE_GRID, similarity } from './hash'

/**
 * How photos get sorted into cars and paired up.
 *
 * Two things this got wrong in practice, both reported from real use, and both
 * worth stating because they were structural rather than tuning:
 *
 * 1. One car came back as six. The old design assembled cars by pairing bursts
 *    two at a time — it assumed a car was exactly "the before walk-around plus
 *    the after walk-around". Real sessions are nothing like that tidy: photos
 *    come in many bursts across a job, and a car shot in twelve bursts became
 *    six cars. No threshold fixes that; the model was wrong.
 *
 * 2. Wheels were matched to centre consoles. Walk-around order was weighted at
 *    45%, near-equal with what the photos actually looked like, so the third
 *    before shot got married to the third after shot whatever either contained.
 *    Assignment was also greedy, which compounds it: greedy takes the best
 *    single pair first, and everything after that settles for what's left.
 *
 * What replaced them is deliberately simpler and easier to reason about, which
 * matters — the settings have to be comprehensible to be fixable:
 *
 *   Cars are cut on the clock. A new car starts after a long enough break, and
 *   no car may span more than a set number of hours. Both are plain numbers a
 *   person can picture, and they match how the day actually runs.
 *
 *   Pairs are chosen by optimal assignment over the whole before/after set, so
 *   the result is the best total matching rather than whatever a first pass
 *   grabbed. Order is a light tiebreak. Anything below the quality floor is
 *   left unpaired rather than married to the nearest leftover, because a wrong
 *   pair costs more than a missing one.
 */

export const DEFAULT_CLUSTER_SETTINGS: ClusterSettings = {
  /* Longer than a car sits mid-job. A detail leaves the car alone for two or
     three hours, so anything shorter than that splits one car in half — which
     is exactly what was happening. */
  newCarGapMinutes: 240,
  /** No car spans longer than this end to end. */
  maxCarSpanHours: 6,
  /* Off by default.
   *
   * The idea was sound — people circle a car the same way twice — but it
   * assumes the two batches line up, and on real sessions they don't: three
   * before shots against five after shots makes index 1 the console rather than
   * the wheel. Measured on a real car, even a 15% weight was enough to pull the
   * wheel away from the wheel and onto the centre console, which is exactly the
   * failure that was reported. Content decides; this is available to turn up for
   * anyone who really does shoot a fixed sequence. */
  orderWeight: 0,
  /** Below this match, no pair is suggested at all. */
  minPairScore: 0.5,
}

let groupCounter = 0
let pairCounter = 0
const nextGroupId = () => `g${Date.now().toString(36)}_${(groupCounter++).toString(36)}`
const nextPairId = () => `pair${Date.now().toString(36)}_${(pairCounter++).toString(36)}`

/**
 * Cut a day's photos into cars.
 *
 * On the clock, and only on the clock — which is a deliberate retreat, so it's
 * worth recording why.
 *
 * Vision was tried here twice. The second attempt compared the photos either
 * side of every long pause, on the theory that a car looks like itself and a
 * boundary between two cars would show up as a drop. Measured against real
 * photographs it does not. Scoring each boundary against the run it sits in:
 *
 *   one car, boundaries that must NOT be cut   0.94, 0.98, 1.12, 1.12, 1.17
 *   five cars, boundaries that MUST be cut     0.94, 1.01, 1.03, 1.08
 *
 * The distributions sit on top of each other, and three of the four genuine
 * car boundaries look *more* alike across the boundary than the photos within a
 * car do. There is no threshold in there. Two different cars photographed in
 * the same driveway under the same sky simply are not distinguishable this way,
 * and pretending otherwise produced worse results than doing nothing.
 *
 * So: two rules a person can picture and correct.
 *
 *   A break longer than `newCarGapMinutes` starts a new car.
 *   No car spans more than `maxCarSpanHours` end to end.
 *
 * The honest limitation, which the settings text says out loud: two cars
 * finished and started within the gap will land together, and want one tap on
 * Split. That is the right way round — a merged car is one tap to fix, whereas
 * a car shattered into six was the complaint that started this.
 */
function splitIntoCars(ordered: Photo[], settings: ClusterSettings): Photo[][] {
  if (!ordered.length) return []
  const gapMs = settings.newCarGapMinutes * 60_000
  const spanMs = settings.maxCarSpanHours * 3_600_000

  const cars: Photo[][] = [[ordered[0]]]
  for (let i = 1; i < ordered.length; i++) {
    const current = cars[cars.length - 1]
    const sinceLast = ordered[i].takenAt - current[current.length - 1].takenAt
    const spanIfAdded = ordered[i].takenAt - current[0].takenAt

    if (sinceLast > gapMs || spanIfAdded > spanMs) cars.push([ordered[i]])
    else current.push(ordered[i])
  }
  return cars
}

/**
 * Split one car's photos into the before batch and the after batch.
 *
 * The job itself is the longest pause among the car's photos, so the widest
 * internal gap is the divider. A car photographed in one go has no meaningful
 * gap and nothing to pair.
 */
function splitBeforeAfter(photos: Photo[]): { before: Photo[]; after: Photo[] } | null {
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

  // Under three minutes is one continuous walk-around, not a job.
  if (at < 0 || widest < 180_000) return null
  return { before: photos.slice(0, at), after: photos.slice(at) }
}

/**
 * Suggest before/after pairs within a set of photos.
 *
 * The scoring is mostly what the two photos look like. Walk-around order gets a
 * small say — people do tend to circle a car the same way twice — but only
 * enough to break ties between similar candidates, never enough to pair a wheel
 * with a dashboard because they happened to be third in their batches.
 */
export function findPairs(photos: Photo[], settings: ClusterSettings): Pair[] {
  const ordered = [...photos].sort((a, b) => a.takenAt - b.takenAt)
  const split = splitBeforeAfter(ordered)
  if (!split) return []

  const { before, after } = split
  const spread = Math.max(2, Math.floor(Math.max(before.length, after.length) / 2))

  const visual: number[][] = []
  const scores: number[][] = []
  for (let i = 0; i < before.length; i++) {
    visual[i] = []
    scores[i] = []
    for (let j = 0; j < after.length; j++) {
      const v = similarity(before[i], after[j])
      const order = Math.max(0, 1 - Math.abs(i - j) / spread)
      visual[i][j] = v
      scores[i][j] = v * (1 - settings.orderWeight) + order * settings.orderWeight
    }
  }

  /* Optimal assignment across the whole set, not a greedy pass.
   *
   * The floor is applied to what the photos look like, not to the blended
   * score: order should be allowed to choose between two plausible matches, but
   * never to lift an implausible one over the bar. */
  const chosen = assignMax(
    scores.map((row, i) =>
      row.map((s, j) => (visual[i][j] < settings.minPairScore ? -Infinity : s)),
    ),
    -Infinity,
  )

  const pairs: Pair[] = []
  chosen.forEach((j, i) => {
    if (j < 0) return
    if (visual[i][j] < settings.minPairScore) return
    pairs.push({
      id: nextPairId(),
      beforeId: before[i].id,
      afterId: after[j].id,
      // Report what the user is being asked to judge: how alike they look.
      confidence: Math.max(0, Math.min(1, visual[i][j])),
      confirmed: false,
    })
  })

  // Strongest first, so the easy yeses come early.
  return pairs.sort((a, b) => b.confidence - a.confidence)
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
  return splitIntoCars(ordered, settings).map((carPhotos, i) => ({
    id: nextGroupId(),
    name: labelFor(carPhotos, i),
    photoIds: carPhotos.map((p) => p.id),
    pairs: findPairs(carPhotos, settings),
  }))
}

/** Exposed so the diagnostics can report on the same descriptor the app uses. */
export { COARSE_GRID }
