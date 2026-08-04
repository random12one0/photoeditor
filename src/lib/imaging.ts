/** Image decoding, downscaling and proxy generation. */

import { canvasToBlob, scratch, type ScratchKey } from './canvasPool'

export { canvasToBlob }

/** Longest edge of the in-browser proxy. Big enough to preview, small enough
 *  that 150 of them don't exhaust mobile Safari. */
export const PROXY_MAX_EDGE = 1400

export interface DecodedProxy {
  bitmap: ImageBitmap
  width: number
  height: number
}

/**
 * Decode a file, honouring EXIF orientation, and downscale it to a proxy.
 * Returns the original pixel dimensions alongside the proxy bitmap.
 *
 * `hint` carries the dimensions read out of EXIF, when there are any. With them
 * the decoder can scale during decode — JPEG can be decoded at a fraction of
 * full size almost for free — instead of building a 12MP bitmap and throwing
 * most of it away. On a phone that is the single most expensive step of an
 * import, and it happens once per photo.
 *
 * Only one axis is constrained, never both. Passing a single dimension makes
 * the browser preserve the aspect ratio, which means that if it applies EXIF
 * rotation *after* the resize — implementations have differed on this — the
 * worst case is a proxy somewhat larger than intended rather than a stretched
 * one. Correctness first; the saving survives either way.
 */
export async function decodeToProxy(
  file: Blob,
  hint?: { width: number; height: number } | null,
): Promise<DecodedProxy> {
  if (hint && hint.width > 0 && hint.height > 0) {
    const longEdge = Math.max(hint.width, hint.height)
    if (longEdge > PROXY_MAX_EDGE) {
      const landscape = hint.width >= hint.height
      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        resizeQuality: 'high',
        ...(landscape
          ? { resizeWidth: PROXY_MAX_EDGE }
          : { resizeHeight: PROXY_MAX_EDGE }),
      })

      /* Report the original size the way the bitmap is actually shaped, not the
         way EXIF listed it. A rotated photo carries its dimensions unswapped in
         the header, so handing those straight back would call a portrait shot
         landscape — and that decides how the pair review lays the two photos
         out. The decoded bitmap has already had the rotation applied, so its
         aspect ratio is the one to trust; the header only supplies the scale. */
      const longEdge = Math.max(hint.width, hint.height)
      const wide = bitmap.width >= bitmap.height
      const ratio = wide
        ? bitmap.height / bitmap.width
        : bitmap.width / bitmap.height
      return {
        bitmap,
        width: wide ? longEdge : Math.round(longEdge * ratio),
        height: wide ? Math.round(longEdge * ratio) : longEdge,
      }
    }
  }

  const full = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const { width, height } = full
  const scale = Math.min(1, PROXY_MAX_EDGE / Math.max(width, height))

  if (scale >= 1) {
    return { bitmap: full, width, height }
  }

  const pw = Math.max(1, Math.round(width * scale))
  const ph = Math.max(1, Math.round(height * scale))
  const proxy = await createImageBitmap(full, {
    resizeWidth: pw,
    resizeHeight: ph,
    resizeQuality: 'high',
  })
  full.close()
  return { bitmap: proxy, width, height }
}

/** Decode at full resolution. Only used at export time, one photo at a time. */
export async function decodeFull(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' })
}

/**
 * Squash a bitmap down to a tiny grid and hand back its raw pixels.
 *
 * Uses the shared scratch canvas: this runs three times per imported photo, and
 * allocating a canvas each time is what exhausts Safari's canvas memory budget
 * partway through a large import.
 */
export function extractGrid(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  key: ScratchKey = 'grid',
): ImageData {
  const canvas = scratch(key, w, h)
  const ctx = canvas.getContext('2d', {
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/** Turn a bitmap into a blob URL the UI can use in an <img>. */
export async function bitmapToObjectUrl(
  bitmap: ImageBitmap,
  quality = 0.85,
): Promise<string> {
  const canvas = scratch('proxy', bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
  ctx.clearRect(0, 0, bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, 0, 0)
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  return URL.createObjectURL(blob)
}
