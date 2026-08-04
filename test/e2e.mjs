/**
 * End-to-end harness.
 *
 * Generates a synthetic camera roll — several cars, each shot from several
 * angles before and after a "detail" — then drives the real UI through import,
 * grouping, pairing and export, asserting the result at each step.
 *
 * Run against a built preview server:  node test/e2e.mjs
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4319
const BASE = `http://127.0.0.1:${PORT}`

const CARS = 4
const ANGLES_PER_CAR = 3
const EXTRA_SINGLES = 1

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
  if (!ok) failures++
  return ok
}
function checkThat(label, condition, detail = '') {
  console.log(`${condition ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
  return condition
}

/** Runs in the browser: build a fake camera roll and hand it to the file input. */
async function injectSyntheticRoll(page, opts) {
  return page.evaluate(async ({ cars, angles, extras }) => {
    const W = 800
    const H = 600

    /** Deterministic PRNG so runs are reproducible. */
    function rng(seed) {
      let s = seed >>> 0
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s / 4294967296
      }
    }

    /**
     * One photo. `carSeed` fixes the car's colour, `angleSeed` fixes the
     * composition, and `dirty` decides how grubby it looks. A before and an
     * after share carSeed+angleSeed, so they must hash alike; different angles
     * must not.
     */
    function drawPhoto(carSeed, angleSeed, dirty, closeup = false) {
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d')
      const rand = rng(carSeed * 7919 + angleSeed * 104729)

      const hue = (carSeed * 67) % 360
      const bright = dirty ? 0.55 : 1

      // A detail shot: tight on one wheel, nothing like a full-car angle.
      if (closeup) {
        ctx.fillStyle = `hsl(${(hue + 20) % 360} 20% ${18 * bright + 6}%)`
        ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = `hsl(0 0% ${8 * bright + 3}%)`
        ctx.beginPath()
        ctx.arc(W / 2, H / 2, 230, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `hsl(${hue} 30% ${62 * bright + 12}%)`
        for (let i = 0; i < 7; i++) {
          const ang = (i / 7) * Math.PI * 2 + angleSeed
          ctx.beginPath()
          ctx.moveTo(W / 2, H / 2)
          ctx.arc(W / 2, H / 2, 160, ang - 0.16, ang + 0.16)
          ctx.closePath()
          ctx.fill()
        }
        return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9))
      }

      // Sky / backdrop
      const grad = ctx.createLinearGradient(0, 0, 0, H)
      grad.addColorStop(0, `hsl(${(hue + 200) % 360} 40% ${28 * bright + 12}%)`)
      grad.addColorStop(1, `hsl(${(hue + 200) % 360} 30% ${12 * bright + 6}%)`)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)

      // The "car" — a big body whose placement depends on the angle.
      const cx = 120 + (angleSeed % 3) * 180
      const cy = 220 + ((angleSeed >> 1) % 2) * 90
      ctx.fillStyle = `hsl(${hue} 65% ${34 * bright + 8}%)`
      ctx.beginPath()
      ctx.ellipse(cx + 200, cy + 130, 260, 110, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillRect(cx, cy, 400, 150)

      // Windows and wheels give the hash strong local gradients.
      ctx.fillStyle = `hsl(${hue} 35% ${58 * bright + 10}%)`
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(cx + 30 + i * 120, cy + 20, 90, 62)
      }
      ctx.fillStyle = `hsl(0 0% ${9 * bright + 4}%)`
      for (const wx of [cx + 70, cx + 320]) {
        ctx.beginPath()
        ctx.arc(wx, cy + 165, 46, 0, Math.PI * 2)
        ctx.fill()
      }

      // Ground
      ctx.fillStyle = `hsl(${(hue + 40) % 360} 12% ${20 * bright + 6}%)`
      ctx.fillRect(0, cy + 200, W, H - cy - 200)

      // Dirt: only on the "before" shot.
      if (dirty) {
        ctx.globalAlpha = 0.22
        ctx.fillStyle = '#6b5637'
        for (let i = 0; i < 900; i++) {
          const x = rand() * W
          const y = rand() * H
          ctx.fillRect(x, y, 1 + rand() * 4, 1 + rand() * 4)
        }
        ctx.globalAlpha = 1
      } else {
        // A clean car gets a specular highlight instead.
        ctx.globalAlpha = 0.16
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.ellipse(cx + 160, cy + 40, 150, 26, -0.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }

      return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9))
    }

    const files = []
    const HOUR = 3600_000
    const MINUTE = 60_000
    const t0 = new Date('2026-03-02T09:00:00Z').getTime()

    for (let car = 0; car < cars; car++) {
      // Each car gets its own 3-hour slot: before batch, then a gap while it's
      // detailed, then the after batch.
      const carStart = t0 + car * 4 * HOUR

      for (let a = 0; a < angles; a++) {
        const blob = await drawPhoto(car + 1, a + 1, true)
        files.push(
          new File([blob], `car${car + 1}_before_${a + 1}.jpg`, {
            type: 'image/jpeg',
            lastModified: carStart + a * 2 * MINUTE,
          }),
        )
      }

      const afterStart = carStart + 100 * MINUTE
      for (let a = 0; a < angles; a++) {
        const blob = await drawPhoto(car + 1, a + 1, false)
        files.push(
          new File([blob], `car${car + 1}_after_${a + 1}.jpg`, {
            type: 'image/jpeg',
            lastModified: afterStart + a * 2 * MINUTE,
          }),
        )
      }

      // Unmatchable extras — detail shots that have no partner.
      for (let e = 0; e < extras; e++) {
        const blob = await drawPhoto(car + 1, 90 + e, false, true)
        files.push(
          new File([blob], `car${car + 1}_detail_${e + 1}.jpg`, {
            type: 'image/jpeg',
            lastModified: afterStart + (angles + e) * 2 * MINUTE,
          }),
        )
      }
    }

    const input = document.querySelector('input[type=file]')
    const dt = new DataTransfer()
    files.forEach((f) => dt.items.add(f))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))

    return files.length
  }, opts)
}

