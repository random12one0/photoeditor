/**
 * Which descriptors actually separate a true pair from a plausible impostor.
 *
 * Reported as wheels being confused with interiors, with a hypothesis worth
 * testing: that judging by average colour is the problem, because "an outside
 * shot has some green in it and an interior has none" is information the
 * average throws away.
 *
 * So this scores candidate scoring functions against both sets of real
 * photographs, with ground truth, and reports:
 *
 *   row wins   — does the true partner beat every impostor for that photo?
 *                This is the honest measure of the descriptor itself.
 *   assigned   — how many pairs survive the global assignment. Higher than row
 *                wins, because the assignment can rescue a row that loses.
 *   margin     — how far ahead the true partner is. Negative means it lost.
 *
 * Row wins is the one to watch. The assignment can paper over a weak descriptor
 * right up until the day it can't, which is what happened here.
 *
 * Run:  node test/diagnose-descriptors.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { AFTER, BEFORE, PAIRS, SUBJECT, num } from './lib/samecar-truth.mjs'

const PORT = 4334
const JEEP = new URL('./fixtures/samecar/', import.meta.url).pathname
const REFS = new URL('./fixtures/photos/', import.meta.url).pathname
if (!existsSync(JEEP)) {
  console.log(`No fixtures in ${JEEP} — skipping. (Real photos, deliberately not committed.)`)
  process.exit(0)
}
const jeepNames = readdirSync(JEEP).filter((f) => /\.jpe?g$/i.test(f)).sort()
const refNames = existsSync(REFS)
  ? readdirSync(REFS).filter((f) => /\.jpe?g$/i.test(f)).sort()
  : []

const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

const out = await page.evaluate(async ({ jeep, refs, jeepDir, refDir, beforeNums, pairs }) => {
  const H = await import('/src/lib/hash.ts')
  const { assignMax } = await import('/src/lib/assign.ts')

  const EDGE = 1400

  async function fingerprint(dir, name) {
    const res = await fetch(`${dir}${name}`)
    if (!res.ok) throw new Error(`${name} ${res.status}`)
    const full = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' })
    const scale = Math.min(1, EDGE / Math.max(full.width, full.height))
    const bmp =
      scale >= 1
        ? full
        : await createImageBitmap(full, {
            resizeWidth: Math.round(full.width * scale),
            resizeHeight: Math.round(full.height * scale),
            resizeQuality: 'high',
          })
    const grid = (w, h) => {
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bmp, 0, 0, w, h)
      return ctx.getImageData(0, 0, w, h)
    }
    const colorGrid = grid(32, 32)
    const bigGrid = grid(H.QUALITY_GRID, H.QUALITY_GRID)
    const fp = {
      name,
      dhash: H.dhashFromImageData(grid(9, 8)),
      chromaSig: H.chromaSignature(colorGrid),
      lumaGrid: H.lumaGridFromImageData(grid(H.LUMA_GRID, H.LUMA_GRID)),
      lumaGridCoarse: H.lumaGridFromImageData(grid(H.COARSE_GRID, H.COARSE_GRID)),
      colorHist: H.colorHistogram(bigGrid),
      edgeHist: H.edgeHistogram(bigGrid),
    }
    if (bmp !== full) full.close()
    bmp.close()
    return fp
  }

  /** The four terms every candidate is built from, each already 0-1. */
  const terms = (a, b) => ({
    coarse: (H.shiftedNcc(a.lumaGridCoarse, b.lumaGridCoarse, H.COARSE_GRID, 2) + 1) / 2,
    fine: (H.shiftedNcc(a.lumaGrid, b.lumaGrid, H.LUMA_GRID, 3) + 1) / 2,
    chroma: 1 - H.chromaDistance(a.chromaSig, b.chromaSig),
    hash: 1 - H.hamming(a.dhash, b.dhash) / 64,
    color: H.colorHistogramSimilarity(a.colorHist, b.colorHist),
    edge: H.edgeHistogramSimilarity(a.edgeHist, b.edgeHist),
  })

  /* Candidates. The first is what ships today, so every other row is a
     comparison against it rather than against nothing. */
  const CANDIDATES = [
    { name: 'current (shipping)', w: { coarse: 0.4, fine: 0.25, chroma: 0.25, hash: 0.1 } },
    { name: 'colour histogram only', w: { color: 1 } },
    { name: 'edge histogram only', w: { edge: 1 } },
    { name: 'structure only', w: { coarse: 0.6, fine: 0.4 } },
    { name: '+colour, light', w: { coarse: 0.34, fine: 0.21, chroma: 0.15, hash: 0.08, color: 0.22 } },
    { name: '+colour, heavy', w: { coarse: 0.26, fine: 0.16, chroma: 0.06, hash: 0.06, color: 0.46 } },
    { name: '+colour +edge', w: { coarse: 0.26, fine: 0.14, chroma: 0.06, hash: 0.04, color: 0.30, edge: 0.20 } },
    { name: '+colour +edge, no chroma', w: { coarse: 0.26, fine: 0.16, hash: 0.04, color: 0.32, edge: 0.22 } },
    { name: 'colour + edge only', w: { color: 0.55, edge: 0.45 } },
    { name: 'colour + edge + coarse', w: { coarse: 0.3, color: 0.42, edge: 0.28 } },
    { name: 'colour + edge, even', w: { color: 0.5, edge: 0.5 } },
    { name: 'edge-led + colour', w: { color: 0.4, edge: 0.6 } },
    { name: 'colour-led + edge', w: { color: 0.65, edge: 0.35 } },
    { name: 'c+e + a little coarse', w: { coarse: 0.14, color: 0.47, edge: 0.39 } },
    { name: 'c+e + a little structure', w: { coarse: 0.12, fine: 0.08, color: 0.44, edge: 0.36 } },
    { name: 'c+e + hash', w: { color: 0.48, edge: 0.4, hash: 0.12 } },
    { name: 'c+e + chroma', w: { color: 0.45, edge: 0.38, chroma: 0.17 } },
  ]

  const score = (t, w) => {
    let s = 0
    let total = 0
    for (const k of Object.keys(w)) {
      s += t[k] * w[k]
      total += w[k]
    }
    return s / (total || 1)
  }

  /** Score one before/after set against its ground truth. */
  function evaluate(beforeFps, afterFps, truth, w) {
    const t = beforeFps.map((b) => afterFps.map((a) => terms(b, a)))
    const matrix = t.map((row) => row.map((x) => score(x, w)))

    let rowWins = 0
    let contests = 0
    let margins = []
    const losses = []
    beforeFps.forEach((b, i) => {
      const want = truth[b.name]
      if (!want) return
      contests++
      const j = afterFps.findIndex((a) => a.name === want)
      if (j < 0) return
      const best = matrix[i].reduce((m, v, k) => (v > matrix[i][m] ? k : m), 0)
      const sorted = [...matrix[i]].sort((x, y) => y - x)
      const margin = matrix[i][j] - (best === j ? sorted[1] : sorted[0])
      margins.push(margin)
      if (best === j) rowWins++
      else losses.push(`${b.name}→${afterFps[best].name} (wanted ${want}, by ${(-margin).toFixed(3)})`)
    })

    const chosen = assignMax(matrix, -Infinity)
    let assigned = 0
    chosen.forEach((j, i) => {
      if (j < 0) return
      if (truth[beforeFps[i].name] === afterFps[j].name) assigned++
    })

    return {
      rowWins,
      contests,
      assigned,
      minMargin: margins.length ? Math.min(...margins) : 0,
      meanMargin: margins.length ? margins.reduce((s, m) => s + m, 0) / margins.length : 0,
      losses,
    }
  }

  /* ---- set one: the Jeep, five before shots and four after ---- */
  const jeepFps = {}
  for (const n of jeep) jeepFps[n] = await fingerprint(jeepDir, n)

  /* ---- set two: five cars cut out of the reference collages ---- */
  const refFps = {}
  for (const n of refs) refFps[n] = await fingerprint(refDir, n)

  return {
    candidates: CANDIDATES.map((c) => c.name),
    weights: CANDIDATES.map((c) => c.w),
    jeepNames: jeep,
    refNames: refs,
    // Term-by-term numbers for the one row that was reported as broken.
    wheelTerms: (() => {
      const rows = {}
      for (const n of jeep) {
        rows[n] = {}
        for (const m of jeep) rows[n][m] = terms(jeepFps[n], jeepFps[m])
      }
      return rows
    })(),
    results: CANDIDATES.map((c) => {
      const numOf = (x) => x.match(/IMG_(\d+)/)?.[1]
      const jeepBefore = jeep.filter((x) => beforeNums.includes(numOf(x)))
      const jeepAfter = jeep.filter((x) => !beforeNums.includes(numOf(x)))
      const jeepTruth = {}
      for (const [b, a] of Object.entries(pairs)) {
        const bn = jeep.find((x) => numOf(x) === b)
        const an = jeep.find((x) => numOf(x) === String(a))
        if (bn && an) jeepTruth[bn] = an
      }
      const refBefore = refs.filter((x) => x.includes('_before'))
      const refAfter = refs.filter((x) => x.includes('_after'))
      const refTruth = {}
      for (const b of refBefore) {
        const a = refAfter.find((x) => x.split('_')[0] === b.split('_')[0])
        if (a) refTruth[b] = a
      }
      return {
        name: c.name,
        jeep: evaluate(
          jeepBefore.map((n) => jeepFps[n]),
          jeepAfter.map((n) => jeepFps[n]),
          jeepTruth,
          c.w,
        ),
        refs: refs.length
          ? evaluate(
              refBefore.map((n) => refFps[n]),
              refAfter.map((n) => refFps[n]),
              refTruth,
              c.w,
            )
          : null,
      }
    }),
  }
}, {
  jeep: jeepNames,
  refs: refNames,
  jeepDir: '/test/fixtures/samecar/',
  refDir: '/test/fixtures/photos/',
  beforeNums: BEFORE,
  pairs: PAIRS,
})

