/**
 * Does local feature matching beat the global descriptors?
 *
 * Asked for as: "something that could recognize shapes or objects... not just
 * based off of color, but pattern and, like, maybe specific kind of places", and
 * "I care more about accuracy than time."
 *
 * So: ORB keypoints, matched and then geometrically verified, scored against
 * both sets of real photographs and against everything already shipping. The
 * bar is *row wins* — for each before shot, does its true partner beat every
 * impostor — because the assignment step can rescue a losing row and hide a weak
 * descriptor until the day it can't.
 *
 * Also prints raw inlier counts, which is the number that actually means
 * something: "41 points agree on one camera movement" is evidence, where a
 * similarity of 0.7 is only ever a ranking.
 *
 * Run:  node test/diagnose-features.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { BEFORE, PAIRS, SUBJECT, num } from './lib/samecar-truth.mjs'

const PORT = 4336
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

const out = await page.evaluate(
  async ({ jeep, refs, jeepDir, refDir, beforeNums, pairs }) => {
    const H = await import('/src/lib/hash.ts')
    const F = await import('/src/lib/features.ts')
    const { assignMax } = await import('/src/lib/assign.ts')

    const PROXY = 1400

    async function fingerprint(dir, name) {
      const res = await fetch(`${dir}${name}`)
      if (!res.ok) throw new Error(`${name} ${res.status}`)
      const full = await createImageBitmap(await res.blob(), {
        imageOrientation: 'from-image',
      })
      const scale = Math.min(1, PROXY / Math.max(full.width, full.height))
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

      // The detector runs on a proper aspect-preserving image, not a square.
      const fs = Math.min(1, F.FEATURE_EDGE / Math.max(bmp.width, bmp.height))
      const fw = Math.max(64, Math.round(bmp.width * fs))
      const fh = Math.max(64, Math.round(bmp.height * fs))

      const t0 = performance.now()
      const feats = F.detectAndDescribe(grid(fw, fh))
      const detectMs = performance.now() - t0

      const bigGrid = grid(H.QUALITY_GRID, H.QUALITY_GRID)
      const fp = {
        name,
        dhash: H.dhashFromImageData(grid(9, 8)),
        chromaSig: H.chromaSignature(grid(32, 32)),
        lumaGrid: H.lumaGridFromImageData(grid(H.LUMA_GRID, H.LUMA_GRID)),
        lumaGridCoarse: H.lumaGridFromImageData(grid(H.COARSE_GRID, H.COARSE_GRID)),
        colorHist: H.colorHistogram(bigGrid),
        edgeHist: H.edgeHistogram(bigGrid),
        feats,
        keypoints: feats.points.length / 2,
        detectMs,
      }
      if (bmp !== full) full.close()
      bmp.close()
      return fp
    }

    const terms = (a, b) => {
      const m = F.matchFeatures(a.feats, b.feats)
      return {
        global: H.similarity(a, b),
        color: H.colorHistogramSimilarity(a.colorHist, b.colorHist),
        edge: H.edgeHistogramSimilarity(a.edgeHist, b.edgeHist),
        features: m.score,
        _inliers: m.inliers,
        _candidates: m.candidates,
      }
    }

    const CANDIDATES = [
      { name: 'global (shipping)', w: { global: 1 } },
      { name: 'features only', w: { features: 1 } },
      { name: 'features + global, even', w: { features: 0.5, global: 0.5 } },
      { name: 'features-led', w: { features: 0.7, global: 0.3 } },
      { name: 'features-led, heavy', w: { features: 0.85, global: 0.15 } },
      { name: 'global-led', w: { features: 0.3, global: 0.7 } },
      { name: 'features + colour + edge', w: { features: 0.6, color: 0.24, edge: 0.16 } },
      { name: 'global + features 20%', w: { features: 0.2, global: 0.8 } },
      { name: 'global + features 15%', w: { features: 0.15, global: 0.85 } },
      { name: 'global + features 10%', w: { features: 0.1, global: 0.9 } },
      { name: 'global + features 5%', w: { features: 0.05, global: 0.95 } },

      /* Non-linear. A linear blend lets a weak feature score drag a good global
         one down, which is the wrong shape: geometric agreement is evidence when
         it is present and says nothing when it is absent. These only ever add. */
      { name: 'max(global, features)', fn: (t) => Math.max(t.global, t.features) },
      {
        name: 'boost when >=10 points agree',
        fn: (t) => t.global + (t._inliers >= 10 ? 0.25 : 0),
      },
      {
        name: 'boost when >=15 points agree',
        fn: (t) => t.global + (t._inliers >= 15 ? 0.3 : 0),
      },
      {
        name: 'boost when >=20 points agree',
        fn: (t) => t.global + (t._inliers >= 20 ? 0.3 : 0),
      },
      {
        name: 'graded boost by inliers',
        fn: (t) => t.global + 0.35 * (1 - Math.exp(-Math.max(0, t._inliers - 4) / 10)),
      },
    ]

    const score = (t, c) => {
      if (c.fn) return c.fn(t)
      const w = c.w
      let s = 0
      let total = 0
      for (const k of Object.keys(w)) {
        s += t[k] * w[k]
        total += w[k]
      }
      return s / (total || 1)
    }

    function evaluate(beforeFps, afterFps, truth, w, cache) {
      const matrix = beforeFps.map((b, i) => afterFps.map((a, j) => score(cache[i][j], w)))
      let rowWins = 0
      let contests = 0
      const margins = []
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
        else
          losses.push(
            `${b.name} → ${afterFps[best].name} (wanted ${want}, by ${(-margin).toFixed(3)})`,
          )
      })

      const chosen = assignMax(matrix, -Infinity)
      let assigned = 0
      chosen.forEach((j, i) => {
        if (j >= 0 && truth[beforeFps[i].name] === afterFps[j].name) assigned++
      })

      return {
        rowWins,
        contests,
        assigned,
        minMargin: margins.length ? Math.min(...margins) : 0,
        losses,
      }
    }

    const numOf = (x) => x.match(/IMG_(\d+)/)?.[1]

    const jeepFps = {}
    for (const n of jeep) jeepFps[n] = await fingerprint(jeepDir, n)
    const refFps = {}
    for (const n of refs) refFps[n] = await fingerprint(refDir, n)

    const jeepBefore = jeep.filter((x) => beforeNums.includes(numOf(x))).map((n) => jeepFps[n])
    const jeepAfter = jeep.filter((x) => !beforeNums.includes(numOf(x))).map((n) => jeepFps[n])
    const jeepTruth = {}
    for (const [b, a] of Object.entries(pairs)) {
      const bn = jeep.find((x) => numOf(x) === b)
      const an = jeep.find((x) => numOf(x) === String(a))
      if (bn && an) jeepTruth[bn] = an
    }

    const refBefore = refs.filter((x) => x.includes('_before')).map((n) => refFps[n])
    const refAfter = refs.filter((x) => x.includes('_after')).map((n) => refFps[n])
    const refTruth = {}
    for (const b of refs.filter((x) => x.includes('_before'))) {
      const a = refs.find((x) => x.includes('_after') && x.split('_')[0] === b.split('_')[0])
      if (a) refTruth[b] = a
    }

    // Score every cell once; the candidates only reweight what is already there.
    const jeepCache = jeepBefore.map((b) => jeepAfter.map((a) => terms(b, a)))
    const refCache = refBefore.map((b) => refAfter.map((a) => terms(b, a)))

    return {
      keypoints: Object.fromEntries(
        Object.entries(jeepFps).map(([k, v]) => [k, { n: v.keypoints, ms: v.detectMs }]),
      ),
      jeepBefore: jeepBefore.map((f) => f.name),
      jeepAfter: jeepAfter.map((f) => f.name),
      inliers: jeepCache.map((row) => row.map((t) => t._inliers)),
      candidates: jeepCache.map((row) => row.map((t) => t._candidates)),
      results: CANDIDATES.map((c) => ({
        name: c.name,
        jeep: evaluate(jeepBefore, jeepAfter, jeepTruth, c, jeepCache),
        refs: refBefore.length ? evaluate(refBefore, refAfter, refTruth, c, refCache) : null,
      })),
    }
  },
  {
    jeep: jeepNames,
    refs: refNames,
    jeepDir: '/test/fixtures/samecar/',
    refDir: '/test/fixtures/photos/',
    beforeNums: BEFORE,
    pairs: PAIRS,
  },
)

