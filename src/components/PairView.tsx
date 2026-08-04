import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Group, Pair, Photo, StylePreset } from '../types'
import PairPreview from './PairPreview'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  preset: StylePreset
  onUpdateGroup: (groupId: string, updater: (g: Group) => Group) => void
  onNext: () => void
}

let manualCounter = 0

export default function PairView({
  groups,
  photoMap,
  preset,
  onUpdateGroup,
  onNext,
}: Props) {
  const [groupIndex, setGroupIndex] = useState(0)
  const [manualPick, setManualPick] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const group = groups[Math.min(groupIndex, groups.length - 1)]

  const queue = useMemo(
    () => (group ? group.pairs.filter((p) => !p.confirmed) : []),
    [group],
  )
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

  /* ------------------------------------------------------------------ actions */

  const confirmCurrent = useCallback(() => {
    if (!group || !current) return
    onUpdateGroup(group.id, (g) => ({
      ...g,
      pairs: g.pairs.map((p) => (p.id === current.id ? { ...p, confirmed: true } : p)),
    }))
  }, [group, current, onUpdateGroup])

  const rejectCurrent = useCallback(() => {
    if (!group || !current) return
    onUpdateGroup(group.id, (g) => ({
      ...g,
      pairs: g.pairs.filter((p) => p.id !== current.id),
    }))
  }, [group, current, onUpdateGroup])

  const swapCurrent = useCallback(() => {
    if (!group || !current) return
    onUpdateGroup(group.id, (g) => ({
      ...g,
      pairs: g.pairs.map((p) =>
        p.id === current.id ? { ...p, beforeId: p.afterId, afterId: p.beforeId } : p,
      ),
    }))
  }, [group, current, onUpdateGroup])

  const skipCurrent = useCallback(() => {
    if (!group || !current) return
    // Push to the back of the queue rather than dropping it.
    onUpdateGroup(group.id, (g) => ({
      ...g,
      pairs: [...g.pairs.filter((p) => p.id !== current.id), current],
    }))
  }, [group, current, onUpdateGroup])

  const unpair = useCallback(
    (pairId: string) => {
      if (!group) return
      onUpdateGroup(group.id, (g) => ({
        ...g,
        pairs: g.pairs.filter((p) => p.id !== pairId),
      }))
    },
    [group, onUpdateGroup],
  )

  const swapPair = useCallback(
    (pairId: string) => {
      if (!group) return
      onUpdateGroup(group.id, (g) => ({
        ...g,
        pairs: g.pairs.map((p) =>
          p.id === pairId ? { ...p, beforeId: p.afterId, afterId: p.beforeId } : p,
        ),
      }))
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
      onUpdateGroup(group.id, (g) => ({ ...g, pairs: [...g.pairs, pair] }))
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

  /* ----------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return

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
        case 'Backspace':
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
      <div className="view">
        <p className="muted">No cars yet — import some photos first.</p>
      </div>
    )
  }

  const before = current ? photoMap.get(current.beforeId) : undefined
  const after = current ? photoMap.get(current.afterId) : undefined

  return (
    <div className="view pair-view">
      <div className="group-strip">
        {groups.map((g, i) => {
          const done = g.pairs.filter((p) => p.confirmed).length
          const pending = g.pairs.length - done
          return (
            <button
              key={g.id}
              className={`chip${i === groupIndex ? ' active' : ''}${pending === 0 ? ' done' : ''}`}
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
        <div className="review">
          <div className="review-head">
            <h2>
              Same shot? <span className="muted">{queue.length} left in this car</span>
            </h2>
            <div className="confidence">
              <div className="conf-bar">
                <div
                  className="conf-fill"
                  style={{ width: `${Math.round(current.confidence * 100)}%` }}
                />
              </div>
              <span className="tiny muted">
                {Math.round(current.confidence * 100)}% match
              </span>
            </div>
          </div>

          <div className="review-images">
            <figure>
              <img src={before.proxyUrl} alt="Before" />
              <figcaption>
                BEFORE
                <span className="tiny muted">
                  {new Date(before.takenAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </figcaption>
            </figure>
            <figure>
              <img src={after.proxyUrl} alt="After" />
              <figcaption>
                AFTER
                <span className="tiny muted">
                  {new Date(after.takenAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </figcaption>
            </figure>
          </div>

          <div className="review-actions">
            <button className="btn big danger" onClick={rejectCurrent}>
              ✗ Not a pair
              <kbd>←</kbd>
            </button>
            <button className="btn big ghost" onClick={swapCurrent}>
              ⇄ Swap
              <kbd>S</kbd>
            </button>
            <button className="btn big ghost" onClick={skipCurrent}>
              Skip
              <kbd>space</kbd>
            </button>
            <button className="btn big primary" onClick={confirmCurrent}>
              ✓ Yes
              <kbd>→</kbd>
            </button>
          </div>

          <button className="btn ghost wide" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? 'Hide' : 'Show'} finished preview <kbd>P</kbd>
          </button>
          {showPreview && (
            <div className="inline-preview">
              <PairPreview before={before} after={after} preset={preset} maxWidth={340} />
            </div>
          )}
        </div>
      ) : (
        <div className="review empty">
          <h2>All suggestions handled for this car</h2>
          <p className="muted">
            {confirmed.length} pair{confirmed.length === 1 ? '' : 's'} confirmed.
            {unpaired.length > 0
              ? ` ${unpaired.length} photo${unpaired.length === 1 ? '' : 's'} left over — pair them by hand below, or leave them as singles.`
              : ' Every photo is accounted for.'}
          </p>
          <div className="row">
            {groupIndex < groups.length - 1 ? (
              <button className="btn primary" onClick={nextGroup}>
                Next car →
              </button>
            ) : (
              <button className="btn primary" onClick={onNext}>
                Go style them →
              </button>
            )}
          </div>
        </div>
      )}

      {unpaired.length > 0 && (
        <section className="manual">
          <h3>
            Unpaired {manualPick && <span className="muted">— now tap its partner</span>}
          </h3>
          <p className="muted tiny">
            Tap one photo, then tap the matching one to pair them. The earlier shot becomes
            the "before".
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
        <section className="manual">
          <h3>Confirmed pairs</h3>
          <div className="pair-list">
            {confirmed.map((pair) => {
              const b = photoMap.get(pair.beforeId)
              const a = photoMap.get(pair.afterId)
              if (!b || !a) return null
              return (
                <div key={pair.id} className="pair-row">
                  <img src={b.proxyUrl} alt="before" title={b.name} data-photo={b.name} />
                  <span className="arrow">→</span>
                  <img src={a.proxyUrl} alt="after" title={a.name} data-photo={a.name} />
                  <div className="pair-row-actions">
                    <button className="btn tiny-btn ghost" onClick={() => swapPair(pair.id)}>
                      ⇄
                    </button>
                    <button
                      className="btn tiny-btn danger"
                      onClick={() => unpair(pair.id)}
                    >
                      ✗
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