const n = (x) => (x >= 0 ? ' ' : '') + x.toFixed(3)

console.log('\n[1] The reported failure, term by term\n')
const wt = out.wheelTerms
const wheelBefore = jeepNames.find((x) => x.includes('7993'))
const wheelAfter = jeepNames.find((x) => x.includes('8009'))
const impostor = jeepNames.find((x) => x.includes('8006'))
console.log(`  ${wheelBefore} (${SUBJECT['7993']})`)
console.log(`    against ${wheelAfter}  (${SUBJECT['8009']})  — the true pair`)
console.log(`    against ${impostor}  (${SUBJECT['8006']})  — the impostor it preferred\n`)
const keys = ['coarse', 'fine', 'chroma', 'hash', 'color', 'edge']
console.log('    term      true pair   impostor   verdict')
for (const k of keys) {
  const t = wt[wheelBefore][wheelAfter][k]
  const f = wt[wheelBefore][impostor][k]
  const good = t > f
  console.log(
    `    ${k.padEnd(9)} ${n(t)}      ${n(f)}    ${good ? 'separates' : 'MISLEADS'}`,
  )
}

console.log('\n[2] Candidates, scored on both sets of real photographs\n')
console.log(
  '  ' +
    'candidate'.padEnd(28) +
    'Jeep rows'.padStart(11) +
    'Jeep pairs'.padStart(12) +
    'ref rows'.padStart(11) +
    'ref pairs'.padStart(11) +
    'min margin'.padStart(12),
)
for (const r of out.results) {
  const j = r.jeep
  const f = r.refs
  console.log(
    '  ' +
      r.name.padEnd(28) +
      `${j.rowWins}/${j.contests}`.padStart(11) +
      `${j.assigned}/${j.contests}`.padStart(12) +
      (f ? `${f.rowWins}/${f.contests}`.padStart(11) : '—'.padStart(11)) +
      (f ? `${f.assigned}/${f.contests}`.padStart(11) : '—'.padStart(11)) +
      n(Math.min(j.minMargin, f ? f.minMargin : Infinity)).padStart(12),
  )
}

console.log('\n[3] Where each candidate still loses a row\n')
for (const r of out.results) {
  const all = [...r.jeep.losses, ...(r.refs ? r.refs.losses : [])]
  if (!all.length) {
    console.log(`  ${r.name} — no lost rows`)
    continue
  }
  console.log(`  ${r.name}`)
  for (const l of all) console.log(`      ${l}`)
}

await browser.close()
server.kill('SIGTERM')
