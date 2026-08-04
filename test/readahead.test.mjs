/**
 * The import read-ahead.
 *
 * Reported as: "when I just did a ton of photos, it takes a super long time. I
 * don't know if that's because all my photos are, like, stored on the cloud."
 *
 * That is almost certainly what it is. A photo held in iCloud rather than on the
 * phone has to be downloaded before its bytes can be read, and the import used
 * to do that strictly one at a time — then read each file a *second* time to
 * parse its EXIF. Two serial round trips per photo, times a hundred and fifty.
 *
 * The claim being tested is that reads now overlap. It can't be tested against
 * iCloud from here, so the latency is simulated: files whose bytes take a fixed
 * time to arrive. If reads were still serial the run would take n × delay; with
 * a look-ahead of k it should take roughly (n / k) × delay.
 *
 * Run:  node test/readahead.test.mjs
 */
import { launchBrowser, startServer } from './lib/harness.mjs'

const PORT = 4331
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

const out = await page.evaluate(async () => {
  const { readAhead } = await import('/src/lib/ingest.ts')

  const DELAY = 50
  const COUNT = 12

  /** A stand-in for a file that has to come down from iCloud first. */
  function slowFile(name, { fail = false } = {}) {
    let started = null
    return {
      name,
      get startedAt() {
        return started
      },
      arrayBuffer() {
        started = performance.now()
        return new Promise((resolve, reject) =>
          setTimeout(
            () => (fail ? reject(new Error('offline')) : resolve(new ArrayBuffer(8))),
            DELAY,
          ),
        )
      },
    }
  }

  /* Order and completeness: every file comes back, in the order given. */
  const files = Array.from({ length: COUNT }, (_, i) => slowFile(`p${i}.jpg`))
  const seen = []
  const t0 = performance.now()
  for await (const item of readAhead(files)) {
    seen.push({ name: item.file.name, bytes: item.bytes ? item.bytes.byteLength : null })
    // Stand in for the decode work that happens between yields.
    await new Promise((r) => setTimeout(r, DELAY))
  }
  const elapsed = performance.now() - t0

  /* How far ahead reads actually got: the number of files whose read had
     already started by the time the first one was handed over. */
  const probe = Array.from({ length: COUNT }, (_, i) => slowFile(`q${i}.jpg`))
  const it = readAhead(probe)
  await it.next()
  const inFlight = probe.filter((f) => f.startedAt !== null).length
  await it.return?.()

  /* A read that fails must not take the rest of the import down with it. */
  const mixed = [slowFile('ok1.jpg'), slowFile('bad.jpg', { fail: true }), slowFile('ok2.jpg')]
  const mixedSeen = []
  for await (const item of readAhead(mixed)) {
    mixedSeen.push({ name: item.file.name, ok: item.bytes !== null, error: !!item.error })
  }

  return { DELAY, COUNT, seen, elapsed, inFlight, mixedSeen }
})

console.log(`\n${out.COUNT} files, ${out.DELAY}ms to read each, ${out.DELAY}ms of work between\n`)

console.log('[1] Nothing is lost or reordered')
check('every file came back', out.seen.length === out.COUNT, `${out.seen.length}`)
check(
  'in the order they were given',
  out.seen.every((s, i) => s.name === `p${i}.jpg`),
)
check(
  'each with its bytes',
  out.seen.every((s) => s.bytes === 8),
)

console.log('\n[2] Reads overlap the work between them')
check(
  'more than one read is in flight at a time',
  out.inFlight > 1,
  `${out.inFlight} started before the first was handed over`,
)
/* Serial would be COUNT × (read + work) = 24 × DELAY. Overlapped, the reads
   hide behind the work and it approaches COUNT × work = 12 × DELAY. The bar is
   set loosely because timers on a busy CI runner are not precise. */
const serial = out.COUNT * out.DELAY * 2
check(
  'the run is meaningfully faster than reading serially',
  out.elapsed < serial * 0.75,
  `${Math.round(out.elapsed)}ms vs ${serial}ms serial`,
)

console.log('\n[3] One unreadable file does not sink the import')
check('all three were yielded', out.mixedSeen.length === 3)
check(
  'the good ones carry their bytes',
  out.mixedSeen[0]?.ok === true && out.mixedSeen[2]?.ok === true,
)
check(
  'the bad one is reported rather than thrown',
  out.mixedSeen[1]?.ok === false && out.mixedSeen[1]?.error === true,
)

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
