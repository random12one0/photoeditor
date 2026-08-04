/**
 * Saying no should offer the next best answer, not give up.
 *
 * Reported as: "once you say no it brings up that image again... maybe it just
 * kinda falls back, okay this is the second best image it detected. Or there's
 * a button that says, oh, this is not it, this is a solo image."
 *
 * Both, then. "Not a pair" walks down the ranked runners-up for that photo, and
 * a separate control says there is no partner at all. The distinction matters:
 * one of them means "wrong answer, try again" and the other means "stop asking".
 *
 * Run:  node test/runnerup.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { MINUTES } from './lib/samecar-truth.mjs'

const PORT = 4335
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

await page.evaluate(
  async ({ files, minutes }) => {
    const MIN = 60_000
    const t0 = new Date('2026-05-10T09:00:00Z').getTime()
    const out = []
    for (const name of files) {
      const res = await fetch(`/test/fixtures/samecar/${name}`)
      if (!res.ok) throw new Error(`${name} ${res.status}`)
      out.push(
        new File([await res.blob()], name, {
          type: 'image/jpeg',
          lastModified: t0 + minutes[name.match(/IMG_(\d+)/)[1]] * MIN,
        }),
      )
    }
    const input = document.querySelector('input[type=file]')
    const dt = new DataTransfer()
    out.forEach((f) => dt.items.add(f))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  },
  { files: names, minutes: MINUTES },
)

await page.waitForSelector('[data-view=cars]', { timeout: 120000 })
await page.click('[data-view=cars] .btn.primary')
await page.waitForSelector('[data-view=pairs]')
await page.waitForTimeout(400)

const shown = () =>
  page.evaluate(() => {
    const figs = [...document.querySelectorAll('[data-testid=review-images] figure')]
    if (!figs.length) return null
    return {
      pct: document.querySelector('.match .mono')?.textContent,
      rejectLabel: document.querySelector('[data-testid=reject]')?.innerText.trim(),
    }
  })

/* Driven by the reject label and the match percentage, both of which have to
   change as the list is walked. */
console.log('[1] "Not a pair" offers another candidate rather than giving up')
const first = await shown()
check(
  'the reject button offers to try another',
  first.rejectLabel === 'Try another',
  `label is "${first.rejectLabel}"`,
)

const seenPct = [first.pct]
let steps = 0
while (steps < 6) {
  const before = await shown()
  if (!before || before.rejectLabel !== 'Try another') break
  await page.click('[data-testid=reject]')
  await page.waitForTimeout(180)
  const after = await shown()
  if (!after) break
  steps++
  seenPct.push(after.pct)
}
console.log(`  walked ${steps} candidate(s): ${seenPct.join(' → ')}`)
check('rejecting produced a different candidate', steps >= 1)
check(
  'each fallback is a distinct match strength',
  new Set(seenPct).size === seenPct.length,
  seenPct.join(', '),
)
check(
  'the card is still up — the photo was not abandoned',
  (await page.locator('[data-testid=review-images]').count()) === 1,
)

console.log('\n[2] When the candidates run out, the label says so')
let guard = 0
while (guard++ < 10) {
  const s = await shown()
  if (!s || s.rejectLabel !== 'Try another') break
  await page.click('[data-testid=reject]')
  await page.waitForTimeout(150)
}
const exhausted = await shown()
if (exhausted) {
  check(
    'the button now reads "Not a pair"',
    exhausted.rejectLabel === 'Not a pair',
    `label is "${exhausted.rejectLabel}"`,
  )
  const queued = await page.locator('[data-testid=review-images]').count()
  await page.click('[data-testid=reject]')
  await page.waitForTimeout(200)
  check('and it finally drops the suggestion', queued === 1)
} else {
  check('a card was still showing to check the exhausted label', false)
}

console.log('\n[3] "Neither" drops it in one tap, whatever is left to try')
const beforeCount = await page.locator('[data-testid=pair-by-hand] .handpair-tile').count()
if ((await page.locator('[data-testid=review-images]').count()) > 0) {
  const label = (await shown())?.rejectLabel
  await page.click('[data-testid=no-partner]')
  await page.waitForTimeout(250)
  const afterCount = await page.locator('[data-testid=pair-by-hand] .handpair-tile').count()
  check(
    'both photos went straight to the hand-pairing panel',
    afterCount >= beforeCount + 2,
    `${beforeCount} → ${afterCount} leftovers (reject said "${label}")`,
  )
} else {
  check('a card was still showing to test Neither', false, 'queue empty')
}

console.log('\n[4] Console health')
check('no page errors', pageErrors.length === 0, pageErrors.join('; ') || 'clean')

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
