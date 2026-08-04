/**
 * Session persistence.
 *
 * Mobile Safari will happily evict a background tab holding 150 decoded photos.
 * Losing an hour of pairing to a tab reload would be miserable, so the raw files
 * and all the grouping decisions go into IndexedDB as you work.
 */

import type { ClusterSettings, Group, Photo, SavedPreset, StylePreset } from '../types'

const DB_NAME = 'unbklok'
const DB_VERSION = 1
const STORE_FILES = 'files'
const STORE_META = 'meta'

/** Everything about a Photo except the things we can rebuild or re-derive. */
type StoredPhoto = Omit<Photo, 'file' | 'proxyUrl'>

/**
 * Bump whenever anything *derived* from a photo changes — a new descriptor, a
 * different weighting, a new field on a pair.
 *
 * This is the fix for the most confusing bug in this project's history. A saved
 * session stores the fingerprints computed at import, so after an upgrade the
 * app was running new code over old numbers: photos with no colour or edge
 * histogram fell back to the superseded weighting, and pairs saved before
 * runners-up existed had none, so "not a pair" still just deleted the
 * suggestion. Both reported symptoms, exactly — and neither reproducible from a
 * fresh import, which is the only way it was ever tested.
 *
 * A version means the app can tell that what it loaded predates what it knows,
 * and rebuild rather than quietly behave like the old version.
 */
export const SCHEMA_VERSION = 3

interface StoredSession {
  photos: StoredPhoto[]
  groups: Group[]
  savedAt: number
  /** Absent on anything saved before versioning existed. */
  schema?: number
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES)
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveSession(photos: Photo[], groups: Group[]): Promise<void> {
  const db = await open()
  try {
    const stored: StoredPhoto[] = photos.map(
      ({ file: _file, proxyUrl: _proxyUrl, ...rest }) => rest,
    )
    await tx(db, STORE_META, 'readwrite', (s) =>
      s.put(
        { photos: stored, groups, savedAt: Date.now(), schema: SCHEMA_VERSION } satisfies StoredSession,
        'session',
      ),
    )

    // Files are written separately so re-saving metadata (which happens on every
    // pairing keystroke) doesn't rewrite hundreds of megabytes of image data.
    const existing = new Set(
      (await tx<IDBValidKey[]>(db, STORE_FILES, 'readonly', (s) => s.getAllKeys())).map(
        String,
      ),
    )
    const wanted = new Set(photos.map((p) => p.id))

    for (const photo of photos) {
      if (!existing.has(photo.id)) {
        await tx(db, STORE_FILES, 'readwrite', (s) => s.put(photo.file, photo.id))
      }
    }
    for (const key of existing) {
      if (!wanted.has(key)) {
        await tx(db, STORE_FILES, 'readwrite', (s) => s.delete(key))
      }
    }
  } finally {
    db.close()
  }
}

export async function loadSession(): Promise<{
  photos: StoredPhoto[]
  groups: Group[]
  files: Map<string, File>
  savedAt: number
  /** True when this session was saved by an older build of the app. */
  stale: boolean
} | null> {
  const db = await open()
  try {
    const session = await tx<StoredSession | undefined>(db, STORE_META, 'readonly', (s) =>
      s.get('session'),
    )
    if (!session?.photos?.length) return null

    const files = new Map<string, File>()
    for (const p of session.photos) {
      const f = await tx<File | undefined>(db, STORE_FILES, 'readonly', (s) => s.get(p.id))
      if (f) files.set(p.id, f)
    }
    // A photo whose bytes didn't survive is unusable; drop it and its pairs.
    const usable = session.photos.filter((p) => files.has(p.id))
    const usableIds = new Set(usable.map((p) => p.id))
    const groups = session.groups
      .map((g) => ({
        ...g,
        photoIds: g.photoIds.filter((id) => usableIds.has(id)),
        pairs: g.pairs.filter((p) => usableIds.has(p.beforeId) && usableIds.has(p.afterId)),
      }))
      .filter((g) => g.photoIds.length > 0)

    return {
      photos: usable,
      groups,
      files,
      savedAt: session.savedAt,
      stale: (session.schema ?? 0) < SCHEMA_VERSION,
    }
  } catch {
    return null
  } finally {
    db.close()
  }
}

export async function clearSession(): Promise<void> {
  const db = await open()
  try {
    await tx(db, STORE_META, 'readwrite', (s) => s.clear())
    await tx(db, STORE_FILES, 'readwrite', (s) => s.clear())
  } finally {
    db.close()
  }
}

const PRESET_KEY = 'unbklok:preset'
const CLUSTER_KEY = 'unbklok:cluster'

export function savePreset(preset: StylePreset): void {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(preset))
  } catch {
    // Private browsing / quota. Not worth interrupting the user over.
  }
}

export function loadPreset(fallback: StylePreset): StylePreset {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    if (!raw) return fallback
    // Merge so presets saved by an older build pick up new knobs.
    return { ...fallback, ...(JSON.parse(raw) as Partial<StylePreset>) }
  } catch {
    return fallback
  }
}

export function saveClusterSettings(settings: ClusterSettings): void {
  try {
    localStorage.setItem(CLUSTER_KEY, JSON.stringify(settings))
  } catch {
    /* ignore */
  }
}

export function loadClusterSettings(fallback: ClusterSettings): ClusterSettings {
  try {
    const raw = localStorage.getItem(CLUSTER_KEY)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as Partial<ClusterSettings>) }
  } catch {
    return fallback
  }
}

const SAVED_KEY = 'unbklok:presets'

/** Named looks the user can flip between — a feed style and a story style. */
export function saveSavedPresets(list: SavedPreset[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

export function loadSavedPresets(): SavedPreset[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SavedPreset[]) : []
  } catch {
    return []
  }
}
