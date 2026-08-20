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
 * Step 1: review the bursts the pipeline collapsed near-identical re-shots
 * into. Each card is one burst -- one angle, shot more than once -- with its
 * representative (the sharpest, or whichever the user picked) highlighted.
 *
 * Select one non-representative photo and "Make representative" swaps the
 * pick; select two representatives from different bursts and "Merge" folds
 * them into one; select any single non-representative member and "Split
 * out" gives it its own burst, for the case this collapsed something that
 * shouldn't have been.
 */
export default function BurstsView({ jobId, cars, photoById, onConstraint, onNext }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  const makeRepresentative = () => {
    const [id] = [...selected]
    if (selected.size !== 1 || !id) return
    void run(() => onConstraint({ type: 'represent', photo_id: id }))
  }

  const splitOut = () => {
    const ids = [...selected]
    void run(async () => {
      for (const id of ids) await onConstraint({ type: 'burstSplit', photo_id: id })
    })
  }

  const mergeSelected = () => {
    const ids = [...selected]
    if (ids.length < 2) return
    void run(async () => {
      for (let i = 1; i < ids.length; i++) {
        await onConstraint({ type: 'burstMerge', a: ids[0], b: ids[i] })
      }
    })
  }

  const totalBursts = cars.reduce((n, c) => n + c.bursts.length, 0)

  return (
    <>
      <main className="content has-actionbar" data-view="bursts">
        <div className="wrap">
          <p className="tiny dim" style={{ marginBottom: 12 }}>
            {totalBursts} bursts across {cars.length} car{cars.length === 1 ? '' : 's'}. Near-identical
            re-shots are grouped together; pick a photo to fix one that's wrong.
          </p>

          {cars.map((car) => (
            <section key={car.id} className="card">
              <header className="card-head">
                <strong style={{ flex: 1, fontSize: '0.92rem' }}>{car.name}</strong>
                <span className="pill">{car.bursts.length} bursts</span>
              </header>
              <div className="card-body">
                <div className="thumb-grid">
                  {car.bursts.map((b) =>
                    b.photo_ids.map((pid) => {
                      const photo = photoById.get(pid)
                      const isRep = pid === b.representative_id
                      return (
                        <button
                          key={pid}
                          className={`thumb${selected.has(pid) ? ' selected' : ''}${isRep ? ' picked' : ''}`}
                          onClick={() => toggle(pid)}
                          aria-label={photo?.name}
                          title={photo?.name}
                        >
                          <img src={imageUrl(jobId, pid)} alt="" loading="lazy" />
                          {isRep && <span className="thumb-badge">pick</span>}
                          {b.photo_ids.length > 1 && !isRep && (
                            <span className="thumb-badge warn">{b.photo_ids.length}</span>
                          )}
                          {selected.has(pid) && <span className="thumb-check"><Icon name="check" size={13} /></span>}
                        </button>
                      )
                    }),
                  )}
                </div>
              </div>
            </section>
          ))}
        </div>
      </main>

      <div className="actionbar">
        <div className="actionbar-inner">
          <button className="btn ghost sm" disabled={busy || selected.size !== 1} onClick={makeRepresentative}>
            <Icon name="sparkle" size={15} />
            Make representative
          </button>
          <button className="btn ghost sm" disabled={busy || selected.size === 0} onClick={splitOut}>
            <Icon name="split" size={15} />
            Split out
          </button>
          <button className="btn ghost sm" disabled={busy || selected.size < 2} onClick={mergeSelected}>
            <Icon name="merge" size={15} />
            Merge
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={onNext}>
            Verify pairs
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
      </div>
    </>
  )
}
