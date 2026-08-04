/**
 * The two bugs reported from real use, checked against real photos of one car.
 *
 *   1. A single car being split into six.
 *   2. Wheels being matched to interiors.
 *
 * The fixtures are one car shot over a morning. Timestamps are synthesised here
 * because the upload path strips EXIF, but the *shape* is what a real session
 * looks like: many short bursts spread across the job, not two tidy ones.
 *
 * Run:  node test/samecar.mjs
 */
import { launchBrowser, startServer } from './lib/harness.mjs'
import { existsSync, readdirSync } from 'node:fs'

const PORT = 4327
const DIR = new URL('./fixtures/samecar/', import.meta.url).pathname

/* The fixtures are the user's own photographs, plates and all, so they are
   gitignored — this suite only runs where they exist. */
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
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

const injected = await page.evaluate(async (files) => {
  const MIN = 60_000
  const t0 = new Date('2026-05-10T09:00:00Z').getTime()
  const out = []

  /* One car, photographed across a five-hour job in many separate bursts —
     the shape that used to shatter into six cars. Lower IMG numbers are the
     before pass, higher ones the after pass. */
  const offsets = [0, 6, 13, 190, 205, 218, 240, 262]

  for (let i = 0; i < files.length; i++) {
    const res = await fetch(`/test/fixtures/samecar/${files[i]}`)
    if (!res.ok) throw new Error(`${files[i]} ${res.status}`)
    out.push(
      new File([await res.blob()], files[i], {
        type: 'image/jpeg',
        lastModified: t0 + offsets[i % offsets.length] * MIN,
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

console.log(`${injected} photos of one car, spread over ~4.4 hours\n`)
await page.waitForSelector('[data-view=cars]', { timeout: 120000 })
await page.waitForTimeout(500)

console.log('[1] One car stays one car')
const carCount = await page.locator('[data-view=cars] .card').count()
check('grouped into a single car', carCount === 1, `${carCount} car(s)`)

console.log('\n[2] Pairs are the same subject')
const pairs = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pair-row')]
  return rows.map((r) => {
    const imgs = r.querySelectorAll('img[data-photo]')
    return { before: imgs[0]?.dataset.photo, after: imgs[1]?.dataset.photo }
  })
})

await page.click('[data-view=cars] .btn.primary')
await page.waitForSelector('[data-view=pairs]')
await page.waitForTimeout(300)

const suggested = []
let guard = 0
while ((await page.locator('[data-testid=review-images]').count()) > 0 && guard++ < 40) {
  const shown = await page.evaluate(() => {
    const imgs = document.querySelectorAll('[data-testid=review-images] img')
    return { pct: document.querySelector('.match .mono')?.textContent }
  })
  await page.click('[data-testid=confirm]')
  await page.waitForTimeout(120)
}
const confirmed = await page.evaluate(() =>
  [...document.querySelectorAll('.pair-row')].map((r) => {
    const imgs = r.querySelectorAll('img[data-photo]')
    return { before: imgs[0]?.dataset.photo, after: imgs[1]?.dataset.photo }
  }),
)

console.log(`  proposed ${confirmed.length} pair(s):`)
for (const p of confirmed) console.log(`    ${p.before}  →  ${p.after}`)

/* Ground truth, established by looking at every photo in the set:
 *   7986 exterior dirty  -> 8011 exterior clean
 *   7993 wheel dirty     -> 8009 wheel clean
 *   7996 trunk dirty     -> 8006 trunk clean
 *   8003, 8005           -> centre-console shots with no partner
 *
 * This is the case that used to produce wheel-to-console matches. */
const TRUTH = { 7986: 8011, 7993: 8009, 7996: 8006 }
const NO_PARTNER = ['8003', '8005']

const num = (n) => n?.match(/IMG_(\d+)/)?.[1]

for (const [before, after] of Object.entries(TRUTH)) {
  const got = confirmed.find((p) => num(p.before) === before)
  check(
    `${before} pairs with ${after}`,
    got && num(got.after) === String(after),
    got ? `got ${num(got.after)}` : 'not proposed',
  )
}

const strays = confirmed.filter(
  (p) => NO_PARTNER.includes(num(p.before)) || NO_PARTNER.includes(num(p.after)),
)
check(
  'the console shots are left unpaired',
  strays.length === 0,
  strays.length ? strays.map((p) => `${num(p.before)}→${num(p.after)}`).join(', ') : 'clean',
)

check('exactly three pairs proposed', confirmed.length === 3, `${confirmed.length}`)

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
