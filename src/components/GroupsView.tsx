import { useMemo, useState } from 'react'
import type { ClusterSettings, Group, Photo } from '../types'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  clusterSettings: ClusterSettings
  onRegroup: (s: ClusterSettings) => void
  onRename: (id: string, name: string) => void
  onMerge: (ids: string[]) => void
  onSplit: (fromGroupId: string, photoIds: string[]) => void
  onMove: (photoIds: string[], toGroupId: string) => void
  onDelete: (photoIds: string[]) => void
  onNext: () => void
}

export default function GroupsView({
  groups,
  photoMap,
  clusterSettings,
  onRegroup,
  onRename,
  onMerge,
  onSplit,
  onMove,
  onDelete,
  onNext,
}: Props) {
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set())
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
  const [showSettings, setShowSettings] = useState(false)
  const [draft, setDraft] = useState(clusterSettings)

  /** Which group each selected photo currently lives in. */
  const selectionOrigin = useMemo(() => {
    for (const g of groups) {
      if (g.photoIds.some((id) => selectedPhotos.has(id))) return g.id
    }
    return null
  }, [groups, selectedPhotos])

  const togglePhoto = (id: string) => {
    setSelectedPhotos((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleGroup = (id: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedPhotos(new Set())

  return (
    <div className="view groups-view">
      <div className="view-head">
        <div>
          <h2>Cars</h2>
          <p className="muted">
            Check the grouping. Tap photos to move them, or tick two cars and merge.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => setShowSettings((s) => !s)}>
            Grouping settings
          </button>
          <button className="btn primary" onClick={onNext}>
            Pair them up →
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="settings-panel">
          <p className="muted tiny">
            Re-grouping rebuilds every car from scratch and discards manual moves and
            confirmed pairs.
          </p>
          <label className="field">
            <span>
              New car after a gap of <strong>{draft.timeGapMinutes} min</strong>
            </span>
            <input
              type="range"
              min={2}
              max={120}
              value={draft.timeGapMinutes}
              onChange={(e) =>
                setDraft({ ...draft, timeGapMinutes: Number(e.target.value) })
              }
            />
          </label>
          <label className="field">
            <span>
              Rejoin a car's before and after batches at{' '}
              <strong>{draft.nccThreshold.toFixed(2)}</strong> match — lower if before and
              after batches are being split apart
            </span>
            <input
              type="range"
              min={0.3}
              max={0.95}
              step={0.01}
              value={draft.nccThreshold}
              onChange={(e) => setDraft({ ...draft, nccThreshold: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>
              Suggest a pair at <strong>{draft.pairNccThreshold.toFixed(2)}</strong> match —
              lower for more suggestions
            </span>
            <input
              type="range"
              min={0.3}
              max={0.95}
              step={0.01}
              value={draft.pairNccThreshold}
              onChange={(e) =>
                setDraft({ ...draft, pairNccThreshold: Number(e.target.value) })
              }
            />
          </label>
          <label className="field">
            <span>
              Colour tolerance <strong>{draft.chromaThreshold.toFixed(2)}</strong> — lower
              keeps different-coloured cars apart
            </span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.02}
              value={draft.chromaThreshold}
              onChange={(e) =>
                setDraft({ ...draft, chromaThreshold: Number(e.target.value) })
              }
            />
          </label>
          <button
            className="btn"
            onClick={() => {
              if (confirm('Rebuild all cars? Manual edits will be lost.')) onRegroup(draft)
            }}
          >
            Re-group everything
          </button>
        </div>
      )}

      {selectedGroups.size >= 2 && (
        <div className="action-bar">
          <span>{selectedGroups.size} cars ticked</span>
          <button
            className="btn primary"
            onClick={() => {
              onMerge([...selectedGroups])
              setSelectedGroups(new Set())
            }}
          >
            Merge into one
          </button>
          <button className="btn ghost" onClick={() => setSelectedGroups(new Set())}>
            Cancel
          </button>
        </div>
      )}

      {selectedPhotos.size > 0 && (
        <div className="action-bar">
          <span>{selectedPhotos.size} selected</span>
          <button
            className="btn"
            disabled={!selectionOrigin}
            onClick={() => {
              if (selectionOrigin) onSplit(selectionOrigin, [...selectedPhotos])
              clearSelection()
            }}
          >
            Split to new car
          </button>
          <select
            className="select"
            value=""
            onChange={(e) => {
              if (e.target.value) {
                onMove([...selectedPhotos], e.target.value)
                clearSelection()
              }
            }}
          >
            <option value="">Move to…</option>
            {groups
              .filter((g) => g.id !== selectionOrigin)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Remove ${selectedPhotos.size} photos from this session?`)) {
                onDelete([...selectedPhotos])
                clearSelection()
              }
            }}
          >
            Remove
          </button>
          <button className="btn ghost" onClick={clearSelection}>
            Cancel
          </button>
        </div>
      )}

      {groups.length === 0 && <p className="muted">No photos loaded yet.</p>}

      {groups.map((group) => {
        const pairedIds = new Set(group.pairs.flatMap((p) => [p.beforeId, p.afterId]))
        return (
          <section key={group.id} className="group-card">
            <header className="group-head">
              <label className="tick">
                <input
                  type="checkbox"
                  checked={selectedGroups.has(group.id)}
                  onChange={() => toggleGroup(group.id)}
                />
              </label>
              <input
                className="group-name"
                value={group.name}
                onChange={(e) => onRename(group.id, e.target.value)}
                aria-label="Car name"
              />
              <span className="pill">
                {group.photoIds.length} photo{group.photoIds.length === 1 ? '' : 's'}
              </span>
              <span className="pill accent">
                {group.pairs.length} pair{group.pairs.length === 1 ? '' : 's'}
              </span>
            </header>

            <div className="thumb-grid">
              {group.photoIds.map((id) => {
                const photo = photoMap.get(id)
                if (!photo) return null
                return (
                  <button
                    key={id}
                    className={`thumb${selectedPhotos.has(id) ? ' selected' : ''}`}
                    onClick={() => togglePhoto(id)}
                    title={`${photo.name} · ${new Date(photo.takenAt).toLocaleString()}`}
                  >
                    <img src={photo.proxyUrl} alt={photo.name} loading="lazy" />
                    {pairedIds.has(id) && <span className="thumb-badge">paired</span>}
                    {photo.timeIsApproximate && (
                      <span className="thumb-badge warn" title="No EXIF timestamp">
                        no time
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
