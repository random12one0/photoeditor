import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BurstsView from './components/BurstsView'
import ExportView from './components/ExportView'
import Icon from './components/Icon'
import LeftoversView from './components/LeftoversView'
import ShortcutSheet from './components/ShortcutSheet'
import StyleView from './components/StyleView'
import VerifyPairsView from './components/VerifyPairsView'
import { APP_NAME } from './brand'
import {
  browseFolder,
  createJob,
  fetchFullFile,
  getJob,
  getPhotos,
  jobEventsUrl,
  solveJob,
  addConstraint as apiAddConstraint,
  undoLastConstraint as apiUndoLast,
} from './lib/api'
import type { ApiCarSolution, ApiPhoto, ConstraintIn, JobSummary } from './lib/api'
import { loadPreset, loadSavedPresets, loadTransforms, savePreset, saveSavedPresets, saveTransforms } from './lib/db'
import { buildGroups, buildPhotoMap, buildPhotoMapSync, hasAnyTransform } from './lib/photoAdapter'
import { DEFAULT_PRESET } from './lib/render'
import type { PhotoTransform } from './lib/transform'
import { IDENTITY_TRANSFORM } from './lib/transform'
import type { Photo, SavedPreset, StylePreset } from './types'

export type Stage = 'choose' | 'bursts' | 'verify' | 'leftovers' | 'style' | 'export'

const STAGES: { id: Stage; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'choose', label: 'Folder', icon: 'upload' },
  { id: 'bursts', label: 'Bursts', icon: 'cars' },
  { id: 'verify', label: 'Verify', icon: 'pair' },
  { id: 'leftovers', label: 'Leftovers', icon: 'flask' },
  { id: 'style', label: 'Style', icon: 'sliders' },
  { id: 'export', label: 'Export', icon: 'share' },
]

interface Toast {
  id: number
  message: string
}

