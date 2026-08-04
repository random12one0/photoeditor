import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { haptic } from '../lib/share'
import { rejectionKey } from '../lib/cluster'
import type { Group, Pair, Photo, StylePreset } from '../types'
import Icon from './Icon'
import PairByHand from './PairByHand'
import PairPreview from './PairPreview'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  preset: StylePreset
  onUpdateGroup: (groupId: string, updater: (g: Group) => Group, label?: string) => void
  /** Re-solve one car's suggestions, honouring confirmations and rejections. */
  onResuggest: (groupId: string) => void
  /** Throw away every suggestion and rejection for a car and start it over. */
  onRematch: (groupId: string) => void
  onNext: () => void
  notify: (msg: string, undoable?: boolean) => void
}

let manualCounter = 0

/** Past this many pixels of drag, releasing commits the verdict. */
const SWIPE_COMMIT = 96

const clockOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * The other takes of this angle, when there are any.
 *
 * Shooting three of one angle and one of the other is normal, so something has
 * to decide which of the three goes in the composite. It picks the sharpest, and
 * this is where that decision is shown and overridden — silently choosing on
 * someone's behalf and never saying so is the part that would feel arbitrary.
 *
 * Chronological order, so the strip reads the way the shots were taken and
 * doesn't reorder itself when the pick changes.
 */
