/**
 * Threshold diagnostics.
 *
 * Measures how far apart the interesting categories actually are, so the
 * clustering thresholds get set from evidence instead of taste:
 *
 *   TRUE PAIR      same car, same angle, before vs after   — must match
 *   SAME CAR       same car, different angle               — must not pair
 *   CROSS CAR      different car, same angle               — must not group
 *
 * Run:  node test/diagnose.mjs
 */

import { launchBrowser, startServer } from './lib/harness.mjs'

const PORT = 4321
const BASE = `http://127.0.0.1:${PORT}`

const CONFIGS = [
  { label: 'normal colours', cars: 6, angles: 4, gapMinutes: 180, detailMinutes: 90, hueStep: 45 },
  {
    label: 'similar colours (silver)',
    cars: 6,
    angles: 4,
    gapMinutes: 180,
    detailMinutes: 90,
    hueStep: 4,
    saturation: 8,
  },
  {
    label: 'handheld drift',
    cars: 6,
    angles: 4,
    gapMinutes: 180,
    detailMinutes: 90,
    hueStep: 45,
    drift: true,
  },
]

function stats(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { min: s[0], p05: q(0.05), p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }
}

const fmt = (st, d = 1) =>
  st
    ? `min ${st.min.toFixed(d)}  p05 ${st.p05.toFixed(d)}  p50 ${st.p50.toFixed(d)}  p95 ${st.p95.toFixed(d)}  max ${st.max.toFixed(d)}`
    : 'n/a'

async function main() {
  const { proc: server } = await startServer(PORT, { mode: 'dev' })
  const browser = await launchBrowser()
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
  await page.goto(BASE)

  const report = await page.evaluate(async (configs) => {
    const { buildRoll } = await import('/test/lib/roll.js')
    const { hamming, chromaDistance, ncc } = await import('/src/lib/hash.ts')

    return configs.map((cfg) => {
      const { photos } = buildRoll(cfg)
      const meta = (p) => {
        const m = p.name.match(/^car(\d+)_(before|after)_(\d+)$/)
        return m ? { car: m[1], kind: m[2], angle: m[3] } : null
      }

      const buckets = {
        truePair: { hash: [], chroma: [], ncc: [] },
        sameCar: { hash: [], chroma: [], ncc: [] },
        crossCarSameAngle: { hash: [], chroma: [], ncc: [] },
        crossCarOther: { hash: [], chroma: [], ncc: [] },
      }

      for (let i = 0; i < photos.length; i++) {
        for (let j = i + 1; j < photos.length; j++) {
          const a = meta(photos[i])
          const b = meta(photos[j])
          if (!a || !b) continue
          const h = hamming(photos[i].dhash, photos[j].dhash)
          const c = chromaDistance(photos[i].chromaSig, photos[j].chromaSig)
          const nc = ncc(photos[i].lumaGrid, photos[j].lumaGrid)

          let bucket
          if (a.car === b.car && a.angle === b.angle && a.kind !== b.kind) bucket = 'truePair'
          else if (a.car === b.car) bucket = 'sameCar'
          else if (a.angle === b.angle) bucket = 'crossCarSameAngle'
          else bucket = 'crossCarOther'

          buckets[bucket].hash.push(h)
          buckets[bucket].chroma.push(c)
          buckets[bucket].ncc.push(nc)
        }
      }
      return { label: cfg.label, buckets }
    })
  }, CONFIGS)

  await browser.close()
  server.kill('SIGTERM')

  for (const r of report) {
    console.log('\n' + '='.repeat(76))
    console.log(r.label.toUpperCase())
    console.log('='.repeat(76))
    for (const [name, data] of Object.entries(r.buckets)) {
      console.log(`\n  ${name}  (n=${data.hash.length})`)
      console.log(`    ncc     : ${fmt(stats(data.ncc), 3)}`)
      console.log(`    chroma  : ${fmt(stats(data.chroma), 3)}`)
      console.log(`    hamming : ${fmt(stats(data.hash), 1)}`)
    }
  }
  console.log('')
}

main()