export default function App() {
  const [stage, setStage] = useState<Stage>('choose')
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<JobSummary | null>(null)
  const [apiPhotos, setApiPhotos] = useState<ApiPhoto[]>([])
  const [cars, setCars] = useState<ApiCarSolution[]>([])
  const [files, setFiles] = useState<Map<string, File>>(new Map())
  const [transforms, setTransforms] = useState<Map<string, PhotoTransform>>(() => loadTransforms())
  const [preparingExport, setPreparingExport] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [checkingNow, setCheckingNow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)

  const [preset, setPreset] = useState<StylePreset>(() => loadPreset(DEFAULT_PRESET))
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => loadSavedPresets())

  const toastSeq = useRef(0)
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback((message: string) => {
    const id = ++toastSeq.current
    setToast({ id, message })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 3200)
  }, [])

  useEffect(() => savePreset(preset), [preset])
  useEffect(() => saveSavedPresets(savedPresets), [savedPresets])
  useEffect(() => saveTransforms(transforms), [transforms])

  const setPhotoTransform = useCallback((photoId: string, patch: Partial<PhotoTransform>) => {
    setTransforms((prev) => {
      const next = new Map(prev)
      next.set(photoId, { ...(prev.get(photoId) ?? IDENTITY_TRANSFORM), ...patch })
      return next
    })
  }, [])

  // Reattach to a job by id from the URL (?job=...) -- lets a reload pick
  // back up instead of losing the whole session, and gives the folder-pick
  // step a URL worth bookmarking mid-job.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('job')
    if (fromUrl) setJobId(fromUrl)
  }, [])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (jobId) url.searchParams.set('job', jobId)
    else url.searchParams.delete('job')
    window.history.replaceState(null, '', url)
  }, [jobId])

  /* ------------------------------------------------------------- job intake */

  const chooseFolder = useCallback(async () => {
    setError(null)
    setBrowsing(true)
    try {
      const picked = await browseFolder()
      if (picked.cancelled || !picked.path) return
      const summary = await createJob(picked.path)
      setJobId(summary.id)
      setJob(summary)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the local server')
    } finally {
      setBrowsing(false)
    }
  }, [])

  // Applying one status snapshot -- shared by the SSE stream below and the
  // manual "Check now" fallback, so both paths do the exact same "job just
  // finished" handoff into loading photos/solve and moving to Bursts.
  const applyJobSummary = useCallback(
    async (summary: JobSummary) => {
      setJob(summary)
      if (summary.status === 'ready' && jobId) {
        const [photos, solved] = await Promise.all([getPhotos(jobId), solveJob(jobId)])
        setApiPhotos(photos)
        setCars(solved)
        setStage('bursts')
      }
    },
    [jobId],
  )

  // Manual fallback -- a direct request-response check, for the "Check now"
  // button on the progress screen. Kept even though the server now pushes
  // status over SSE below, as a belt-and-suspenders escape hatch: an
  // EventSource that silently wedges is a smaller, more specific failure
  // mode than the plain setTimeout poll loop this replaced, but "smaller"
  // isn't "impossible", and a manual button that always works costs nothing
  // to keep around.
  const checkJobNow = useCallback(async (): Promise<JobSummary | null> => {
    if (!jobId) return null
    try {
      const summary = await getJob(jobId)
      await applyJobSummary(summary)
      return summary
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lost contact with the local server')
      return null
    }
  }, [jobId, applyJobSummary])

  // Server-pushed job status over SSE, in place of the frontend asking on
  // its own timer. Why this replaced polling: a plain client-side
  // setTimeout loop was reported live to silently stop advancing in a real
  // browser session -- the job had actually finished server-side, but the
  // tab sat showing a stale progress message indefinitely, and the cause
  // wasn't reproducible in testing. Rather than keep guessing at that one
  // browser's specific timer/throttling behaviour, this removes the whole
  // class of bug: the server announces state changes over one long-lived
  // connection, and EventSource reconnects on its own if that connection
  // drops, which a hand-rolled retry loop doesn't get for free.
  useEffect(() => {
    if (!jobId || job?.status === 'ready' || job?.status === 'error') return
    let cancelled = false
    const source = new EventSource(jobEventsUrl(jobId))

    source.onmessage = (ev) => {
      if (cancelled) return
      let summary: (JobSummary & { error?: string }) | null = null
      try {
        summary = JSON.parse(ev.data)
      } catch {
        return
      }
      if (!summary) return
      if (summary.error) {
        setError(summary.error)
        source.close()
        return
      }
      void applyJobSummary(summary)
      if (summary.status === 'ready' || summary.status === 'error') source.close()
    }

    return () => {
      cancelled = true
      source.close()
    }
  }, [jobId, job?.status, applyJobSummary])

  /* -------------------------------------------------------------- constraints */

  const applyConstraint = useCallback(
    async (c: ConstraintIn) => {
      if (!jobId) return
      const solved = await apiAddConstraint(jobId, c)
      setCars(solved)
    },
    [jobId],
  )

  const undo = useCallback(async () => {
    if (!jobId) return
    const solved = await apiUndoLast(jobId)
    setCars(solved)
    notify('Undid last change')
  }, [jobId, notify])

  /* -------------------------------------------------------------------- style */

  const photoById = useMemo(() => new Map(apiPhotos.map((p) => [p.id, p])), [apiPhotos])

  const enterStyle = useCallback(async () => {
    if (!jobId || apiPhotos.length === 0) {
      setStage('style')
      return
    }
    setPreparingExport(true)
    try {
      const entries = await Promise.all(
        apiPhotos.map(async (p) => [p.id, await fetchFullFile(jobId, p)] as const),
      )
      setFiles(new Map(entries))
      setStage('style')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not load full-resolution photos')
    } finally {
      setPreparingExport(false)
    }
  }, [jobId, apiPhotos, notify])

  const groups = useMemo(() => buildGroups(cars), [cars])

  // Synchronous fast path first, always -- correct immediately for the
  // common case (nothing has been rotated/flipped/zoomed), no flash of an
  // empty Style preview while an unnecessary async round trip settles. Only
  // when a transform is actually in play does the async path (baking the
  // correction into a fetched/decoded/re-encoded proxyUrl or File -- see
  // transform.ts) get invoked, and its result then overwrites the base map.
  const basePhotoMap = useMemo(
    () => buildPhotoMapSync(apiPhotos, jobId ?? '', files),
    [apiPhotos, jobId, files],
  )
  const [photoMap, setPhotoMap] = useState<Map<string, Photo>>(basePhotoMap)
  useEffect(() => {
    if (!hasAnyTransform(apiPhotos, transforms)) {
      setPhotoMap(basePhotoMap)
      return
    }
    let cancelled = false
    void buildPhotoMap(apiPhotos, jobId ?? '', files, transforms).then((map) => {
      if (!cancelled) setPhotoMap(map)
    })
    return () => {
      cancelled = true
    }
  }, [basePhotoMap, apiPhotos, jobId, files, transforms])

  const savePresetAs = useCallback(
    (name: string) => {
      const entry: SavedPreset = { id: `sp${Date.now().toString(36)}`, name, preset }
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
  const deletePreset = useCallback((id: string) => setSavedPresets((ps) => ps.filter((p) => p.id !== id)), [])

  /* ------------------------------------------------------------------ render */

  const pairCount = cars.reduce((n, c) => n + c.pairs.length, 0)
  const confirmedCount = cars.reduce((n, c) => n + c.pairs.filter((p) => p.tier === 'confirmed').length, 0)
  const jobActive = jobId !== null && stage !== 'choose'

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <div className="brand" title={`Build ${__BUILD_ID__}`}>
            <span className="brand-dot" />
            {APP_NAME}
            <span className="build-id mono dim" data-testid="build-id">
              v{__APP_VERSION__}
            </span>
          </div>
          <div className="counts">
            {apiPhotos.length > 0 && (
              <>
                <span className="mono" title="photos">{apiPhotos.length}</span>
                <span className="dim label">photos</span>
                <span className="mono" title="cars">{cars.length}</span>
                <span className="dim label">cars</span>
                <span className="mono" title="pairs confirmed">{confirmedCount}/{pairCount}</span>
                <span className="dim label">pairs</span>
              </>
            )}
          </div>
          <button
            className="icon-btn"
            onClick={() => void undo()}
            disabled={!jobActive}
            title="Undo last constraint"
            aria-label="Undo"
          >
            <Icon name="undo" />
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
          >
            <Icon name="keyboard" />
          </button>
        </div>

        <nav className="stepper" aria-label="Stages">
          {STAGES.map((s) => {
            const locked = s.id !== 'choose' && !jobActive
            return (
              <button
                key={s.id}
                className="step"
                data-step={s.id}
                aria-current={stage === s.id ? 'step' : undefined}
                disabled={locked}
                onClick={() => setStage(s.id)}
              >
                <Icon name={s.icon} size={16} />
                {s.label}
              </button>
            )
          })}
        </nav>
      </header>

      {stage === 'choose' && (
        <main className="content">
          <div className="wrap" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh', gap: 16 }}>
            {!job || job.status === 'error' ? (
              <>
                <p className="muted" style={{ textAlign: 'center', maxWidth: 420 }}>
                  Point this at a folder of photos from one day's work. Everything runs on this
                  machine — nothing uploads anywhere.
                </p>
                <button className="btn primary" disabled={browsing} onClick={() => void chooseFolder()}>
                  <Icon name="upload" size={17} />
                  {browsing ? 'Opening…' : 'Choose a folder'}
                </button>
                {(error || job?.status === 'error') && (
                  <p className="tiny" style={{ color: 'var(--no, #e5484d)' }}>
                    {error ?? job?.message}
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="spinner" />
                <p className="tiny dim mono">{job.message || job.status}</p>
                <div className="bar" style={{ width: 260 }}>
                  <div className="bar-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </div>
                <button
                  className="btn ghost sm"
                  disabled={checkingNow}
                  onClick={() => {
                    setCheckingNow(true)
                    void checkJobNow().finally(() => setCheckingNow(false))
                  }}
                >
                  {checkingNow ? 'Checking…' : 'Check now'}
                </button>
                <p className="tiny dim" style={{ textAlign: 'center', maxWidth: 320 }}>
                  This updates itself as the server works. If it looks stuck,
                  "Check now" always asks directly.
                </p>
              </>
            )}
          </div>
        </main>
      )}

      {stage === 'bursts' && jobId && (
        <BurstsView jobId={jobId} cars={cars} photoById={photoById} onConstraint={applyConstraint} onNext={() => setStage('verify')} />
      )}
      {stage === 'verify' && jobId && (
        <VerifyPairsView
          jobId={jobId}
          cars={cars}
          photoById={photoById}
          onConstraint={applyConstraint}
          transforms={transforms}
          onSetTransform={setPhotoTransform}
          onNext={() => setStage('leftovers')}
        />
      )}
      {stage === 'leftovers' && jobId && (
        <LeftoversView jobId={jobId} cars={cars} photoById={photoById} onConstraint={applyConstraint} onNext={() => void enterStyle()} />
      )}
      {stage === 'style' && (
        preparingExport ? (
          <main className="content">
            <div className="wrap" style={{ display: 'grid', placeItems: 'center', minHeight: '40vh', gap: 12 }}>
              <div className="spinner" />
              <p className="tiny dim">Loading full-resolution photos…</p>
            </div>
          </main>
        ) : (
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
        )
      )}
      {stage === 'export' && (
        <ExportView groups={groups} photoMap={photoMap} preset={preset} notify={notify} />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
        </div>
      )}

      {showShortcuts && <ShortcutSheet onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}
