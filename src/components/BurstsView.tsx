import { useState } from 'react'
import type { ApiBurst, ApiCarSolution, ApiPhoto, ConstraintIn, Side } from '../lib/api'
import { imageUrl } from '../lib/api'
import Icon from './Icon'

interface Props {
  jobId: string
  cars: ApiCarSolution[]
  photoById: Map<string, ApiPhoto>
  onConstraint: (c: ConstraintIn) => Promise<void>
  onNext: () => void
}

const SIDE_LABEL: Record<Side, string> = { before: 'Before', after: 'After', unknown: 'Unclear' }

/**
 * Step 1: review the bursts the pipeline collapsed near-identical re-shots
 * into, grouped by which side of the wash the timing split put them on --
 * that grouping is what makes a misclassified batch visible at a glance
 * instead of hiding inside one flat grid.
 *
 * The before/after split is a single widest-time-gap heuristic (see
 * timing.py) and it has a real failure mode: a car photographed across a
 * long day with more than one natural pause (a lunch break in the middle of
 * documenting a dirty interior, say) can have its widest gap sit *inside*
 * the "before" pass rather than between before and after, dumping a chunk
 * of dirty-car photos into "After" with nothing to catch it. "Move to
 * Before"/"Move to After" is the fix -- moves every photo in the selected
 * burst(s) at once (not just the one thumbnail clicked) so a burst never
 * ends up split across sides by accident.
 *
 * Select one non-representative photo and "Make representative" swaps the
 * pick; select two representatives from different bursts and "Merge" folds
 * them into one; select any single non-representative member and "Split
 * out" gives it its own burst. "Not part of the wash" excludes a photo
 * entirely -- a snow-foam "fun cannon" shot, say -- so it's never offered as
 * a before or after. That's a one-click manual call rather than an
 * automatic one on purpose: appearance statistics alone can't reliably tell
 * a foam-coated car apart from a genuinely white or silver one (checked,
 * and they're too close), so a person deciding beats a heuristic guessing
 * wrong.
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

  const excludeSelected = () => {
    const ids = [...selected]
    if (ids.length === 0) return
    void run(async () => {
      for (const id of ids) await onConstraint({ type: 'exclude', photo_id: id })
    })
  }

  /** Every burst touched by the current selection, so a side-move always
   * carries a whole burst with it -- moving just the clicked thumbnail
   * would otherwise split that burst across two sides. */
  const burstsTouchedBySelection = (): ApiBurst[] => {
    const touched: ApiBurst[] = []
    for (const car of cars) {
      for (const b of car.bursts) {
        if (b.photo_ids.some((pid) => selected.has(pid))) touched.push(b)
      }
    }
    return touched
  }

  const moveSelectedTo = (side: Side) => {
    const bursts = burstsTouchedBySelection()
    if (bursts.length === 0) return
    void run(async () => {
      for (const b of bursts) {
        for (const pid of b.photo_ids) {
          await onConstraint({ type: 'side', photo_id: pid, side })
        }
      }
    })
  }

  const totalBursts = cars.reduce((n, c) => n + c.bursts.length, 0)

  return (
    <>
      <main className="content has-actionbar" data-view="bursts">
        <div className="wrap">
          <p className="tiny dim" style={{ marginBottom: 12 }}>
            {totalBursts} bursts across {cars.length} car{cars.length === 1 ? '' : 's'}, grouped by
            before/after. If a batch landed on the wrong side, select it and use "Move to Before" /
            "Move to After" below.
          </p>

          {cars.map((car) => {
            const bySide: Record<Side, ApiBurst[]> = { before: [], after: [], unknown: [] }
            for (const b of car.bursts) bySide[b.side].push(b)

            return (
              <section key={car.id} className="card">
                <header className="card-head">
                  <strong style={{ flex: 1, fontSize: '0.92rem' }}>{car.name}</strong>
                  <span className="pill">{car.bursts.length} bursts</span>
                </header>
                <div className="card-body">
                  {(['before', 'after', 'unknown'] as Side[]).map((side) =>
                    bySide[side].length === 0 ? null : (
                      <div key={side} style={{ marginBottom: 10 }}>
                        <p className="tiny dim" style={{ margin: '8px 0 4px' }}>
                          {SIDE_LABEL[side]} · {bySide[side].length}
                        </p>
                        <div className="thumb-grid">
                          {bySide[side].map((b) =>
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
                                  {selected.has(pid) && (
                                    <span className="thumb-check">
                                      <Icon name="check" size={13} />
                                    </span>
                                  )}
                                </button>
                              )
                            }),
                          )}
                        </div>
                      </div>
                    ),
                  )}
                </div>
              </section>
            )
          })}
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
          <button className="btn ghost sm" disabled={busy || selected.size === 0} onClick={() => moveSelectedTo('before')}>
            Move to Before
          </button>
          <button className="btn ghost sm" disabled={busy || selected.size === 0} onClick={() => moveSelectedTo('after')}>
            Move to After
          </button>
          <button className="btn ghost sm" disabled={busy || selected.size === 0} onClick={excludeSelected}>
            <Icon name="trash" size={15} />
            Not part of the wash
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
