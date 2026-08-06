/**
 * Recover the two source photos from an exported collage.
 *
 * The user photographs cars, makes composites in the app, and still has those
 * long after the originals have scrolled away — so composites are the easiest
 * ground truth to collect. Each one is two photos the user has already declared
 * a true pair, which is exactly the label the matcher needs.
 *
 * Finding the panels: the background is a blurred, darkened copy of one of the
 * photos, and the panels are drawn sharp on top of it. So blur is the signal —
 * gradient energy is near zero over the backdrop and never near zero over a
 * photograph. The profile of a collage is therefore margin, panel, a narrow
 * trough, panel, margin, and the trough is what the split keys on. Thresholds
 * relative to the peak do not work: one bright detailed row can be forty times
 * a legitimately flat one, and the cut lands inside a panel.
 *
 * Usage: node scripts/split-collages.mjs
 * Reads  test/fixtures/collages/src/*.jpg
 * Writes test/fixtures/collages/<name>-{a,b}.jpg
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchBrowser } from '../test/lib/harness.mjs'

const SRC = 'test/fixtures/collages/src'
const OUT = 'test/fixtures/collages'

/* The panels have rounded corners and a drop shadow. Pulling in by a little
   over a percent of the short edge clears both without eating into the photo. */
const INSET = 0.012

const files = readdirSync(SRC).filter((f) => /\.jpe?g$/i.test(f))
if (!files.length) {
  console.error(`no collages in ${SRC}`)
  process.exit(1)
}

const browser = await launchBrowser()
const page = await browser.newPage()
await page.goto('about:blank')

let written = 0
let failed = 0

for (const file of files) {
  const name = file.replace(/\.jpe?g$/i, '')
  const dataUrl = `data:image/jpeg;base64,${readFileSync(join(SRC, file)).toString('base64')}`

  const result = await page.evaluate(
    async ({ dataUrl, inset }) => {
      const img = new Image()
      img.src = dataUrl
      await img.decode()

      /* Work on a downscaled copy: the panels are hundreds of pixels across, so
         a 600px view locates them just as well and far faster. */
      const S = 600
      const scale = S / img.width
      const H = Math.round(img.height * scale)
      const c = document.createElement('canvas')
      c.width = S
      c.height = H
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0, S, H)
      const { data } = ctx.getImageData(0, 0, S, H)

      const lum = new Float32Array(S * H)
      for (let i = 0; i < S * H; i++) {
        lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
      }

      const grad = new Float32Array(S * H)
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < S - 1; x++) {
          const i = y * S + x
          grad[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + S] - lum[i - S])
        }
      }

      /** Mean gradient of each row (axis 'y') or column (axis 'x') of a box. */
      const profile = (axis, box) => {
        const { x0, x1, y0, y1 } = box
        const n = axis === 'y' ? y1 - y0 + 1 : x1 - x0 + 1
        const out = new Float32Array(n)
        for (let k = 0; k < n; k++) {
          let sum = 0
          if (axis === 'y') {
            const y = y0 + k
            for (let x = x0; x <= x1; x++) sum += grad[y * S + x]
            out[k] = sum / (x1 - x0 + 1)
          } else {
            const x = x0 + k
            for (let y = y0; y <= y1; y++) sum += grad[y * S + x]
            out[k] = sum / (y1 - y0 + 1)
          }
        }
        return out
      }

      const percentile = (arr, p) => {
        const s = Array.from(arr).sort((a, b) => a - b)
        return s[Math.min(s.length - 1, Math.floor(s.length * p))]
      }

      /**
       * First and last index that is clearly not backdrop.
       *
       * The floor comes from the flattest tenth of the profile — the margins —
       * and the ceiling from the median, so the cut sits well above blur and
       * well below anything photographic.
       */
      const extent = (prof) => {
        const floor = percentile(prof, 0.1)
        const mid = percentile(prof, 0.5)
        const cut = floor + (mid - floor) * 0.25
        let a = 0
        let b = prof.length - 1
        while (a < b && prof[a] < cut) a++
        while (b > a && prof[b] < cut) b--
        return [a, b]
      }

      /** Deepest point of the interior, and how deep it is relative to typical. */
      const trough = (prof) => {
        const margin = Math.floor(prof.length * 0.2)
        let best = margin
        for (let i = margin; i < prof.length - margin; i++) {
          if (prof[i] < prof[best]) best = i
        }
        const mid = percentile(prof, 0.5)
        return { at: best, depth: mid > 0 ? 1 - prof[best] / mid : 0 }
      }

      const full = { x0: 0, x1: S - 1, y0: 0, y1: H - 1 }
      const [cy0, cy1] = extent(profile('y', full))
      const [cx0, cx1] = extent(profile('x', full))
      const content = { x0: cx0, x1: cx1, y0: cy0, y1: cy1 }

      /* Stacked or side by side: whichever axis has the deeper interior trough
         is the one the two panels are separated along. */
      const vert = trough(profile('y', content))
      const horiz = trough(profile('x', content))
      const stacked = vert.depth >= horiz.depth
      const split = stacked ? vert : horiz
      if (split.depth < 0.5) {
        return { error: `no clear gap between panels (best depth ${split.depth.toFixed(2)})` }
      }

      /* Two boxes either side of the trough, each then trimmed on both axes so
         the crop hugs the panel rather than the half it lives in. */
      const halves = stacked
        ? [
            { ...content, y1: content.y0 + split.at },
            { ...content, y0: content.y0 + split.at },
          ]
        : [
            { ...content, x1: content.x0 + split.at },
            { ...content, x0: content.x0 + split.at },
          ]

      const rects = []
      for (const half of halves) {
        const [ry0, ry1] = extent(profile('y', half))
        const tight = { ...half, y0: half.y0 + ry0, y1: half.y0 + ry1 }
        const [rx0, rx1] = extent(profile('x', tight))
        const box = { ...tight, x0: tight.x0 + rx0, x1: tight.x0 + rx1 }

        const pad = Math.round(Math.min(box.x1 - box.x0, box.y1 - box.y0) * inset)
        rects.push({
          x: Math.round((box.x0 + pad) / scale),
          y: Math.round((box.y0 + pad) / scale),
          w: Math.round((box.x1 - box.x0 - pad * 2) / scale),
          h: Math.round((box.y1 - box.y0 - pad * 2) / scale),
        })
      }

      const crops = []
      for (const r of rects) {
        if (r.w < 200 || r.h < 200) return { error: `implausible panel ${r.w}x${r.h}` }
        const o = document.createElement('canvas')
        o.width = r.w
        o.height = r.h
        o.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
        crops.push({ rect: r, url: o.toDataURL('image/jpeg', 0.92) })
      }
      return { crops, stacked }
    },
    { dataUrl, inset: INSET },
  )

  if (result.error) {
    console.error(`${name}: ${result.error}`)
    failed++
    continue
  }

  result.crops.forEach((crop, i) => {
    const suffix = i === 0 ? 'a' : 'b'
    const out = join(OUT, `${name}-${suffix}.jpg`)
    writeFileSync(out, Buffer.from(crop.url.split(',')[1], 'base64'))
    console.log(`${out}  ${crop.rect.w}x${crop.rect.h}`)
    written++
  })
}

await browser.close()
console.log(`\n${written} panels written to ${OUT}${failed ? `, ${failed} collages failed` : ''}`)
if (failed) process.exit(1)
