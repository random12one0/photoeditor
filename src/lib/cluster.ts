import type { ClusterSettings, Group, Pair, Photo } from '../types'
import { assignMax } from './assign'
import { COARSE_GRID, sameTakeScore, similarity } from './hash'

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
  /* Longer than a car sits mid-job.
   *
   * This has to clear the whole job, because of how the photos are actually
   * taken: every before shot first, then the detail, then every after shot when
   * the work is finished — around four hours apart, sometimes more. A threshold
   * at or below that cuts the befores away from the afters and turns one car
   * into two, which is the failure that was reported. Five hours sits above the
   * job and still below an overnight break. */
  newCarGapMinutes: 300,
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
 * How alike two shots must be to count as the same take rather than two
 * different angles of the same car.
 *
 * Measured, not guessed — `npm run test:diagnose:takes` prints it. On real
 * photographs, comparing only the shots this ever compares:
 *
 *   same take (the same frame, re-shot handheld)   never below 0.737
 *   different angle, within one batch              never above 0.630
 *
 * A gap 0.107 wide, so this sits near its midpoint.
 *
 * One number in that diagnostic looks like a counterexample and isn't: a true
 * before/after of the same angle scores 0.80, higher than anything here. It has
 * to — it *is* the same framing. It never reaches this comparison, because
 * befores are only ever grouped against befores and afters against afters.
 */
const SAME_TAKE_SCORE = 0.68

/**
 * Two takes of one angle come seconds apart.
 *
 * This is not a formality, and the measurement is what showed it. On the
 * synthetic fixtures, whose four "angles" are one scene drawn at four positions,
 * different angles reach 0.745 — above the threshold above, which is set from
 * real photographs where different angles top out at 0.630. There is no single
 * score that is safe on both, and the fixtures win that argument: two shots of
 * one composition at slightly different distances is a thing people do.
 *
 * The clock settles it, because taking three shots of one angle is a single act
 * that takes seconds, while moving to the next angle takes longer. The fixtures'
 * angles are two minutes apart and are excluded on time alone, whatever they
 * score. Both gates must pass.
 */
const SAME_TAKE_WINDOW_MS = 90_000

/**
 * Collapse runs of near-identical shots into one candidate each.
 *
 * The reason this exists, in the user's words: "I take maybe three pictures of
 * kinda the same angle... I usually only take one after photo, but I take a lot
 * of befores." Three befores against one after is not a matching problem — two
 * of those three have no partner and never did. Handing all three to the
 * assignment step means it pairs whichever *happens* to correlate best with the
 * after, and among three shots of one subject that difference is noise. It could
 * easily hand back the blurred one.
 *
 * So near-identical takes are collapsed first, and the survivor is the sharpest
 * of them. The losers aren't discarded — they're offered on the pair as
 * alternatives, and still export with their car.
 *
 * Ordering within a group is by quality, so index 0 is the pick.
 */
function groupSameTake(photos: Photo[]): Photo[][] {
  const groups: Photo[][] = []
  for (const photo of photos) {
    const last = groups[groups.length - 1]
    /* Compare against the most recent member rather than the group's first:
       a slow pan across a wheel drifts, and each shot resembles its neighbour
       more than it resembles where the run started. */
    const prev = last?.[last.length - 1]
    const sameTake =
      prev &&
      photo.takenAt - prev.takenAt <= SAME_TAKE_WINDOW_MS &&
      sameTakeScore(prev, photo) >= SAME_TAKE_SCORE

    if (sameTake) last.push(photo)
    else groups.push([photo])
  }

  return groups.map((g) =>
    [...g].sort((a, b) => b.quality - a.quality || a.takenAt - b.takenAt),
  )
}

/** How a rejection is keyed. */
export const rejectionKey = (beforeId: string, afterId: string) => `${beforeId}|${afterId}`

export interface PairingConstraints {
  /** Combinations the user has said are wrong, as rejectionKey strings. */
  forbidden?: ReadonlySet<string>
  /** Photos already settled in a confirmed pair, so not up for assignment. */
  taken?: ReadonlySet<string>
}

/**
 * Suggest before/after pairs within a set of photos.
 *
 * The scoring is mostly what the two photos look like. Walk-around order gets a
 * small say — people do tend to circle a car the same way twice — but only
 * enough to break ties between similar candidates, never enough to pair a wheel
 * with a dashboard because they happened to be third in their batches.
 *
 * `constraints` is what makes rejecting a suggestion mean something. Saying "no,
 * that wheel is not that console" is information about the *whole* car, not just
 * about that one card: the console it was wrongly offered is now free for
 * whichever before shot actually wants it. Feeding rejections back in and
 * re-solving is the only way that information reaches anywhere.
 *
 * The before/after split is always computed from every photo in the car, not
 * just the free ones. Otherwise confirming pairs would gradually move the
 * boundary between the two passes, and a car could end up split somewhere that
 * has nothing to do with when the work happened.
 */
