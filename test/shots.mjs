/**
 * Screenshot the app and dump a real exported composite, so the output can be
 * eyeballed without a phone in hand.
 *
 * Run:  node test/shots.mjs   → writes into test/output/
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync, writeFileSync } from 'node:fs'

const PORT = 4322
const BASE = `http://127.0.0.1:${PORT}`
const OUT = new URL('./output/', import.meta.url).pathname

async function main() {
  mkdirSync(OUT, { recursive: true })
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

  /* ---------------------------------------------------- desktop walkthrough */
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
  await page.goto(BASE)
  await page.waitForSelector('[data-view=import] .dropzone')
  await page.screenshot({ path: `${OUT}1-import.png` })

  // Build a roll in-page and feed it through the app's real import path.
  const count = await page.evaluate(async () => {
    const { drawToBlob: draw } = await import('/test/lib/roll.js')
    const MIN = 60_000
    const t0 = new Date('2026-03-02T09:00:00Z').getTime()
    const files = []

    for (let car = 1; car <= 3; car++) {
      const start = t0 + (car - 1) * 4 * 3600_000
      for (let a = 1; a <= 3; a++) {
        files.push(
          new File([await draw({ car, angle: a, dirty: true })], `car${car}_before_${a}.jpg`, {
            type: 'image/jpeg',
            lastModified: start + a * 2 * MIN,
          }),
        )
      }
      for (let a = 1; a <= 3; a++) {
        files.push(
          new File([await draw({ car, angle: a, dirty: false })], `car${car}_after_${a}.jpg`, {
            type: 'image/jpeg',
            lastModified: start + 95 * MIN + a * 2 * MIN,
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
  })
  console.log(`injected ${count} photos`)

  await page.waitForSelector('[data-view=cars]', { timeout: 60000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}2-cars.png`, fullPage: true })

  await page.click('[data-view=cars] .btn.primary')
  await page.waitForSelector('[data-view=pairs]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}3-pairs.png` })

  // Confirm everything so the style screen has samples.
  for (let car = 0; car < 3; car++) {
    await page.locator('.group-strip .chip').nth(car).click()
    await page.waitForTimeout(120)
    let guard = 0
    while ((await page.locator('[data-testid=review-images]').count()) > 0 && guard++ < 50) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(70)
    }
  }

  // Pull the finished composite out at full export resolution, from the
  // confirmed-pairs list that the Pairs screen renders.
  const jpeg = await page.evaluate(async () => {
    const { renderComposite, canvasSize, DEFAULT_PRESET } = await import('/src/lib/render.ts')
    const imgs = [...document.querySelectorAll('.pair-row img[data-photo]')]
    // Fall back to the preview's own sources if the confirmed list isn't shown.
    const srcs = imgs.length >= 2 ? [imgs[0].src, imgs[1].src] : []
    if (srcs.length < 2) return null

    const load = async (src) => createImageBitmap(await (await fetch(src)).blob())
    const [before, after] = await Promise.all(srcs.map(load))

    const { width, height } = canvasSize('4:5', 1600)
    const canvas = new OffscreenCanvas(width, height)
    renderComposite(canvas, { before, after }, DEFAULT_PRESET)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (const b of buf) bin += String.fromCharCode(b)
    return btoa(bin)
  })

  if (jpeg) {
    writeFileSync(`${OUT}composite-sample.jpg`, Buffer.from(jpeg, 'base64'))
    console.log('wrote composite-sample.jpg')
  } else {
    console.log('no confirmed pair available for the composite sample')
  }

  await page.click('[data-step=style]')
  await page.waitForSelector('[data-view=style]')
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}4-style.png`, fullPage: true })

  /* ------------------------------------------------------------ mobile view */
  // Same page, resized — a fresh page would get its own empty IndexedDB and
  // land back on the import screen.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}5-mobile-style.png` })
  await page.click('[data-step=pairs]')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}6-mobile-pairs.png` })
  await page.click('[data-step=cars]')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}7-mobile-cars.png` })

  await page.close()
  await browser.close()
  server.kill('SIGTERM')
  console.log('screenshots written to test/output/')
}

main()