const n = (x) => (x >= 0 ? ' ' : '') + x.toFixed(3)

console.log('\n[1] Corners found per photo, and what it cost\n')
let totalMs = 0
for (const [name, v] of Object.entries(out.keypoints)) {
  totalMs += v.ms
  console.log(
    `  ${num(name)}  ${String(v.n).padStart(4)} keypoints  ${v.ms.toFixed(0).padStart(4)}ms   ${
      SUBJECT[num(name)] ?? ''
    }`,
  )
}
console.log(
  `\n  ${(totalMs / Object.keys(out.keypoints).length).toFixed(0)}ms per photo to detect and describe`,
)

console.log('\n[2] Geometrically verified matches — points agreeing on one camera move\n')
console.log('        ' + out.jeepAfter.map((a) => num(a).padStart(8)).join(''))
for (let i = 0; i < out.jeepBefore.length; i++) {
  const b = num(out.jeepBefore[i])
  const cells = out.jeepAfter.map((a, j) => {
    const v = String(out.inliers[i][j])
    return (PAIRS[b] === Number(num(a)) ? `[${v}]` : ` ${v} `).padStart(8)
  })
  console.log(`  ${b}  ${cells.join('')}   ${SUBJECT[b] ?? ''}`)
}
console.log('  (square brackets mark the true pair)')

console.log('\n[3] Candidates, on both sets of real photographs\n')
console.log(
  '  ' +
    'candidate'.padEnd(26) +
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
      r.name.padEnd(26) +
      `${j.rowWins}/${j.contests}`.padStart(11) +
      `${j.assigned}/${j.contests}`.padStart(12) +
      (f ? `${f.rowWins}/${f.contests}`.padStart(11) : '—'.padStart(11)) +
      (f ? `${f.assigned}/${f.contests}`.padStart(11) : '—'.padStart(11)) +
      n(Math.min(j.minMargin, f ? f.minMargin : Infinity)).padStart(12),
  )
}

console.log('\n[4] Rows still lost\n')
for (const r of out.results) {
  const all = [...r.jeep.losses, ...(r.refs ? r.refs.losses : [])]
  if (!all.length) {
    console.log(`  ${r.name} — none`)
    continue
  }
  console.log(`  ${r.name}`)
  for (const l of all) console.log(`      ${l}`)
}

await browser.close()
server.kill('SIGTERM')
