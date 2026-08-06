/**
 * The labelling loop, end to end.
 *
 * Two things are being asserted, and the second matters more than the first.
 *
 * **That judgements are recorded without being asked for.** Confirming a
 * suggestion and rejecting one are the two things anybody does hundreds of times
 * a day, and each one is a labelled example. If that capture silently stops
 * working, nothing visibly breaks — no error, no missing feature, just an empty
 * log where the training data should have been, discovered weeks later.
 *
 * **That the export contains measurements and nothing else.** The whole reason
 * the export is safe to send to someone is that it holds component scores rather
 * than pixels. That is a promise made in the interface, so it is checked here
 * against the actual bytes: no data URLs, no blobs, no base64, nothing that
 * could reconstruct a photograph of somebody's car.
 *
 * Run:  node test/lab.mjs
 */
import { launchBrowser, startServer } from './lib/harness.mjs'

const PORT = 4333

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

const injected = await page.evaluate(async () => {
  const { drawToBlob } = await import('/test/lib/roll.js')
  const MIN = 60_000
  const t0 = new Date('2026-04-01T09:00:00Z').getTime()
  const files = []

  for (let car = 1; car <= 2; car++) {
    const start = t0 + car * 6 * 60 * MIN
    for (let a = 1; a <= 3; a++) {
      files.push(
        new File([await drawToBlob({ car, angle: a, dirty: true })], `car${car}_b${a}.jpg`, {
          type: 'image/jpeg',
          lastModified: start + a * 2 * MIN,
        }),
      )
    }
    for (let a = 1; a <= 3; a++) {
      files.push(
        new File([await drawToBlob({ car, angle: a, dirty: false })], `car${car}_a${a}.jpg`, {
          type: 'image/jpeg',
          lastModified: start + 100 * MIN + a * 2 * MIN,
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

console.log(`${injected} photos, 2 cars\n`)
await page.waitForSelector('[data-view=cars]', { timeout: 120_000 })

console.log('[1] The lab is reachable and starts empty')
await page.click('[data-testid=lab-open]')
await page.waitForSelector('[data-view=lab]')
await page.waitForTimeout(400)

const initial = await page.locator('[data-testid=lab-stats] .stat-num').first().innerText()
check('no judgements before any are made', initial.trim() === '0', initial.trim())

console.log('\n[2] Judging in the lab records a verdict')
const hadQuestion = (await page.locator('[data-testid=lab-pair]').count()) > 0
check('the lab found something worth asking about', hadQuestion)

if (hadQuestion) {
  await page.click('[data-testid=lab-yes]')
  await page.waitForTimeout(400)
  await page.click('[data-testid=lab-no]')
  await page.waitForTimeout(400)

  const count = await page.locator('[data-testid=lab-stats] .stat-num').first().innerText()
  check('two judgements recorded', count.trim() === '2', count.trim())

  const yesNo = await page.locator('[data-testid=lab-stats] .stat-num').nth(1).innerText()
  check('split as one yes and one no', yesNo.replace(/\s/g, '') === '1/1', yesNo)
}

console.log('\n[3] Confirming and rejecting while pairing records verdicts too')
/* The point of the whole exercise: the user never opens the lab, and the
   labels accumulate anyway. */
await page.click('[data-step=pairs]')
await page.waitForSelector('[data-view=pairs]')
await page.waitForTimeout(300)

let confirms = 0
let rejects = 0
for (let i = 0; i < 6; i++) {
  if ((await page.locator('[data-testid=review-images]').count()) === 0) break
  if (i === 0 && (await page.locator('[data-testid=reject]').count()) > 0) {
    await page.click('[data-testid=reject]')
    rejects++
  } else {
    await page.click('[data-testid=confirm]')
    confirms++
  }
  await page.waitForTimeout(200)
}
console.log(`  drove ${confirms} confirm(s) and ${rejects} rejection(s)`)

await page.click('[data-testid=lab-open]')
await page.waitForSelector('[data-view=lab]')
await page.waitForTimeout(500)
await page.click('.lab-tabs .btn:nth-child(2)')
await page.waitForTimeout(300)

const rows = await page.locator('[data-testid=label-row]').count()
check(
  'the pairing screen added labels of its own',
  rows >= 2 + confirms + rejects,
  `${rows} row(s) for ${2 + confirms + rejects} judgement(s)`,
)

const sources = await page.locator('.lab-log .label-row .source').allInnerTexts()
check('confirmations are attributed', !confirms || sources.includes('confirm'), sources.join(','))
check('lab judgements are attributed', sources.includes('lab'))

console.log('\n[4] The export holds measurements, and no image data')
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('.lab-export .btn.primary'),
])
const stream = await download.createReadStream()
const chunks = []
for await (const c of stream) chunks.push(c)
const raw = Buffer.concat(chunks).toString('utf8')

let parsed = null
try {
  parsed = JSON.parse(raw)
} catch (e) {
  check('export is valid JSON', false, e.message)
}

if (parsed) {
  check('export is valid JSON', true, `${(raw.length / 1024).toFixed(1)} KB`)
  check(
    'every judgement is in it',
    parsed.labels.length === parsed.count && parsed.count >= 2,
    `${parsed.count}`,
  )
  check('it says which app version measured them', Boolean(parsed.appVersion))
  check('it says which descriptor schema was in force', typeof parsed.descriptorSchema === 'number')

  const first = parsed.labels[0]
  const terms = ['color', 'edge', 'hash', 'coarse', 'fine', 'chroma', 'inliers']
  check(
    'each label carries every component the fit consumes',
    terms.every((t) => typeof first?.components?.[t] === 'number'),
    terms.filter((t) => typeof first?.components?.[t] !== 'number').join(', ') || 'all present',
  )
  check('each label carries a verdict', ['yes', 'no'].includes(first?.verdict), first?.verdict)
  check('each label carries the gap between the shots', typeof first?.gapSeconds === 'number')

  /* The privacy promise, checked against the bytes rather than the intent. */
  check('no data URLs in the export', !/data:image/i.test(raw))
  check('no blob URLs in the export', !/blob:/i.test(raw))
  const longRuns = raw.match(/[A-Za-z0-9+/]{300,}={0,2}/g) ?? []
  check('no base64 payload smuggled in', longRuns.length === 0, `${longRuns.length} suspicious run(s)`)
  check(
    'export is small enough to send',
    raw.length / parsed.count < 2000,
    `${Math.round(raw.length / parsed.count)} bytes per judgement`,
  )
}

console.log('\n[5] Labels survive a reload')
await page.reload()
await page.waitForSelector('[data-view=cars], [data-view=import]', { timeout: 120_000 })
await page.click('[data-testid=lab-open]')
await page.waitForSelector('[data-view=lab]')
await page.waitForTimeout(600)
const afterReload = await page.locator('[data-testid=lab-stats] .stat-num').first().innerText()
check(
  'judgements are still there after a reload',
  Number(afterReload.trim()) === parsed?.count,
  `${afterReload.trim()} of ${parsed?.count}`,
)

console.log('\n[6] Agreement is reported')
const agreementText = await page
  .locator('[data-testid=lab-stats] .stat')
  .nth(2)
  .innerText()
check(
  'the matcher reports how often it agrees with the user',
  /%/.test(agreementText),
  agreementText.replace(/\n/g, ' '),
)

console.log('\n[7] Console health')
check('no page errors', pageErrors.length === 0, pageErrors.join('; ') || 'clean')

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
