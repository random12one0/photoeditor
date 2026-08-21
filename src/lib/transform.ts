/**
 * Per-photo manual correction: rotate, mirror, zoom in. Exists for the
 * cases the matcher and the renderer can't fix on their own -- a shot taken
 * in portrait that should sit landscape in the composite, or a frame where
 * zooming in a little just looks better. Deliberately implemented as a
 * pre-processing step that produces an already-corrected bitmap/File/blob
 * URL, rather than as a change to render.ts or exporter.ts -- those stay
 * exactly as tuned, and every consumer (PairPreview, StyleView, ExportView)
 * keeps working unmodified because it never has to know a transform
 * happened.
 */

export interface PhotoTransform {
  rotate: 0 | 90 | 180 | 270
  flipH: boolean
  /** 1 = untouched, 2 = zoomed to half the frame, etc. Centered crop. */
  zoom: number
}

export const IDENTITY_TRANSFORM: PhotoTransform = { rotate: 0, flipH: false, zoom: 1 }

export function isIdentity(t: PhotoTransform): boolean {
  return t.rotate === 0 && !t.flipH && t.zoom === 1
}

function drawTransformed(bitmap: ImageBitmap, t: PhotoTransform): OffscreenCanvas {
  const swap = t.rotate === 90 || t.rotate === 270
  const cropW = bitmap.width / t.zoom
  const cropH = bitmap.height / t.zoom
  const sx = (bitmap.width - cropW) / 2
  const sy = (bitmap.height - cropH) / 2

  const canvas = new OffscreenCanvas(Math.max(1, Math.round(swap ? cropH : cropW)), Math.max(1, Math.round(swap ? cropW : cropH)))
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((t.rotate * Math.PI) / 180)
  ctx.scale(t.flipH ? -1 : 1, 1)
  ctx.drawImage(bitmap, sx, sy, cropW, cropH, -cropW / 2, -cropH / 2, cropW, cropH)
  return canvas
}

export async function applyTransformToBitmap(bitmap: ImageBitmap, t: PhotoTransform): Promise<ImageBitmap> {
  if (isIdentity(t)) return bitmap
  return createImageBitmap(drawTransformed(bitmap, t))
}

/** Full-resolution path, for export -- decodes, transforms, re-encodes to a
 * new File with the same name so exporter.ts's decodeFull(photo.file) sees
 * an already-correct image and needs no changes. */
export async function applyTransformToFile(file: File, t: PhotoTransform): Promise<File> {
  if (isIdentity(t)) return file
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const canvas = drawTransformed(bitmap, t)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
  return new File([blob], file.name, { type: 'image/jpeg', lastModified: file.lastModified })
}

/** Preview-resolution path -- fetches a URL's bytes, transforms, and hands
 * back an object URL a plain <img> or getProxyBitmap's fetch() can use in
 * place of the original. Caller owns revoking it. */
export async function applyTransformToUrl(url: string, t: PhotoTransform): Promise<string> {
  if (isIdentity(t)) return url
  const res = await fetch(url)
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const canvas = drawTransformed(bitmap, t)
  bitmap.close()
  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  return URL.createObjectURL(outBlob)
}
