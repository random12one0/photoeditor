import exifr from 'exifr'
import type { Photo } from '../types'
import {
  COARSE_GRID,
  LUMA_GRID,
  chromaSignature,
  colorSignature,
  dhashFromImageData,
  lumaGridFromImageData,
  meanLuma,
} from './hash'
import { bitmapToObjectUrl, decodeToProxy, extractGrid } from './imaging'

let idCounter = 0
const nextId = () => `p${Date.now().toString(36)}_${(idCounter++).toString(36)}`

/** Pull the real capture time out of EXIF, falling back to the file's mtime. */
async function readTakenAt(
  file: File,
): Promise<{ takenAt: number; approximate: boolean }> {
  try {
    const tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'],
    })
    const raw = tags?.DateTimeOriginal ?? tags?.CreateDate ?? tags?.ModifyDate
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return { takenAt: raw.getTime(), approximate: false }
    }
  } catch {
    // Not all files carry EXIF (screenshots, exports, PNGs). Fall through.
  }
  return { takenAt: file.lastModified || Date.now(), approximate: true }
}

export interface IngestProgress {
  done: number
  total: number
  current: string
}

/**
 * Decode, fingerprint and timestamp a batch of files.
 *
 * Runs sequentially on purpose: decoding a 12MP photo spikes memory, and
 * mobile Safari will kill the tab if we do 150 of them at once.
 */
export async function ingestFiles(
  files: File[],
  onProgress?: (p: IngestProgress) => void,
): Promise<{ photos: Photo[]; failures: { name: string; reason: string }[] }> {
  const photos: Photo[] = []
  const failures: { name: string; reason: string }[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress?.({ done: i, total: files.length, current: file.name })

    try {
      const { bitmap, width, height } = await decodeToProxy(file)
      const hashGrid = extractGrid(bitmap, 9, 8)
      const colorGrid = extractGrid(bitmap, 32, 32)
      const structureGrid = extractGrid(bitmap, LUMA_GRID, LUMA_GRID)
      const coarseGrid = extractGrid(bitmap, COARSE_GRID, COARSE_GRID)
      const proxyUrl = await bitmapToObjectUrl(bitmap)
      const { takenAt, approximate } = await readTakenAt(file)

      photos.push({
        id: nextId(),
        file,
        name: file.name,
        proxyUrl,
        width,
        height,
        takenAt,
        timeIsApproximate: approximate,
        dhash: dhashFromImageData(hashGrid),
        colorSig: colorSignature(colorGrid),
        chromaSig: chromaSignature(colorGrid),
        lumaGrid: lumaGridFromImageData(structureGrid),
        lumaGridCoarse: lumaGridFromImageData(coarseGrid),
        luma: meanLuma(colorGrid),
      })

      bitmap.close()
    } catch (err) {
      failures.push({
        name: file.name,
        reason: err instanceof Error ? err.message : 'could not be decoded',
      })
    }

    // Yield to the event loop so the progress bar actually paints.
    await new Promise((r) => setTimeout(r, 0))
  }

  onProgress?.({ done: files.length, total: files.length, current: '' })
  return { photos, failures }
}
