import { useCallback, useEffect, useMemo, useState } from 'react'
import ExportView from './components/ExportView'
import GroupsView from './components/GroupsView'
import ImportView from './components/ImportView'
import PairView from './components/PairView'
import StyleView from './components/StyleView'
import { clearBitmapCache, dropFromCache } from './lib/bitmapCache'
import { DEFAULT_CLUSTER_SETTINGS, buildGroups, findPairs } from './lib/cluster'
import {
  clearSession,
  loadClusterSettings,
  loadPreset,
  loadSession,
  saveClusterSettings,
  savePreset,
  saveSession,
} from './lib/db'
import { bitmapToObjectUrl, decodeToProxy } from './lib/imaging'
import { DEFAULT_PRESET } from './lib/render'
import type { ClusterSettings, Group, Photo, StylePreset } from './types'

export type Stage = 'import' | 'cars' | 'pairs' | 'style' | 'export'

const STAGES: { id: Stage; label: string; short: string }[] = [
  { id: 'import', label: 'Import', short: '1' },
  { id: 'cars', label: 'Cars', short: '2' },
  { id: 'pairs', label: 'Pairs', short: '3' },
  { id: 'style', label: 'Style', short: '4' },
  { id: 'export', label: 'Export', short: '5' },
]

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [stage, setStage] = useState<Stage>('import')
  const [preset, setPreset] = useState<StylePreset>(() => loadPreset(DEFAULT_PRESET))
  const [clusterSettings, setClusterSettings] = useState<ClusterSettings>(() =>
    loadClusterSettings(DEFAULT_CLUSTER_SETTINGS),
  )
  const [restoring, setRestoring] = useState(true)
  const [toast, setToast] = useState<string | null>(null)

  const photoMap = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 3200)
  }, [])

  /* ---------------------------------------------------------------- restore */

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const saved = await loadSession()
        if (!saved || cancelled) return

        // Proxies are object URLs, which don't survive a reload — rebuild them
        // from the stored files.
        const restored: Photo[] = []
        for (const meta of saved.photos) {
          const file = saved.files.get(meta.id)
          if (!file) continue
          const { bitmap } = await decodeToProxy(file)
          const proxyUrl = await bitmapToObjectUrl(bitmap)
          bitmap.close()
          restored.push({ ...meta, file, proxyUrl })
        }
        if (cancelled) return

        setPhotos(restored)
        setGroups(saved.groups)
        if (restored.length) {
          setStage('cars')
          notify(`Restored ${restored.length} photos from your last session`)
        }
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [notify])

  /* ------------------------------------------------------------- persistence */

  useEffect(() => {
    if (restoring) return
    const id = window.setTimeout(() => {
      void saveSession(photos, groups).catch(() => {
        notify('Could not save your session — storage may be full')
      })
    }, 900)
    return () => window.clearTimeout(id)
  }, [photos, groups, restoring, notify])

  useEffect(() => savePreset(preset), [preset])
  useEffect(() => saveClusterSettings(clusterSettings), [clusterSettings])

  /* ------------------------------------------------------------------ import */

  const handleImported = useCallback(
    (incoming: Photo[]) => {
      if (!incoming.length) return
      setPhotos((prev) => {
        const all = [...prev, ...incoming]
        setGroups(buildGroups(all, clusterSettings))
        return all
      })
      setStage('cars')
    },
    [clusterSettings],
  )

  const regroup = useCallback(
    (settings: ClusterSettings) => {
      setClusterSettings(settings)
      setGroups(buildGroups(photos, settings))
      notify('Re-grouped from scratch')
    },
    [photos, notify],
  )

  const reset = useCallback(async () => {
    photos.forEach((p) => URL.revokeObjectURL(p.proxyUrl))
    clearBitmapCache()
    await clearSession()
    setPhotos([])
    setGroups([])
    setStage('import')
  }, [photos])

  /* ------------------------------------------------------------- group edits */

  const renameGroup = useCallback((id: string, name: string) => {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)))
  }, [])

  const mergeGroups = useCallback(
    (ids: string[]) => {
      if (ids.length < 2) return
      setGroups((gs) => {
        const chosen = gs.filter((g) => ids.includes(g.id))
        if (chosen.length < 2) return gs
        const target = chosen[0]
        const mergedIds = chosen.flatMap((g) => g.photoIds)
        const ordered = mergedIds
          .map((id) => photoMap.get(id))
          .filter((p): p is Photo => Boolean(p))
          .sort((a, b) => a.takenAt - b.takenAt)

        const merged: Group = {
          ...target,
          photoIds: ordered.map((p) => p.id),
          // Keep hand-confirmed pairs, then re-suggest across the new whole.
          pairs: mergePairs(
            chosen.flatMap((g) => g.pairs).filter((p) => p.confirmed),
            findPairs(ordered, clusterSettings),
          ),
        }
        return gs.filter((g) => !ids.includes(g.id) || g.id === target.id)
          .map((g) => (g.id === target.id ? merged : g))
      })
      notify('Merged')
    },
    [photoMap, clusterSettings, notify],
  )

  const splitPhotosToNewGroup = useCallback(
    (fromGroupId: string, photoIds: string[]) => {
      if (!photoIds.length) return
      const moving = new Set(photoIds)
      setGroups((gs) => {
        const source = gs.find((g) => g.id === fromGroupId)
        if (!source) return gs

        const remaining = source.photoIds.filter((id) => !moving.has(id))
        const movedPhotos = photoIds
          .map((id) => photoMap.get(id))
          .filter((p): p is Photo => Boolean(p))
          .sort((a, b) => a.takenAt - b.takenAt)

        const newGroup: Group = {
          id: `g${Date.now().toString(36)}_split`,
          name: `${source.name} (split)`,
          photoIds: movedPhotos.map((p) => p.id),
          pairs: findPairs(movedPhotos, clusterSettings),
        }

        const updatedSource: Group = {
          ...source,
          photoIds: remaining,
          pairs: source.pairs.filter(
            (p) => !moving.has(p.beforeId) && !moving.has(p.afterId),
          ),
        }

        const next = gs.map((g) => (g.id === fromGroupId ? updatedSource : g))
        const insertAt = next.findIndex((g) => g.id === fromGroupId) + 1
        next.splice(insertAt, 0, newGroup)
        return next.filter((g) => g.photoIds.length > 0)
      })
      notify(`Split ${photoIds.length} photo${photoIds.length === 1 ? '' : 's'} out`)
    },
    [photoMap, clusterSettings, notify],
  )

  const movePhotos = useCallback(
    (photoIds: string[], toGroupId: string) => {
      const moving = new Set(photoIds)
      setGroups((gs) =>
        gs
          .map((g) => {
            if (g.id === toGroupId) {
              const combined = [...new Set([...g.photoIds, ...photoIds])]
                .map((id) => photoMap.get(id))
                .filter((p): p is Photo => Boolean(p))
                .sort((a, b) => a.takenAt - b.takenAt)
              return {
                ...g,
                photoIds: combined.map((p) => p.id),
                pairs: mergePairs(
                  g.pairs.filter((p) => p.confirmed),
                  findPairs(combined, clusterSettings),
                ),
              }
            }
            return {
              ...g,
              photoIds: g.photoIds.filter((id) => !moving.has(id)),
              pairs: g.pairs.filter(
                (p) => !moving.has(p.beforeId) && !moving.has(p.afterId),
              ),
            }
          })
          .filter((g) => g.photoIds.length > 0),
      )
      notify('Moved')
    },
    [photoMap, clusterSettings, notify],
  )

  const deletePhotos = useCallback((photoIds: string[]) => {
    const doomed = new Set(photoIds)
    setPhotos((ps) => {
      ps.filter((p) => doomed.has(p.id)).forEach((p) => {
        URL.revokeObjectURL(p.proxyUrl)
        dropFromCache(p.id)
      })
      return ps.filter((p) => !doomed.has(p.id))
    })
    setGroups((gs) =>
      gs
        .map((g) => ({
          ...g,
          photoIds: g.photoIds.filter((id) => !doomed.has(id)),
          pairs: g.pairs.filter((p) => !doomed.has(p.beforeId) && !doomed.has(p.afterId)),
        }))
        .filter((g) => g.photoIds.length > 0),
    )
  }, [])

  /* -------------------------------------------------------------- pair edits */

  const updateGroup = useCallback((groupId: string, updater: (g: Group) => Group) => {
    setGroups((gs) => gs.map((g) => (g.id === groupId ? updater(g) : g)))
  }, [])

  /* ------------------------------------------------------------------- render */

  const pairCount = groups.reduce((n, g) => n + g.pairs.length, 0)
  const confirmedCount = groups.reduce(
    (n, g) => n + g.pairs.filter((p) => p.confirmed).length,
    0,
  )

  if (restoring) {
    return (
      <div className="boot">
        <div className="boot-mark">unbklok</div>
        <div className="boot-note">Checking for a saved session…</div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          unbklok
          <span className="brand-sub">detail studio</span>
        </div>
        <nav className="stages">
          {STAGES.map((s) => {
            const locked = s.id !== 'import' && photos.length === 0
            return (
              <button
                key={s.id}
                className={`stage-tab${stage === s.id ? ' active' : ''}`}
                disabled={locked}
                onClick={() => setStage(s.id)}
              >
                <span className="stage-num">{s.short}</span>
                <span className="stage-label">{s.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="counts">
          {photos.length > 0 && (
            <>
              <span>{photos.length} photos</span>
              <span className="dot">·</span>
              <span>{groups.length} cars</span>
              <span className="dot">·</span>
              <span>
                {confirmedCount}/{pairCount} pairs
              </span>
            </>
          )}
        </div>
      </header>

      <main className="content">
        {stage === 'import' && (
          <ImportView
            existingCount={photos.length}
            onImported={handleImported}
            onReset={reset}
            notify={notify}
          />
        )}
        {stage === 'cars' && (
          <GroupsView
            groups={groups}
            photoMap={photoMap}
            clusterSettings={clusterSettings}
            onRegroup={regroup}
            onRename={renameGroup}
            onMerge={mergeGroups}
            onSplit={splitPhotosToNewGroup}
            onMove={movePhotos}
            onDelete={deletePhotos}
            onNext={() => setStage('pairs')}
          />
        )}
        {stage === 'pairs' && (
          <PairView
            groups={groups}
            photoMap={photoMap}
            preset={preset}
            onUpdateGroup={updateGroup}
            onNext={() => setStage('style')}
          />
        )}
        {stage === 'style' && (
          <StyleView
            groups={groups}
            photoMap={photoMap}
            preset={preset}
            onChange={setPreset}
            onNext={() => setStage('export')}
          />
        )}
        {stage === 'export' && (
          <ExportView
            groups={groups}
            photoMap={photoMap}
            preset={preset}
            notify={notify}
          />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

/** Keep confirmed pairs, and fill in around them with fresh suggestions. */
function mergePairs(confirmed: Group['pairs'], suggested: Group['pairs']): Group['pairs'] {
  const claimed = new Set(confirmed.flatMap((p) => [p.beforeId, p.afterId]))
  const extra = suggested.filter(
    (p) => !claimed.has(p.beforeId) && !claimed.has(p.afterId),
  )
  return [...confirmed, ...extra]
}
