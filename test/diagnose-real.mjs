/**
 * Distance distributions over REAL photographs.
 *
 * The synthetic fixtures said an ncc gate of 0.65 cleanly separated true pairs
 * from everything else. Real photos disagreed — the pipeline found zero pairs.
 * This measures the same statistics over the actual crops so the thresholds and
 * the descriptor can be fixed against evidence rather than intuition.
 *
 * Run:  node test/diagnose-real.mjs
 */

import { launchBrowser, startServer } from './lib/harness.mjs'
import { readdirSync } from 'node:fs'

const PORT = 4325
const BASE = `http://127.0.0.1:${PORT}`
const PHOTO_DIR = new URL('./fixtures/photos/', import.meta.url).pathname

function stats(v) {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { min: s[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), max: s[s.length - 1] }
}
const fmt = (s, d = 3) =>
  s
    ? `min ${s.min.toFixed(d)}  p25 ${s.p25.toFixed(d)}  p50 ${s.p50.toFixed(d)}  p75 ${s.p75.toFixed(d)}  max ${s.max.toFixed(d)}`
    : 'n/a'

async function main() {
  const names = readdirSync(PHOTO_DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()
  const { proc: server } = await startServer(PORT, { mode: 'dev' })
  const browser = await launchBrowser()
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
  await page.goto(BASE)

  const report = await page.evaluate(async (files) => {
    const hash = await import('/src/lib/hash.ts')
    const { LUMA_GRID, chromaSignature, dhashFromImageData, lumaGridFromImageData } = hash

    const grid = (bmp, w, h) => {
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bmp, 0, 0, w, h)
      return ctx.getImageData(0, 0, w, h)
    }

    const photos = []
    for (const name of files) {
      const res = await fetch(`/test/fixtures/photos/${name}`)
      if (!res.ok) throw new Error(`${name} ${res.status}`)
      const bmp = await createImageBitmap(await res.blob())
      photos.push({
        name,
        car: name.split('_')[0],
        kind: name.includes('_after') ? 'after' : 'before',
        dhash: dhashFromImageData(grid(bmp, 9, 8)),
        chromaSig: chromaSignature(grid(bmp, 32, 32)),
        lumaGrid: lumaGridFromImageData(grid(bmp, LUMA_GRID, LUMA_GRID)),
        lumaGridCoarse: lumaGridFromImageData(grid(bmp, 8, 8)),
        // A coarser grid tolerates the framing drift between two handheld
        // shots far better than a fine one.
        luma8: lumaGridFromImageData(grid(bmp, 8, 8)),
      })
      bmp.close()
    }

    /**
     * Cross-correlation maximised over small shifts.
     *
     * Plain NCC assumes the two frames line up. Two handheld shots taken ninety
     * minutes apart do not: the photographer stands in a slightly different
     * place, so the whole scene translates by a few percent. Sliding one grid
     * over the other and keeping the best score removes that penalty.
     */
    function shiftedNcc(a, b, size, maxShift) {
      let best = -1
      for (let dy = -maxShift; dy <= maxShift; dy++) {
        for (let dx = -maxShift; dx <= maxShift; dx++) {
          let dot = 0
          let n = 0
          for (let y = 0; y < size; y++) {
            const yb = y + dy
            if (yb < 0 || yb >= size) continue
            for (let x = 0; x < size; x++) {
              const xb = x + dx
              if (xb < 0 || xb >= size) continue
              dot += a[y * size + x] * b[yb * size + xb]
              n++
            }
          }
          if (n > 0) best = Math.max(best, dot / n)
        }
      }
      return best
    }

    const buckets = {
      truePair: { ncc16: [], ncc8: [], shift16: [], shift8: [], chroma: [], hamming: [], combined: [] },
      crossCar: { ncc16: [], ncc8: [], shift16: [], shift8: [], chroma: [], hamming: [], combined: [] },
    }

    for (let i = 0; i < photos.length; i++) {
      for (let j = i + 1; j < photos.length; j++) {
        const a = photos[i]
        const b = photos[j]
        const same = a.car === b.car && a.kind !== b.kind
        const k = same ? 'truePair' : 'crossCar'
        buckets[k].ncc16.push(hash.ncc(a.lumaGrid, b.lumaGrid))
        buckets[k].ncc8.push(hash.ncc(a.luma8, b.luma8))
        buckets[k].shift16.push(shiftedNcc(a.lumaGrid, b.lumaGrid, 16, 3))
        buckets[k].shift8.push(shiftedNcc(a.luma8, b.luma8, 8, 2))
        buckets[k].chroma.push(hash.chromaDistance(a.chromaSig, b.chromaSig))
        buckets[k].hamming.push(hash.hamming(a.dhash, b.dhash))
        buckets[k].combined.push(hash.similarity(a, b))
      }
    }

    // Per-pair detail, so a bad apple can be identified by name.
    const perPair = []
    for (let i = 0; i < photos.length; i++) {
      for (let j = i + 1; j < photos.length; j++) {
        const a = photos[i]
        const b = photos[j]
        if (a.car === b.car && a.kind !== b.kind) {
          perPair.push({
            pair: `${a.car}`,
            ncc16: hash.ncc(a.lumaGrid, b.lumaGrid),
            shift16: shiftedNcc(a.lumaGrid, b.lumaGrid, 16, 3),
            shift8: shiftedNcc(a.luma8, b.luma8, 8, 2),
            chroma: hash.chromaDistance(a.chromaSig, b.chromaSig),
          })
        }
      }
    }

    return { buckets, perPair }
  }, names)

  await browser.close()
  server.kill('SIGTERM')

  for (const [name, data] of Object.entries(report.buckets)) {
    console.log(`\n${'='.repeat(72)}\n${name.toUpperCase()}  (n=${data.ncc16.length})`)
    console.log(`  ncc 16x16          : ${fmt(stats(data.ncc16))}`)
    console.log(`  ncc 8x8            : ${fmt(stats(data.ncc8))}`)
    console.log(`  ncc 16x16 shifted  : ${fmt(stats(data.shift16))}`)
    console.log(`  ncc 8x8 shifted    : ${fmt(stats(data.shift8))}`)
    console.log(`  chroma             : ${fmt(stats(data.chroma))}`)
    console.log(`  hamming            : ${fmt(stats(data.hamming), 1)}`)
    console.log(`  COMBINED similarity: ${fmt(stats(data.combined))}`)
  }

  console.log(`\n${'='.repeat(72)}\nTRUE PAIRS, ONE BY ONE`)
  for (const p of report.perPair) {
    console.log(
      `  ${p.pair}  ncc16 ${p.ncc16.toFixed(3)}  shift16 ${p.shift16.toFixed(3)}  shift8 ${p.shift8.toFixed(3)}  chroma ${p.chroma.toFixed(3)}`,
    )
  }
  console.log('')
}

main()
