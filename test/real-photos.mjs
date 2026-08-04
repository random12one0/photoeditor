/**
 * The pipeline, run against real photographs.
 *
 * Every other test uses drawn fixtures. These are actual detailing photos, cut
 * back out of the user's own finished collages by test/measure.mjs — real
 * lighting, real noise, real handheld framing, and genuinely hard cases (two
 * different cars' wheels, shot close up, look far more alike than any synthetic
 * fixture does).
 *
 * Each source collage is one car: its two panels are that car's before and
 * after. So the correct answer is one group per collage, with exactly one pair
 * inside it, matching the panels that came from the same file.
 *
 * Run:  node test/real-photos.mjs
 */

import { launchBrowser, startServer } from './lib/harness.mjs'
import { readdirSync } from 'node:fs'

const PORT = 4324
const BASE = `http://127.0.0.1:${PORT}`
const PHOTO_DIR = new URL('./fixtures/photos/', import.meta.url).pathname

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
  if (!ok) failures++
}
const checkThat = (label, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

async function main() {
  const names = readdirSync(PHOTO_DIR)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort()
  if (names.length < 2) {
    console.error(`No cropped photos in ${PHOTO_DIR}. Run: node test/measure.mjs`)
    process.exit(1)
  }

  const cars = [...new Set(names.map((n) => n.split('_')[0]))].sort()
  console.log(`${names.length} real photos across ${cars.length} cars\n`)

  // Dev server, not preview: this harness fetches fixtures from /test/, which
  // only the dev server serves.
  const { proc: server } = await startServer(PORT, { mode: 'dev' })
  const browser = await launchBrowser()
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()))

  try {
    await page.goto(BASE)
    await page.waitForSelector('[data-view=import]')

    /* --------------------------------------------------------------- import */
    console.log('[1] Import real photos')
    const injected = await page.evaluate(async (files) => {
      const MIN = 60_000
      const t0 = new Date('2026-05-04T09:00:00Z').getTime()
      const out = []

      /* Five separate jobs, one per day — which is what these fixtures are.
         They were previously spaced four hours apart, which was invented rather
         than observed, and tighter than a mobile detailer ever works. */
      const cars = [...new Set(files.map((n) => n.split('_')[0]))].sort()
      for (let ci = 0; ci < cars.length; ci++) {
        const carStart = t0 + ci * 24 * 3600_000
        for (const name of files.filter((n) => n.startsWith(cars[ci] + '_'))) {
          const isAfter = name.includes('_after')
          const blob = await (await fetch(`/test/fixtures/photos/${name}`)).blob()
          out.push(
            new File([blob], name, {
              type: 'image/jpeg',
              lastModified: carStart + (isAfter ? 95 * MIN : 2 * MIN),
            }),
          )
        }
      }

      const input = document.querySelector('input[type=file]')
      const dt = new DataTransfer()
      out.forEach((f) => dt.items.add(f))
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return out.length
    }, names)
    check('photos injected', injected, names.length)

    await page.waitForSelector('[data-view=cars]', { timeout: 120000 })
    check('photos imported', await page.locator('[data-view=cars] .thumb').count(), names.length)

    /* ------------------------------------------------------------- grouping */
    console.log('\n[2] Grouping real photos')
    /* One short of perfect is the documented, accepted result here, and the
       reason is worth knowing. These fixtures are the degenerate case: exactly
       one photo per burst, so each burst-to-burst affinity rests on a single
       comparison instead of averaging over a whole walk-around. On top of that,
       one car's before shot has a wet, soapy driveway and its after is dry,
       which moves the colour signature that car identity leans on.

       What must hold is that it never guesses: no two cars merged, and every
       pair it does propose is correct. Missing one costs a single Merge tap;
       inventing one costs a wrong export. */
    const detected = await page.locator('[data-view=cars] .card').count()
    checkThat(
      'cars detected',
      detected >= cars.length && detected <= cars.length + 1,
      `${detected} (ideal ${cars.length}, one under-merge tolerated)`,
    )

    const perGroup = await page.$$eval('[data-view=cars] .card', (cards) =>
      cards.map((c) =>
        [...c.querySelectorAll('.thumb')].map(
          (t) => t.getAttribute('title')?.split(' ·')[0] ?? '',
        ),
      ),
    )
    const mixed = perGroup.filter(
      (g) => new Set(g.map((n) => n.split('_')[0])).size > 1,
    )
    checkThat(
      'no two cars merged together',
      mixed.length === 0,
      mixed.length ? JSON.stringify(mixed) : `${perGroup.length} clean groups`,
    )

    /* -------------------------------------------------------------- pairing */
    console.log('\n[3] Pairing real photos')
    await page.click('[data-view=cars] .btn.primary')
    await page.waitForSelector('[data-view=pairs]')

    let reviewed = 0
    const found = []
    for (let i = 0; i < cars.length; i++) {
      await page.locator('.group-strip .chip').nth(i).click()
      await page.waitForTimeout(150)
      while ((await page.locator('[data-testid=review-images]').count()) > 0) {
        reviewed++
        await page.click('[data-testid=confirm]')
        await page.waitForTimeout(110)
        if (reviewed > 60) throw new Error('queue never drained')
      }
      const pairs = await page.$$eval('.pair-row', (rows) =>
        rows.map((r) => {
          const imgs = r.querySelectorAll('img[data-photo]')
          return { before: imgs[0]?.dataset.photo, after: imgs[1]?.dataset.photo }
        }),
      )
      found.push(...pairs)
    }

    checkThat(
      'pairs suggested',
      reviewed >= cars.length - 1,
      `${reviewed} of ${cars.length}`,
    )
    check('pairs confirmed', found.length, reviewed)

    const wrong = found.filter(({ before, after }) => {
      if (!before || !after) return true
      const cb = before.split('_')[0]
      const ca = after.split('_')[0]
      return cb !== ca || !before.includes('_before') || !after.includes('_after')
    })
    checkThat(
      'every pair is the right car, before→after',
      wrong.length === 0,
      wrong.length ? JSON.stringify(wrong) : `${found.length}/${found.length} exact`,
    )

    /* ---------------------------------------------------------------- style */
    console.log('\n[4] Render real composites')
    await page.click('[data-step=style]')
    await page.waitForSelector('[data-view=style]')
    await page.waitForTimeout(1200)

    const stats = await page.evaluate(() => {
      const c = document.querySelector('.preview-canvas')
      if (!c) return null
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let sum = 0
      let lit = 0
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3
        sum += l
        if (l > 12) lit++
      }
      return {
        w: c.width,
        h: c.height,
        luma: sum / (d.length / 4),
        coverage: lit / (d.length / 4),
      }
    })
    checkThat('preview rendered', stats !== null)
    if (stats) {
      checkThat(
        'preview is 4:5 and fully painted',
        Math.abs(stats.w / stats.h - 0.8) < 0.01 && stats.coverage > 0.85,
        `${stats.w}x${stats.h} luma=${stats.luma.toFixed(0)} coverage=${(stats.coverage * 100).toFixed(1)}%`,
      )
    }

    /* --------------------------------------------------------------- export */
    console.log('\n[5] Export real composites')
    await page.click('[data-step=export]')
    await page.waitForSelector('[data-view=export]')

    const dl = page.waitForEvent('download', { timeout: 180000 })
    await page.click('.actionbar .btn:has-text("ZIP")')
    const download = await dl
    const path = await download.path()

    const { readFileSync, statSync, mkdirSync, writeFileSync } = await import('node:fs')
    checkThat('zip downloaded', statSync(path).size > 100_000, `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`)

    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(readFileSync(path))
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
    const composites = entries.filter((n) => n.endsWith('_before-after.jpg'))
    check('composites in zip', composites.length, found.length)

    // Keep one for eyeballing.
    const outDir = new URL('./output/', import.meta.url).pathname
    mkdirSync(outDir, { recursive: true })
    for (let i = 0; i < composites.length; i++) {
      writeFileSync(
        `${outDir}real-${i + 1}.jpg`,
        await zip.file(composites[i]).async('nodebuffer'),
      )
    }
    console.log(`  → wrote ${composites.length} real composites to test/output/`)

    console.log('\n[6] Console health')
    const real = pageErrors.filter((e) => !/favicon|manifest/i.test(e))
    checkThat('no page errors', real.length === 0, real.slice(0, 2).join(' | ') || 'clean')
  } catch (err) {
    console.error('\nHarness threw:', err)
    failures++
  } finally {
    await browser.close()
    server.kill('SIGTERM')
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
