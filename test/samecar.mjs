/**
 * One car, one job, nine real photographs — the bug-report suite.
 *
 * It started as the two failures reported from real use:
 *
 *   1. A single car being split into six.
 *   2. Wheels being matched to interiors.
 *
 * It now also carries the interior case, which was reported next and which this
 * file previously got backwards: the two centre-console frames were recorded as
 * having no partner, and asserted to be left alone. They are a genuine pair —
 * the console dusty, then the console wiped — so the suite was demanding the
 * very failure it was meant to catch. Ground truth now lives in one place,
 * test/lib/samecar-truth.mjs, with what each frame actually shows.
 *
 * Timestamps are synthesised because the upload path strips EXIF, but the shape
 * is real: every before shot, four hours of work, every after shot.
 *
 * Run:  node test/samecar.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import {
  AFTER,
  BEFORE,
  INTERIOR,
  MINUTES,
  NO_PARTNER,
  PAIRS,
  SUBJECT,
  num,
} from './lib/samecar-truth.mjs'

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

const missing = [...BEFORE, ...AFTER].filter((n) => !names.some((f) => num(f) === n))
if (missing.length) {
  console.error(`Fixture set is incomplete — missing IMG_${missing.join(', IMG_')}`)
  process.exit(1)
}

const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

const injected = await page.evaluate(
  async ({ files, minutes }) => {
    const MIN = 60_000
    const t0 = new Date('2026-05-10T09:00:00Z').getTime()
    const out = []

    for (const name of files) {
      const key = name.match(/IMG_(\d+)/)?.[1]
      const res = await fetch(`/test/fixtures/samecar/${name}`)
      if (!res.ok) throw new Error(`${name} ${res.status}`)
      out.push(
        new File([await res.blob()], name, {
          type: 'image/jpeg',
          lastModified: t0 + minutes[key] * MIN,
        }),
      )
    }

    const input = document.querySelector('input[type=file]')
    const dt = new DataTransfer()
    out.forEach((f) => dt.items.add(f))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return out.length
  },
  { files: names, minutes: MINUTES },
)

const span = (Math.max(...Object.values(MINUTES)) / 60).toFixed(1)
console.log(`${injected} photos of one car over ${span} hours, four of them a job gap\n`)
await page.waitForSelector('[data-view=cars]', { timeout: 120000 })
await page.waitForTimeout(500)

console.log('[1] One car stays one car')
const carCount = await page.locator('[data-view=cars] .card').count()
check('grouped into a single car', carCount === 1, `${carCount} car(s)`)

console.log('\n[2] The before/after split lands on the job, not inside a pass')
await page.click('[data-view=cars] .btn.primary')
await page.waitForSelector('[data-view=pairs]')
await page.waitForTimeout(300)

let guard = 0
while ((await page.locator('[data-testid=review-images]').count()) > 0 && guard++ < 40) {
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
for (const p of confirmed) {
  const b = num(p.before)
  const a = num(p.after)
  const right = PAIRS[b] === Number(a)
  console.log(
    `    ${right ? '·' : '!'} ${b} ${SUBJECT[b] ?? ''}  →  ${a} ${SUBJECT[a] ?? ''}`,
  )
}

const wrongSide = confirmed.filter((p) => !BEFORE.includes(num(p.before)))
check(
  'every proposed before really is from the before pass',
  wrongSide.length === 0,
  wrongSide.map((p) => num(p.before)).join(', ') || 'clean',
)

console.log('\n[3] Every true pair is found, and none invented')
for (const [before, after] of Object.entries(PAIRS)) {
  const got = confirmed.find((p) => num(p.before) === before)
  check(
    `${before} ${SUBJECT[before]}  →  ${after} ${SUBJECT[after]}`,
    got && num(got.after) === String(after),
    got ? `got ${num(got.after)} ${SUBJECT[num(got.after)] ?? ''}` : 'not proposed',
  )
}

const strays = confirmed.filter(
  (p) => NO_PARTNER.includes(num(p.before)) || NO_PARTNER.includes(num(p.after)),
)
check(
  `the ${NO_PARTNER.length} shot with no partner is left alone`,
  strays.length === 0,
  strays.length ? strays.map((p) => `${num(p.before)}→${num(p.after)}`).join(', ') : 'clean',
)

check(
  `exactly ${Object.keys(PAIRS).length} pairs proposed`,
  confirmed.length === Object.keys(PAIRS).length,
  `${confirmed.length}`,
)

console.log('\n[4] The interior frames specifically')
/* Called out separately because they are the reported weak spot: dark, low
   contrast, and with none of the paint colour that separates one car from
   another. Whether the rest of the set works says nothing about these. */
const interiorPairs = Object.entries(PAIRS).filter(([b]) => INTERIOR.includes(b))
for (const [before, after] of interiorPairs) {
  const got = confirmed.find((p) => num(p.before) === before)
  check(
    `interior: ${before} → ${after}`,
    got && num(got.after) === String(after),
    got ? `got ${num(got.after)}` : 'not proposed',
  )
}
const interiorStray = confirmed.filter(
  (p) =>
    (INTERIOR.includes(num(p.before)) && !INTERIOR.includes(num(p.after))) ||
    (!INTERIOR.includes(num(p.before)) && INTERIOR.includes(num(p.after))),
)
check(
  'no interior married to an exterior',
  interiorStray.length === 0,
  interiorStray.map((p) => `${num(p.before)}→${num(p.after)}`).join(', ') || 'clean',
)

console.log('\n[5] Console health')
check('no page errors', pageErrors.length === 0, pageErrors.join('; ') || 'clean')

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
