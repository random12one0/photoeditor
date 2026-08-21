/**
 * Bridges the backend's wire shapes (api.ts) to the browser-prototype's
 * Photo/Group/Pair types that render.ts, exporter.ts, StyleView and
 * ExportView already know how to consume unmodified.
 *
 * Those three files draw into a canvas and zip blobs together -- genuinely
 * browser-only work that has to stay client-side (see docs/local-desktop-
 * plan.md) -- so rather than rewrite them around a new data model, this
 * builds the same Photo/Group/Pair shapes they already expect, just sourced
 * from the backend instead of from local ingest.ts. The matching-derived
 * fields on Photo (dhash, colorSig, chromaSig, ...) are dead weight here --
 * nothing in the renderer or exporter reads them -- so they're filled with
 * inert placeholders rather than recomputed.
 *
 * Per-photo rotate/flip/zoom (transform.ts) is applied here too, for the
 * same reason: baking the correction into proxyUrl/file before render.ts or
 * exporter.ts ever sees the photo means neither of them needs to know
 * transforms exist.
 */

import type { ApiCarSolution, ApiPhoto } from './api'
import { imageUrl } from './api'
import type { PhotoTransform } from './transform'
import { applyTransformToFile, applyTransformToUrl, isIdentity } from './transform'
import type { Group, Pair, Photo } from '../types'

function placeholderPhoto(p: ApiPhoto, proxyUrl: string, file: File | null): Photo {
  return {
    id: p.id,
    file: file as File, // only read by exporter.ts at export time, where it's always real
    name: p.name,
    proxyUrl,
    width: p.width,
    height: p.height,
    takenAt: p.taken_at,
    timeIsApproximate: p.time_is_approximate,
    dhash: '0'.repeat(16),
    colorSig: [],
    chromaSig: [],
    lumaGrid: [],
    lumaGridCoarse: [],
    colorHist: [],
    edgeHist: [],
    luma: 128,
    quality: 0.5,
  }
}

/** Async because a photo carrying a non-identity transform needs a fetch +
 * decode + re-encode round trip (transform.ts) before it can be handed off
 * -- but that only happens for photos actually edited, everything else
 * takes the same synchronous path as before. */
export async function buildPhotoMap(
  apiPhotos: ApiPhoto[],
  jobId: string,
  files?: Map<string, File>,
  transforms?: Map<string, PhotoTransform>,
): Promise<Map<string, Photo>> {
  const entries = await Promise.all(
    apiPhotos.map(async (p) => {
      const t = transforms?.get(p.id)
      const rawUrl = imageUrl(jobId, p.id)
      const rawFile = files?.get(p.id) ?? null

      if (!t || isIdentity(t)) {
        return [p.id, placeholderPhoto(p, rawUrl, rawFile)] as const
      }

      const [proxyUrl, file] = await Promise.all([
        applyTransformToUrl(rawUrl, t),
        rawFile ? applyTransformToFile(rawFile, t) : Promise.resolve(null),
      ])
      return [p.id, placeholderPhoto(p, proxyUrl, file)] as const
    }),
  )
  return new Map(entries)
}

/** Only confirmed pairs (tier 'confirmed' or explicitly pinned) render/export
 * by default -- 'high'/'uncertain' pairs are still awaiting review in the
 * Verify step and showing up in the Style/Export screens as if approved
 * would defeat the point of that step. */
function toLegacyPair(p: ApiCarSolution['pairs'][number]): Pair {
  return {
    id: p.id,
    beforeId: p.before_id,
    afterId: p.after_id,
    confidence: p.score,
    confirmed: p.tier === 'confirmed',
  }
}

export function buildGroups(cars: ApiCarSolution[]): Group[] {
  return cars.map((car) => ({
    id: car.id,
    name: car.name,
    photoIds: car.bursts.map((b) => b.representative_id),
    pairs: car.pairs.map(toLegacyPair),
  }))
}
