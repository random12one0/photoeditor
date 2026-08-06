/**
 * A record of every judgement the user has made about a pair.
 *
 * The matcher's weights were fitted to nineteen rows of photographs, because
 * nineteen rows is what happened to be available. That is not enough to pin
 * down six weights — a quarter of the search space wins all of them — and the
 * proof is that a weighting fitted to two of the three sets fails on the third.
 * More labelled pairs is the only thing that fixes that, and the person using
 * this app makes dozens of judgements an hour without being asked.
 *
 * So every one is kept. Confirming a suggestion is a yes. "Not a pair" is a no.
 * Pairing two photos by hand is a yes about a combination the matcher never
 * offered, which is the most informative kind. None of it costs the user
 * anything they weren't already doing.
 *
 * ## What is stored, and what deliberately isn't
 *
 * Not the photographs. Not the descriptors either — the *six component scores*
 * for the pair, which is what a re-fit actually consumes, and which cannot be
 * turned back into an image. A label is a couple of hundred bytes and contains
 * nothing recognisable, so the export can be sent to someone for analysis
 * without sending anyone's cars, driveways or number plates.
 *
 * That choice has a cost worth stating: a component that does not exist yet
 * cannot be recovered from an old label. Labels therefore carry the descriptor
 * schema version they were made under, and a re-fit has to either restrict
 * itself to the terms they share or discard the older ones.
 */

import type { Group, Photo } from '../types'
import { matchFeatures } from './features'
import {
  COARSE_GRID,
  LUMA_GRID,
  chromaDistance,
  colorHistogramSimilarity,
  edgeHistogramSimilarity,
  hamming,
  shiftedNcc,
} from './hash'
import { SCHEMA_VERSION, STORE_LABELS, openDb } from './db'

export type Verdict = 'yes' | 'no'

/** Where a judgement came from. Its reliability is not the same in each case. */
export type LabelSource =
  /** Accepted a suggestion in the review screen. */
  | 'confirm'
  /** "Not a pair" — the strongest kind of negative, since it was a near miss. */
  | 'reject'
  /** Built by hand out of two photos the matcher never put together. */
  | 'hand'
  /** Judged deliberately in the lab, where the app chose what to ask about. */
  | 'lab'

/** The terms `similarity` blends, plus the geometric evidence beside it. */
export interface PairComponents {
  color: number
  edge: number
  hash: number
  coarse: number
  fine: number
  chroma: number
  /** Keypoints agreeing on one camera movement. See features.ts. */
  inliers: number
}

/** Just enough about a photo to read a label back in context. */
export interface PhotoRef {
  id: string
  name: string
  takenAt: number
  width: number
  height: number
}

export interface Label {
  /** `beforeId|afterId`. One judgement per combination; the latest wins. */
  key: string
  verdict: Verdict
  source: LabelSource
  at: number
  before: PhotoRef
  after: PhotoRef
  components: PairComponents
  /** Gap between the two shots, in seconds. Cheap and surprisingly predictive. */
  gapSeconds: number
  /** Descriptor schema in force when this was measured. */
  schema: number
  appVersion: string
}

/* The database is opened by lib/db.ts and nowhere else — see openDb() there for
   why a second opener with its own version number is a bug that hides. */
const open = openDb

export const labelKey = (beforeId: string, afterId: string) => `${beforeId}|${afterId}`

/**
 * Every component score for a pair, in one place.
 *
 * Deliberately separate from `similarity`, which blends these down to a single
 * number. A label needs the parts, because the whole point of collecting labels
 * is to work out what the blend should be.
 */
export function describePair(a: Photo, b: Photo): PairComponents {
  return {
    color:
      a.colorHist && b.colorHist ? colorHistogramSimilarity(a.colorHist, b.colorHist) : 0,
    edge: a.edgeHist && b.edgeHist ? edgeHistogramSimilarity(a.edgeHist, b.edgeHist) : 0,
    hash: 1 - hamming(a.dhash, b.dhash) / 64,
    coarse: (shiftedNcc(a.lumaGridCoarse, b.lumaGridCoarse, COARSE_GRID, 2) + 1) / 2,
    fine: (shiftedNcc(a.lumaGrid, b.lumaGrid, LUMA_GRID, 3) + 1) / 2,
    chroma: 1 - chromaDistance(a.chromaSig, b.chromaSig),
    inliers:
      a.features && b.features ? matchFeatures(a.features, b.features).inliers : 0,
  }
}

