/**
 * Two measurements behind the "three shots of one angle" handling.
 *
 * 1. Does the quality score rank shots the way a person would? Checked by
 *    degrading real photographs in known ways — defocus, camera shake, shooting
 *    into the sun — and asking whether the untouched original wins.
 *
 * 2. Where does "same take" sit against "same car, different angle"? Measured
 *    on both photo sources, because they fail differently and a threshold has
 *    to survive both:
 *
 *      real photographs — different angles show different things
 *      synthetic fixtures — different angles are the same scene, moved
 *
 *    The second is the harsher test of a shift-tolerant metric, and it is what
 *    caught `similarity` being the wrong measure for this question.
 *
 * In both, a "same take" is simulated the way a burst actually differs: the
 * photographer's hands move a little and the exposure drifts.
 *
 * Run:  node test/diagnose-takes.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { BEFORE } from './lib/samecar-truth.mjs'

const PORT = 4328
const DIR = new URL('./fixtures/samecar/', import.meta.url).pathname
const hasReal = existsSync(DIR)
const names = hasReal
  ? readdirSync(DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()
  : []

const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

const out = await page.evaluate(async ({ files, beforeNums }) => {
  const {
    qualityFromImageData,
    similarity,
    sameTakeScore,
    chromaSignature,
    dhashFromImageData,
    lumaGridFromImageData,
    QUALITY_GRID,
    LUMA_GRID,
    COARSE_GRID,
  } = await import('/src/lib/hash.ts')
  const { drawScene } = await import('/test/lib/roll.js')

  const EDGE = 1400

  async function loadReal(name) {
    const res = await fetch(`/test/fixtures/samecar/${name}`)
    if (!res.ok) throw new Error(`${name} ${res.status}`)
    const full = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' })
    const scale = Math.min(1, EDGE / Math.max(full.width, full.height))
    if (scale >= 1) return full
    const small = await createImageBitmap(full, {
      resizeWidth: Math.round(full.width * scale),
      resizeHeight: Math.round(full.height * scale),
      resizeQuality: 'high',
    })
    full.close()
    return small
  }

  /** Draw a source through a named degradation onto a canvas of the same size. */
  function render(src, mode) {
    const w = src.width
    const h = src.height
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')
    ctx.filter = 'none'
    if (mode === 'defocus') ctx.filter = 'blur(3px)'
    if (mode === 'soft') ctx.filter = 'blur(1.2px)'
    if (mode === 'blown') ctx.filter = 'brightness(1.85) contrast(1.3)'
    if (mode === 'crushed') ctx.filter = 'brightness(0.35)'

    if (mode === 'shake') {
      ctx.globalAlpha = 1 / 5
      for (let i = 0; i < 5; i++) ctx.drawImage(src, i * 2, i * 0.6)
      ctx.globalAlpha = 1
    } else if (mode === 'handheld') {
      // A second take: a step sideways, a breath in, slightly different light.
      ctx.filter = 'brightness(1.06)'
      ctx.drawImage(src, w * 0.01, h * -0.008, w * 1.03, h * 1.03)
    } else {
      ctx.drawImage(src, 0, 0)
    }
    return c
  }

  function gridsOf(canvas) {
    const grid = (w, h) => {
      const g = new OffscreenCanvas(w, h)
      const gc = g.getContext('2d', { willReadFrequently: true })
      gc.drawImage(canvas, 0, 0, w, h)
      return gc.getImageData(0, 0, w, h)
    }
    return {
      quality: qualityFromImageData(grid(QUALITY_GRID, QUALITY_GRID)),
      fp: {
        dhash: dhashFromImageData(grid(9, 8)),
        chromaSig: chromaSignature(grid(32, 32)),
        lumaGrid: lumaGridFromImageData(grid(LUMA_GRID, LUMA_GRID)),
        lumaGridCoarse: lumaGridFromImageData(grid(COARSE_GRID, COARSE_GRID)),
      },
    }
  }

  const MODES = ['original', 'soft', 'defocus', 'shake', 'blown', 'crushed', 'handheld']

  /* ---------------------------------------------------------- real photographs */

  const perPhoto = []
  const realOriginals = []
  const realSameTake = []

  for (const name of files) {
    const bitmap = await loadReal(name)
    const row = { name, scores: {}, fps: {} }
    for (const mode of MODES) {
      const { quality, fp } = gridsOf(render(bitmap, mode))
      row.scores[mode] = quality
      row.fps[mode] = fp
    }
    realOriginals.push({ name, fp: row.fps.original })
    realSameTake.push({
      label: name,
      similarity: similarity(row.fps.original, row.fps.handheld),
      sameTake: sameTakeScore(row.fps.original, row.fps.handheld),
    })
    perPhoto.push({ name, scores: row.scores })
    bitmap.close()
  }

  /* Only compare within a batch. A before and its own after look like the same
     take by design and are never candidates to be collapsed, because befores
     are grouped among befores and afters among afters.
     Which frames are the before pass comes from the shared ground truth: the
     numbering looks like it splits at 8000 and does not. */
  const batchOf = (name) =>
    beforeNums.includes(name.match(/IMG_(\d+)/)?.[1]) ? 'before' : 'after'
  const realOtherAngle = []
  const realAcrossBatch = []
  for (let i = 0; i < realOriginals.length; i++) {
    for (let j = i + 1; j < realOriginals.length; j++) {
      const entry = {
        label: `${realOriginals[i].name} / ${realOriginals[j].name}`,
        similarity: similarity(realOriginals[i].fp, realOriginals[j].fp),
        sameTake: sameTakeScore(realOriginals[i].fp, realOriginals[j].fp),
      }
      if (batchOf(realOriginals[i].name) === batchOf(realOriginals[j].name))
        realOtherAngle.push(entry)
      else realAcrossBatch.push(entry)
    }
  }

  /* ------------------------------------------------------- synthetic fixtures */

  const synthSameTake = []
  const synthOtherAngle = []
  const CARS = 6
  const ANGLES = 4

  for (let car = 1; car <= CARS; car++) {
    for (const dirty of [true, false]) {
      const byAngle = []
      for (let angle = 1; angle <= ANGLES; angle++) {
        const scene = drawScene({ car, angle, dirty }, { hueStep: 45 })
        const original = gridsOf(render(scene, 'original')).fp
        const retake = gridsOf(render(scene, 'handheld')).fp
        byAngle.push({ angle, original, retake })
        synthSameTake.push({
          label: `car${car} ${dirty ? 'before' : 'after'} a${angle}`,
          similarity: similarity(original, retake),
          sameTake: sameTakeScore(original, retake),
        })
      }
      // Different angles of one car, within one batch — the comparison that
      // actually happens, and the one the fixtures make hardest.
      for (let i = 0; i < byAngle.length; i++) {
        for (let j = i + 1; j < byAngle.length; j++) {
          synthOtherAngle.push({
            label: `car${car} ${dirty ? 'before' : 'after'} a${byAngle[i].angle}/a${byAngle[j].angle}`,
            similarity: similarity(byAngle[i].original, byAngle[j].original),
            sameTake: sameTakeScore(byAngle[i].original, byAngle[j].original),
          })
        }
      }
    }
  }

  return {
    MODES,
    perPhoto,
    real: { sameTake: realSameTake, otherAngle: realOtherAngle, acrossBatch: realAcrossBatch },
    synth: { sameTake: synthSameTake, otherAngle: synthOtherAngle },
  }
}, { files: names, beforeNums: BEFORE })

