import { useCallback, useEffect, useMemo, useState } from 'react'
import { candidatePartners } from '../lib/cluster'
import {
  type Label,
  agreement,
  clearLabels,
  labelKey,
  labelsToJson,
  loadLabels,
  recordLabel,
} from '../lib/labels'
import { similarity } from '../lib/hash'
import { haptic } from '../lib/share'
import { FILE_PREFIX } from '../brand'
import type { ClusterSettings, Group, Photo } from '../types'
import Icon from './Icon'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  clusterSettings: ClusterSettings
  notify: (message: string, undoable?: boolean) => void
}

/** One question: are these two the same shot, before and after? */
interface Question {
  before: Photo
  after: Photo
  groupName: string
  score: number
  /** How close the runner-up was. Small means the matcher is nearly guessing. */
  doubt: number
}

const clockOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const gapLabel = (seconds: number) => {
  if (seconds < 90) return `${seconds}s apart`
  const mins = Math.round(seconds / 60)
  if (mins < 90) return `${mins} min apart`
  return `${(mins / 60).toFixed(1)} h apart`
}

/**
 * A screen for telling the matcher when it is wrong, on purpose.
 *
 * The rest of the app already collects judgements as a side effect of normal
 * use — every confirm, every "not a pair", every hand-made pair is written down.
 * That is the bulk of the data and it costs nobody anything. But it is biased in
 * a specific way: it only ever contains combinations the matcher *proposed*, so
 * the cases where it is confidently wrong in a direction it never suggests are
 * exactly the ones missing.
 *
 * This screen fixes that by choosing the questions itself, and the choosing is
 * the whole feature. Asking about a random pair of photos is close to worthless:
 * the answer is no, everyone knows it is no, and a fit learns nothing from being
 * told what it already gets right. What is worth asking about is a pair the
 * matcher cannot separate — where its first and second choices are within a
 * whisker of each other. One answer there moves a decision boundary. So the
 * queue is sorted by the matcher's own doubt, hardest first.
 *
 * The agreement figure at the top is the other half. It reads back, on today's
 * cars, how often the matcher's ranking agrees with the user's verdicts — so
 * "is this version actually better" stops being a question anyone has to take on
 * trust, and can be answered on the phone in the bay.
 */
