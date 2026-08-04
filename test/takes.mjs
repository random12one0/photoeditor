/**
 * Three shots of one angle, one shot of the other.
 *
 * Reported as: "I take maybe three pictures of kinda the same angle... I
 * usually only take one after photo, but I take a lot of befores. So it kinda
 * just has to pick one of them. I don't know how it's gonna do that. Maybe it's
 * just gonna be random."
 *
 * It must not be random. This builds that exact situation out of real
 * photographs — each before shot duplicated into a burst of three, one of which
 * is visibly out of focus — and asserts three things:
 *
 *   1. The burst collapses. One pair per angle, not three near-identical ones.
 *   2. The sharp shot wins. Never the defocused one.
 *   3. The rejects are still reachable, offered on the pair and exported.
 *
 * Run:  node test/takes.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'

const PORT = 4329
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
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

const built = await page.evaluate(async (files) => {
  const MIN = 60_000
  const t0 = new Date('2026-05-10T09:00:00Z').getTime()

  /* The before pass is IMG_79xx, the after pass IMG_80xx, four hours later —
     the way the photos are actually taken: every before first, the detail, then
     every after. */
  const befores = files.filter((f) => /IMG_79/.test(f))
  const afters = files.filter((f) => /IMG_80/.test(f))

  async function bitmapOf(name) {
    const res = await fetch(`/test/fixtures/samecar/${name}`)
    if (!res.ok) throw new Error(`${name} ${res.status}`)
    return createImageBitmap(await res.blob(), { imageOrientation: 'from-image' })
  }

  /** Re-encode a bitmap, optionally softened and nudged as a handheld re-take. */
  async function variant(bitmap, { blur = 0, dx = 0, dy = 0 }) {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')
    if (blur) ctx.filter = `blur(${blur}px)`
    ctx.drawImage(bitmap, dx, dy, bitmap.width * 1.01, bitmap.height * 1.01)
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  }

  const out = []
  const expected = []

  for (let i = 0; i < befores.length; i++) {
    const bitmap = await bitmapOf(befores[i])
    const base = t0 + i * 3 * MIN
    const stem = befores[i].replace(/\.jpe?g$/i, '')

    /* A burst of three: a slightly soft first attempt, the keeper, and a badly
       defocused one. Deliberately ordered so neither "first" nor "last" is the
       right answer — only "sharpest" is. */
    const takes = [
      { tag: 'soft', blur: 1.4, dx: 6, dy: -3 },
      { tag: 'sharp', blur: 0, dx: 0, dy: 0 },
      { tag: 'blurred', blur: 3.2, dx: -5, dy: 4 },
    ]
    for (let t = 0; t < takes.length; t++) {
      const blob = await variant(bitmap, takes[t])
      out.push(
        new File([blob], `${stem}_${takes[t].tag}.jpg`, {
          type: 'image/jpeg',
          lastModified: base + t * 20_000,
        }),
      )
    }
    expected.push(`${stem}_sharp.jpg`)
    bitmap.close()
  }

  // The after pass: one shot each, four hours later.
  for (let i = 0; i < afters.length; i++) {
    const res = await fetch(`/test/fixtures/samecar/${afters[i]}`)
    if (!res.ok) throw new Error(`${afters[i]} ${res.status}`)
    out.push(
      new File([await res.blob()], afters[i], {
        type: 'image/jpeg',
        lastModified: t0 + (240 + i * 3) * MIN,
      }),
    )
  }

  const input = document.querySelector('input[type=file]')
  const dt = new DataTransfer()
  out.forEach((f) => dt.items.add(f))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))

  return { total: out.length, bursts: befores.length, expected }
}, names)

console.log(
  `${built.total} photos — ${built.bursts} before angles shot 3× each, ${built.total - built.bursts * 3} single afters\n`,
)
await page.waitForSelector('[data-view=cars]', { timeout: 180000 })
await page.waitForTimeout(500)

console.log('[1] The job holds together')
const carCount = await page.locator('[data-view=cars] .card').count()
check('one car despite the four-hour job gap', carCount === 1, `${carCount} car(s)`)

await page.click('[data-view=cars] .btn.primary')
await page.waitForSelector('[data-view=pairs]')
await page.waitForTimeout(400)

console.log('\n[2] Bursts collapse to one pair per angle')
const suggested = await page.evaluate(() => {
  const el = document.querySelector('[data-testid=review-images]')
  return el ? [...el.querySelectorAll('figure > img')].length : 0
})
check('a pair is being offered', suggested === 2, `${suggested} images on the card`)