function TakeStrip({
  side,
  pair,
  chosen,
  photoMap,
  onPick,
}: {
  side: 'before' | 'after'
  pair: Pair
  chosen: Photo
  photoMap: Map<string, Photo>
  onPick: (pairId: string, side: 'before' | 'after', photoId: string) => void
}) {
  const alternates = (side === 'before' ? pair.beforeAlternates : pair.afterAlternates) ?? []
  const takes = [chosen.id, ...alternates]
    .map((id) => photoMap.get(id))
    .filter((p): p is Photo => Boolean(p))
    .sort((a, b) => a.takenAt - b.takenAt)

  // A restored session can reference a photo whose bytes didn't survive.
  if (takes.length < 2) return null

  return (
    <div className="take-strip" data-testid={`takes-${side}`}>
      <span className="tiny dim">{takes.length} shots — sharpest picked</span>
      <div className="take-row">
        {takes.map((take) => (
          <button
            key={take.id}
            className={`take${take.id === chosen.id ? ' picked' : ''}`}
            aria-pressed={take.id === chosen.id}
            aria-label={`Use the ${side} shot from ${clockOf(take.takenAt)}`}
            data-photo={take.name}
            onClick={() => onPick(pair.id, side, take.id)}
          >
            <img src={take.proxyUrl} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  )
}

export default function PairView({
  groups,
  photoMap,
  preset,
  onUpdateGroup,
  onResuggest,
  onRematch,
  onNext,
  notify,
}: Props) {
  const [groupIndex, setGroupIndex] = useState(0)
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

  /**
   * "Not a pair" — record it, then re-solve the whole car around it.
   *
   * The first version of this walked one before shot down a private list of
   * runners-up and told nothing else about the car, which made the screen a dead
   * end: a wheel with no after in the set could burn through every remaining
   * photo in turn, and each one it burned was gone rather than offered to the
   * before shot that actually wanted it. Ten photos could finish unsorted
   * because of one unpartnerable wheel.
   *
   * Rejecting is information about the car, not about the card. Recording it and
   * re-solving is how that information reaches everything else.
   */
  const rejectCurrent = useCallback(() => {
    if (!group || !current) return
    haptic([8, 40, 8])
    const key = rejectionKey(current.beforeId, current.afterId)
    onUpdateGroup(
      group.id,
      (g) => ({ ...g, rejected: [...new Set([...(g.rejected ?? []), key])] }),
      'not a pair',
    )
    onResuggest(group.id)
  }, [group, current, onUpdateGroup, onResuggest])

  /**
   * "Neither" — this before shot has no partner anywhere in this car.
   *
   * Forbids it against every after shot at once, so re-solving never offers it
   * again, and frees whatever it was holding for the rest of the car. That is
   * the difference from rejecting: one says "wrong answer", this says "stop
   * asking about this photo".
   */
  const dropCurrent = useCallback(() => {
    if (!group || !current) return
    haptic([8, 40, 8])
    const beforeId = current.beforeId
    const keys = group.photoIds.map((id) => rejectionKey(beforeId, id))
    onUpdateGroup(
      group.id,
      (g) => ({ ...g, rejected: [...new Set([...(g.rejected ?? []), ...keys])] }),
      'no partner',
    )
    onResuggest(group.id)
  }, [group, current, onUpdateGroup, onResuggest])

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

  /**
   * Swap one of the other takes of the same angle into the pair.
   *
   * Done in place — the photo coming out takes the slot of the one going in —
   * so the strip of thumbnails doesn't reshuffle under the finger that just
   * tapped it.
   */
  const chooseTake = useCallback(
    (pairId: string, side: 'before' | 'after', photoId: string) => {
      if (!group) return
      haptic(6)
      onUpdateGroup(
        group.id,
        (g) => ({
          ...g,
          pairs: g.pairs.map((p) => {
            if (p.id !== pairId) return p
            const alts = (side === 'before' ? p.beforeAlternates : p.afterAlternates) ?? []
            if (!alts.includes(photoId)) return p
            const outgoing = side === 'before' ? p.beforeId : p.afterId
            const nextAlts = alts.map((id) => (id === photoId ? outgoing : id))
            return side === 'before'
              ? { ...p, beforeId: photoId, beforeAlternates: nextAlts }
              : { ...p, afterId: photoId, afterAlternates: nextAlts }
          }),
        }),
        'change shot',
      )
    },
    [group, onUpdateGroup],
  )

  /**
   * Pair two leftovers by hand.
   *
   * Tap order decides: first is the before, second is the after. It used to
   * infer that from capture time, which is right most of the time and silent
   * when it isn't — and "before first, after second" is a rule someone can hold
   * in their head and correct against.
   */
  const pairByHand = useCallback(
    (beforeId: string, afterId: string) => {
      if (!group) return
      const pair: Pair = {
        id: `manual${Date.now().toString(36)}_${manualCounter++}`,
        beforeId,
        afterId,
        confidence: 1,
        confirmed: true,
      }
      onUpdateGroup(group.id, (g) => ({ ...g, pairs: [...g.pairs, pair] }), 'pair by hand')
      notify('Paired', true)
    },
    [group, onUpdateGroup, notify],
  )

  const nextGroup = useCallback(() => {
    setGroupIndex((i) => Math.min(i + 1, groups.length - 1))
  }, [groups.length])

  const prevGroup = useCallback(() => {
    setGroupIndex((i) => Math.max(i - 1, 0))
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
        case 'n':
        case 'N':
          e.preventDefault()
          dropCurrent()
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
  }, [confirmCurrent, rejectCurrent, dropCurrent, swapCurrent, skipCurrent, nextGroup, prevGroup])

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

          {/* The panel for these lives below a full-height review card, which on
              a phone means it is a screen and a half down and was reported as
              never having been seen at all. A count at the top, where the eye
              already is, and a tap to get there. */}
          {unpaired.length > 0 && (
            <button
              className="leftover-jump"
              data-testid="leftover-jump"
              onClick={() =>
                document
                  .getElementById('pair-by-hand')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              <span>
                <strong>{unpaired.length}</strong> photo
                {unpaired.length === 1 ? '' : 's'} not paired up
              </span>
              <span className="leftover-jump-cta">
                Pair by hand
                <Icon name="chevronRight" size={15} />
              </span>
            </button>
          )}

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
                      <span className="mono dim">{clockOf(before.takenAt)}</span>
                    </figcaption>
                    <TakeStrip
                      side="before"
                      pair={current}
                      chosen={before}
                      photoMap={photoMap}
                      onPick={chooseTake}
                    />
                  </figure>
                  <figure>
                    <img src={after.proxyUrl} alt="After" draggable={false} />
                    <figcaption className="review-cap">
                      <span>AFTER</span>
                      <span className="mono dim">{clockOf(after.takenAt)}</span>
                    </figcaption>
                    <TakeStrip
                      side="after"
                      pair={current}
                      chosen={after}
                      photoMap={photoMap}
                      onPick={chooseTake}
                    />
                  </figure>
                </div>
              </div>

              {/* Rarer than the two verdicts, so these sit outside the thumb
                  zone rather than competing with them for it. */}
              <div className="review-extra">
                <button className="btn ghost sm" onClick={dropCurrent} data-testid="no-partner">
                  Neither — this one has no partner
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => onRematch(group.id)}
                  data-testid="rematch"
                  title="Forget every yes and no for this car and match it again"
                >
                  <Icon name="undo" size={15} />
                  Start this car over
                </button>
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
              <div className="review-extra">
                <button
                  className="btn ghost sm"
                  onClick={() => onRematch(group.id)}
                  data-testid="rematch-done"
                >
                  <Icon name="undo" size={15} />
                  Start this car over
                </button>
              </div>
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

          <PairByHand photos={unpaired} onPair={pairByHand} />

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
            {/* The label says what the button will actually do. "Not a pair"
                when there is nothing else to try, "Try another" when there is —
                because those are different promises and getting the second one
                wrong is what made rejecting feel like a dead end. */}
            <button className="verdict no" data-testid="reject" onClick={rejectCurrent}>
              <Icon name="close" size={20} />
              {current.runnersUp?.length ? 'Try another' : 'Not a pair'}
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
