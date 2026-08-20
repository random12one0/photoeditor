import { useMemo, useState } from 'react'
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

const TIER_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  high: 'Likely',
  uncertain: 'Uncertain',
}

/** "9:02 AM" for a same-day pair, with the date added if they span days --
 * a double-check that the matcher didn't pair two photos taken hours or
 * days apart, which visual similarity alone can't rule out. */
function formatTakenAt(photo: ApiPhoto | undefined): string {
  if (!photo) return ''
  const d = new Date(photo.taken_at)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return photo.time_is_approximate ? `${time} (approx.)` : time
}

function sameDay(a?: ApiPhoto, b?: ApiPhoto): boolean {
  if (!a || !b) return true
  return new Date(a.taken_at).toDateString() === new Date(b.taken_at).toDateString()
}

/**
 * Step 2: walk through the matcher's suggested before/after pairs. Confirm
 * pins it (locking it against being disturbed by a later edit); Reject
 * forbids that exact combination and re-solves, which frees both photos --
 * the same "not a pair falls through to the next candidate" behaviour the
 * browser prototype had, just server-side now (pipeline/solver.py).
 */
export default function VerifyPairsView({ jobId, cars, photoById, onConstraint, onNext }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [swapping, setSwapping] = useState<{ pairId: string; side: 'before' | 'after' } | null>(null)

  const rows = useMemo(
    () =>
      cars.flatMap((car) =>
        car.pairs
          .filter((p) => !dismissed.has(p.id))
          .map((pair) => ({ car, pair })),
      ),
    [cars, dismissed],
  )

  const confirm = async (pairId: string, beforeId: string, afterId: string) => {
    setBusy(pairId)
    try {
      await onConstraint({ type: 'pin', before: beforeId, after: afterId })
      setDismissed((d) => new Set(d).add(pairId))
    } finally {
      setBusy(null)
    }
  }

  const reject = async (pairId: string, beforeId: string, afterId: string) => {
    setBusy(pairId)
    try {
      await onConstraint({ type: 'forbid', before: beforeId, after: afterId })
      setDismissed((d) => new Set(d).add(pairId))
    } finally {
      setBusy(null)
    }
  }

  /** Swap just one side of a pair and keep the other -- pinning the new
   * combination directly is enough; the old photo on that side simply
   * becomes free for the solver to offer somewhere else on the next solve,
   * no separate "un-pin" step needed. */
  const swapTo = async (pairId: string, beforeId: string, afterId: string, replacementId: string) => {
    setBusy(pairId)
    try {
      if (swapping?.side === 'before') {
        await onConstraint({ type: 'pin', before: replacementId, after: afterId })
      } else {
        await onConstraint({ type: 'pin', before: beforeId, after: replacementId })
      }
      setDismissed((d) => new Set(d).add(pairId))
      setSwapping(null)
    } finally {
      setBusy(null)
    }
  }

  const remaining = rows.length
  const totalConfirmed = cars.reduce(
    (n, c) => n + c.pairs.filter((p) => p.tier === 'confirmed').length,
    0,
  )

  return (
    <>
      <main className="content has-actionbar" data-view="verify">
        <div className="wrap">
          <p className="tiny dim" style={{ marginBottom: 12 }}>
            {remaining} pair{remaining === 1 ? '' : 's'} to review
            {totalConfirmed ? ` · ${totalConfirmed} already confirmed` : ''}.
          </p>

          {rows.length === 0 && (
            <p className="muted tiny" style={{ padding: 24, textAlign: 'center' }}>
              Nothing left to review here — head to the next step.
            </p>
          )}

          {rows.map(({ car, pair }) => {
            const before = photoById.get(pair.before_id)
            const after = photoById.get(pair.after_id)
            const spansDays = !sameDay(before, after)
            return (
              <section key={pair.id} className="card">
                <header className="card-head">
                  <strong style={{ flex: 1, fontSize: '0.85rem' }}>{car.name}</strong>
                  <span className={`pill${pair.tier === 'confirmed' ? ' good' : ''}`}>
                    {TIER_LABEL[pair.tier] ?? pair.tier} · {Math.round(pair.score * 100)}%
                    {pair.inliers > 0 ? ` · ${pair.inliers} pts` : ''}
                  </span>
                </header>
                <div className="card-body">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <img
                        src={imageUrl(jobId, pair.before_id)}
                        alt={before?.name}
                        style={{ width: '100%', borderRadius: 8, display: 'block' }}
                      />
                      <p className="tiny dim mono" style={{ marginTop: 4 }}>{before?.name}</p>
                      <p className="tiny dim mono">{formatTakenAt(before)}</p>
                      <button
                        className="btn ghost sm"
                        style={{ marginTop: 4, width: '100%', fontSize: '0.7rem' }}
                        disabled={busy === pair.id}
                        onClick={() =>
                          setSwapping((s) =>
                            s?.pairId === pair.id && s.side === 'before' ? null : { pairId: pair.id, side: 'before' },
                          )
                        }
                      >
                        <Icon name="swap" size={13} /> Replace before
                      </button>
                    </div>
                    <div style={{ flex: 1 }}>
                      <img
                        src={imageUrl(jobId, pair.after_id)}
                        alt={after?.name}
                        style={{ width: '100%', borderRadius: 8, display: 'block' }}
                      />
                      <p className="tiny dim mono" style={{ marginTop: 4 }}>{after?.name}</p>
                      <p className="tiny dim mono">{formatTakenAt(after)}</p>
                      <button
                        className="btn ghost sm"
                        style={{ marginTop: 4, width: '100%', fontSize: '0.7rem' }}
                        disabled={busy === pair.id}
                        onClick={() =>
                          setSwapping((s) =>
                            s?.pairId === pair.id && s.side === 'after' ? null : { pairId: pair.id, side: 'after' },
                          )
                        }
                      >
                        <Icon name="swap" size={13} /> Replace after
                      </button>
                    </div>
                  </div>
                  {swapping?.pairId === pair.id && (
                    <div style={{ marginTop: 8 }}>
                      <p className="tiny dim" style={{ margin: '4px 0' }}>
                        Pick a replacement {swapping.side} photo for this car:
                      </p>
                      <div className="thumb-grid">
                        {car.bursts
                          .filter((b) => b.side === swapping.side)
                          .map((b) => b.representative_id)
                          .filter((pid) => pid !== pair[swapping.side === 'before' ? 'before_id' : 'after_id'])
                          .map((pid) => {
                            const candidate = photoById.get(pid)
                            return (
                              <button
                                key={pid}
                                className="thumb"
                                title={candidate?.name}
                                aria-label={candidate?.name}
                                disabled={busy === pair.id}
                                onClick={() => void swapTo(pair.id, pair.before_id, pair.after_id, pid)}
                              >
                                <img src={imageUrl(jobId, pid)} alt="" loading="lazy" />
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  )}
                  {spansDays && (
                    <p className="tiny" style={{ color: 'var(--no, #e5484d)', marginTop: 6 }}>
                      <Icon name="clock" size={12} /> These were taken on different days — worth a second look.
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      className="btn ghost sm"
                      style={{ flex: 1 }}
                      disabled={busy === pair.id}
                      onClick={() => void reject(pair.id, pair.before_id, pair.after_id)}
                    >
                      <Icon name="thumbDown" size={15} />
                      Not a pair
                    </button>
                    <button
                      className="btn primary sm"
                      style={{ flex: 1 }}
                      disabled={busy === pair.id}
                      onClick={() => void confirm(pair.id, pair.before_id, pair.after_id)}
                    >
                      <Icon name="thumbUp" size={15} />
                      Confirm
                    </button>
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      </main>

      <div className="actionbar">
        <div className="actionbar-inner">
          <button className="btn primary block" onClick={onNext}>
            Fix leftovers
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
      </div>
    </>
  )
}
