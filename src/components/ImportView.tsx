import { useCallback, useRef, useState } from 'react'
import { ingestFiles, type IngestProgress } from '../lib/ingest'
import type { Photo } from '../types'

interface Props {
  existingCount: number
  onImported: (photos: Photo[]) => void
  onReset: () => void
  notify: (msg: string) => void
}

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
        notify('No images found in that selection')
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
    <div className="view import-view">
      <div
        className={`dropzone${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
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
            <div className="ingest-count">
              {progress.done} / {progress.total}
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="ingest-file">{progress.current || 'Finishing up…'}</div>
          </div>
        ) : (
          <>
            <div className="drop-icon" aria-hidden>
              ⬆
            </div>
            <h2>Drop your photos here</h2>
            <p className="muted">or tap to pick from your camera roll</p>
            <p className="muted tiny">
              JPEG, PNG, WebP, HEIC · nothing is uploaded anywhere
            </p>
          </>
        )}
      </div>

      <div className="explainer">
        <h3>How this works</h3>
        <ol>
          <li>
            <strong>Import</strong> — photos are read straight off your device. They never
            leave it.
          </li>
          <li>
            <strong>Cars</strong> — shots are split into cars by when they were taken, then
            sessions that share a matching angle get stitched back together, so the before
            batch and the after batch land in one car.
          </li>
          <li>
            <strong>Pairs</strong> — matching before/after shots are suggested for you.
            Confirm or reject them fast with one key or one tap.
          </li>
          <li>
            <strong>Style</strong> — dial in the look once with a live preview.
          </li>
          <li>
            <strong>Export</strong> — one ZIP, one folder per car, finished composites
            inside.
          </li>
        </ol>
      </div>

      {existingCount > 0 && (
        <div className="danger-row">
          <span className="muted">
            {existingCount} photos already loaded. New imports get added to them.
          </span>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm('Clear all loaded photos and start over?')) onReset()
            }}
          >
            Clear everything
          </button>
        </div>
      )}
    </div>
  )
}