export default function LabView({ groups, photoMap, clusterSettings, notify }: Props) {
  const [labels, setLabels] = useState<Label[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(true)
  const [tab, setTab] = useState<'judge' | 'log'>('judge')

  useEffect(() => {
    let cancelled = false
    void loadLabels().then((l) => {
      if (!cancelled) {
        setLabels(l)
        setBusy(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const labelled = useMemo(() => new Set(labels.map((l) => l.key)), [labels])

  /**
   * The queue, hardest first.
   *
   * For every photo in every car, the matcher's top two candidates. If those two
   * are close, the pick is nearly arbitrary and the answer is worth having; if
   * the top candidate is far ahead, the matcher is sure and asking is a waste of
   * the user's time. Anything already judged drops out.
   */
  const questions = useMemo<Question[]>(() => {
    const out: Question[] = []
    const seen = new Set<string>()

    for (const group of groups) {
      const photos = group.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p))
      if (photos.length < 2) continue

      for (const before of photos) {
        const partners = candidatePartners(
          group,
          photoMap,
          clusterSettings,
          before.id,
          'before',
        )
          .map((id) => photoMap.get(id))
          .filter((p): p is Photo => Boolean(p))
        if (!partners.length) continue

        const scored = partners
          .map((p) => ({ photo: p, score: similarity(before, p) }))
          .sort((a, b) => b.score - a.score)

        const top = scored[0]
        const runnerUp = scored[1]
        const key = labelKey(before.id, top.photo.id)
        /* One direction only. A and B is the same question as B and A, and
           asking both would double the work for no extra information. */
        const mirror = labelKey(top.photo.id, before.id)
        if (labelled.has(key) || labelled.has(mirror) || seen.has(key) || seen.has(mirror)) {
          continue
        }
        seen.add(key)

        out.push({
          before,
          after: top.photo,
          groupName: group.name,
          score: top.score,
          doubt: runnerUp ? 1 - (top.score - runnerUp.score) : 0,
        })
      }
    }

    return out.sort((a, b) => b.doubt - a.doubt)
  }, [groups, photoMap, clusterSettings, labelled])

  const current = questions[index] ?? null

  /* The matcher's own opinion, recomputed live, so the agreement figure tracks
     whatever version is running rather than whatever version made the label. */
  const rank = useCallback((before: Photo, candidates: Photo[]) => {
    let best: Photo | null = null
    let bestScore = -Infinity
    for (const c of candidates) {
      const s = similarity(before, c)
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
    return best
  }, [])

  const stats = useMemo(
    () => agreement(labels, groups, photoMap, rank),
    [labels, groups, photoMap, rank],
  )

  const judge = useCallback(
    async (verdict: 'yes' | 'no') => {
      if (!current) return
      haptic(verdict === 'yes' ? 10 : 6)
      await recordLabel(current.before, current.after, verdict, 'lab')
      setLabels(await loadLabels())
      setIndex((i) => i + 1)
    },
    [current],
  )

  const skip = useCallback(() => setIndex((i) => i + 1), [])

  useEffect(() => {
    if (tab !== 'judge') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      /* Same keys as the review card, deliberately: Y and → to agree, X and ←
         to disagree, Space to move on. A second set of bindings for the same
         gesture is a second thing to remember. */
      const k = e.key.toLowerCase()
      if (k === 'y' || e.key === 'ArrowRight' || e.key === 'Enter') void judge('yes')
      else if (k === 'x' || k === 'n' || e.key === 'ArrowLeft') void judge('no')
      else if (e.key === ' ') {
        e.preventDefault()
        skip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [judge, skip, tab])

  const download = useCallback(() => {
    const blob = new Blob([labelsToJson(labels)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${FILE_PREFIX}-labels-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    notify(`Exported ${labels.length} judgements`)
  }, [labels, notify])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(labelsToJson(labels))
      notify('Copied — paste it anywhere')
    } catch {
      notify('Could not copy — use Download instead')
    }
  }, [labels, notify])

  const wipe = useCallback(async () => {
    if (!window.confirm(`Delete all ${labels.length} judgements? This cannot be undone.`)) {
      return
    }
    await clearLabels()
    setLabels([])
    setIndex(0)
    notify('Judgements cleared')
  }, [labels.length, notify])

  const yes = labels.filter((l) => l.verdict === 'yes').length
  const bySource = (s: Label['source']) => labels.filter((l) => l.source === s).length

  return (
    <main className="content lab" data-view="lab">
      <div className="lab-head">
        <div>
          <h2>Lab</h2>
          <p className="dim">
            Judge pairs the matcher is unsure about. Everything you decide here — and
            everything you confirm or reject while pairing normally — is kept, so the
            matching can be measured and re-fitted against your own cars.
          </p>
        </div>
      </div>

      <div className="lab-stats" data-testid="lab-stats">
        <div className="stat">
          <span className="stat-num mono">{labels.length}</span>
          <span className="stat-label">judgements</span>
        </div>
        <div className="stat">
          <span className="stat-num mono">
            {yes}
            <span className="dim">/{labels.length - yes}</span>
          </span>
          <span className="stat-label">yes / no</span>
        </div>
        <div className="stat">
          <span className="stat-num mono">
            {stats.total ? `${Math.round((stats.agreed / stats.total) * 100)}%` : '—'}
          </span>
          <span className="stat-label">
            matcher agrees
            {stats.total > 0 && (
              <span className="dim"> ({stats.agreed}/{stats.total})</span>
            )}
          </span>
        </div>
      </div>

      <nav className="lab-tabs">
        <button
          className={`btn ghost${tab === 'judge' ? ' active' : ''}`}
          onClick={() => setTab('judge')}
        >
          Judge
          {questions.length > index && (
            <span className="pill">{questions.length - index}</span>
          )}
        </button>
        <button
          className={`btn ghost${tab === 'log' ? ' active' : ''}`}
          onClick={() => setTab('log')}
        >
          Log
          <span className="pill">{labels.length}</span>
        </button>
      </nav>

      {tab === 'judge' &&
        (busy ? (
          <div className="empty-state">
            <div className="spinner" />
          </div>
        ) : !current ? (
          <div className="empty-state" data-testid="lab-done">
            <Icon name="check" size={28} />
            <p>
              {questions.length === 0 && labels.length === 0
                ? 'Nothing to judge yet — import some photos first.'
                : 'Nothing left the matcher is unsure about.'}
            </p>
            {index > 0 && (
              <button className="btn ghost" onClick={() => setIndex(0)}>
                Start over
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="lab-context">
              <span className="pill">{current.groupName}</span>
              <span className="dim tiny">
                {index + 1} of {questions.length} · match {current.score.toFixed(3)} ·{' '}
                {gapLabel(
                  Math.round(Math.abs(current.after.takenAt - current.before.takenAt) / 1000),
                )}
              </span>
            </div>

            <div className="lab-pair" data-testid="lab-pair">
              {[current.before, current.after].map((photo, i) => (
                <figure key={photo.id} className="lab-shot">
                  <img src={photo.proxyUrl} alt={photo.name} data-photo={photo.id} />
                  <figcaption>
                    <span className="tag">{i === 0 ? 'Before' : 'After'}</span>
                    <span className="mono tiny">{clockOf(photo.takenAt)}</span>
                    <span className="dim tiny name">{photo.name}</span>
                  </figcaption>
                </figure>
              ))}
            </div>

            <div className="lab-actions">
              <button
                className="btn danger lab-btn"
                onClick={() => void judge('no')}
                data-testid="lab-no"
              >
                <Icon name="thumbDown" />
                Not a pair
                <kbd>X</kbd>
              </button>
              <button className="btn ghost" onClick={skip}>
                Skip
                <kbd>Space</kbd>
              </button>
              <button
                className="btn primary lab-btn"
                onClick={() => void judge('yes')}
                data-testid="lab-yes"
              >
                <Icon name="thumbUp" />
                Same shot
                <kbd>Y</kbd>
              </button>
            </div>

            <p className="tiny dim lab-hint">
              Hardest first — these are the ones where the matcher's first and second
              choices were nearly tied, so your answer here is worth the most.
            </p>
          </>
        ))}

      {tab === 'log' && (
        <>
          <div className="lab-export">
            <button className="btn primary" onClick={download} disabled={!labels.length}>
              <Icon name="download" />
              Download JSON
            </button>
            <button className="btn ghost" onClick={copy} disabled={!labels.length}>
              <Icon name="copy" />
              Copy
            </button>
            <button className="btn ghost danger" onClick={wipe} disabled={!labels.length}>
              <Icon name="trash" />
              Clear
            </button>
          </div>

          <p className="tiny dim">
            The file holds verdicts and measurements only — no image data, no
            recognisable content. Judged here: {bySource('lab')} · confirmed while
            pairing: {bySource('confirm')} · rejected: {bySource('reject')} · paired by
            hand: {bySource('hand')}.
          </p>

          {stats.disagreements.length > 0 && (
            <div className="lab-disagree">
              <h3>
                Where the matcher disagrees with you
                <span className="pill">{stats.disagreements.length}</span>
              </h3>
              <p className="tiny dim">
                These are the cases still worth fixing. Everything else it already gets
                right.
              </p>
              {stats.disagreements.slice(0, 12).map((l) => (
                <LabelRow key={l.key} label={l} photoMap={photoMap} />
              ))}
            </div>
          )}

          <div className="lab-log">
            {labels.length === 0 && (
              <div className="empty-state">
                <p>Nothing recorded yet.</p>
              </div>
            )}
            {labels.slice(0, 60).map((l) => (
              <LabelRow key={l.key} label={l} photoMap={photoMap} />
            ))}
            {labels.length > 60 && (
              <p className="tiny dim">
                …and {labels.length - 60} more. The export has all of them.
              </p>
            )}
          </div>
        </>
      )}
    </main>
  )
}

function LabelRow({ label, photoMap }: { label: Label; photoMap: Map<string, Photo> }) {
  const before = photoMap.get(label.before.id)
  const after = photoMap.get(label.after.id)
  /* Recomputed rather than read off the label, so the row shows what the running
     version thinks — which is the only number worth comparing a verdict against. */
  const live = before && after ? similarity(before, after) : null

  return (
    <div className={`label-row ${label.verdict}`} data-testid="label-row">
      <span className={`verdict ${label.verdict}`}>
        <Icon name={label.verdict === 'yes' ? 'thumbUp' : 'thumbDown'} size={14} />
      </span>
      {before && <img src={before.proxyUrl} alt="" />}
      {after && <img src={after.proxyUrl} alt="" />}
      <span className="dim tiny names">
        {label.before.name} → {label.after.name}
      </span>
      <span className="mono tiny">
        {live !== null ? live.toFixed(3) : '—'}
        {label.components.inliers >= 12 && (
          <span className="dim"> · {label.components.inliers} pts</span>
        )}
      </span>
      <span className="dim tiny source">{label.source}</span>
    </div>
  )
}