async function main() {
  console.log('Starting preview server…')
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  })

  // Wait for the server to answer.
  let up = false
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE)
      if (res.ok) {
        up = true
        break
      }
    } catch {
      /* not yet */
    }
    await sleep(250)
  }
  if (!up) {
    console.error('Preview server never came up')
    server.kill()
    process.exit(1)
  }

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()

  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })

  try {
    await page.goto(BASE)
    await page.waitForSelector('.dropzone', { timeout: 15000 })

    /* ------------------------------------------------------------- import */
    console.log('\n[1] Import')
    const expectedFiles = CARS * (ANGLES_PER_CAR * 2 + EXTRA_SINGLES)
    const injected = await injectSyntheticRoll(page, {
      cars: CARS,
      angles: ANGLES_PER_CAR,
      extras: EXTRA_SINGLES,
    })
    check('files injected', injected, expectedFiles)

    await page.waitForSelector('.groups-view', { timeout: 60000 })
    const photoCount = await page.locator('.group-card .thumb').count()
    check('photos imported', photoCount, expectedFiles)

    /* ----------------------------------------------------------- grouping */
    console.log('\n[2] Grouping')
    const groupCount = await page.locator('.group-card').count()
    check('cars detected', groupCount, CARS)

    // Each car's before batch and after batch must have been stitched together.
    const groupSizes = await page.$$eval('.group-card', (cards) =>
      cards.map((c) => c.querySelectorAll('.thumb').length),
    )
    checkThat(
      'every car holds its full set',
      groupSizes.every((n) => n === ANGLES_PER_CAR * 2 + EXTRA_SINGLES),
      `sizes = [${groupSizes}]`,
    )

    // And no photo from one car leaked into another.
    const namesPerGroup = await page.$$eval('.group-card', (cards) =>
      cards.map((c) =>
        [...c.querySelectorAll('.thumb')].map((t) => t.getAttribute('title')?.split(' ·')[0]),
      ),
    )
    const mixed = namesPerGroup.filter((names) => {
      const carIds = new Set(names.map((n) => n?.match(/^car(\d+)_/)?.[1]))
      return carIds.size > 1
    })
    checkThat('no cross-car contamination', mixed.length === 0, `${mixed.length} mixed groups`)

    /* ------------------------------------------------------------ pairing */
    console.log('\n[3] Pairing')
    const suggestedPairs = await page.$$eval('.group-card .pill.accent', (pills) =>
      pills.map((p) => parseInt(p.textContent ?? '0', 10)),
    )
    check(
      'pairs suggested overall',
      suggestedPairs.reduce((a, b) => a + b, 0),
      CARS * ANGLES_PER_CAR,
    )

    await page.click('.btn.primary:has-text("Pair them up")')
    await page.waitForSelector('.pair-view')

    // Confirm every suggestion using only the keyboard, the way a real session
    // would run, then read back exactly which shots got married to which.
    let totalSuggestions = 0
    const allPairs = []

    for (let car = 0; car < CARS; car++) {
      await page.locator('.group-strip .chip').nth(car).click()
      await page.waitForTimeout(150)

      while ((await page.locator('.review-images').count()) > 0) {
        totalSuggestions++
        await page.keyboard.press('ArrowRight') // confirm
        await page.waitForTimeout(90)
        if (totalSuggestions > 200) throw new Error('pair queue never drained')
      }

      const pairs = await page.$$eval('.manual .pair-row', (rows) =>
        rows.map((r) => {
          const imgs = r.querySelectorAll('img[data-photo]')
          return { before: imgs[0]?.dataset.photo, after: imgs[1]?.dataset.photo }
        }),
      )
      allPairs.push(...pairs)
    }
    check('suggestions reviewed', totalSuggestions, CARS * ANGLES_PER_CAR)
    check('confirmed pairs recorded', allPairs.length, CARS * ANGLES_PER_CAR)

    // The real test: is every pair the same car, the same angle, before→after?
    const parse = (n) => n?.match(/^car(\d+)_(before|after|detail)_(\d+)\.jpg$/)
    const wrong = allPairs.filter(({ before, after }) => {
      const b = parse(before)
      const a = parse(after)
      if (!b || !a) return true
      return (
        b[1] !== a[1] || // different car
        b[3] !== a[3] || // different angle
        b[2] !== 'before' ||
        a[2] !== 'after'
      )
    })
    checkThat(
      'every pair is the same car + same angle, before→after',
      wrong.length === 0,
      wrong.length ? JSON.stringify(wrong.slice(0, 3)) : `${allPairs.length}/${allPairs.length} exact`,
    )

    await page.click('.stage-tab:has-text("Cars")')
    await page.waitForSelector('.groups-view')
    const pairedBadges = await page.locator('.thumb-badge:not(.warn)').count()
    check('photos marked paired', pairedBadges, CARS * ANGLES_PER_CAR * 2)

    const pairReport = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.group-card')]
      return groups.map((g) => ({
        singles: [...g.querySelectorAll('.thumb')]
          .filter((t) => !t.querySelector('.thumb-badge:not(.warn)'))
          .map((t) => t.getAttribute('title')?.split(' ·')[0]),
      }))
    })

    const singlesOk = pairReport.every(
      (g) => g.singles.length === EXTRA_SINGLES && g.singles.every((n) => n?.includes('_detail_')),
    )
    checkThat(
      'unmatched detail shots left as singles',
      singlesOk,
      JSON.stringify(pairReport.map((g) => g.singles)),
    )

    /* -------------------------------------------------------------- style */
    console.log('\n[4] Style + preview render')
    await page.click('.stage-tab:has-text("Style")')
    await page.waitForSelector('.style-view')
    await page.waitForTimeout(700)

    const previewStats = await page.evaluate(() => {
      const c = document.querySelector('.preview-canvas')
      if (!c) return null
      const ctx = c.getContext('2d')
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let sum = 0
      let nonBlack = 0
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3
        sum += l
        if (l > 12) nonBlack++
      }
      return {
        width: c.width,
        height: c.height,
        meanLuma: sum / (d.length / 4),
        coverage: nonBlack / (d.length / 4),
      }
    })
    checkThat('preview canvas exists', previewStats !== null)
    if (previewStats) {
      checkThat(
        'preview is 4:5',
        Math.abs(previewStats.width / previewStats.height - 0.8) < 0.01,
        `${previewStats.width}x${previewStats.height}`,
      )
      checkThat(
        'preview actually rendered content',
        previewStats.meanLuma > 8 && previewStats.coverage > 0.7,
        `luma=${previewStats.meanLuma.toFixed(1)} coverage=${(previewStats.coverage * 100).toFixed(1)}%`,
      )
    }

    // Slider changes must reach the canvas.
    const before = await page.evaluate(() => {
      const c = document.querySelector('.preview-canvas')
      return c.getContext('2d').getImageData(0, 0, 40, 40).data.join(',')
    })
    await page.evaluate(() => {
      const sliders = [...document.querySelectorAll('.style-controls input[type=range]')]
      const darken = sliders.find((s) => s.closest('label')?.textContent?.includes('Darken'))
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(darken, '0.85')
      darken.dispatchEvent(new Event('input', { bubbles: true }))
      darken.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForTimeout(500)
    const after = await page.evaluate(() => {
      const c = document.querySelector('.preview-canvas')
      return c.getContext('2d').getImageData(0, 0, 40, 40).data.join(',')
    })
    checkThat('slider changes repaint the preview', before !== after)

    /* ------------------------------------------------------------- export */
    console.log('\n[5] Export')
    await page.click('.stage-tab:has-text("Export")')
    await page.waitForSelector('.export-view')

    const downloadPromise = page.waitForEvent('download', { timeout: 120000 })
    await page.click('.view-head .btn.primary')
    const download = await downloadPromise
    const path = await download.path()

    const { statSync } = await import('node:fs')
    const size = statSync(path).size
    checkThat('zip downloaded', size > 20000, `${(size / 1024).toFixed(0)} KB`)

    // Crack the zip open and verify its shape.
    const JSZipMod = await import('jszip')
    const JSZip = JSZipMod.default
    const { readFileSync } = await import('node:fs')
    const zip = await JSZip.loadAsync(readFileSync(path))
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir)

    const composites = entries.filter((n) => n.endsWith('_before-after.jpg'))
    const singles = entries.filter((n) => n.includes('/singles/'))
    check('composites in zip', composites.length, CARS * ANGLES_PER_CAR)
    check('singles in zip', singles.length, CARS * EXTRA_SINGLES)

    const folders = new Set(entries.map((n) => n.split('/')[0]))
    check('one folder per car', folders.size, CARS)

    // A composite must be a real, correctly-sized JPEG.
    const firstComposite = await zip.file(composites[0]).async('nodebuffer')
    checkThat(
      'composite is a JPEG',
      firstComposite[0] === 0xff && firstComposite[1] === 0xd8,
      `${(firstComposite.length / 1024).toFixed(0)} KB`,
    )

    const dims = await page.evaluate(async (b64) => {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      const out = { w: bmp.width, h: bmp.height }
      bmp.close()
      return out
    }, firstComposite.toString('base64'))
    check('composite width', dims.w, 1600)
    check('composite height', dims.h, 2000)

    /* --------------------------------------------------------- resilience */
    console.log('\n[6] Session restore')
    await page.reload()
    await page.waitForSelector('.groups-view', { timeout: 60000 })
    const restoredPhotos = await page.locator('.group-card .thumb').count()
    check('photos restored after reload', restoredPhotos, expectedFiles)
    const restoredGroups = await page.locator('.group-card').count()
    check('cars restored after reload', restoredGroups, CARS)

    /* ------------------------------------------------------------- errors */
    console.log('\n[7] Console health')
    const realErrors = pageErrors.filter((e) => !/favicon|manifest/i.test(e))
    checkThat(
      'no page errors',
      realErrors.length === 0,
      realErrors.slice(0, 3).join(' | ') || 'clean',
    )
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
