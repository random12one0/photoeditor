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
                    </div>
                    <div style={{ flex: 1 }}>
                      <img
                        src={imageUrl(jobId, pair.after_id)}
                        alt={after?.name}
                        style={{ width: '100%', borderRadius: 8, display: 'block' }}
                      />
                      <p className="tiny dim mono" style={{ marginTop: 4 }}>{after?.name}</p>
                    </div>
                  </div>
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
