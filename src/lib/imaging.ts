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
 */
export async function decodeToProxy(file: File): Promise<DecodedProxy> {
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
