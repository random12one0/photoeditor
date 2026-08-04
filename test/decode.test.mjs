/**
 * Decoding straight to proxy size.
 *
 * Importing a hundred phone photos spends most of its CPU in one place:
 * building a full-resolution bitmap of each one and immediately shrinking it.
 * Given the dimensions out of the EXIF header the decoder can scale during the
 * decode instead, which is close to free for JPEG.
 *
 * The risk is entirely about correctness, and it needs its own test because the
 * real-photo suites cannot cover it — their fixtures have been through an
 * upload and carry no EXIF at all, so they always take the slow path.
 *
 * Two things must hold no matter what the header says, including when it lies:
 * the proxy is never stretched, and a portrait photo is still reported as
 * portrait. Only one axis is ever constrained, so the browser preserves the
 * aspect ratio itself; a wrong hint can only cost some size.
 *
 * Run:  node test/decode.test.mjs
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
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await page.goto(`http://127.0.0.1:${PORT}`)

const out = await page.evaluate(async () => {
  const { decodeToProxy, PROXY_MAX_EDGE, extractGrid } = await import('/src/lib/imaging.ts')
  const { lumaGridFromImageData, ncc, LUMA_GRID } = await import('/src/lib/hash.ts')

  /** A picture with obvious structure, so a flip or a stretch shows up. */
  async function makeJpeg(w, h) {
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#222'
    ctx.fillRect(0, 0, w, h)
    // Asymmetric in both axes: a bright wedge in one corner, bars down one side.
    ctx.fillStyle = '#eee'
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(w * 0.45, 0)
    ctx.lineTo(0, h * 0.7)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#9a9'
    for (let i = 0; i < 6; i++) ctx.fillRect(w * 0.6, h * (0.1 + i * 0.14), w * 0.3, h * 0.07)
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  }

  const gridOf = (bitmap) =>
    lumaGridFromImageData(extractGrid(bitmap, LUMA_GRID, LUMA_GRID, 'measure'))

  async function compare(w, h, hint) {
    const blob = await makeJpeg(w, h)
    const plain = await decodeToProxy(blob)
    const hinted = await decodeToProxy(blob, hint)
    const result = {
      plain: { w: plain.bitmap.width, h: plain.bitmap.height, rw: plain.width, rh: plain.height },
      hinted: {
        w: hinted.bitmap.width,
        h: hinted.bitmap.height,
        rw: hinted.width,
        rh: hinted.height,
      },
      // 1.0 means the two proxies show the same picture.
      match: ncc(gridOf(plain.bitmap), gridOf(hinted.bitmap)),
    }
    plain.bitmap.close()
    hinted.bitmap.close()
    return result
  }

  /* Timing on a 12MP frame, the size a phone actually produces. Both paths run
     the same number of times, alternating, so a warm-up or a background task
     can't land entirely on one of them. */
  async function bench(rounds) {
    const blob = await makeJpeg(4032, 3024)
    const hint = { width: 4032, height: 3024 }
    let plainMs = 0
    let hintedMs = 0
    for (let i = 0; i < rounds; i++) {
      let t = performance.now()
      const a = await decodeToProxy(blob)
      plainMs += performance.now() - t
      a.bitmap.close()

      t = performance.now()
      const b = await decodeToProxy(blob, hint)
      hintedMs += performance.now() - t
      b.bitmap.close()
    }
    return { rounds, plainMs: plainMs / rounds, hintedMs: hintedMs / rounds }
  }

  return {
    PROXY_MAX_EDGE,
    landscape: await compare(3000, 2000, { width: 3000, height: 2000 }),
    portrait: await compare(2000, 3000, { width: 2000, height: 3000 }),
    // A rotated photo lists its dimensions unswapped in the header.
    liedTo: await compare(3000, 2000, { width: 2000, height: 3000 }),
    small: await compare(800, 600, { width: 800, height: 600 }),
    timing: await bench(8),
  }
})

const EDGE = out.PROXY_MAX_EDGE
const aspect = (o) => o.w / o.h
const near = (a, b, tol) => Math.abs(a - b) <= tol

console.log(`\nproxy long edge is ${EDGE}px\n`)

for (const [name, r] of Object.entries(out).filter(
  ([k]) => k !== 'PROXY_MAX_EDGE' && k !== 'timing',
)) {
  console.log(`[${name}]`)
  console.log(
    `  plain  ${r.plain.w}x${r.plain.h}  reports original ${r.plain.rw}x${r.plain.rh}`,
  )
  console.log(
    `  hinted ${r.hinted.w}x${r.hinted.h}  reports original ${r.hinted.rw}x${r.hinted.rh}`,
  )

  check(
    'the proxy is not stretched',
    near(aspect(r.hinted), aspect(r.plain), 0.02),
    `${aspect(r.hinted).toFixed(3)} vs ${aspect(r.plain).toFixed(3)}`,
  )
  check(
    'it is the same picture',
    r.match > 0.98,
    `correlation ${r.match.toFixed(4)}`,
  )
  check(
    'portrait is still portrait, landscape still landscape',
    r.hinted.rw >= r.hinted.rh === (r.plain.rw >= r.plain.rh),
    `${r.hinted.rw}x${r.hinted.rh}`,
  )
  check(
    'the reported original size is right',
    near(r.hinted.rw, r.plain.rw, 2) && near(r.hinted.rh, r.plain.rh, 2),
    `${r.hinted.rw}x${r.hinted.rh} vs ${r.plain.rw}x${r.plain.rh}`,
  )
  console.log('')
}

check(
  'a photo already smaller than the proxy is left alone',
  out.small.hinted.w === 800 && out.small.hinted.h === 600,
  `${out.small.hinted.w}x${out.small.hinted.h}`,
)
check(
  'a big photo really is scaled down to the proxy edge',
  Math.max(out.landscape.hinted.w, out.landscape.hinted.h) <= EDGE + 1,
  `${out.landscape.hinted.w}x${out.landscape.hinted.h}`,
)

const { plainMs, hintedMs, rounds } = out.timing
const saved = ((1 - hintedMs / plainMs) * 100).toFixed(0)
console.log(
  `\n12MP frame, mean of ${rounds}: full decode then shrink ${plainMs.toFixed(1)}ms, ` +
    `decode straight to size ${hintedMs.toFixed(1)}ms  (${saved}% saved)`,
)
console.log(
  '  A desktop number. The saving is the same shape on a phone and matters more there.',
)
/* Deliberately loose: this is a regression guard, not a benchmark. Whether the
   decoder can scale during decode is up to the browser, and the point is only
   that asking it to never costs more than not asking. */
check(
  'decoding straight to size is not slower',
  hintedMs <= plainMs * 1.1,
  `${hintedMs.toFixed(1)}ms vs ${plainMs.toFixed(1)}ms`,
)

await browser.close()
server.kill('SIGTERM')
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures ? 1 : 0)
