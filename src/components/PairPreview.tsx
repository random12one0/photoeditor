import { useEffect, useRef, useState } from 'react'
import { getProxyBitmap } from '../lib/bitmapCache'
import { canvasSize, renderComposite } from '../lib/render'
import type { Photo, StylePreset } from '../types'

interface Props {
  before: Photo
  after: Photo
  preset: StylePreset
  maxWidth: number
  /** Fill the parent instead of sizing to maxWidth. Used by the export grid. */
  fill?: boolean
}

/** Decoded logos, keyed by data URL, so the preview doesn't re-decode per tick. */
const logoCache = new Map<string, ImageBitmap>()

async function getLogo(dataUrl: string | null): Promise<ImageBitmap | null> {
  if (!dataUrl) return null
  const hit = logoCache.get(dataUrl)
  if (hit) return hit
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob())
    // One logo at a time is plenty; drop anything stale.
    for (const [k, v] of logoCache) {
      v.close()
      logoCache.delete(k)
    }
    logoCache.set(dataUrl, bmp)
    return bmp
  } catch {
    return null
  }
}

/**
 * Live composite preview.
 *
 * Renders from the low-res proxies at a fraction of export size. Because every
 * spatial value in the preset is a percentage of canvas width, this is
 * proportionally identical to what gets exported.
 */
export default function PairPreview({ before, after, preset, maxWidth, fill }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pending, setPending] = useState(true)

  useEffect(() => {
    let cancelled = false

    // Debounce so dragging a slider doesn't queue a render per pixel.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [beforeBmp, afterBmp, logo] = await Promise.all([
            getProxyBitmap(before),
            getProxyBitmap(after),
            getLogo(preset.watermarkLogo),
          ])
          if (cancelled) return
          const canvas = canvasRef.current
          if (!canvas) return

          const dpr = Math.min(2, window.devicePixelRatio || 1)
          const { width, height } = canvasSize(
            preset.ratio,
            Math.round(maxWidth * 2 * dpr),
          )
          canvas.width = width
          canvas.height = height
          if (!fill) {
            canvas.style.width = `${maxWidth}px`
            canvas.style.height = `${Math.round((height / width) * maxWidth)}px`
          }

          renderComposite(canvas, { before: beforeBmp, after: afterBmp, logo }, preset)
          setPending(false)
        } catch {
          if (!cancelled) setPending(false)
        }
      })()
    }, 60)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [before, after, preset, maxWidth, fill])

  return (
    <canvas
      ref={canvasRef}
      className={`preview-canvas${pending ? ' loading' : ''}`}
      aria-label="Preview of the finished image"
    />
  )
}
