import exifr from 'exifr'
import type { Photo } from '../types'
import {
  COARSE_GRID,
  LUMA_GRID,
  QUALITY_GRID,
  chromaSignature,
  colorSignature,
  dhashFromImageData,
  lumaGridFromImageData,
  meanLuma,
  qualityFromImageData,
} from './hash'
import { bitmapToObjectUrl, decodeToProxy, extractGrid } from './imaging'

let idCounter = 0
const nextId = () => `p${Date.now().toString(36)}_${(idCounter++).toString(36)}`

/** Pull the real capture time out of EXIF, falling back to the file's mtime. */
async function readTakenAt(
  file: File,
  bytes: ArrayBuffer | null,
): Promise<{ takenAt: number; approximate: boolean }> {
  try {
    const tags = await exifr.parse(bytes ?? file, {
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
  /** ms per photo so far, once there's enough of a run to mean anything. */
  msPerPhoto?: number
}

/**
 * How many files are being read ahead of the one being decoded.
 *
 * This is the fix for imports taking minutes on a phone. A photo that lives in
 * iCloud rather than on the device has to be downloaded before its bytes can be
 * read, and the import was doing that strictly one at a time with the CPU idle
 * throughout — then reading each file a *second* time to parse its EXIF. So the
 * wait was two serial network round trips per photo, times a hundred and fifty.
 *
 * Now each file is read once into memory, several reads are in flight at once,
 * and the decoding of one photo overlaps the download of the next few.
 *
 * Three is deliberately modest: the point is to hide latency, and holding many
 * full-resolution files in memory at once is exactly what kills the tab on iOS.
 * At three it is around 12MB of buffers.
 */
const READ_AHEAD = 3

/**
 * Read files with a bounded look-ahead, yielding them in order.
 *
 * A read that fails yields its error rather than throwing, so one unreadable
 * file doesn't abandon the rest of the import.
 */
export async function* readAhead(
  files: File[],
): AsyncGenerator<{ file: File; bytes: ArrayBuffer | null; error?: unknown }> {
  const queue: Promise<{ file: File; bytes: ArrayBuffer | null; error?: unknown }>[] = []
  let next = 0

  const fill = () => {
    while (queue.length < READ_AHEAD && next < files.length) {
      const file = files[next++]
      queue.push(
        file
          .arrayBuffer()
          .then((bytes) => ({ file, bytes }))
          .catch((error: unknown) => ({ file, bytes: null, error })),
      )
    }
  }

  fill()
  while (queue.length) {
    const item = await queue.shift()!
    fill()
    yield item
  }
}

/**
 * Decode, fingerprint and timestamp a batch of files.
 *
 * Reads run ahead; decoding stays sequential on purpose, because decoding a
 * 12MP photo spikes memory and mobile Safari will kill the tab if we do 150 of
 * them at once.
 */
export async function ingestFiles(
  files: File[],
  onProgress?: (p: IngestProgress) => void,
): Promise<{ photos: Photo[]; failures: { name: string; reason: string }[] }> {
  const photos: Photo[] = []
  const failures: { name: string; reason: string }[] = []
  const startedAt = Date.now()
  let i = -1

  for await (const { file, bytes, error } of readAhead(files)) {
    i++
    onProgress?.({
      done: i,
      total: files.length,
      current: file.name,
      msPerPhoto: i >= 3 ? (Date.now() - startedAt) / i : undefined,
    })

    if (!bytes) {
      failures.push({
        name: file.name,
        reason: error instanceof Error ? error.message : 'could not be read',
      })
      continue
    }

    try {
      /* Decode from the bytes already in hand rather than the File, so the
         photo isn't fetched from iCloud a second time. */
      const source = new Blob([bytes], { type: file.type || 'image/jpeg' })
      const { bitmap, width, height } = await decodeToProxy(source)
      const hashGrid = extractGrid(bitmap, 9, 8)
      const colorGrid = extractGrid(bitmap, 32, 32)
      const structureGrid = extractGrid(bitmap, LUMA_GRID, LUMA_GRID)
      const coarseGrid = extractGrid(bitmap, COARSE_GRID, COARSE_GRID)
      const qualityGrid = extractGrid(bitmap, QUALITY_GRID, QUALITY_GRID, 'quality')
      const proxyUrl = await bitmapToObjectUrl(bitmap)
      const { takenAt, approximate } = await readTakenAt(file, bytes)

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
        quality: qualityFromImageData(qualityGrid),
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
