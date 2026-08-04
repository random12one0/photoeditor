/**
 * Why interior shots pair badly.
 *
 * Reported as: "it wasn't really, like, with interior shots... it just didn't
 * really do interior shots well."
 *
 * Reproduced: on the one-Jeep set the three exterior pairs are exact and the
 * interior pair is not — the seat gets married to the clean console instead of
 * the dirty console it belongs to.
 *
 * This prints the whole before × after score matrix, with what each frame
 * actually shows, and the same matrix per component, so it is visible which
 * term is misleading rather than merely which answer came out.
 *
 * Run:  node test/diagnose-interior.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { AFTER, BEFORE, PAIRS, SUBJECT, num } from './lib/samecar-truth.mjs'

const PORT = 4332
const DIR = new URL('./fixtures/samecar/', import.meta.url).pathname
if (!existsSync(DIR)) {
  console.log(`No fixtures in ${DIR} — skipping. (Real photos, deliberately not committed.)`)
  process.exit(0)
}
const names = readdirSync(DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()

const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

const out = await page.evaluate(async (files) => {
  const {
    similarity,
    shiftedNcc,
    chromaDistance,
    hamming,
    chromaSignature,
    dhashFromImageData,
    lumaGridFromImageData,
    meanLuma,
    qualityFromImageData,
    LUMA_GRID,
    COARSE_GRID,
    QUALITY_GRID,
  } = await import('/src/lib/hash.ts')

  const EDGE = 1400
  const prints = {}

  for (const name of files) {
    const res = await fetch(`/test/fixtures/samecar/${name}`)
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
    prints[name.match(/IMG_(\d+)/)[1]] = {
      dhash: dhashFromImageData(grid(9, 8)),
      chromaSig: chromaSignature(colorGrid),
      lumaGrid: lumaGridFromImageData(grid(LUMA_GRID, LUMA_GRID)),
      lumaGridCoarse: lumaGridFromImageData(grid(COARSE_GRID, COARSE_GRID)),
      luma: meanLuma(colorGrid),
      quality: qualityFromImageData(grid(QUALITY_GRID, QUALITY_GRID)),
    }
    if (bmp !== full) full.close()
    bmp.close()
  }

  const parts = (a, b) => ({
    total: similarity(a, b),
    coarse: (shiftedNcc(a.lumaGridCoarse, b.lumaGridCoarse, COARSE_GRID, 2) + 1) / 2,
    fine: (shiftedNcc(a.lumaGrid, b.lumaGrid, LUMA_GRID, 3) + 1) / 2,
    chroma: 1 - chromaDistance(a.chromaSig, b.chromaSig),
    hash: 1 - hamming(a.dhash, b.dhash) / 64,
  })

  return { prints, parts: null, keys: Object.keys(prints), scored: true, allParts: (() => {
    const m = {}
    for (const b of Object.keys(prints)) {
      m[b] = {}
      for (const a of Object.keys(prints)) m[b][a] = parts(prints[b], prints[a])
    }
    return m
  })() }
}, names)

const n = (x) => x.toFixed(3)
const m = out.allParts
const luma = Object.fromEntries(Object.entries(out.prints).map(([k, v]) => [k, v.luma]))

console.log('\n[1] How dark each frame is (mean luminance, 0-255)\n')
for (const k of [...BEFORE, ...AFTER]) {
  const bar = '█'.repeat(Math.round(luma[k] / 6))
  console.log(`  ${k}  ${String(Math.round(luma[k])).padStart(3)}  ${bar}  ${SUBJECT[k]}`)
}

function matrix(label, pick) {
  console.log(`\n${label}\n`)
  console.log('        ' + AFTER.map((a) => a.padStart(8)).join(''))
  for (const b of BEFORE) {
    const cells = AFTER.map((a) => {
      const v = n(pick(m[b][a]))
      return (PAIRS[b] === Number(a) ? `[${v}]` : ` ${v} `).padStart(8)
    })
    console.log(`  ${b}  ${cells.join('')}   ${SUBJECT[b]}`)
  }
  console.log('  (square brackets mark the true pair)')
}

matrix('[2] similarity — the score the matcher actually uses', (p) => p.total)
matrix('[3] chroma — 25% of it', (p) => p.chroma)
matrix('[4] coarse structure — 40% of it', (p) => p.coarse)
matrix('[5] fine structure — 25% of it', (p) => p.fine)

console.log('\n[6] Does the true pair win its own row?\n')
let rowWins = 0
let contests = 0
for (const b of BEFORE) {
  if (!PAIRS[b]) continue
  contests++
  const scores = AFTER.map((a) => ({ a, v: m[b][a].total })).sort((x, y) => y.v - x.v)
  const best = scores[0]
  const truth = scores.find((s) => Number(s.a) === PAIRS[b])
  const won = Number(best.a) === PAIRS[b]
  if (won) rowWins++
  console.log(
    `  ${b} ${SUBJECT[b].padEnd(24)} best ${best.a} (${n(best.v)})` +
      (won ? '  ✓' : `  ✗ truth ${truth.a} (${n(truth.v)}), behind by ${n(best.v - truth.v)}`),
  )
}
console.log(`\n  ${rowWins}/${contests} true pairs are the strongest match in their own row`)

console.log('\n[7] The margin the assignment has to work with\n')
/* The interior frames' scores against everything, to see whether the problem is
   that the true pair scores low or that the wrong ones score high. */
const interiorRows = BEFORE.filter((b) => ['8001', '8003'].includes(b))
for (const b of interiorRows) {
  const row = AFTER.map((a) => `${a}:${n(m[b][a].total)}`).join('  ')
  console.log(`  ${b} ${SUBJECT[b].padEnd(24)} ${row}`)
}
const spread = (b) => {
  const v = AFTER.map((a) => m[b][a].total).sort((x, y) => y - x)
  return v[0] - v[v.length - 1]
}
console.log('')
for (const b of BEFORE) {
  console.log(`  ${b} spread across its row: ${n(spread(b))}   ${SUBJECT[b]}`)
}

await browser.close()
server.kill('SIGTERM')
