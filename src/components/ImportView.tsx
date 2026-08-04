import { useCallback, useEffect, useRef, useState } from 'react'
import { ingestFiles, type IngestProgress } from '../lib/ingest'
import type { Photo } from '../types'
import Icon from './Icon'

interface Props {
  existingCount: number
  onImported: (photos: Photo[]) => void
  onReset: () => void
  notify: (msg: string, undoable?: boolean) => void
}

const STEPS = [
  ['Import', 'Photos are read straight off this device. Nothing is uploaded anywhere.'],
  [
    'Cars',
    'Shots get sorted into cars automatically, using when they were taken and which ones are the same framing.',
  ],
  ['Pairs', 'Matching before/after shots are proposed. One tap or one key each.'],
  ['Style', 'Dial in the look once, with a live preview. It sticks for next time.'],
  ['Export', 'Share straight to Instagram, or download the lot as a ZIP.'],
]

/**
 * iPhone or iPad, including iPadOS pretending to be a Mac.
 *
 * Used only to decide whether to show advice about the iOS photo picker, so a
 * false positive costs a paragraph of irrelevant text and a false negative
 * costs nothing at all.
 */
const isApple =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/** Rounded hard, because a countdown that reads "3m 47s" invites watching it. */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 45) return 'less than a minute'
  const m = Math.round(s / 60)
  return m <= 1 ? 'a minute' : `${m} minutes`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export default function ImportView({ existingCount, onImported, onReset, notify }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<IngestProgress | null>(null)
  const [dragging, setDragging] = useState(false)
  const [landed, setLanded] = useState<string[]>([])

  const run = useCallback(
    async (fileList: FileList | File[]) => {
      const files = [...fileList].filter(
        (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name),
      )
      if (!files.length) {
        notify('No images in that selection')
        return
      }

      setBusy(true)
      setProgress({ done: 0, total: files.length, current: '' })
      setLanded([])
      try {
        const { photos, failures } = await ingestFiles(files, setProgress, (photo) => {
          /* Newest first, and only the last few are kept: this is a sign of life,
             not a gallery, and a hundred live <img> elements on a phone is the
             sort of thing that makes an import slower rather than faster. */
          setLanded((prev) => [photo.proxyUrl, ...prev].slice(0, 12))
        })
        onImported(photos)
        if (failures.length) {
          notify(
            `${failures.length} file${failures.length === 1 ? '' : 's'} couldn't be read (${failures[0].name})`,
          )
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Import failed')
      } finally {
        setBusy(false)
        setProgress(null)
        setLanded([])
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [onImported, notify],
  )

  /* A session of full-resolution photos is hundreds of megabytes, and the
     browser will start refusing writes at its quota with no warning of its own.
     Showing the number means a failed save is explicable rather than mysterious. */
  useEffect(() => {
    let cancelled = false
    void navigator.storage?.estimate?.().then((e) => {
      if (!cancelled && e.usage != null && e.quota != null) {
        setStorage({ used: e.usage, quota: e.quota })
      }
    })
    return () => {
      cancelled = true
    }
  }, [existingCount, busy])

  const pct = progress && progress.total ? (progress.done / progress.total) * 100 : 0
  const storagePct = storage ? (storage.used / storage.quota) * 100 : 0

  /* Only once there's a real rate to extrapolate from — an estimate that swings
     wildly for the first few photos is worse than none. */
  const left = progress ? progress.total - progress.done : 0
  const remaining =
    progress?.msPerPhoto && left > 0 ? formatDuration(progress.msPerPhoto * left) : null
  const slow = (progress?.msPerPhoto ?? 0) > 1500

  return (
    <main className="content" data-view="import">
      <div className="wrap">
        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (!busy && e.dataTransfer.files.length) void run(e.dataTransfer.files)
          }}
          onClick={() => !busy && inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !busy) inputRef.current?.click()
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => e.target.files && void run(e.target.files)}
          />

          {busy && progress ? (
            <div className="ingest">
              <div className="ingest-count mono">
                {progress.done}
                <span className="dim"> / {progress.total}</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="ingest-file">{progress.current || 'Finishing up'}</div>
              {remaining && <div className="tiny dim">about {remaining} left</div>}
              {/* Photos appearing one by one is the difference between "working"
                  and "hung". The count alone doesn't read as either. */}
              {landed.length > 0 && (
                <div className="ingest-strip" data-testid="ingest-strip">
                  {landed.map((url) => (
                    <img key={url} src={url} alt="" />
                  ))}
                </div>
              )}
              {/* A hundred photos off iCloud is a genuinely long wait, and a
                  progress bar with no explanation reads as a hang. */}
              {slow && (
                <p className="tiny dim ingest-note">
                  Photos kept in iCloud rather than on the phone have to download
                  first, which is most of this wait. Keep this tab open.
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="drop-icon">
                <Icon name="upload" size={22} />
              </div>
              <h2>Add your photos</h2>
              <p className="muted tiny">Tap to pick from your camera roll, or drop files here</p>
              <p className="dim tiny">JPEG · PNG · HEIC — nothing leaves this device</p>
            </>
          )}
        </div>

        {/* The long wait after tapping the checkmark happens before this app
            gets to run at all, so it can't be fixed here — only explained, and
            it has a fix worth knowing. */}
        {isApple && !busy && (
          <div className="card ios-tip">
            <div className="fieldset-body">
              <h3>Why the picker sits there after you tap ✓</h3>
              <p className="tiny muted">
                iOS converts every selected photo to JPEG before it hands them over,
                and shows nothing while it does. With a hundred photos that is most
                of the wait, and it happens before this page can react.
              </p>
              <ul className="tiny muted howto">
                <li>
                  <strong>Turn the conversion off.</strong> In the picker, tap{' '}
                  <strong>Options</strong> at the top and set <strong>Format</strong>{' '}
                  to <strong>Current</strong>. Originals are handed over as-is, and
                  they're about half the size.
                </li>
                <li>
                  <strong>Pick in batches.</strong> Thirty at a time comes back far
                  sooner than a hundred, and anything you add joins what's already
                  here.
                </li>
                <li>
                  <strong>Photos in iCloud download first.</strong> Ones already on
                  the phone are much quicker.
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* The exact build, where it can be found but isn't in the way. The
            header carries the version number for reading out; this is for when
            that isn't specific enough. */}
        <p className="tiny dim build-line mono" data-testid="build-line">
          v{__APP_VERSION__} · built {__BUILD_ID__}
        </p>

        <div className="steps-list">
          <h3 style={{ marginBottom: 4 }}>How it works</h3>
          <ol>
            {STEPS.map(([title, body], i) => (
              <li key={title}>
                <span className="step-num">{i + 1}</span>
                <span>
                  <strong>{title}</strong> — {body}
                </span>
              </li>
            ))}
          </ol>
        </div>

        {existingCount > 0 && (
          <div className="section" style={{ display: 'grid', gap: 12 }}>
            <p className="tiny muted">
              {existingCount} photos already loaded. Anything you add joins them.
            </p>
            {storage && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div className="bar">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.min(100, storagePct)}%`,
                      background: storagePct > 80 ? 'var(--no)' : undefined,
                    }}
                  />
                </div>
                <p className="tiny dim">
                  {formatBytes(storage.used)} of {formatBytes(storage.quota)} used on this
                  device
                  {storagePct > 80 && ' — nearly full, clear this session when you\'re done'}
                </p>
              </div>
            )}
            <button
              className="btn danger"
              onClick={() => {
                if (confirm('Clear all loaded photos and start over?')) onReset()
              }}
            >
              <Icon name="trash" size={17} />
              Clear everything
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
