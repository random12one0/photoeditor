/**
 * Measure the reference collages, and cut the source photos back out of them.
 *
 * The reference images are exports from the app the user has been editing in by
 * hand. Rather than eyeball the layout, this finds the two photo panels by
 * looking for detail: the panels are sharp, the backdrop behind them is a heavy
 * blur, so a per-row and per-column gradient score separates them cleanly.
 *
 * Prints margins, gap, corner radius and backdrop brightness as percentages of
 * canvas width, which is exactly how StylePreset expresses them — and writes
 * each panel out as its own JPEG into test/fixtures/photos/ so the pipeline can
 * be tested against real photographs instead of synthetic ones.
 *
 * Run:  node test/measure.mjs
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'

const PORT = 4323
const BASE = `http://127.0.0.1:${PORT}`
const REF_DIR = new URL('./fixtures/reference/', import.meta.url).pathname
const OUT_DIR = new URL('./fixtures/photos/', import.meta.url).pathname

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const refs = readdirSync(REF_DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()
  if (!refs.length) {
    console.error(`no reference images in ${REF_DIR}`)
    process.exit(1)
  }

  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) break
    } catch {
      /* wait */
    }
    await sleep(250)
  }

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
  await page.goto(BASE)

  const results = await page.evaluate(async (names) => {
    const out = []

    for (const name of names) {
      const bmp = await createImageBitmap(
        await (await fetch(`/test/fixtures/reference/${name}`)).blob(),
      )
      const W = bmp.width
      const H = bmp.height
      const c = new OffscreenCanvas(W, H)
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bmp, 0, 0)
      const { data } = ctx.getImageData(0, 0, W, H)

      const lumaAt = (x, y) => {
        const p = (y * W + x) * 4
        return data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722
      }

      /* Detail per column, over the whole height, to find the panel's side
         edges. The backdrop is a heavy blur and scores near zero. */
      const colDetail = new Float64Array(W)
      for (let x = 0; x < W; x++) {
        let sum = 0
        for (let y = 1; y < H; y++) sum += Math.abs(lumaAt(x, y) - lumaAt(x, y - 1))
        colDetail[x] = sum / H
      }
      const colPeakEarly = Math.max(...colDetail)
      let lx = 0
      while (lx < W && colDetail[lx] <= colPeakEarly * 0.18) lx++
      let rx = W - 1
      while (rx > 0 && colDetail[rx] <= colPeakEarly * 0.18) rx--

      /* Row detail measured only across the panel's own width. Scoring the full
         row lets the blurred margins drag a dark, smooth photo — a black car
         carpet, say — down below any threshold set as a fraction of the peak,
         which silently truncates the crop. */
      const rowDetail = new Float64Array(H)
      for (let y = 0; y < H; y++) {
        let sum = 0
        let n = 0
        for (let x = lx + 4; x < rx - 4; x++) {
          sum += Math.abs(lumaAt(x, y) - lumaAt(x - 1, y))
          n++
        }
        rowDetail[y] = n ? sum / n : 0
      }

      /* Calibrate against the backdrop itself rather than against the peak.
         Rows near the very top are always backdrop, whatever the photos hold. */
      let bgDetail = 0
      let bgRows = 0
      for (let y = 4; y < Math.min(H * 0.03, 120); y++) {
        bgDetail += rowDetail[y]
        bgRows++
      }
      bgDetail = bgRows ? bgDetail / bgRows : 0
      const threshold = Math.max(bgDetail * 4, 0.6)

      const isPanelRow = (y) => rowDetail[y] > threshold

      /* Two panels, so find the outer bounds and split at one quiet stretch
         between them. Picking the *widest* stretch is wrong: a photo containing
         a clear blue sky has a flatter run than the real gap does. The layout is
         symmetric — equal margins top and bottom — so the gap always sits near
         the vertical middle, and "quiet stretch closest to centre" identifies it
         where "quietest" does not. */
      let firstOn = 0
      while (firstOn < H && !isPanelRow(firstOn)) firstOn++
      let lastOn = H - 1
      while (lastOn > 0 && !isPanelRow(lastOn)) lastOn--

      const MIN_GAP = Math.max(12, H * 0.004)
      const centre = H / 2
      let bestGap = null
      let bestDist = Infinity
      let runStart = -1
      for (let y = firstOn; y <= lastOn; y++) {
        const quiet = !isPanelRow(y)
        if (quiet && runStart < 0) runStart = y
        if ((!quiet || y === lastOn) && runStart >= 0) {
          const end = y - 1
          if (end - runStart >= MIN_GAP) {
            const dist = Math.abs((runStart + end) / 2 - centre)
            if (dist < bestDist) {
              bestDist = dist
              bestGap = [runStart, end]
            }
          }
          runStart = -1
        }
      }

      const runs =
        bestGap
          ? [
              [firstOn, bestGap[0] - 1],
              [bestGap[1] + 1, lastOn],
            ]
          : [[firstOn, lastOn]]

      const left = lx
      const right = rx

      // Backdrop sample: the strip above the first panel.
      let bgSum = 0
      let bgN = 0
      const topEdge = runs.length ? runs[0][0] : Math.round(H * 0.02)
      for (let y = 0; y < Math.max(1, topEdge - 4); y++) {
        for (let x = 0; x < W; x += 4) {
          bgSum += lumaAt(x, y)
          bgN++
        }
      }

      /* Corner radius: walk down the left edge of the top panel and find where
         the panel's own left boundary settles to its final x. */
      let radius = 0
      if (runs.length) {
        const [y0, y1] = runs[0]
        const settled = left
        for (let dy = 0; dy < Math.min(120, y1 - y0); dy++) {
          const y = y0 + dy
          let x = 0
          while (x < W && Math.abs(lumaAt(x, y) - lumaAt(x + 1, y)) < 3) x++
          if (x <= settled + 2) {
            radius = dy
            break
          }
        }
      }

      // Cut each panel out at full resolution.
      const panels = runs.map(([y0, y1]) => {
        const pw = right - left + 1
        const ph = y1 - y0 + 1
        const pc = new OffscreenCanvas(pw, ph)
        pc.getContext('2d').drawImage(bmp, left, y0, pw, ph, 0, 0, pw, ph)
        return { y0, y1, width: pw, height: ph, canvas: pc }
      })

      const encoded = []
      for (const p of panels) {
        const blob = await p.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
        const buf = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        for (const b of buf) bin += String.fromCharCode(b)
        encoded.push(btoa(bin))
      }

      bmp.close()

      out.push({
        name,
        W,
        H,
        aspect: W / H,
        left,
        right,
        runs,
        radius,
        bgLuma: bgN ? bgSum / bgN : 0,
        panels: panels.map((p) => ({
          y0: p.y0,
          y1: p.y1,
          width: p.width,
          height: p.height,
          aspect: p.width / p.height,
        })),
        encoded,
      })
    }

    return out
  }, refs)

  await browser.close()
  server.kill('SIGTERM')

  const pct = (v, W) => ((v / W) * 100).toFixed(2)
  const agg = { padX: [], padTop: [], padBottom: [], gap: [], radius: [], bg: [] }

  for (const r of results) {
    console.log(`\n${'='.repeat(70)}\n${r.name}  ${r.W}x${r.H}  (${r.aspect.toFixed(3)}:1)`)
    if (r.panels.length !== 2) {
      console.log(`  ⚠ found ${r.panels.length} panels, expected 2 — skipping`)
      continue
    }
    const [top, bottom] = r.panels
    const padLeft = r.left
    const padRight = r.W - 1 - r.right
    const padTop = top.y0
    const padBottom = r.H - 1 - bottom.y1
    const gap = bottom.y0 - top.y1

    console.log(`  side margins   ${pct(padLeft, r.W)}% / ${pct(padRight, r.W)}%`)
    console.log(`  top / bottom   ${pct(padTop, r.W)}% / ${pct(padBottom, r.W)}%`)
    console.log(`  gap            ${pct(gap, r.W)}%  (${gap}px)`)
    console.log(`  corner radius  ~${pct(r.radius, r.W)}%  (${r.radius}px)`)
    console.log(`  backdrop luma  ${r.bgLuma.toFixed(1)} / 255`)
    console.log(
      `  panel aspects  top ${top.aspect.toFixed(3)}  bottom ${bottom.aspect.toFixed(3)}` +
        (Math.abs(top.aspect - bottom.aspect) > 0.02 ? '   ← not forced to match' : ''),
    )

    agg.padX.push(((padLeft + padRight) / 2 / r.W) * 100)
    agg.padTop.push((padTop / r.W) * 100)
    agg.padBottom.push((padBottom / r.W) * 100)
    agg.gap.push((gap / r.W) * 100)
    agg.radius.push((r.radius / r.W) * 100)
    agg.bg.push(r.bgLuma)

    // The user's app puts the finished car on top, so index 0 is the "after".
    const stem = r.name.replace(/\.jpe?g$/i, '')
    const labels = ['after', 'before']
    r.encoded.forEach((b64, i) => {
      writeFileSync(`${OUT_DIR}${stem}_${labels[i] ?? `panel${i}`}.jpg`, Buffer.from(b64, 'base64'))
    })
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1)
  console.log(`\n${'='.repeat(70)}\nAVERAGES (percent of canvas width)`)
  console.log(`  side margin    ${mean(agg.padX).toFixed(2)}%`)
  console.log(`  top margin     ${mean(agg.padTop).toFixed(2)}%`)
  console.log(`  bottom margin  ${mean(agg.padBottom).toFixed(2)}%`)
  console.log(`  gap            ${mean(agg.gap).toFixed(2)}%`)
  console.log(`  corner radius  ${mean(agg.radius).toFixed(2)}%`)
  console.log(`  backdrop luma  ${mean(agg.bg).toFixed(1)} / 255`)
  console.log(`\nwrote ${readdirSync(OUT_DIR).length} cropped photos to test/fixtures/photos/`)
}

main()
