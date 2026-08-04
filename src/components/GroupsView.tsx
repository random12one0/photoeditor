import { useMemo, useState } from 'react'
import type { ClusterSettings, Group, Photo } from '../types'
import { DEFAULT_CLUSTER_SETTINGS } from '../lib/cluster'
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
  onSetTime: (photoId: string, takenAt: number) => void
  onNext: () => void
}

/** "9:02 AM" — the part that matters when scanning a car's photos. */
const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const dayOf = (ms: number) =>
  new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })

/** A car's span, written the way someone would say it out loud. */
function rangeOf(times: number[]): string {
  if (!times.length) return ''
  const lo = Math.min(...times)
  const hi = Math.max(...times)
  const sameDay = new Date(lo).toDateString() === new Date(hi).toDateString()
  return sameDay
    ? `${dayOf(lo)} · ${timeOf(lo)} – ${timeOf(hi)}`
    : `${dayOf(lo)} ${timeOf(lo)} – ${dayOf(hi)} ${timeOf(hi)}`
}

/** The value an <input type="datetime-local"> expects, in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
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
  onSetTime,
  onNext,
}: Props) {
  const [editing, setEditing] = useState<Photo | null>(null)
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

  const soleSelected =
    selectedPhotos.size === 1 ? photoMap.get([...selectedPhotos][0]) : undefined

  /* How much the grouping can be trusted, in one line.
   *
   * Cars, bursts and pair suggestions are all built on capture times, so a roll
   * that arrived without EXIF — copied through something that stripped it, or
   * saved from a message — will group badly no matter how the sliders are set.
   * That's worth saying plainly rather than leaving the user to wonder why the
   * cars look wrong. */
  const timeHealth = useMemo(() => {
    const all = [...photoMap.values()]
    if (!all.length) return null
    const guessed = all.filter((p) => p.timeIsApproximate).length
    const stamps = new Set(all.map((p) => p.takenAt))
    // Identical timestamps across many photos means the real capture time is
    // gone; whatever copied them stamped them all at once.
    const collapsed = all.length > 2 && stamps.size <= Math.max(1, all.length / 4)
    return { total: all.length, guessed, collapsed }
  }, [photoMap])

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
                    Start a new car after a break of{' '}
                    <b>{formatGap(draft.newCarGapMinutes)}</b>
                  </span>
                  <input
                    type="range"
                    min={15}
                    max={360}
                    step={15}
                    value={draft.newCarGapMinutes}
                    onChange={(e) =>
                      setDraft({ ...draft, newCarGapMinutes: Number(e.target.value) })
                    }
                  />
                  <span className="tiny dim">
                    Longer than you leave a car mid-job, shorter than the gap before the
                    next one. If two cars land together, tick their photos and tap
                    Split — that's cheaper than one car breaking into six.
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">
                    One car never spans more than <b>{draft.maxCarSpanHours} hours</b>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={14}
                    step={0.5}
                    value={draft.maxCarSpanHours}
                    onChange={(e) =>
                      setDraft({ ...draft, maxCarSpanHours: Number(e.target.value) })
                    }
                  />
                  <span className="tiny dim">
                    First photo to last photo of the same car.
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">
                    Only suggest a pair above{' '}
                    <b>{Math.round(draft.minPairScore * 100)}% match</b>
                  </span>
                  <input
                    type="range"
                    min={0.3}
                    max={0.9}
                    step={0.01}
                    value={draft.minPairScore}
                    onChange={(e) =>
                      setDraft({ ...draft, minPairScore: Number(e.target.value) })
                    }
                  />
                  <span className="tiny dim">
                    Raise it if you're being offered pairs that aren't the same shot.
                    Anything below is left for you to pair by hand.
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">
                    Follow the order you shoot in{' '}
                    <b>{Math.round(draft.orderWeight * 100)}%</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.05}
                    value={draft.orderWeight}
                    onChange={(e) =>
                      setDraft({ ...draft, orderWeight: Number(e.target.value) })
                    }
                  />
                  <span className="tiny dim">
                    Only breaks ties. Raise it if you always circle a car the same way;
                    leave it low if you don't.
                  </span>
                </label>
                <div className="field-actions">
                  <button className="btn" onClick={() => onRegroup(draft)}>
                    Re-group everything
                  </button>
                  {/* A way back out. These four numbers interact, and someone who
                      has moved all of them has no way to find the tested set again. */}
                  <button
                    className="btn ghost"
                    disabled={
                      JSON.stringify(draft) === JSON.stringify(DEFAULT_CLUSTER_SETTINGS)
                    }
                    onClick={() => setDraft({ ...DEFAULT_CLUSTER_SETTINGS })}
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>
          )}

          {timeHealth && (timeHealth.guessed > 0 || timeHealth.collapsed) && (
            <div className="notice">
              <Icon name="clock" size={17} />
              <div>
                <strong>
                  {timeHealth.collapsed
                    ? 'These photos lost their capture times'
                    : `${timeHealth.guessed} of ${timeHealth.total} photos have no capture time`}
                </strong>
                <p className="tiny muted">
                  {timeHealth.collapsed
                    ? 'Whatever copied them stamped them all at once, so the order they arrived in is all there is to go on. Grouping will be rough — fix the odd one below, or sort the cars out by hand.'
                    : 'Those fall back to the file date, which is usually close but can be wrong. Cars, before/after splits and pair suggestions are all built on these times.'}
                </p>
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
                  <p className="tiny dim range">
                    {rangeOf(
                      group.photoIds
                        .map((id) => photoMap.get(id)?.takenAt)
                        .filter((t): t is number => typeof t === 'number'),
                    )}
                  </p>
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
                          {/* Shown, not hidden in a tooltip: the time is the
                              thing the whole grouping rests on, and a phone has
                              no hover. */}
                          <span
                            className={`thumb-time${photo.timeIsApproximate ? ' warn' : ''}`}
                          >
                            {photo.timeIsApproximate && '~'}
                            {timeOf(photo.takenAt)}
                          </span>
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
                {soleSelected && (
                  <button
                    className="btn sm"
                    onClick={() => setEditing(soleSelected)}
                  >
                    <Icon name="clock" size={16} />
                    Time
                  </button>
                )}
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

      {editing && (
        <div
          className="sheet-backdrop"
          onClick={() => setEditing(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Change capture time"
        >
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <h3>When was this taken?</h3>
            <p className="tiny muted" style={{ marginBottom: 16 }}>
              {editing.timeIsApproximate
                ? 'This photo had no capture time, so the file date is standing in for it.'
                : 'Read from the photo itself.'}{' '}
              Cars, before/after splits and pair suggestions all follow this.
            </p>

            <img
              src={editing.proxyUrl}
              alt={editing.name}
              style={{
                width: '100%',
                maxHeight: 180,
                objectFit: 'cover',
                borderRadius: 10,
                marginBottom: 16,
              }}
            />

            <form
              onSubmit={(e) => {
                e.preventDefault()
                const value = new FormData(e.currentTarget).get('taken')
                const ms = typeof value === 'string' ? new Date(value).getTime() : NaN
                if (!Number.isNaN(ms)) onSetTime(editing.id, ms)
                setEditing(null)
                clearSelection()
              }}
            >
              <label className="field">
                <span className="field-label">Capture time</span>
                <input
                  className="text-input"
                  type="datetime-local"
                  name="taken"
                  defaultValue={toLocalInput(editing.takenAt)}
                />
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
                <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary" style={{ flex: 1 }}>
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
