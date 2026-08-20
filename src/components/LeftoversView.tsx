import { useState } from 'react'
import type { ApiCarSolution, ApiPhoto, ConstraintIn } from '../lib/api'
import { imageUrl } from '../lib/api'
import Icon from './Icon'

interface Props {
  jobId: string
  cars: ApiCarSolution[]
  photoById: Map<string, ApiPhoto>
  onConstraint: (c: ConstraintIn) => Promise<void>
  onNext: () => void
}

/**
 * Step 3: whatever the matcher couldn't place on its own -- an orphan
 * before with no after (or the reverse), or a photo whose before/after side
 * was never determined because the car had no clear time gap. Pick one from
 * each column and Pair them by hand, or Exclude a photo that shouldn't be
 * in the export at all (a stray shot of the driveway, say).
 */
export default function LeftoversView({ jobId, cars, photoById, onConstraint, onNext }: Props) {
  const [pickedBefore, setPickedBefore] = useState<string | null>(null)
  const [pickedAfter, setPickedAfter] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const totalLeftover = cars.reduce(
    (n, c) => n + c.orphan_befores.length + c.orphan_afters.length + c.unknown_side.length,
    0,
  )

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setPickedBefore(null)
      setPickedAfter(null)
    } finally {
      setBusy(false)
    }
  }

  const thumb = (
    pid: string,
    picked: boolean,
    onClick: () => void,
    badge?: string,
  ) => {
    const photo = photoById.get(pid)
    return (
      <button
        key={pid}
        className={`thumb${picked ? ' selected' : ''}`}
        onClick={onClick}
        title={photo?.name}
        aria-label={photo?.name}
      >
        <img src={imageUrl(jobId, pid)} alt="" loading="lazy" />
        {badge && <span className="thumb-badge">{badge}</span>}
        {picked && (
          <span className="thumb-check">
            <Icon name="check" size={13} />
          </span>
        )}
      </button>
    )
  }

  if (totalLeftover === 0) {
    return (
      <>
        <main className="content has-actionbar" data-view="leftovers">
          <div className="wrap">
            <p className="muted tiny" style={{ padding: 24, textAlign: 'center' }}>
              No leftovers — every photo has a side and a partner.
            </p>
          </div>
        </main>
        <div className="actionbar">
          <div className="actionbar-inner">
            <button className="btn primary block" onClick={onNext}>
              Style &amp; export
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <main className="content has-actionbar" data-view="leftovers">
        <div className="wrap">
          <p className="tiny dim" style={{ marginBottom: 12 }}>
            Pick one before and one after, then Pair them — or select any single photo and Exclude it.
          </p>

          {cars.map((car) => {
            if (!car.orphan_befores.length && !car.orphan_afters.length && !car.unknown_side.length) {
              return null
            }
            return (
              <section key={car.id} className="card">
                <header className="card-head">
                  <strong style={{ flex: 1, fontSize: '0.92rem' }}>{car.name}</strong>
                </header>
                <div className="card-body">
                  {car.orphan_befores.length > 0 && (
                    <>
                      <p className="tiny dim" style={{ margin: '8px 0 4px' }}>Before, no partner found</p>
                      <div className="thumb-grid">
                        {car.orphan_befores.map((pid) =>
                          thumb(pid, pickedBefore === pid, () =>
                            setPickedBefore((cur) => (cur === pid ? null : pid)),
                          ),
                        )}
                      </div>
                    </>
                  )}
                  {car.orphan_afters.length > 0 && (
                    <>
                      <p className="tiny dim" style={{ margin: '12px 0 4px' }}>After, no partner found</p>
                      <div className="thumb-grid">
                        {car.orphan_afters.map((pid) =>
                          thumb(pid, pickedAfter === pid, () =>
                            setPickedAfter((cur) => (cur === pid ? null : pid)),
                          ),
                        )}
                      </div>
                    </>
                  )}
                  {car.unknown_side.length > 0 && (
                    <>
                      <p className="tiny dim" style={{ margin: '12px 0 4px' }}>
                        No clear before/after gap in this car — mark each one by hand
                      </p>
                      <div className="thumb-grid">
                        {car.unknown_side.map((pid) => (
                          <div key={pid} style={{ display: 'grid', gap: 4 }}>
                            {thumb(pid, false, () => {})}
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                className="btn ghost sm"
                                style={{ flex: 1, fontSize: '0.7rem' }}
                                disabled={busy}
                                onClick={() =>
                                  void run(() => onConstraint({ type: 'side', photo_id: pid, side: 'before' }))
                                }
                              >
                                Before
                              </button>
                              <button
                                className="btn ghost sm"
                                style={{ flex: 1, fontSize: '0.7rem' }}
                                disabled={busy}
                                onClick={() =>
                                  void run(() => onConstraint({ type: 'side', photo_id: pid, side: 'after' }))
                                }
                              >
                                After
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </main>

      <div className="actionbar">
        <div className="actionbar-inner">
          <button
            className="btn ghost sm"
            disabled={busy || (!pickedBefore && !pickedAfter)}
            onClick={() =>
              void run(async () => {
                if (pickedBefore) await onConstraint({ type: 'exclude', photo_id: pickedBefore })
                if (pickedAfter) await onConstraint({ type: 'exclude', photo_id: pickedAfter })
              })
            }
          >
            <Icon name="trash" size={15} />
            Exclude selected
          </button>
          <button
            className="btn ghost sm"
            disabled={busy || !pickedBefore || !pickedAfter}
            onClick={() =>
              void run(() => onConstraint({ type: 'pin', before: pickedBefore!, after: pickedAfter! }))
            }
          >
            <Icon name="pair" size={15} />
            Pair selected
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={onNext}>
            Style &amp; export
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
      </div>
    </>
  )
}
