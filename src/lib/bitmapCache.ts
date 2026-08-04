import type { Photo } from '../types'

/**
 * Proxy bitmaps for the live preview. Decoding the same photo on every slider
 * tick would make the editor feel like mud, so we hold a small LRU of them.
 */
const MAX_ENTRIES = 24
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
  const bitmap = await createImageBitmap(blob)

  cache.set(photo.id, bitmap)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.get(oldest)?.close()
    cache.delete(oldest)
  }
  return bitmap
}

export function dropFromCache(photoId: string): void {
  cache.get(photoId)?.close()
  cache.delete(photoId)
}

export function clearBitmapCache(): void {
  for (const b of cache.values()) b.close()
  cache.clear()
}
