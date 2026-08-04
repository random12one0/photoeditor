/**
 * Shared scratch canvases.
 *
 * iOS Safari caps *total* canvas memory at around 384MB and is notorious for
 * holding on to canvas backing stores well after the JS object is unreachable.
 * Allocating a fresh canvas per operation is therefore a slow leak: importing
 * 150 photos at three grids each, plus two per preview repaint while a slider is
 * being dragged, runs into the hundreds and takes the tab down with it.
 *
 * Every short-lived drawing operation borrows one of a handful of canvases from
 * here instead. They're keyed by purpose so two nested operations never fight
 * over the same pixels, and resized in place rather than reallocated.
 */

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

export type ScratchKey =
  | 'grid'
  | 'proxy'
  | 'backdrop-small'
  | 'backdrop-blur'
  | 'export'
  | 'measure'

const pool = new Map<ScratchKey, AnyCanvas>()

function create(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * A canvas of at least the requested size, reused across calls.
 *
 * Callers must treat the contents as undefined and must not hold the reference
 * past the current synchronous operation.
 */
export function scratch(key: ScratchKey, width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))

  const existing = pool.get(key)
  if (existing) {
    if (existing.width !== w || existing.height !== h) {
      existing.width = w
      existing.height = h
    }
    return existing
  }

  const made = create(w, h)
  pool.set(key, made)
  return made
}

/** Drop a scratch canvas's backing store. Used when clearing a whole session. */
export function releaseScratch(): void {
  for (const c of pool.values()) {
    c.width = 1
    c.height = 1
  }
  pool.clear()
}

export function canvasToBlob(
  canvas: AnyCanvas,
  type: string,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality })
  }
  return new Promise<Blob>((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      type,
      quality,
    )
  })
}