console.log('\n[3] Tapping another take swaps it in')
const mainBefore = () =>
  page.evaluate(
    () =>
      document.querySelector('[data-testid=review-images] figure img')?.getAttribute('src') ??
      null,
  )
const startSrc = await mainBefore()
const otherTake = page.locator('[data-testid=takes-before] .take:not(.picked)').first()
const otherName = await otherTake.getAttribute('data-photo')
await otherTake.click()
await page.waitForTimeout(200)
const swappedSrc = await mainBefore()
check('the shown photo changed', swappedSrc !== startSrc, `now ${otherName}`)
check(
  'the tapped take is now the pick',
  await page
    .locator('[data-testid=takes-before] .take.picked')
    .first()
    .evaluate((el) => el.getAttribute('data-photo'))
    .then((n) => n === otherName),
)
check(
  'still exactly three takes offered',
  (await page.locator('[data-testid=takes-before] .take').count()) === 3,
)
// Put the sharp one back, so the rest of the run tests the automatic choice.
await page.locator(`[data-testid=takes-before] .take[data-photo$="_sharp.jpg"]`).click()
await page.waitForTimeout(200)
check('tapping back restores the original pick', (await mainBefore()) === startSrc)

console.log('\n[4] Pairs and their takes')
// Walk the queue, recording each pair and the takes offered alongside it.
const seen = []
let guard = 0
while ((await page.locator('[data-testid=review-images]').count()) > 0 && guard++ < 40) {
  seen.push(
    await page.evaluate(() => {
      const strip = (side) =>
        [...document.querySelectorAll(`[data-testid=takes-${side}] .take`)].map((b) => ({
          name: b.getAttribute('data-photo'),
          picked: b.classList.contains('picked'),
        }))
      return { beforeTakes: strip('before'), afterTakes: strip('after') }
    }),
  )
  await page.click('[data-testid=confirm]')
  await page.waitForTimeout(120)
}

const confirmed = await page.evaluate(() =>
  [...document.querySelectorAll('.pair-row')].map((r) => {
    const imgs = r.querySelectorAll('img[data-photo]')
    return { before: imgs[0]?.dataset.photo, after: imgs[1]?.dataset.photo }
  }),
)

console.log(`  ${confirmed.length} pair(s):`)
for (const p of confirmed) console.log(`    ${p.before}  →  ${p.after}`)

check(
  'one pair per before angle, not three',
  confirmed.length === built.bursts,
  `${confirmed.length} of ${built.bursts}`,
)

console.log('\n[5] The sharp take is the one that got picked')
const blurredUsed = confirmed.filter((p) => /_blurred|_soft/.test(p.before ?? ''))
check(
  'no soft or defocused shot used in a pair',
  blurredUsed.length === 0,
  blurredUsed.length ? blurredUsed.map((p) => p.before).join(', ') : 'all sharp',
)
for (const want of built.expected) {
  check(`${want} was chosen`, confirmed.some((p) => p.before === want))
}

console.log('\n[6] The rejected takes are still offered')
const strips = seen.filter((s) => s.beforeTakes.length > 0)
check(
  'every pair showed its other takes',
  strips.length === seen.length && seen.length > 0,
  `${strips.length} of ${seen.length}`,
)
check(
  'three takes offered per before',
  strips.every((s) => s.beforeTakes.length === 3),
  strips.map((s) => s.beforeTakes.length).join(', '),
)
check(
  'exactly one is marked as the pick',
  strips.every((s) => s.beforeTakes.filter((t) => t.picked).length === 1),
)
check(
  'the after has no alternates to offer',
  seen.every((s) => s.afterTakes.length === 0),
)

console.log('\n[7] Nothing was thrown away')
const leftover = await page.evaluate(
  () => document.querySelectorAll('.thumb-grid .thumb').length,
)
/* Two rejected takes per before angle, plus the after shots that genuinely have
   no partner — in this set the two centre-console photos. */
const unusedTakes = built.bursts * 2
const unpairedAfters = built.total - built.bursts * 3 - confirmed.length
check(
  'the unused takes are still there to hand-pair or export',
  leftover === unusedTakes + unpairedAfters,
  `${leftover} left over = ${unusedTakes} rejected takes + ${unpairedAfters} afters with no partner`,
)

console.log('\n[8] Console health')
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
check('no page errors', errors.length === 0, errors.join('; ') || 'clean')

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
