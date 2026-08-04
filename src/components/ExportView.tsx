import { useMemo, useState } from 'react'
import {
  countExportItems,
  downloadBlob,
  exportZip,
  renderPairBlob,
  type ExportOptions,
  type ExportProgress,
} from '../lib/exporter'
import type { Group, Photo, StylePreset } from '../types'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  preset: StylePreset
  notify: (msg: string) => void
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

  const options: ExportOptions = useMemo(
    () => ({ includeSingles, confirmedOnly, groupIds: [...selected] }),
    [includeSingles, confirmedOnly, selected],
  )

  const itemCount = useMemo(
    () => countExportItems(groups, photoMap, options),
    [groups, photoMap, options],
  )

  const compositeCount = useMemo(() => {
    const wanted = selected.size ? groups.filter((g) => selected.has(g.id)) : groups
    return wanted.reduce(
      (n, g) => n + g.pairs.filter((p) => !confirmedOnly || p.confirmed).length,
      0,
    )
  }, [groups, selected, confirmedOnly])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const runExport = async () => {
    if (compositeCount === 0 && !includeSingles) {
      notify('Nothing selected to export')
      return
    }
    setBusy(true)
    try {
      const blob = await exportZip(groups, photoMap, preset, options, setProgress)
      downloadBlob(blob, `unbklok-${stamp()}.zip`)
      notify('ZIP downloaded')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const exportOnePair = async (group: Group, index: number) => {
    const pair = group.pairs[index]
    const before = photoMap.get(pair.beforeId)
    const after = photoMap.get(pair.afterId)
    if (!before || !after) return
    setBusy(true)
    try {
      const blob = await renderPairBlob(before, after, preset)
      downloadBlob(blob, `${group.name.replace(/[^\w -]/g, '')}-${index + 1}.jpg`)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Render failed')
    } finally {
      setBusy(false)
    }
  }

  const pct = progress && progress.total ? (progress.done / progress.total) * 100 : 0

  return (
    <div className="view export-view">
      <div className="view-head">
        <div>
          <h2>Export</h2>
          <p className="muted">One ZIP, one folder per car.</p>
        </div>
        <button className="btn primary big" disabled={busy} onClick={runExport}>
          {busy ? 'Working…' : `Download ${itemCount} file${itemCount === 1 ? '' : 's'}`}
        </button>
      </div>

      {busy && progress && (
        <div className="export-progress">
          <div className="bar">
            <div className="bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="tiny muted">
            {progress.done} / {progress.total} — {progress.label}
          </p>
        </div>
      )}

      <fieldset className="export-options">
        <legend>Options</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={confirmedOnly}
            onChange={(e) => setConfirmedOnly(e.target.checked)}
          />
          <span>
            Only confirmed pairs
            <em className="tiny muted"> — untick to include unreviewed suggestions</em>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={includeSingles}
            onChange={(e) => setIncludeSingles(e.target.checked)}
          />
          <span>
            Include unpaired photos
            <em className="tiny muted">
              {' '}
              — originals, untouched, in a <code>singles</code> subfolder
            </em>
          </span>
        </label>
        <p className="tiny muted">
          {compositeCount} composite{compositeCount === 1 ? '' : 's'} will be rendered at{' '}
          {preset.exportSize}px, {preset.ratio}.
        </p>
      </fieldset>

      <section className="export-groups">
        <div className="row spread">
          <h3>Cars</h3>
          <div className="row">
            <button className="btn ghost tiny-btn" onClick={() => setSelected(new Set())}>
              All
            </button>
            <button
              className="btn ghost tiny-btn"
              onClick={() => setSelected(new Set(groups.map((g) => g.id)))}
            >
              Select each
            </button>
          </div>
        </div>
        <p className="tiny muted">
          {selected.size === 0
            ? 'Everything is included. Tick specific cars to narrow it down.'
            : `${selected.size} car${selected.size === 1 ? '' : 's'} selected.`}
        </p>

        {groups.map((group) => {
          const pairs = group.pairs.filter((p) => !confirmedOnly || p.confirmed)
          const active = selected.size === 0 || selected.has(group.id)
          return (
            <div key={group.id} className={`export-group${active ? '' : ' dim'}`}>
              <header className="group-head">
                <label className="tick">
                  <input
                    type="checkbox"
                    checked={selected.has(group.id)}
                    onChange={() => toggle(group.id)}
                  />
                </label>
                <strong>{group.name}</strong>
                <span className="pill accent">
                  {pairs.length} composite{pairs.length === 1 ? '' : 's'}
                </span>
                <span className="pill">
                  {group.photoIds.length - pairs.length * 2} single
                  {group.photoIds.length - pairs.length * 2 === 1 ? '' : 's'}
                </span>
              </header>
              {pairs.length > 0 && (
                <div className="pair-list">
                  {pairs.map((pair, i) => {
                    const b = photoMap.get(pair.beforeId)
                    const a = photoMap.get(pair.afterId)
                    if (!b || !a) return null
                    return (
                      <div key={pair.id} className="pair-row">
                        <img src={b.proxyUrl} alt="before" title={b.name} data-photo={b.name} />
                        <span className="arrow">→</span>
                        <img src={a.proxyUrl} alt="after" title={a.name} data-photo={a.name} />
                        <div className="pair-row-actions">
                          <button
                            className="btn tiny-btn ghost"
                            disabled={busy}
                            onClick={() => void exportOnePair(group, group.pairs.indexOf(pair))}
                            title="Download just this one"
                          >
                            ⬇
                          </button>
                        </div>
                        <span className="tiny muted">#{i + 1}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
