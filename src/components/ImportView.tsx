import { useCallback, useRef, useState } from 'react'
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

export default function ImportView({ existingCount, onImported, onReset, notify }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<IngestProgress | null>(null)
  const [dragging, setDragging] = useState(false)

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
      try {
        const { photos, failures } = await ingestFiles(files, setProgress)
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
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [onImported, notify],
  )

  const pct = progress && progress.total ? (progress.done / progress.total) * 100 : 0

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
