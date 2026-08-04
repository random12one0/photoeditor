import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ExportView from './components/ExportView'
import GroupsView from './components/GroupsView'
import Icon from './components/Icon'
import ImportView from './components/ImportView'
import PairView from './components/PairView'
import ShortcutSheet from './components/ShortcutSheet'
import StyleView from './components/StyleView'
import { APP_NAME } from './brand'
import { clearBitmapCache, dropFromCache } from './lib/bitmapCache'
import { releaseScratch } from './lib/canvasPool'
import { DEFAULT_CLUSTER_SETTINGS, buildGroups, findPairs } from './lib/cluster'
import { refingerprint } from './lib/ingest'
import {
  clearSession,
  loadClusterSettings,
  loadPreset,
  loadSavedPresets,
  loadSession,
  saveClusterSettings,
  savePreset,
  saveSavedPresets,
  saveSession,
} from './lib/db'
import { bitmapToObjectUrl, decodeToProxy } from './lib/imaging'
import { DEFAULT_PRESET } from './lib/render'
import type {
  ClusterSettings,
  Group,
  Photo,
  SavedPreset,
  StylePreset,
} from './types'

export type Stage = 'import' | 'cars' | 'pairs' | 'style' | 'export'

const STAGES: { id: Stage; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'import', label: 'Import', icon: 'upload' },
  { id: 'cars', label: 'Cars', icon: 'cars' },
  { id: 'pairs', label: 'Pairs', icon: 'pair' },
  { id: 'style', label: 'Style', icon: 'sliders' },
  { id: 'export', label: 'Export', icon: 'share' },
]

/** One undoable step. Snapshots are shallow — cheap, since photos are shared. */
interface Snapshot {
  photos: Photo[]
  groups: Group[]
  label: string
}

const MAX_UNDO = 40

