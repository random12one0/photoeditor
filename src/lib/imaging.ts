/** Image decoding, downscaling and proxy generation. */

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

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Squash a bitmap down to a tiny grid and hand back its raw pixels. */
export function extractGrid(bitmap: ImageBitmap, w: number, h: number): ImageData {
  const canvas = makeCanvas(w, h)
  const ctx = canvas.getContext('2d', {
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/** Turn a bitmap into a blob URL the UI can use in an <img>. */
export async function bitmapToObjectUrl(
  bitmap: ImageBitmap,
  quality = 0.85,
): Promise<string> {
  const canvas = makeCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0)

  let blob: Blob
  if (canvas instanceof OffscreenCanvas) {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  } else {
    blob = await new Promise<Blob>((resolve, reject) => {
      ;(canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        'image/jpeg',
        quality,
      )
    })
  }
  return URL.createObjectURL(blob)
}

export async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality })
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      type,
      quality,
    )
  })
}