export function findPairs(
  photos: Photo[],
  settings: ClusterSettings,
  constraints: PairingConstraints = {},
): Pair[] {
  const ordered = [...photos].sort((a, b) => a.takenAt - b.takenAt)
  const split = splitBeforeAfter(ordered)
  if (!split) return []

  /* Match one take per angle, not one photo per angle. */
  const taken = constraints.taken ?? new Set<string>()
  const forbidden = constraints.forbidden ?? new Set<string>()

  /* Whole takes drop out once any of their shots is spoken for: the group
     exists to offer one candidate per angle, and an angle whose pick is already
     confirmed has nothing left to offer. */
  const beforeTakes = groupSameTake(split.before).filter((t) => !t.some((p) => taken.has(p.id)))
  const afterTakes = groupSameTake(split.after).filter((t) => !t.some((p) => taken.has(p.id)))
  const before = beforeTakes.map((t) => t[0])
  const after = afterTakes.map((t) => t[0])

  const spread = Math.max(2, Math.floor(Math.max(before.length, after.length) / 2))

  const visual: number[][] = []
  const scores: number[][] = []
  for (let i = 0; i < before.length; i++) {
    visual[i] = []
    scores[i] = []
    for (let j = 0; j < after.length; j++) {
      const rejected = forbidden.has(rejectionKey(before[i].id, after[j].id))
      const v = rejected ? -Infinity : similarity(before[i], after[j])
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
    const beforeAlternates = beforeTakes[i].slice(1).map((p) => p.id)
    const afterAlternates = afterTakes[j].slice(1).map((p) => p.id)

    /* Runners-up for this before shot: the other afters, best first, above the
       floor. Saying no to a suggestion should offer the next best answer rather
       than just deleting the question — the photo still has a partner
       somewhere, and making the user go and find it by hand is a worse answer
       than the one the matcher already has ranked. */
    const runnersUp = after
      .map((photo, k) => ({ id: photo.id, score: visual[i][k] }))
      .filter((c) => c.id !== after[j].id && c.score >= settings.minPairScore)
      .sort((x, y) => y.score - x.score)
      .slice(0, 4)

    pairs.push({
      id: nextPairId(),
      beforeId: before[i].id,
      afterId: after[j].id,
      // Report what the user is being asked to judge: how alike they look.
      confidence: Math.max(0, Math.min(1, visual[i][j])),
      confirmed: false,
      ...(beforeAlternates.length ? { beforeAlternates } : {}),
      ...(afterAlternates.length ? { afterAlternates } : {}),
      ...(runnersUp.length ? { runnersUp } : {}),
    })
  })

  // Strongest first, so the easy yeses come early.
  return pairs.sort((a, b) => b.confidence - a.confidence)
}

/**
 * Re-suggest a car's pairs, keeping what the user has confirmed.
 *
 * This is the answer to a flaw that made the review screen a dead end: pressing
 * "try another" walked one before shot down its own private list of runners-up
 * and told nothing else about the car. So a wheel with no after in the set could
 * be offered every remaining photo in turn, burning each one — and every
 * candidate it burned was simply gone, never offered to the before shot that
 * actually wanted it. Ten photos could end up unsorted because of a single
 * unpartnerable wheel.
 *
 * Rejecting is information about the whole car. Re-solving is how it gets there:
 * the rejected combination is forbidden, everything confirmed is locked, and the
 * assignment runs again over what is left. A photo freed by one rejection is
 * immediately available to whichever before shot scores best on it.
 */
export function resuggestGroup(
  group: Group,
  photoMap: Map<string, Photo>,
  settings: ClusterSettings,
): Pair[] {
  const photos = group.photoIds
    .map((id) => photoMap.get(id))
    .filter((p): p is Photo => Boolean(p))

  const confirmed = group.pairs.filter((p) => p.confirmed)
  const taken = new Set(confirmed.flatMap((p) => [p.beforeId, p.afterId]))
  const forbidden = new Set(group.rejected ?? [])

  const suggestions = findPairs(photos, settings, { forbidden, taken })
  return [...confirmed, ...suggestions]
}

/**
 * Every photo on the opposite side that could partner this one, best first.
 *
 * Exists so the review screen can offer a predictable "show me the next
 * candidate" rather than re-solving the whole car and handing back a different
 * question. Re-solving is right when a constraint really changes — a
 * confirmation, or a photo declared partnerless — but doing it on every
 * rejection means the before shot changes underneath the person looking at it,
 * which reads as the app shuffling at random. It was reported exactly that way.
 *
 * Ranked by how alike the two photos look, with anything already confirmed
 * elsewhere, already rejected, or below the quality floor left out.
 */
export function candidatePartners(
  group: Group,
  photoMap: Map<string, Photo>,
  settings: ClusterSettings,
  photoId: string,
  side: 'before' | 'after',
): string[] {
  const photos = group.photoIds
    .map((id) => photoMap.get(id))
    .filter((p): p is Photo => Boolean(p))
    .sort((a, b) => a.takenAt - b.takenAt)

  const split = splitBeforeAfter(photos)
  if (!split) return []

  const subject = photoMap.get(photoId)
  if (!subject) return []

  /* Partners come from the other pass. Asking for the partners of a before shot
     means the after batch, and the other way round. */
  const pool = side === 'before' ? split.after : split.before

  const rejected = new Set(group.rejected ?? [])
  const claimed = new Set(
    group.pairs.filter((p) => p.confirmed).flatMap((p) => [p.beforeId, p.afterId]),
  )

  return pool
    .filter((p) => p.id !== photoId && !claimed.has(p.id))
    .filter((p) => {
      const key =
        side === 'before' ? rejectionKey(photoId, p.id) : rejectionKey(p.id, photoId)
      return !rejected.has(key)
    })
    .map((p) => ({ id: p.id, score: similarity(subject, p) }))
    .filter((c) => c.score >= settings.minPairScore)
    .sort((a, b) => b.score - a.score)
    .map((c) => c.id)
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