const n = (x) => x.toFixed(3)
const short = (s) => s.replace(/\.jpe?g$/i, '').replace(/^IMG_/, '')

if (out.perPhoto.length) {
  console.log('\n[1] Quality — does the untouched shot win?\n')
  console.log(['photo'.padEnd(6), ...out.MODES.map((m) => m.padStart(9))].join(''))
  let wins = 0
  let contests = 0
  for (const row of out.perPhoto) {
    console.log(
      [short(row.name).padEnd(6), ...out.MODES.map((m) => n(row.scores[m]).padStart(9))].join(''),
    )
    // 'handheld' is not a degradation — it is the same shot from a step sideways.
    for (const m of out.MODES) {
      if (m === 'original' || m === 'handheld') continue
      contests++
      if (row.scores.original > row.scores[m]) wins++
    }
  }
  console.log(`\n  original beat the degraded version ${wins}/${contests} times`)
} else {
  console.log('\n[1] Quality — skipped, no real fixtures on this machine.')
}

const stats = (rows, key) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b)
  return { min: v[0], max: v[v.length - 1], med: v[Math.floor(v.length / 2)], n: v.length }
}

function report(title, sameRows, otherRows) {
  console.log(`\n${title}\n`)
  console.log('  metric        same take (min)   different angle (max)   gap')
  const verdicts = []
  for (const key of ['similarity', 'sameTake']) {
    const s = stats(sameRows, key)
    const o = stats(otherRows, key)
    const gap = s.min - o.max
    verdicts.push({ key, gap, lo: o.max, hi: s.min })
    console.log(
      `  ${key.padEnd(12)}  ${n(s.min).padStart(13)}   ${n(o.max).padStart(21)}   ${
        gap > 0 ? '+' : ''
      }${n(gap)}`,
    )
  }
  for (const v of verdicts) {
    if (v.gap > 0) {
      console.log(
        `    ${v.key}: separates — any threshold in [${n(v.lo)}, ${n(v.hi)}], midpoint ${n(
          (v.lo + v.hi) / 2,
        )}`,
      )
    } else {
      console.log(`    ${v.key}: OVERLAPS — no threshold exists`)
    }
  }
  return verdicts
}

let real = null
if (out.real.sameTake.length) {
  real = report('[2] Real photographs', out.real.sameTake, out.real.otherAngle)
  const across = stats(out.real.acrossBatch, 'sameTake')
  console.log(
    `\n  for reference, across the batches — true pairs live here and are *meant*\n  to look alike: sameTake max ${n(across.max)} over ${across.n} comparisons`,
  )
} else {
  console.log('\n[2] Real photographs — skipped, no fixtures on this machine.')
}

const synth = report('[3] Synthetic fixtures (angles differ only by position)', out.synth.sameTake, out.synth.otherAngle)

console.log('\n[4] A threshold that survives both\n')
for (const key of ['similarity', 'sameTake']) {
  const s = synth.find((v) => v.key === key)
  const r = real?.find((v) => v.key === key)
  const lo = Math.max(s.lo, r ? r.lo : -Infinity)
  const hi = Math.min(s.hi, r ? r.hi : Infinity)
  console.log(
    lo < hi
      ? `  ${key.padEnd(12)} works everywhere: [${n(lo)}, ${n(hi)}], midpoint ${n((lo + hi) / 2)}`
      : `  ${key.padEnd(12)} has no single threshold that works on both`,
  )
}
console.log(`
  Which is why the clock is the other half of the rule. Shooting one angle three
  times is a single act that takes seconds; moving to the next angle takes
  longer. The fixtures' angles are two minutes apart and are excluded on time
  whatever they score, so the threshold can be set from the real photographs,
  where it has a 0.1-wide gap to sit in.`)

await browser.close()
server.kill('SIGTERM')
