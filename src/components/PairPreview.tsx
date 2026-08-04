import { useEffect, useRef, useState } from 'react'
import { getProxyBitmap } from '../lib/bitmapCache'
import { canvasSize, renderComposite } from '../lib/render'
import type { Photo, StylePreset } from '../types'

interface Props {
  before: Photo
  after: Photo
  preset: StylePreset
  maxWidth: number
}

/**
 * Live composite preview.
 *
 * Renders from the low-res proxies at a fraction of export size. Because every
 * spatial value in the preset is a percentage of canvas width, this is
 * proportionally identical to what the ZIP will contain.
 */
export default function PairPreview({ before, after, preset, maxWidth }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    // Debounce so dragging a slider doesn't queue a render per pixel.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [beforeBmp, afterBmp] = await Promise.all([
            getProxyBitmap(before),
            getProxyBitmap(after),
          ])
          if (cancelled) return

          const canvas = canvasRef.current
          if (!canvas) return

          const dpr = Math.min(2, window.devicePixelRatio || 1)
          const { width, height } = canvasSize(preset.ratio, Math.round(maxWidth * 2 * dpr))
          canvas.width = width
          canvas.height = height
          canvas.style.width = `${maxWidth}px`
          canvas.style.height = `${Math.round((height / width) * maxWidth)}px`

          renderComposite(canvas, { before: beforeBmp, after: afterBmp }, preset)
          setError(null)
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Preview failed')
          }
        }
      })()
    }, 60)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [before, after, preset, maxWidth])

  return (
    <div className="preview-wrap">
      <canvas ref={canvasRef} className="preview-canvas" />
      {error && <p className="muted tiny">{error}</p>}
    </div>
  )
}
