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
  const [failure, setFailure] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)

  /**
   * Only render once the preview is actually on screen.
   *
   * The export screen shows one of these per pair, and rendering all of them at
   * once meant a dozen canvases and two dozen decoded photos allocated in the
   * same frame — which is how a phone runs out of canvas memory and starts
   * handing back blank ones. Rendering on sight also means scrolling to a car
   * costs one preview rather than the whole page costing all of them.
   */
  useEffect(() => {
    /* The canvas, not its wrapper. The wrapper is `display: contents` so it
       doesn't disturb the export grid's layout — which also means it generates
       no box, and an element with no box never intersects anything. Observing
       it meant every preview stayed invisible for ever. */
    const el = canvasRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      // A screen's worth of warning, so it is painted before it is scrolled to.
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
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
          setFailure(null)
          setPending(false)
        } catch (err) {
          /* This used to be swallowed, which is why a preview that failed was
             indistinguishable from one still loading: both were a grey
             rectangle, for ever, with nothing to report. A visible reason is
             worth far more than a tidy catch block — especially for a failure
             that only happens on someone else's phone. */
          if (cancelled) return
          setFailure(err instanceof Error ? err.message : 'could not be drawn')
          setPending(false)
        }
      })()
    }, 60)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [before, after, preset, maxWidth, fill, visible])

  return (
    <div className="preview-holder">
      <canvas
        ref={canvasRef}
        className={`preview-canvas${pending ? ' loading' : ''}`}
        aria-label="Preview of the finished image"
        data-testid="preview-canvas"
        hidden={Boolean(failure)}
      />
      {failure && (
        <p className="tiny preview-failed" role="status" data-testid="preview-failed">
          Preview didn’t render — {failure}
        </p>
      )}
    </div>
  )
}