interface Toast {
  id: number
  message: string
  undoable: boolean
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [stage, setStage] = useState<Stage>('import')
  const [preset, setPreset] = useState<StylePreset>(() => loadPreset(DEFAULT_PRESET))
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => loadSavedPresets())
  const [clusterSettings, setClusterSettings] = useState<ClusterSettings>(() =>
    loadClusterSettings(DEFAULT_CLUSTER_SETTINGS),
  )
  const [restoring, setRestoring] = useState(true)
  const [toast, setToast] = useState<Toast | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)

  const history = useRef<Snapshot[]>([])
  const toastSeq = useRef(0)
  const toastTimer = useRef<number | undefined>(undefined)

  const photoMap = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  const notify = useCallback((message: string, undoable = false) => {
    const id = ++toastSeq.current
    setToast({ id, message, undoable })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(
      () => setToast((t) => (t?.id === id ? null : t)),
      undoable ? 5000 : 3000,
    )
  }, [])

  /** Record the current state so the next mutation can be taken back. */
  const checkpoint = useCallback(
    (label: string) => {
      history.current.push({ photos, groups, label })
      if (history.current.length > MAX_UNDO) history.current.shift()
    },
    [photos, groups],
  )

  const undo = useCallback(() => {
    const prev = history.current.pop()
    if (!prev) {
      notify('Nothing to undo')
      return
    }
    setPhotos(prev.photos)
    setGroups(prev.groups)
    notify(`Undid: ${prev.label}`)
  }, [notify])

  const canUndo = history.current.length > 0

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

          /* Re-derive everything computed from the pixels rather than trusting
             what was saved. The photo is already decoded here to rebuild its
             preview, so this costs almost nothing — and the alternative is
             running new matching code over fingerprints produced by an older
             build, which is precisely the bug this exists to prevent. */
          const fresh = saved.stale ? refingerprint(bitmap) : null
          bitmap.close()
          restored.push({
            ...meta,
            ...(fresh ?? {}),
            /* A session saved before shot quality existed has no score. Neutral
               rather than zero, so an old session doesn't rank every photo last. */
            quality: fresh?.quality ?? meta.quality ?? 0.5,
            file,
            proxyUrl,
          })
        }
        if (cancelled) return

        setPhotos(restored)

        /* Suggestions made by an older build carry its mistakes, and its pairs
           are missing whatever later versions added — runners-up, for one, so
           "not a pair" would still just delete rather than offering the next
           candidate. Rebuilding them is the only honest option, and it is
           undoable. */
        if (saved.stale && restored.length) {
          setGroups(buildGroups(restored, DEFAULT_CLUSTER_SETTINGS))
          setStage('cars')
          notify(
            `Matching has improved since this session was saved — ${restored.length} photos re-matched`,
            true,
          )
        } else {
          setGroups(saved.groups)
          if (restored.length) {
            setStage('cars')
            notify(`Picked up where you left off — ${restored.length} photos`)
          }
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
      void saveSession(photos, groups).catch(() =>
        notify('Could not save your session — storage may be full'),
      )
    }, 900)
    return () => window.clearTimeout(id)
  }, [photos, groups, restoring, notify])

  useEffect(() => savePreset(preset), [preset])
  useEffect(() => saveClusterSettings(clusterSettings), [clusterSettings])
  useEffect(() => saveSavedPresets(savedPresets), [savedPresets])

  /* ------------------------------------------------------------------ import */

  const handleImported = useCallback(
    (incoming: Photo[]) => {
      if (!incoming.length) return
      checkpoint('import')
      setPhotos((prev) => {
        const all = [...prev, ...incoming]
        setGroups(buildGroups(all, clusterSettings))
        return all
      })
      setStage('cars')
    },
    [clusterSettings, checkpoint],
  )

  const regroup = useCallback(
    (settings: ClusterSettings) => {
      checkpoint('re-group')
      setClusterSettings(settings)
      setGroups(buildGroups(photos, settings))
      notify('Re-grouped from scratch', true)
    },
    [photos, notify, checkpoint],
  )

  const reset = useCallback(async () => {
    photos.forEach((p) => URL.revokeObjectURL(p.proxyUrl))
    clearBitmapCache()
    releaseScratch()
    history.current = []
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
      checkpoint('merge cars')
      setGroups((gs) => {
        const chosen = gs.filter((g) => ids.includes(g.id))
        if (chosen.length < 2) return gs
        const target = chosen[0]
        const ordered = chosen
          .flatMap((g) => g.photoIds)
          .map((id) => photoMap.get(id))
          .filter((p): p is Photo => Boolean(p))
          .sort((a, b) => a.takenAt - b.takenAt)

        const merged: Group = {
          ...target,
          photoIds: ordered.map((p) => p.id),
          pairs: mergePairs(
            chosen.flatMap((g) => g.pairs).filter((p) => p.confirmed),
            findPairs(ordered, clusterSettings),
          ),
        }
        return gs
          .filter((g) => !ids.includes(g.id) || g.id === target.id)
          .map((g) => (g.id === target.id ? merged : g))
      })
      notify('Merged', true)
    },
    [photoMap, clusterSettings, notify, checkpoint],
  )

  const splitPhotosToNewGroup = useCallback(
    (fromGroupId: string, photoIds: string[]) => {
      if (!photoIds.length) return
      checkpoint('split out photos')
      const moving = new Set(photoIds)
      setGroups((gs) => {
        const source = gs.find((g) => g.id === fromGroupId)
        if (!source) return gs

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
          photoIds: source.photoIds.filter((id) => !moving.has(id)),
          pairs: source.pairs.filter(
            (p) => !moving.has(p.beforeId) && !moving.has(p.afterId),
          ),
        }

        const next = gs.map((g) => (g.id === fromGroupId ? updatedSource : g))
        next.splice(next.findIndex((g) => g.id === fromGroupId) + 1, 0, newGroup)
        return next.filter((g) => g.photoIds.length > 0)
      })
      notify(`Split ${photoIds.length} out`, true)
    },
    [photoMap, clusterSettings, notify, checkpoint],
  )

  const movePhotos = useCallback(
    (photoIds: string[], toGroupId: string) => {
      checkpoint('move photos')
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
      notify('Moved', true)
    },
    [photoMap, clusterSettings, notify, checkpoint],
  )

  const deletePhotos = useCallback(
    (photoIds: string[]) => {
      checkpoint('remove photos')
      const doomed = new Set(photoIds)
      setPhotos((ps) => {
        // Object URLs are deliberately NOT revoked here: undo restores these
        // same Photo objects, and a revoked URL would come back blank.
        ps.filter((p) => doomed.has(p.id)).forEach((p) => dropFromCache(p.id))
        return ps.filter((p) => !doomed.has(p.id))
      })
      setGroups((gs) =>
        gs
          .map((g) => ({
            ...g,
            photoIds: g.photoIds.filter((id) => !doomed.has(id)),
            pairs: g.pairs.filter(
              (p) => !doomed.has(p.beforeId) && !doomed.has(p.afterId),
            ),
          }))
          .filter((g) => g.photoIds.length > 0),
      )
      notify(`Removed ${photoIds.length}`, true)
    },
    [notify, checkpoint],
  )

  const updateGroup = useCallback(
    (groupId: string, updater: (g: Group) => Group, label?: string) => {
      if (label) checkpoint(label)
      setGroups((gs) => gs.map((g) => (g.id === groupId ? updater(g) : g)))
    },
    [checkpoint],
  )

  /**
   * Correct a photo's capture time.
   *
   * Everything downstream — which car a photo lands in, which shots are the
   * before batch, which pairs get proposed — is built on these timestamps. When
   * a photo arrives without EXIF, or with a time set by whatever copied it
   * rather than the camera, the grouping inherits that error and no amount of
   * merging and splitting really fixes it. Editing the time at the source does.
   */
  const setPhotoTime = useCallback(
    (photoId: string, takenAt: number) => {
      checkpoint('change photo time')
      setPhotos((ps) =>
        ps.map((p) =>
          p.id === photoId ? { ...p, takenAt, timeIsApproximate: false } : p,
        ),
      )
      // Keep each car's photos in time order so the before/after split, which
      // looks for the widest internal pause, still sees the right sequence.
      setGroups((gs) =>
        gs.map((g) => ({
          ...g,
          photoIds: [...g.photoIds].sort((a, b) => {
            const ta = a === photoId ? takenAt : (photoMap.get(a)?.takenAt ?? 0)
            const tb = b === photoId ? takenAt : (photoMap.get(b)?.takenAt ?? 0)
            return ta - tb
          }),
        })),
      )
      notify('Time updated — re-group to rebuild the cars around it', true)
    },
    [photoMap, notify, checkpoint],
  )

  /* ---------------------------------------------------------------- presets */

  const savePresetAs = useCallback(
    (name: string) => {
      const entry: SavedPreset = {
        id: `sp${Date.now().toString(36)}`,
        name,
        preset,
      }
      setSavedPresets((ps) => [...ps.filter((p) => p.name !== name), entry])
      notify(`Saved "${name}"`)
    },
    [preset, notify],
  )

  const applyPreset = useCallback(
    (id: string) => {
      const found = savedPresets.find((p) => p.id === id)
      if (found) {
        setPreset(found.preset)
        notify(`Applied "${found.name}"`)
      }
    },
    [savedPresets, notify],
  )

  const deletePreset = useCallback((id: string) => {
    setSavedPresets((ps) => ps.filter((p) => p.id !== id))
  }, [])

  /* -------------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return

      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault()
        setShowShortcuts((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      } else if (e.key === 'Escape') {
        setShowShortcuts(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo])

  /* ------------------------------------------------------------------ render */

  const pairCount = groups.reduce((n, g) => n + g.pairs.length, 0)
  const confirmedCount = groups.reduce(
    (n, g) => n + g.pairs.filter((p) => p.confirmed).length,
    0,
  )

  if (restoring) {
    return (
      <div className="boot">
        <div className="boot-mark">{APP_NAME}</div>
        <div className="spinner" />
        <div className="tiny dim">Looking for a saved session</div>
      </div>
    )
  }

  const stageDone: Record<Stage, boolean> = {
    import: photos.length > 0,
    cars: groups.length > 0,
    pairs: pairCount > 0 && confirmedCount === pairCount,
    style: false,
    export: false,
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          {/* The version, on screen. A stale cached build and a genuinely broken
              feature look identical from the outside; this is the difference
              between diagnosing that and guessing at it. The number is short
              enough to read out; the date and commit sit under Import for when
              that isn't specific enough. */}
          <div className="brand" title={`Build ${__BUILD_ID__}`}>
            <span className="brand-dot" />
            {APP_NAME}
            <span className="build-id mono dim" data-testid="build-id">
              v{__APP_VERSION__}
            </span>
          </div>
          <div className="counts">
            {photos.length > 0 && (
              <>
                <span className="mono" title="photos">
                  {photos.length}
                </span>
                <span className="dim label">photos</span>
                <span className="mono" title="cars">
                  {groups.length}
                </span>
                <span className="dim label">cars</span>
                <span className="mono" title="pairs confirmed">
                  {confirmedCount}/{pairCount}
                </span>
                <span className="dim label">pairs</span>
              </>
            )}
          </div>
          <button
            className="icon-btn"
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Icon name="undo" />
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Icon name="keyboard" />
          </button>
        </div>

        <nav className="stepper" aria-label="Stages">
          {STAGES.map((s) => {
            const locked = s.id !== 'import' && photos.length === 0
            return (
              <button
                key={s.id}
                className="step"
                data-step={s.id}
                aria-current={stage === s.id ? 'step' : undefined}
                disabled={locked}
                onClick={() => setStage(s.id)}
              >
                <Icon
                  name={stageDone[s.id] && stage !== s.id ? 'check' : s.icon}
                  size={16}
                  className={stageDone[s.id] && stage !== s.id ? 'step-done' : undefined}
                />
                {s.label}
              </button>
            )
          })}
        </nav>
      </header>

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
          onSetTime={setPhotoTime}
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
          notify={notify}
        />
      )}
      {stage === 'style' && (
        <StyleView
          groups={groups}
          photoMap={photoMap}
          preset={preset}
          savedPresets={savedPresets}
          onChange={setPreset}
          onSavePreset={savePresetAs}
          onApplyPreset={applyPreset}
          onDeletePreset={deletePreset}
          onNext={() => setStage('export')}
          notify={notify}
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

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undoable && canUndo && (
            <button
              onClick={() => {
                undo()
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}

      {showShortcuts && <ShortcutSheet onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}

/** Keep confirmed pairs, and fill in around them with fresh suggestions. */
function mergePairs(confirmed: Group['pairs'], suggested: Group['pairs']): Group['pairs'] {
  const claimed = new Set(confirmed.flatMap((p) => [p.beforeId, p.afterId]))
  return [
    ...confirmed,
    ...suggested.filter((p) => !claimed.has(p.beforeId) && !claimed.has(p.afterId)),
  ]
}
