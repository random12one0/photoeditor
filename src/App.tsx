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
  solveJob,
  addConstraint as apiAddConstraint,
  undoLastConstraint as apiUndoLast,
} from './lib/api'
import type { ApiCarSolution, ApiPhoto, ConstraintIn, JobSummary } from './lib/api'
import { loadPreset, loadSavedPresets, savePreset, saveSavedPresets } from './lib/db'
import { buildGroups, buildPhotoMap } from './lib/photoAdapter'
import { DEFAULT_PRESET } from './lib/render'
import type { SavedPreset, StylePreset } from './types'

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
  const [preparingExport, setPreparingExport] = useState(false)
  const [browsing, setBrowsing] = useState(false)
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

  // Poll job status until the pipeline finishes, then load its solved cars.
  useEffect(() => {
    if (!jobId || job?.status === 'ready' || job?.status === 'error') return
    let cancelled = false
    const tick = async () => {
      try {
        const summary = await getJob(jobId)
        if (cancelled) return
        setJob(summary)
        if (summary.status === 'ready') {
          const [photos, solved] = await Promise.all([getPhotos(jobId), solveJob(jobId)])
          if (cancelled) return
          setApiPhotos(photos)
          setCars(solved)
          setStage('bursts')
        } else if (summary.status !== 'error') {
          window.setTimeout(tick, 1200)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Lost contact with the local server')
      }
    }
    void tick()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

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
  const photoMap = useMemo(
    () => buildPhotoMap(apiPhotos, jobId ?? '', files),
    [apiPhotos, jobId, files],
  )

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
              </>
            )}
          </div>
        </main>
      )}

      {stage === 'bursts' && jobId && (
        <BurstsView jobId={jobId} cars={cars} photoById={photoById} onConstraint={applyConstraint} onNext={() => setStage('verify')} />
      )}
      {stage === 'verify' && jobId && (
        <VerifyPairsView jobId={jobId} cars={cars} photoById={photoById} onConstraint={applyConstraint} onNext={() => setStage('leftovers')} />
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
