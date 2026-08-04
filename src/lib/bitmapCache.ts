import type { Photo } from '../types'

/**
 * Proxy bitmaps for the live preview.
 *
 * Decoding the same photo on every slider tick would make the editor feel like
 * mud, so a small LRU holds them. Two things here were wrong on a phone, and
 * both showed up as a preview that simply never appeared.
 *
 * **The bitmaps were far too big.** They were decoded at the full proxy size —
 * 1400px on the long edge, about 5.9MB of pixels each — and twenty-four of them
 * is 140MB of decoded image. Previews are drawn into a canvas a few hundred
 * pixels wide, so none of that resolution ever reached the screen. iOS Safari
 * caps total canvas and bitmap memory, and past the cap `createImageBitmap`
 * starts rejecting rather than degrading. Preview bitmaps are now decoded to
 * the size they are actually drawn at, which is roughly nine times smaller.
 *
 * **Evicting closed a bitmap that might still be in use.** Renders are async:
 * a preview asks for two bitmaps, awaits them, then draws. If a later preview
 * pushed the first one out of the cache in between, `close()` had already freed
 * it and the draw threw. With more tiles on screen than the cache holds — an
 * export grid of a dozen cars — that is not an edge case, it is the normal
 * path. Eviction now waits before closing, long enough for any render already
 * holding the bitmap to have finished with it.
 */

/**
 * Long edge for preview bitmaps. The largest preview canvas is around 800px
 * across on a desktop at 2x, and drawing a larger source into it buys nothing.
 */
const PREVIEW_MAX_EDGE = 900

const MAX_ENTRIES = 24

/** How long an evicted bitmap stays alive in case a render is mid-flight. */
const CLOSE_DELAY_MS = 10_000

const cache = new Map<string, ImageBitmap>()

export async function getProxyBitmap(photo: Photo): Promise<ImageBitmap> {
  const hit = cache.get(photo.id)
  if (hit) {
    // Refresh recency.
    cache.delete(photo.id)
    cache.set(photo.id, hit)
    return hit
  }

  const res = await fetch(photo.proxyUrl)
  const blob = await res.blob()

  /* Only one axis is constrained so the browser keeps the aspect ratio, and the
     proxy has already been through EXIF rotation, so its own shape is right. */
  const landscape = photo.width >= photo.height
  const bitmap = await createImageBitmap(
    blob,
    landscape
      ? { resizeWidth: PREVIEW_MAX_EDGE, resizeQuality: 'high' }
      : { resizeHeight: PREVIEW_MAX_EDGE, resizeQuality: 'high' },
  )

  cache.set(photo.id, bitmap)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    const stale = cache.get(oldest)
    cache.delete(oldest)
    if (stale) retire(stale)
  }
  return bitmap
}

/**
 * Free a bitmap, but not immediately.
 *
 * A render that already has this bitmap in hand and is waiting on its second
 * one would otherwise draw a closed bitmap and throw. The delay costs a little
 * memory for a few seconds and removes a whole class of blank previews.
 */
function retire(bitmap: ImageBitmap): void {
  setTimeout(() => {
    try {
      bitmap.close()
    } catch {
      // Already closed, or the page is going away. Nothing to do either way.
    }
  }, CLOSE_DELAY_MS)
}

export function dropFromCache(photoId: string): void {
  const bmp = cache.get(photoId)
  cache.delete(photoId)
  if (bmp) retire(bmp)
}

export function clearBitmapCache(): void {
  for (const b of cache.values()) retire(b)
  cache.clear()
}
