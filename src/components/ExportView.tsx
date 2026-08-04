import { useEffect, useMemo, useState } from 'react'
import {
  countExportItems,
  downloadBlob,
  exportZip,
  pairsOf,
  renderAllComposites,
  renderPairBlob,
  selectedGroups,
  type ExportOptions,
  type ExportProgress,
} from '../lib/exporter'
import {
  canShareFiles,
  copyImage,
  haptic,
  isEmbedded,
  shareFiles,
  supportsImageShare,
} from '../lib/share'
import type { Group, Photo, StylePreset } from '../types'
import Icon from './Icon'
import PairPreview from './PairPreview'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  preset: StylePreset
  notify: (msg: string, undoable?: boolean) => void
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function ExportView({ groups, photoMap, preset, notify }: Props) {
  const [includeSingles, setIncludeSingles] = useState(true)
  const [confirmedOnly, setConfirmedOnly] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [canShare, setCanShare] = useState(false)
  const [embedded, setEmbedded] = useState(false)

  useEffect(() => {
    setCanShare(supportsImageShare())
    setEmbedded(isEmbedded())
  }, [])

  const options: ExportOptions = useMemo(
    () => ({ includeSingles, confirmedOnly, groupIds: [...selected] }),
    [includeSingles, confirmedOnly, selected],
  )

  const itemCount = useMemo(
    () => countExportItems(groups, photoMap, options),
    [groups, photoMap, options],
  )

  const compositeCount = useMemo(
    () =>
      selectedGroups(groups, options).reduce((n, g) => n + pairsOf(g, options).length, 0),
    [groups, options],
  )

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const shareAll = () =>
    withBusy(async () => {
      const files = await renderAllComposites(
        groups,
        photoMap,
        preset,
        options,
        setProgress,
      )
      if (!files.length) {
        notify('Nothing to share')
        return
      }
      const outcome = await shareFiles(files, 'Before & after')
      if (outcome === 'shared') {
        haptic(14)
        notify(`Shared ${files.length}`)
      } else if (outcome === 'unsupported') {
        notify('Sharing not available here — downloading instead')
        files.forEach((f, i) => setTimeout(() => downloadBlob(f, f.name), i * 260))
      }
    })

  const downloadAll = () =>
    withBusy(async () => {
      const blob = await exportZip(groups, photoMap, preset, options, setProgress)
      const name = `unbklok-${stamp()}.zip`

      /* Try the share sheet first where a plain download can't be trusted.
         Inside an embedded frame the browser blocks the download silently —
         nothing happens, nothing is reported — and on a phone the share sheet
         is the better destination anyway: it can put the file in Files, in a
         message, or straight into another app. */
      const zipFile = new File([blob], name, { type: 'application/zip' })
      if (isEmbedded() && canShareFiles([zipFile])) {
        const outcome = await shareFiles([zipFile], 'Before & after')
        if (outcome === 'shared') {
          notify('ZIP shared')
          return
        }
        if (outcome === 'cancelled') return
      }

      downloadBlob(blob, name)
      notify(
        isEmbedded()
          ? 'ZIP built — if nothing saved, downloads are blocked in this embedded view'
          : 'ZIP downloaded',
      )
    })

  const shareOne = (group: Group, index: number) =>
    withBusy(async () => {
      const pair = pairsOf(group, options)[index]
      const before = photoMap.get(pair.beforeId)
      const after = photoMap.get(pair.afterId)
      if (!before || !after) return
      const blob = await renderPairBlob(before, after, preset)
      const file = new File([blob], `${group.name.replace(/[^\w -]/g, '')}-${index + 1}.jpg`, {
        type: 'image/jpeg',
      })
      if (canShare) {
        const outcome = await shareFiles([file], group.name)
        if (outcome === 'shared') haptic(14)
      } else {
        downloadBlob(file, file.name)
      }
    })

  const copyOne = (group: Group, index: number) =>
    withBusy(async () => {
      const pair = pairsOf(group, options)[index]
      const before = photoMap.get(pair.beforeId)
      const after = photoMap.get(pair.afterId)
      if (!before || !after) return
      const blob = await renderPairBlob(before, after, preset)
      notify((await copyImage(blob)) ? 'Copied to clipboard' : 'Clipboard not available')
    })

  const pct = progress && progress.total ? (progress.done / progress.total) * 100 : 0

  return (
    <>
      <main className="content has-actionbar" data-view="export">
        <div className="wrap">
          {/* Downloads are blocked inside an embedded frame, and blocked
              silently — the click does nothing and reports nothing. Better to
              say so up front than to let it look like the export is broken. */}
          {embedded && (
            <div className="notice" data-testid="embedded-notice">
              <Icon name="sparkle" size={16} />
              <div>
                <strong>Downloads may not work here.</strong> This page is running
                inside another page, and browsers block file downloads from an
                embedded frame. <strong>Share</strong> and <strong>Copy</strong>{' '}
                still work. For ZIPs, open the app at its own web address.
              </div>
            </div>
          )}

          <div className="export-hero">
            <div>
              <div className="export-count mono">{compositeCount}</div>
              <p className="muted tiny">
                composite{compositeCount === 1 ? '' : 's'} at {preset.exportSize}px,{' '}
                {preset.ratio}
                {includeSingles && itemCount > compositeCount
                  ? ` · plus ${itemCount - compositeCount} unpaired original${
                      itemCount - compositeCount === 1 ? '' : 's'
                    }`
                  : ''}
              </p>
            </div>

            {busy && progress && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <p className="tiny dim mono">
                  {progress.done} / {progress.total} — {progress.label}
                </p>
              </div>
            )}

            <label className="check">
              <input
                type="checkbox"
                checked={confirmedOnly}
                onChange={(e) => setConfirmedOnly(e.target.checked)}
              />
              <span>
                Only confirmed pairs
                <span className="dim tiny"> — untick to include unreviewed suggestions</span>
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={includeSingles}
                onChange={(e) => setIncludeSingles(e.target.checked)}
              />
              <span>
                Include unpaired photos in the ZIP
                <span className="dim tiny"> — originals, untouched</span>
              </span>
            </label>
          </div>

          <div className="section-head">
            <h3>Cars</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn ghost sm" onClick={() => setSelected(new Set())}>
                All
              </button>
              <button
                className="btn ghost sm"
                onClick={() => setSelected(new Set(groups.map((g) => g.id)))}
              >
                Pick
              </button>
            </div>
          </div>
          <p className="tiny dim" style={{ marginBottom: 12 }}>
            {selected.size === 0
              ? 'Everything is included. Tick cars to narrow it down.'
              : `${selected.size} car${selected.size === 1 ? '' : 's'} selected.`}
          </p>

          {groups.map((group) => {
            const pairs = pairsOf(group, options)
            const active = selected.size === 0 || selected.has(group.id)
            return (
              <section key={group.id} className="card" style={{ opacity: active ? 1 : 0.45 }}>
                <header className="card-head">
                  <label className="tick">
                    <input
                      type="checkbox"
                      checked={selected.has(group.id)}
                      onChange={() => toggle(group.id)}
                      aria-label={`Select ${group.name}`}
                    />
                  </label>
                  <strong style={{ flex: 1, fontSize: '0.92rem' }}>{group.name}</strong>
                  <span className="pill good">{pairs.length}</span>
                </header>

                {pairs.length > 0 && (
                  <div className="card-body">
                    <div className="export-grid">
                      {pairs.map((pair, i) => {
                        const b = photoMap.get(pair.beforeId)
                        const a = photoMap.get(pair.afterId)
                        if (!b || !a) return null
                        return (
                          <div className="export-tile" key={pair.id}>
                            <PairPreview
                              before={b}
                              after={a}
                              preset={preset}
                              maxWidth={150}
                              fill
                            />
                            <div className="export-tile-actions">
                              <button
                                className="mini-btn"
                                disabled={busy}
                                onClick={() => void shareOne(group, i)}
                                aria-label={canShare ? 'Share' : 'Download'}
                                title={canShare ? 'Share' : 'Download'}
                              >
                                <Icon name={canShare ? 'share' : 'download'} size={16} />
                              </button>
                              <button
                                className="mini-btn"
                                disabled={busy}
                                onClick={() => void copyOne(group, i)}
                                aria-label="Copy to clipboard"
                                title="Copy"
                              >
                                <Icon name="copy" size={16} />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </main>

      <div className="actionbar">
        <div className="actionbar-inner">
          {canShare && (
            <button
              className="btn primary"
              style={{ flex: 1 }}
              disabled={busy || compositeCount === 0}
              onClick={() => void shareAll()}
            >
              <Icon name="share" size={17} />
              {busy ? 'Working…' : `Share ${compositeCount}`}
            </button>
          )}
          <button
            className={`btn${canShare ? '' : ' primary'}`}
            style={{ flex: 1 }}
            disabled={busy || itemCount === 0}
            onClick={() => void downloadAll()}
          >
            <Icon name="download" size={17} />
            {busy && !canShare ? 'Working…' : `ZIP (${itemCount})`}
          </button>
        </div>
      </div>
    </>
  )
}
