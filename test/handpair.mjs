/**
 * Pairing the leftovers by hand.
 *
 * Reported as: "there should be a manual mode, at least... it needs to be
 * better manual, like, more instructions like before you click first and after
 * you click second, and you do pairs. Maybe a bigger screen... for all the
 * unpaired ones that are leftover after it does the auto pairing."
 *
 * The photos that reach this panel are the ones the matcher couldn't place —
 * disproportionately interiors, which are the hardest to tell apart from a
 * thumbnail. So this checks the three things that make the panel usable rather
 * than merely present: the step you're on is stated, tap order decides
 * before/after, and any photo can be opened full screen.
 *
 * Run:  node test/handpair.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'

const PORT = 4330
const DIR = new URL('./fixtures/samecar/', import.meta.url).pathname
if (!existsSync(DIR)) {
  console.log(`No fixtures in ${DIR} — skipping. (Real photos, deliberately not committed.)`)
  process.exit(0)
}
const names = readdirSync(DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()

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

const total = await page.evaluate(async (files) => {
  const MIN = 60_000
  const t0 = new Date('2026-05-10T09:00:00Z').getTime()
  const out = []
  for (let i = 0; i < files.length; i++) {
    const res = await fetch(`/test/fixtures/samecar/${files[i]}`)
    if (!res.ok) throw new Error(`${files[i]} ${res.status}`)
    out.push(
      new File([await res.blob()], files[i], {
        type: 'image/jpeg',
        lastModified: t0 + [0, 6, 13, 190, 205, 218, 240, 262][i % 8] * MIN,
      }),
    )
  }
  const input = document.querySelector('input[type=file]')
  const dt = new DataTransfer()
  out.forEach((f) => dt.items.add(f))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return out.length
}, names)

console.log(`${total} photos of one car\n`)
await page.waitForSelector('[data-view=cars]', { timeout: 120000 })
await page.click('[data-view=cars] .btn.primary')
await page.waitForSelector('[data-view=pairs]')

/* Reject every automatic suggestion, which is what someone does when the
   matcher got a car wrong — it puts all eight photos into the panel and is the
   situation the panel exists for. */
let guard = 0
while ((await page.locator('[data-testid=review-images]').count()) > 0 && guard++ < 40) {
  await page.click('[data-testid=reject]')
  await page.waitForTimeout(120)
}
await page.waitForTimeout(200)

console.log('[1] The panel is there, with room to see')
const panel = page.locator('[data-testid=pair-by-hand]')
check('the hand-pairing panel is shown', (await panel.count()) === 1)
const tiles = page.locator('[data-testid=pair-by-hand] .handpair-tile')
const tileCount = await tiles.count()
check('the leftovers are listed', tileCount >= 2, `${tileCount} photo(s)`)

const box = await tiles.first().locator('.handpair-pick').boundingBox()
/* The old grid was 88px minimum. These are the photos nobody can identify
   small, so the tiles have to be substantially bigger than that. */
check('tiles are large enough to recognise a photo', box.width >= 140, `${Math.round(box.width)}px wide`)
check(
  'every tile is at least a 44px touch target tall',
  box.height >= 44,
  `${Math.round(box.height)}px`,
)

console.log('\n[2] The step you are on is stated')
const step1 = await page.locator('.handpair-steps').innerText()
check('it says to tap the before shot first', /tap the\s+before shot/i.test(step1), step1.split('\n')[0])
check('it does not yet ask for the after', !/Now tap its/i.test(step1))

await tiles.first().locator('.handpair-pick').click()
await page.waitForTimeout(150)
const step2 = await page.locator('.handpair-steps').innerText()
check('after one tap it asks for the after', /Now tap its\s+after/i.test(step2))
check(
  'the chosen photo is badged BEFORE',
  (await page.locator('.handpair-tile.picked .handpair-badge').innerText()) === 'BEFORE',
)

console.log('\n[3] Tap order decides which is which')
const firstName = await tiles.first().locator('.handpair-pick').getAttribute('data-photo')
const secondName = await tiles.nth(1).locator('.handpair-pick').getAttribute('data-photo')
await tiles.nth(1).locator('.handpair-pick').click()
await page.waitForTimeout(250)

const madePair = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pair-row')]
  const last = rows[rows.length - 1]
  if (!last) return null
  const imgs = last.querySelectorAll('img[data-photo]')
  return { before: imgs[0]?.dataset.photo, after: imgs[1]?.dataset.photo }
})
check(
  'the first tapped photo became the before',
  madePair?.before === firstName,
  `${madePair?.before} → ${madePair?.after}`,
)
check('the second tapped photo became the after', madePair?.after === secondName)
check(
  'both left the leftovers list',
  (await tiles.count()) === tileCount - 2,
  `${await tiles.count()} remaining`,
)
check(
  'the panel reset to step one',
  /tap the\s+before shot/i.test(await page.locator('.handpair-steps').innerText()),
)

console.log('\n[4] Any photo can be opened full screen')
if ((await tiles.count()) > 0) {
  await tiles.first().locator('.handpair-zoom').click()
  await page.waitForSelector('[data-testid=lightbox]')
  const shot = await page.locator('[data-testid=lightbox] img').boundingBox()
  const view = page.viewportSize()
  check('the lightbox opened', true)
  check(
    'the photo fills most of the screen',
    shot.width > view.width * 0.5 || shot.height > view.height * 0.5,
    `${Math.round(shot.width)}x${Math.round(shot.height)} in ${view.width}x${view.height}`,
  )
  check(
    'it offers to use the photo without closing first',
    /Use as (before|after)/i.test(await page.locator('.lightbox-bar').innerText()),
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('Escape closes it', (await page.locator('[data-testid=lightbox]').count()) === 0)
} else {
  check('enough leftovers remained to test the lightbox', false, 'none left')
}

console.log('\n[5] Console health')
check('no page errors', pageErrors.length === 0, pageErrors.join('; ') || 'clean')

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
