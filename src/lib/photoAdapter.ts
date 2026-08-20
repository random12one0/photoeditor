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
 */

import type { ApiCarSolution, ApiPhoto } from './api'
import { imageUrl } from './api'
import type { Group, Pair, Photo } from '../types'

function placeholderPhoto(p: ApiPhoto, jobId: string, file: File | null): Photo {
  return {
    id: p.id,
    file: file as File, // only read by exporter.ts at export time, where it's always real
    name: p.name,
    proxyUrl: imageUrl(jobId, p.id),
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

export function buildPhotoMap(
  apiPhotos: ApiPhoto[],
  jobId: string,
  files?: Map<string, File>,
): Map<string, Photo> {
  return new Map(apiPhotos.map((p) => [p.id, placeholderPhoto(p, jobId, files?.get(p.id) ?? null)]))
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
