import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { haptic } from '../lib/share'
import type { Group, Pair, Photo, StylePreset } from '../types'
import Icon from './Icon'
import PairPreview from './PairPreview'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  preset: StylePreset
  onUpdateGroup: (groupId: string, updater: (g: Group) => Group, label?: string) => void
  onNext: () => void
  notify: (msg: string, undoable?: boolean) => void
}

let manualCounter = 0

/** Past this many pixels of drag, releasing commits the verdict. */
const SWIPE_COMMIT = 96

export default function PairView({
  groups,
  photoMap,
  preset,
  onUpdateGroup,
  onNext,
  notify,
}: Props) {
  const [groupIndex, setGroupIndex] = useState(0)
  const [manualPick, setManualPick] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [drag, setDrag] = useState(0)

  const cardRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const dragging = useRef(false)

  const group = groups[Math.min(groupIndex, groups.length - 1)]
  const queue = useMemo(() => (group ? group.pairs.filter((p) => !p.confirmed) : []), [group])
  const current = queue[0]
  const confirmed = useMemo(
    () => (group ? group.pairs.filter((p) => p.confirmed) : []),
    [group],
  )

  const unpaired = useMemo(() => {
    if (!group) return []
    const claimed = new Set(group.pairs.flatMap((p) => [p.beforeId, p.afterId]))
    return group.photoIds
      .filter((id) => !claimed.has(id))
      .map((id) => photoMap.get(id))
      .filter((p): p is Photo => Boolean(p))
  }, [group, photoMap])

  /* ------------------------------------------------------------------ verdicts */

  const confirmCurrent = useCallback(() => {
    if (!group || !current) return
    haptic(10)
    onUpdateGroup(
      group.id,
      (g) => ({
        ...g,
        pairs: g.pairs.map((p) => (p.id === current.id ? { ...p, confirmed: true } : p)),
      }),
      'confirm pair',
    )
  }, [group, current, onUpdateGroup])

  const rejectCurrent = useCallback(() => {
    if (!group || !current) return
    haptic([8, 40, 8])
    onUpdateGroup(
      group.id,
      (g) => ({ ...g, pairs: g.pairs.filter((p) => p.id !== current.id) }),
      'reject pair',
    )
  }, [group, current, onUpdateGroup])

  const swapCurrent = useCallback(() => {
    if (!group || !current) return
    onUpdateGroup(
      group.id,
      (g) => ({
        ...g,
        pairs: g.pairs.map((p) =>
          p.id === current.id ? { ...p, beforeId: p.afterId, afterId: p.beforeId } : p,
        ),
      }),
      'swap pair',
    )
  }, [group, current, onUpdateGroup])

  const skipCurrent = useCallback(() => {
    if (!group || !current) return
    onUpdateGroup(group.id, (g) => ({
      ...g,
      pairs: [...g.pairs.filter((p) => p.id !== current.id), current],
    }))
  }, [group, current, onUpdateGroup])

  const unpair = useCallback(
    (pairId: string) => {
      if (!group) return
      onUpdateGroup(
        group.id,
        (g) => ({ ...g, pairs: g.pairs.filter((p) => p.id !== pairId) }),
        'unpair',
      )
    },
    [group, onUpdateGroup],
  )

  const swapPair = useCallback(
    (pairId: string) => {
      if (!group) return
      onUpdateGroup(
        group.id,
        (g) => ({
          ...g,
          pairs: g.pairs.map((p) =>
            p.id === pairId ? { ...p, beforeId: p.afterId, afterId: p.beforeId } : p,
          ),
        }),
        'swap pair',
      )
    },
    [group, onUpdateGroup],
  )

  const handleManualPick = useCallback(
    (photoId: string) => {
      if (!group) return
      if (manualPick === null) {
        setManualPick(photoId)
        return
      }
      if (manualPick === photoId) {
        setManualPick(null)
        return
      }
      const a = photoMap.get(manualPick)
      const b = photoMap.get(photoId)
      if (!a || !b) {
        setManualPick(null)
        return
      }
      const [before, after] = a.takenAt <= b.takenAt ? [a, b] : [b, a]
      const pair: Pair = {
        id: `manual${Date.now().toString(36)}_${manualCounter++}`,
        beforeId: before.id,
        afterId: after.id,
        confidence: 1,
        confirmed: true,
      }
      haptic(10)
      onUpdateGroup(group.id, (g) => ({ ...g, pairs: [...g.pairs, pair] }), 'pair by hand')
      setManualPick(null)
    },
    [group, manualPick, photoMap, onUpdateGroup],
  )

  const nextGroup = useCallback(() => {
    setGroupIndex((i) => Math.min(i + 1, groups.length - 1))
    setManualPick(null)
  }, [groups.length])

  const prevGroup = useCallback(() => {
    setGroupIndex((i) => Math.max(i - 1, 0))
    setManualPick(null)
  }, [])

  /* -------------------------------------------------------------------- swipe */

  const endDrag = useCallback(
    (dx: number) => {
      dragging.current = false
      dragStart.current = null
      setDrag(0)
      if (dx > SWIPE_COMMIT) confirmCurrent()
      else if (dx < -SWIPE_COMMIT) rejectCurrent()
    },
    [confirmCurrent, rejectCurrent],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (!current) return
    // Ignore drags that begin on a control.
    if ((e.target as HTMLElement).closest('button')) return
    dragStart.current = { x: e.clientX, y: e.clientY }
    dragging.current = false
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    // Only claim the gesture once it's clearly horizontal, so the page can
    // still be scrolled vertically from anywhere on the card.
    if (!dragging.current) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)) return
      dragging.current = true
      cardRef.current?.setPointerCapture?.(e.pointerId)
    }
    setDrag(dx)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragStart.current) return
    const dx = dragging.current ? e.clientX - dragStart.current.x : 0
    endDrag(dx)
  }

  /* ----------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.metaKey || e.ctrlKey) return

      switch (e.key) {
        case 'ArrowRight':
        case 'Enter':
        case 'y':
        case 'Y':
          e.preventDefault()
          confirmCurrent()
          break
        case 'ArrowLeft':
        case 'x':
        case 'X':
          e.preventDefault()
          rejectCurrent()
          break
        case 's':
        case 'S':
          e.preventDefault()
          swapCurrent()
          break
        case ' ':
          e.preventDefault()
          skipCurrent()
          break
        case 'p':
        case 'P':
          e.preventDefault()
          setShowPreview((v) => !v)
          break
        case 'ArrowDown':
          e.preventDefault()
          nextGroup()
          break
        case 'ArrowUp':
          e.preventDefault()
          prevGroup()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmCurrent, rejectCurrent, swapCurrent, skipCurrent, nextGroup, prevGroup])

  if (!group) {
    return (
      <main className="content" data-view="pairs">
        <div className="wrap">
          <p className="muted">No cars yet — import some photos first.</p>
        </div>
      </main>
    )
  }

  const before = current ? photoMap.get(current.beforeId) : undefined
  const after = current ? photoMap.get(current.afterId) : undefined
  const portrait = before ? before.height > before.width : false

  const allDone = groups.every((g) => g.pairs.every((p) => p.confirmed))

  return (
    <>
      <main className={`content${current ? ' has-actionbar' : ''}`} data-view="pairs">
        <div className="wrap">
          <div className="group-strip" role="tablist" aria-label="Cars">
            {groups.map((g, i) => {
              const done = g.pairs.filter((p) => p.confirmed).length
              return (
                <button
                  key={g.id}
                  role="tab"
                  className={`chip${done === g.pairs.length && g.pairs.length > 0 ? ' done' : ''}`}
                  aria-pressed={i === groupIndex}
                  onClick={() => {
                    setGroupIndex(i)
                    setManualPick(null)
                  }}
                >
                  {g.name}
                  <span className="chip-count">
                    {done}/{g.pairs.length}
                  </span>
                </button>
              )
            })}
          </div>

          {current && before && after ? (
            <div
              className="review"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div
                className="swipe-hint yes"
                style={{ opacity: Math.max(0, Math.min(1, drag / SWIPE_COMMIT)) }}
              >
                <Icon name="check" size={30} />
              </div>
              <div
                className="swipe-hint no"
                style={{ opacity: Math.max(0, Math.min(1, -drag / SWIPE_COMMIT)) }}
              >
                <Icon name="close" size={30} />
              </div>

              <div
                className="review-card"
                ref={cardRef}
                style={{
                  transform: `translateX(${drag}px) rotate(${drag * 0.02}deg)`,
                  transition: dragging.current ? 'none' : 'transform 0.22s var(--ease)',
                }}
              >
                <div className="review-head">
                  <h2>Same shot?</h2>
                  <div className="match">
                    <div className="match-bar">
                      <div
                        className="match-fill"
                        style={{ width: `${Math.round(current.confidence * 100)}%` }}
                      />
                    </div>
                    <span className="mono">{Math.round(current.confidence * 100)}%</span>
                  </div>
                </div>

                <div className={`review-images${portrait ? ' portrait' : ''}`} data-testid="review-images">
                  <figure>
                    <img src={before.proxyUrl} alt="Before" draggable={false} />
                    <figcaption className="review-cap">
                      <span>BEFORE</span>
                      <span className="mono dim">
                        {new Date(before.takenAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </figcaption>
                  </figure>
                  <figure>
                    <img src={after.proxyUrl} alt="After" draggable={false} />
                    <figcaption className="review-cap">
                      <span>AFTER</span>
                      <span className="mono dim">
                        {new Date(after.takenAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </figcaption>
                  </figure>
                </div>
              </div>

              <p className="tiny dim" style={{ textAlign: 'center', marginTop: 12 }}>
                {queue.length} left in this car · swipe or use the buttons
              </p>

              {showPreview && (
                <div style={{ display: 'grid', justifyItems: 'center', marginTop: 16 }}>
                  <PairPreview
                    before={before}
                    after={after}
                    preset={preset}
                    maxWidth={280}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <Icon name="check" size={24} />
              </div>
              <h2>This car is done</h2>
              <p className="muted tiny">
                {confirmed.length} pair{confirmed.length === 1 ? '' : 's'} confirmed
                {unpaired.length > 0
                  ? ` · ${unpaired.length} photo${unpaired.length === 1 ? '' : 's'} left over`
                  : ' · every photo accounted for'}
              </p>
              {groupIndex < groups.length - 1 ? (
                <button className="btn primary" onClick={nextGroup}>
                  Next car
                  <Icon name="chevronRight" size={16} />
                </button>
              ) : (
                <button className="btn primary" onClick={onNext}>
                  {allDone ? 'Style them' : 'Continue'}
                  <Icon name="chevronRight" size={16} />
                </button>
              )}
            </div>
          )}

          {unpaired.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h3>
                  Unpaired
                  {manualPick && <span className="muted"> — tap its partner</span>}
                </h3>
                <span className="pill">{unpaired.length}</span>
              </div>
              <p className="tiny dim" style={{ marginBottom: 12 }}>
                Tap one photo then the matching one. The earlier shot becomes the before.
                Anything left alone still exports with this car.
              </p>
              <div className="thumb-grid">
                {unpaired.map((photo) => (
                  <button
                    key={photo.id}
                    className={`thumb${manualPick === photo.id ? ' picked' : ''}`}
                    onClick={() => handleManualPick(photo.id)}
                  >
                    <img src={photo.proxyUrl} alt={photo.name} loading="lazy" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {confirmed.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h3>Confirmed</h3>
                <span className="pill good">{confirmed.length}</span>
              </div>
              <div className="pair-list">
                {confirmed.map((pair) => {
                  const b = photoMap.get(pair.beforeId)
                  const a = photoMap.get(pair.afterId)
                  if (!b || !a) return null
                  return (
                    <div key={pair.id} className="pair-row">
                      <img src={b.proxyUrl} alt="before" title={b.name} data-photo={b.name} />
                      <Icon name="chevronRight" size={14} className="arrow" />
                      <img src={a.proxyUrl} alt="after" title={a.name} data-photo={a.name} />
                      <div className="pair-row-actions">
                        <button
                          className="verdict-sm"
                          style={{ width: 40, minHeight: 40 }}
                          onClick={() => swapPair(pair.id)}
                          aria-label="Swap before and after"
                        >
                          <Icon name="swap" size={17} />
                        </button>
                        <button
                          className="verdict-sm"
                          style={{ width: 40, minHeight: 40 }}
                          onClick={() => unpair(pair.id)}
                          aria-label="Unpair"
                        >
                          <Icon name="close" size={17} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {!current && groups.length > 1 && (
            <div className="section" style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={prevGroup} disabled={groupIndex === 0}>
                <Icon name="chevronLeft" size={16} />
                Previous car
              </button>
              <button
                className="btn ghost"
                onClick={nextGroup}
                disabled={groupIndex >= groups.length - 1}
              >
                Next car
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Thumb-zone action bar. Two big verdict buttons, everything else small. */}
      {current && (
        <div className="actionbar">
          <div className="actionbar-inner">
            <button className="verdict no" data-testid="reject" onClick={rejectCurrent}>
              <Icon name="close" size={20} />
              Not a pair
            </button>
            <button
              className="verdict-sm"
              onClick={swapCurrent}
              aria-label="Swap before and after"
              title="Swap (S)"
            >
              <Icon name="swap" />
            </button>
            <button
              className="verdict-sm"
              onClick={() => setShowPreview((v) => !v)}
              aria-label="Toggle preview"
              title="Preview (P)"
            >
              <Icon name="eye" />
            </button>
            <button
              className="verdict-sm"
              onClick={skipCurrent}
              aria-label="Skip"
              title="Skip (Space)"
            >
              <Icon name="skip" />
            </button>
            <button
              className="verdict yes"
              data-testid="confirm"
              onClick={() => {
                confirmCurrent()
                if (queue.length === 1) notify('Car finished')
              }}
            >
              <Icon name="check" size={20} />
              Yes
            </button>
          </div>
        </div>
      )}
    </>
  )
}
