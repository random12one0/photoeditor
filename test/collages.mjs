/**
 * Does each photo's true partner outrank every impostor?
 *
 * The other real-photo suites drive the whole app and check which pairs come
 * out. This one goes at the scoring function directly, because the question it
 * answers is narrower and more useful when tuning: for each of ten photographs,
 * where does its real partner sit in the ranking of the other nine?
 *
 * That framing matters. A pair can come out right for the wrong reason — the
 * assignment step will rescue a mediocre score if no other row wants that
 * column — and a suite that only looks at the final pairs cannot tell the
 * difference. Rank and margin can, and margin is what predicts whether the
 * next car breaks.
 *
 * The set is small and deliberately adversarial. See test/lib/collage-truth.mjs
 * for what is in it and why.
 *
 * Run:  node test/collages.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { LOOKALIKE, SAME_CAR, SUBJECT, partnerOf, stemOf } from './lib/collage-truth.mjs'

const PORT = 4331
const DIR = new URL('./fixtures/collages/', import.meta.url).pathname

/* Real photographs of real cars, so gitignored — this suite runs only where
   they exist. scripts/split-collages.mjs regenerates them from the exports. */
if (!existsSync(DIR)) {
  console.log(`No fixtures in ${DIR} — skipping. (Real photos, deliberately not committed.)`)
  process.exit(0)
}
const names = readdirSync(DIR)
  .filter((f) => /-(a|b)\.jpe?g$/i.test(f))
  .sort()

if (!names.length) {
  console.log(`No split panels in ${DIR} — run: node scripts/split-collages.mjs`)
  process.exit(0)
}

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

console.log(`${names.length} panels from ${names.length / 2} collages\n`)

const ranked = await page.evaluate(async (files) => {
  const { ingestFiles } = await import('/src/lib/ingest.ts')
  const { similarity, colorHistogramSimilarity, edgeHistogramSimilarity, hamming } =
    await import('/src/lib/hash.ts')
  const { matchFeatures } = await import('/src/lib/features.ts')

  const blobs = []
  for (const name of files) {
    const res = await fetch(`/test/fixtures/collages/${name}`)
    if (!res.ok) throw new Error(`${name} ${res.status}`)
    blobs.push(new File([await res.blob()], name, { type: 'image/jpeg' }))
  }

  const { photos } = await ingestFiles(blobs)

  const rows = []
  for (const a of photos) {
    const scores = photos
      .filter((b) => b.id !== a.id)
      .map((b) => ({
        name: b.name,
        visual: similarity(a, b),
        color: colorHistogramSimilarity(a.colorHist, b.colorHist),
        edge: edgeHistogramSimilarity(a.edgeHist, b.edgeHist),
        hash: 1 - hamming(a.dhash, b.dhash) / 64,
        inliers:
          a.features && b.features ? matchFeatures(a.features, b.features).inliers : 0,
      }))
      .sort((x, y) => y.visual - x.visual)
    rows.push({ name: a.name, scores })
  }
  return rows
}, names)

/* The bonus the app applies, mirrored here so the ranking under test is the
   ranking the app actually uses. Kept as a literal rather than imported so a
   change to it shows up as a diff in this file too. */
const FEATURE_BONUS = 0.3
const FEATURE_MIN_INLIERS = 12
const final = (s) => s.visual + (s.inliers >= FEATURE_MIN_INLIERS ? FEATURE_BONUS : 0)

console.log('[1] The true partner ranks first')
const results = []
for (const row of ranked) {
  const want = partnerOf(row.name)
  const order = [...row.scores].sort((a, b) => final(b) - final(a))
  const rank = order.findIndex((s) => s.name === want) + 1
  const truth = order.find((s) => s.name === want)
  const bestImpostor = order.find((s) => s.name !== want)
  const margin = final(truth) - final(bestImpostor)
  results.push({ name: row.name, rank, truth, bestImpostor, margin })

  check(
    `${row.name.padEnd(26)} → ${want}`,
    rank === 1,
    rank === 1
      ? `margin ${margin.toFixed(3)}`
      : `ranked ${rank}, beaten by ${bestImpostor.name}`,
  )
}

console.log('\n[2] Where the score comes from')
console.log(
  `  ${'photo'.padEnd(26)} ${'partner'.padEnd(8)} ${'colour'.padEnd(7)} ${'edge'.padEnd(7)} ${'hash'.padEnd(7)} orb    │ best impostor`,
)
for (const r of results) {
  const t = r.truth
  const i = r.bestImpostor
  console.log(
    `  ${r.name.padEnd(26)} ${final(t).toFixed(3).padEnd(8)} ${t.color.toFixed(3).padEnd(7)} ${t.edge.toFixed(3).padEnd(7)} ${t.hash.toFixed(3).padEnd(7)} ${String(t.inliers).padEnd(6)} │ ${final(i).toFixed(3)} ${i.name} (orb ${i.inliers})`,
  )
}

console.log('\n[3] The reported failure: same car, different subject')
for (const [x, y] of SAME_CAR) {
  console.log(`  ${SUBJECT[x]}  vs  ${SUBJECT[y]}`)
  for (const row of ranked) {
    if (stemOf(row.name) !== x) continue
    const crossing = row.scores.filter((s) => stemOf(s.name) === y)
    const worst = crossing.reduce((m, s) => (final(s) > final(m) ? s : m), crossing[0])
    const own = row.scores.find((s) => s.name === partnerOf(row.name))
    check(
      `${row.name} prefers its own shot over any ${y}`,
      final(own) > final(worst),
      `own ${final(own).toFixed(3)} vs ${worst.name} ${final(worst).toFixed(3)} (orb ${worst.inliers})`,
    )
  }
}

console.log('\n[4] The second trap: same subject, different car')
for (const [x, y] of LOOKALIKE) {
  console.log(`  ${SUBJECT[x]}  vs  ${SUBJECT[y]}`)
  for (const row of ranked) {
    if (stemOf(row.name) !== x) continue
    const crossing = row.scores.filter((s) => stemOf(s.name) === y)
    const worst = crossing.reduce((m, s) => (final(s) > final(m) ? s : m), crossing[0])
    const own = row.scores.find((s) => s.name === partnerOf(row.name))
    check(
      `${row.name} prefers its own shot over any ${y}`,
      final(own) > final(worst),
      `own ${final(own).toFixed(3)} vs ${worst.name} ${final(worst).toFixed(3)} (orb ${worst.inliers})`,
    )
  }
}

console.log('\n[5] Margins')
const worst = results.reduce((m, r) => (r.margin < m.margin ? r : m), results[0])
console.log(`  tightest: ${worst.name} at ${worst.margin.toFixed(3)}`)
console.log(
  `  mean:     ${(results.reduce((s, r) => s + r.margin, 0) / results.length).toFixed(3)}`,
)

console.log('\n[6] Console health')
check('no page errors', pageErrors.length === 0, pageErrors.join('; ') || 'clean')

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
