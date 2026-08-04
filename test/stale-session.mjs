/**
 * Reopening a session that an older build saved.
 *
 * This is the bug behind "I don't really see much change between when we first
 * started and now" — and it is the one failure mode that every other test in
 * this repo was structurally unable to catch, because they all start from a
 * fresh import.
 *
 * A saved session stores the fingerprints computed at import time. Load it into
 * a newer build and the new matcher runs over the old numbers: photos with no
 * colour or edge histogram fall back to the superseded weighting, and pairs
 * saved before runners-up existed have none, so "not a pair" still just deletes
 * the suggestion instead of offering the next candidate. Both reported symptoms.
 *
 * So this imports normally, corrupts the stored session into what an old build
 * would have written — strips the newer fields, drops the schema version —
 * reloads, and checks the app notices and rebuilds rather than quietly behaving
 * like the old version.
 *
 * Run:  node test/stale-session.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { MINUTES } from './lib/samecar-truth.mjs'

const PORT = 4337
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
// The session is written on a debounce; give it room.
await page.waitForTimeout(2000)

console.log('[1] A fresh import saves a versioned session')
const savedSchema = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('unbklok')
      req.onsuccess = () => {
        const db = req.result
        const get = db.transaction('meta', 'readonly').objectStore('meta').get('session')
        get.onsuccess = () => resolve(get.result?.schema ?? null)
        get.onerror = () => resolve(null)
      }
      req.onerror = () => resolve(null)
    }),
)
check('the stored session carries a schema version', typeof savedSchema === 'number', `${savedSchema}`)

console.log('\n[2] Rewrite it the way an older build would have')
const damage = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('unbklok')
      req.onsuccess = () => {
        const db = req.result
        const store = db.transaction('meta', 'readwrite').objectStore('meta')
        const get = store.get('session')
        get.onsuccess = () => {
          const s = get.result
          if (!s) return resolve(null)
          // Exactly what an older build wrote: no version, no new descriptors,
          // and pairs with no runners-up.
          delete s.schema
          for (const p of s.photos) {
            delete p.colorHist
            delete p.edgeHist
            delete p.quality
          }
          let pairCount = 0
          for (const g of s.groups) {
            for (const pair of g.pairs) {
              delete pair.runnersUp
              delete pair.beforeAlternates
              delete pair.afterAlternates
              pairCount++
            }
          }
          const put = store.put(s, 'session')
          put.onsuccess = () =>
            resolve({ photos: s.photos.length, pairs: pairCount, groups: s.groups.length })
          put.onerror = () => resolve(null)
        }
      }
    }),
)
check('the session was downgraded', damage !== null, damage && `${damage.photos} photos, ${damage.pairs} pairs`)

console.log('\n[3] Reopening notices and rebuilds')
await page.reload()
await page.waitForSelector('[data-view=cars]', { timeout: 120000 })
await page.waitForTimeout(1200)

const toast = await page.evaluate(() => document.querySelector('.toast')?.innerText ?? '')
check(
  'it says the session was re-matched',
  /re-matched|improved/i.test(toast),
  toast.replace(/\n/g, ' ') || 'no toast',
)

const restoredPhotos = await page.locator('[data-view=cars] .thumb').count()
check('every photo came back', restoredPhotos === names.length, `${restoredPhotos}`)

const rebuilt = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('unbklok')
      req.onsuccess = () => {
        const db = req.result
        const get = db.transaction('meta', 'readonly').objectStore('meta').get('session')
        get.onsuccess = () => {
          const s = get.result
          resolve({
            schema: s?.schema ?? null,
            withHist: s?.photos?.filter((p) => p.colorHist && p.edgeHist).length ?? 0,
            photos: s?.photos?.length ?? 0,
            withRunners: (s?.groups ?? []).flatMap((g) => g.pairs).filter((p) => p.runnersUp)
              .length,
            pairs: (s?.groups ?? []).flatMap((g) => g.pairs).length,
          })
        }
      }
    }),
)
check(
  'the fingerprints were recomputed, not carried over',
  rebuilt.withHist === rebuilt.photos && rebuilt.photos > 0,
  `${rebuilt.withHist} of ${rebuilt.photos} have the current descriptors`,
)
check(
  'the session is saved at the current version again',
  rebuilt.schema === savedSchema,
  `${rebuilt.schema}`,
)

console.log('\n[4] The rebuilt suggestions have their runners-up')
check(
  'pairs carry the next-best candidates',
  rebuilt.withRunners > 0,
  `${rebuilt.withRunners} of ${rebuilt.pairs} pairs`,
)

await page.click('[data-view=cars] .btn.primary')
await page.waitForSelector('[data-view=pairs]')
await page.waitForTimeout(400)
const rejectLabel = await page.evaluate(
  () => document.querySelector('[data-testid=reject]')?.innerText.trim() ?? '',
)
check(
  '"not a pair" offers another candidate after the rebuild',
  rejectLabel === 'Try another',
  `button reads "${rejectLabel}"`,
)

console.log('\n[5] Console health')
check('no page errors', pageErrors.length === 0, pageErrors.join('; ') || 'clean')

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
