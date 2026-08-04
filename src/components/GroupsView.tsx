import { useMemo, useState } from 'react'
import type { ClusterSettings, Group, Photo } from '../types'
import Icon from './Icon'

/** Minutes as something readable at a glance. */
function formatGap(min: number): string {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

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

  const selectionOrigin = useMemo(() => {
    for (const g of groups) {
      if (g.photoIds.some((id) => selectedPhotos.has(id))) return g.id
    }
    return null
  }, [groups, selectedPhotos])

  const togglePhoto = (id: string) =>
    setSelectedPhotos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleGroup = (id: string) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const clearSelection = () => setSelectedPhotos(new Set())
  const hasSelection = selectedPhotos.size > 0 || selectedGroups.size >= 2

  return (
    <>
      <main className={`content${hasSelection ? ' has-actionbar' : ''}`} data-view="cars">
        <div className="wrap">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div>
              <h2>Cars</h2>
              <p className="tiny muted">
                Tap photos to move them. Tick two cars to merge.
              </p>
            </div>
            <button className="btn ghost sm" onClick={() => setShowSettings((s) => !s)}>
              <Icon name="sliders" size={16} />
              Grouping
            </button>
          </div>

          {showSettings && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="fieldset-body">
                <p className="tiny dim">
                  Re-grouping rebuilds every car from scratch and discards manual
                  moves and confirmed pairs. It can be undone.
                </p>
                <label className="field">
                  <span className="field-label">
                    New car after a gap of <b>{formatGap(draft.carGapMinutes)}</b>
                  </span>
                  <input
                    type="range"
                    min={20}
                    max={480}
                    step={10}
                    value={draft.carGapMinutes}
                    onChange={(e) =>
                      setDraft({ ...draft, carGapMinutes: Number(e.target.value) })
                    }
                  />
                  <span className="tiny dim">
                    Longer than a detail takes, shorter than the gap to the next car.
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">
                    Separate before &amp; after at <b>{formatGap(draft.burstGapMinutes)}</b>
                  </span>
                  <input
                    type="range"
                    min={2}
                    max={90}
                    value={draft.burstGapMinutes}
                    onChange={(e) =>
                      setDraft({ ...draft, burstGapMinutes: Number(e.target.value) })
                    }
                  />
                  <span className="tiny dim">
                    The longest pause inside a car is the job itself.
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">
                    Trust walk-around order <b>{Math.round(draft.orderWeight * 100)}%</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.orderWeight}
                    onChange={(e) =>
                      setDraft({ ...draft, orderWeight: Number(e.target.value) })
                    }
                  />
                  <span className="tiny dim">
                    Raise it if you shoot the same angles in the same order every time;
                    lower it to go on how the photos look instead.
                  </span>
                </label>
                <button className="btn" onClick={() => onRegroup(draft)}>
                  Re-group everything
                </button>
              </div>
            </div>
          )}

          {groups.length === 0 && <p className="muted">No photos loaded yet.</p>}

          {groups.map((group) => {
            const pairedIds = new Set(group.pairs.flatMap((p) => [p.beforeId, p.afterId]))
            return (
              <section key={group.id} className="card">
                <header className="card-head">
                  <label className="tick">
                    <input
                      type="checkbox"
                      checked={selectedGroups.has(group.id)}
                      onChange={() => toggleGroup(group.id)}
                      aria-label={`Select ${group.name}`}
                    />
                  </label>
                  <input
                    className="group-name"
                    value={group.name}
                    onChange={(e) => onRename(group.id, e.target.value)}
                    aria-label="Car name"
                  />
                  <span className="pill">{group.photoIds.length}</span>
                  {group.pairs.length > 0 && (
                    <span className="pill good">
                      {group.pairs.length} pair{group.pairs.length === 1 ? '' : 's'}
                    </span>
                  )}
                </header>

                <div className="card-body">
                  <div className="thumb-grid">
                    {group.photoIds.map((id) => {
                      const photo = photoMap.get(id)
                      if (!photo) return null
                      const selected = selectedPhotos.has(id)
                      return (
                        <button
                          key={id}
                          className={`thumb${selected ? ' selected' : ''}`}
                          onClick={() => togglePhoto(id)}
                          title={`${photo.name} · ${new Date(photo.takenAt).toLocaleString()}`}
                          aria-pressed={selected}
                        >
                          <img src={photo.proxyUrl} alt={photo.name} loading="lazy" />
                          {selected && (
                            <span className="thumb-check">
                              <Icon name="check" size={13} />
                            </span>
                          )}
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
                </div>
              </section>
            )
          })}

          {!hasSelection && groups.length > 0 && (
            <div className="section">
              <button className="btn primary block" onClick={onNext}>
                Pair them up
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          )}
        </div>
      </main>

      {hasSelection && (
        <div className="actionbar">
          <div className="actionbar-inner" style={{ flexWrap: 'wrap' }}>
            {selectedGroups.size >= 2 ? (
              <>
                <span className="tiny muted" style={{ flex: 1 }}>
                  {selectedGroups.size} cars ticked
                </span>
                <button
                  className="btn primary"
                  onClick={() => {
                    onMerge([...selectedGroups])
                    setSelectedGroups(new Set())
                  }}
                >
                  <Icon name="merge" size={17} />
                  Merge
                </button>
                <button className="btn ghost" onClick={() => setSelectedGroups(new Set())}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="tiny muted" style={{ flex: 1 }}>
                  {selectedPhotos.size} selected
                </span>
                <button
                  className="btn sm"
                  disabled={!selectionOrigin}
                  onClick={() => {
                    if (selectionOrigin) onSplit(selectionOrigin, [...selectedPhotos])
                    clearSelection()
                  }}
                >
                  <Icon name="split" size={16} />
                  Split out
                </button>
                <select
                  className="select"
                  style={{ width: 'auto', minHeight: 36, fontSize: '0.82rem' }}
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
                  className="btn danger sm"
                  onClick={() => {
                    onDelete([...selectedPhotos])
                    clearSelection()
                  }}
                >
                  <Icon name="trash" size={16} />
                </button>
                <button className="btn ghost sm" onClick={clearSelection}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
