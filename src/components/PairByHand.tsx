import { useCallback, useEffect, useState } from 'react'
import { haptic } from '../lib/share'
import type { Photo } from '../types'
import Icon from './Icon'

interface Props {
  photos: Photo[]
  /** Click order decides which is which — first tapped is the before. */
  onPair: (beforeId: string, afterId: string) => void
}

const clockOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * Pairing whatever the matcher didn't get.
 *
 * This is a separate surface from the review card because it is a different
 * job. The card asks a yes/no question about a proposal; this is the user doing
 * the matching themselves, which needs three things the old inline grid didn't
 * have:
 *
 * **Room to see.** The leftovers are the hard cases — the ones that didn't
 * auto-match are disproportionately interiors, and an interior at 88px is a dark
 * rectangle. The tiles are much larger, and every one of them opens full screen.
 *
 * **Order that is stated rather than inferred.** It used to decide before/after
 * from capture time, silently. Now the first tap is the before and the second is
 * the after, and the panel says so at each step, because a rule you can see is
 * one you can work with.
 *
 * **A visible current step.** A two-tap interaction with no feedback between the
 * taps is a guessing game.
 */
export default function PairByHand({ photos, onPair }: Props) {
  const [pick, setPick] = useState<string | null>(null)
  const [zoom, setZoom] = useState<string | null>(null)

  // A photo can disappear from under a selection when its pair is made.
  useEffect(() => {
    if (pick && !photos.some((p) => p.id === pick)) setPick(null)
    if (zoom && !photos.some((p) => p.id === zoom)) setZoom(null)
  }, [photos, pick, zoom])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (zoom) setZoom(null)
      else if (pick) setPick(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pick, zoom])

  const choose = useCallback(
    (id: string) => {
      if (pick === null) {
        haptic(6)
        setPick(id)
        return
      }
      if (pick === id) {
        setPick(null)
        return
      }
      haptic(10)
      onPair(pick, id)
      setPick(null)
    },
    [pick, onPair],
  )

  if (photos.length === 0) return null

  const picked = pick ? photos.find((p) => p.id === pick) : null
  const zoomed = zoom ? photos.find((p) => p.id === zoom) : null

  return (
    <section className="section" id="pair-by-hand" data-testid="pair-by-hand">
      <div className="section-head">
        <h3>Pair the rest</h3>
        <span className="pill">{photos.length}</span>
      </div>

      <div className={`handpair-steps${picked ? ' step2' : ''}`}>
        <div className="handpair-step">
          <span className="step-num">1</span>
          <span>
            {picked ? (
              <>
                <s>Tap the before shot</s> — {picked.name}
              </>
            ) : (
              <>
                Tap the <strong>before</strong> shot — the dirty one
              </>
            )}
          </span>
          {picked && (
            <button className="btn ghost sm" onClick={() => setPick(null)}>
              Change
            </button>
          )}
        </div>
        <div className="handpair-step">
          <span className="step-num">2</span>
          <span>
            {picked ? (
              <>
                Now tap its <strong>after</strong>
              </>
            ) : (
              <span className="dim">Then tap the matching after</span>
            )}
          </span>
        </div>
      </div>

      <p className="tiny dim handpair-hint">
        Tapped them the wrong way round? Every finished pair has a swap button.
        Anything you leave alone still exports with this car.
      </p>

      <div className="handpair-grid">
        {photos.map((photo) => (
          <div
            key={photo.id}
            className={`handpair-tile${photo.id === pick ? ' picked' : ''}`}
          >
            <button
              className="handpair-pick"
              onClick={() => choose(photo.id)}
              aria-pressed={photo.id === pick}
              data-photo={photo.name}
              aria-label={
                photo.id === pick
                  ? `${photo.name}, chosen as the before shot. Tap to unchoose.`
                  : picked
                    ? `Use ${photo.name} as the after shot`
                    : `Use ${photo.name} as the before shot`
              }
            >
              <img src={photo.proxyUrl} alt="" loading="lazy" draggable={false} />
              {photo.id === pick && <span className="handpair-badge">BEFORE</span>}
            </button>
            <div className="handpair-meta">
              <span className="mono dim">{clockOf(photo.takenAt)}</span>
              <button
                className="handpair-zoom"
                onClick={() => setZoom(photo.id)}
                aria-label={`Look at ${photo.name} full screen`}
                title="View full screen"
              >
                <Icon name="eye" size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Full screen, because the leftovers are the ones you can't identify from
          a thumbnail — and choosing from here saves closing it again first. */}
      {zoomed && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={zoomed.name}
          data-testid="lightbox"
          onClick={() => setZoom(null)}
        >
          <img src={zoomed.proxyUrl} alt={zoomed.name} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <div className="lightbox-meta">
              <span>{zoomed.name}</span>
              <span className="mono dim">{clockOf(zoomed.takenAt)}</span>
            </div>
            <button
              className="btn"
              onClick={() => {
                choose(zoomed.id)
                setZoom(null)
              }}
            >
              {picked && picked.id !== zoomed.id ? 'Use as after' : 'Use as before'}
            </button>
            <button className="btn ghost" onClick={() => setZoom(null)} aria-label="Close">
              <Icon name="close" size={17} />
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