const ref = (p: Photo): PhotoRef => ({
  id: p.id,
  name: p.name,
  takenAt: p.takenAt,
  width: p.width,
  height: p.height,
})

/**
 * Write down one judgement.
 *
 * Fire and forget on purpose: this runs inside the confirm and reject handlers,
 * and a labelling problem must never be able to stop someone pairing photos.
 * A failure is swallowed rather than surfaced.
 */
export async function recordLabel(
  before: Photo,
  after: Photo,
  verdict: Verdict,
  source: LabelSource,
): Promise<void> {
  try {
    const label: Label = {
      key: labelKey(before.id, after.id),
      verdict,
      source,
      at: Date.now(),
      before: ref(before),
      after: ref(after),
      components: describePair(before, after),
      gapSeconds: Math.round(Math.abs(after.takenAt - before.takenAt) / 1000),
      schema: SCHEMA_VERSION,
      appVersion: __APP_VERSION__,
    }
    const db = await open()
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE_LABELS, 'readwrite')
        t.objectStore(STORE_LABELS).put(label)
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
      })
    } finally {
      db.close()
    }
  } catch {
    /* Storage full, private browsing, or an upgrade in flight. Never worth
       interrupting the work for. */
  }
}

export async function loadLabels(): Promise<Label[]> {
  try {
    const db = await open()
    try {
      const all = await new Promise<Label[]>((resolve, reject) => {
        const req = db.transaction(STORE_LABELS, 'readonly').objectStore(STORE_LABELS).getAll()
        req.onsuccess = () => resolve(req.result as Label[])
        req.onerror = () => reject(req.error)
      })
      return all.sort((a, b) => b.at - a.at)
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

export async function clearLabels(): Promise<void> {
  try {
    const db = await open()
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE_LABELS, 'readwrite')
        t.objectStore(STORE_LABELS).clear()
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
      })
    } finally {
      db.close()
    }
  } catch {
    /* nothing to do */
  }
}

export async function deleteLabel(key: string): Promise<void> {
  try {
    const db = await open()
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE_LABELS, 'readwrite')
        t.objectStore(STORE_LABELS).delete(key)
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
      })
    } finally {
      db.close()
    }
  } catch {
    /* nothing to do */
  }
}

/**
 * How often the matcher's opinion matches the user's, on the pairs the user has
 * ruled on.
 *
 * This is the number that says whether a new version is actually better, and it
 * is the reason to collect labels in the app rather than only in a test file:
 * it can be read on the phone, on that day's cars, without anyone exporting
 * anything. Rank is the test rather than raw score, because ranking is what the
 * matcher is used for — a yes should be the before shot's first choice, and a
 * no should not be.
 */
export function agreement(
  labels: Label[],
  groups: Group[],
  photoMap: Map<string, Photo>,
  rank: (before: Photo, candidates: Photo[]) => Photo | null,
): { agreed: number; total: number; disagreements: Label[] } {
  const groupOf = new Map<string, Group>()
  for (const g of groups) for (const id of g.photoIds) groupOf.set(id, g)

  let agreed = 0
  let total = 0
  const disagreements: Label[] = []

  for (const label of labels) {
    const before = photoMap.get(label.before.id)
    const after = photoMap.get(label.after.id)
    const group = groupOf.get(label.before.id)
    /* Labels outlive the session they were made in. One whose photos are no
       longer loaded still belongs in the export; it just can't be scored here. */
    if (!before || !after || !group) continue

    const candidates = group.photoIds
      .filter((id) => id !== before.id)
      .map((id) => photoMap.get(id))
      .filter((p): p is Photo => Boolean(p))
    if (!candidates.length) continue

    total++
    const top = rank(before, candidates)
    const matcherSaysYes = top?.id === after.id
    if (matcherSaysYes === (label.verdict === 'yes')) agreed++
    else disagreements.push(label)
  }

  return { agreed, total, disagreements }
}

/** The export the analysis actually consumes. Photographs are not in it. */
export function labelsToJson(labels: Label[]): string {
  return JSON.stringify(
    {
      app: 'Before & After',
      appVersion: __APP_VERSION__,
      build: __BUILD_ID__,
      descriptorSchema: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      note:
        'Component scores and verdicts only — no image data. ' +
        'Terms are the six that similarity() blends, plus ORB inlier count.',
      count: labels.length,
      yes: labels.filter((l) => l.verdict === 'yes').length,
      no: labels.filter((l) => l.verdict === 'no').length,
      labels,
    },
    null,
    1,
  )
}
