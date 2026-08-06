/**
 * Fit the scoring weights to every real photograph available, not to one set.
 *
 * The blend in `similarity` was tuned on two sets of real photos, and a third
 * set — the user's exported collages — then broke it: a red Kia's rear bench
 * preferred that same Kia's *wheel* to its own after shot. That is the failure
 * originally reported from real use, finally reproducible.
 *
 * Rather than nudge a weight until that one case passes, this dumps every
 * pairwise component score across all three sets and searches the weight
 * simplex for the assignment that wins the most rows overall. Row wins, not
 * aggregate score: for each photo, does its true partner beat every impostor?
 * The assignment step can rescue a row that loses, which is exactly how a bad
 * weighting hides until the day the rescue is unavailable.
 *
 * The sets are graded, and the grading is deliberate. `photos` and `samecar`
 * are already solved, so their job is to veto: a weighting that trades them for
 * the collages has not learned anything, it has moved the problem. Only a
 * weighting that holds all three is worth shipping.
 *
 * Run:  node test/diagnose-weights.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { launchBrowser, startServer } from './lib/harness.mjs'
import { partnerOf } from './lib/collage-truth.mjs'
import { AFTER, BEFORE, PAIRS, num } from './lib/samecar-truth.mjs'

const PORT = 4332
const OUT = new URL('./output/', import.meta.url).pathname

/** Every fixture directory that exists, with how to read truth out of it. */
const SETS = []

const dir = (name) => new URL(`./fixtures/${name}/`, import.meta.url).pathname
const listing = (name, re) =>
  existsSync(dir(name)) ? readdirSync(dir(name)).filter((f) => re.test(f)).sort() : []

const collagePanels = listing('collages', /-(a|b)\.jpe?g$/i)
if (collagePanels.length) {
  SETS.push({
    name: 'collages',
    path: 'collages',
    files: collagePanels,
    /* Every panel queries every other panel: these are loose photos with no
       before/after structure to lean on. */
    queries: collagePanels.map((f) => ({
      query: f,
      truth: partnerOf(f),
      candidates: collagePanels.filter((g) => g !== f),
    })),
  })
}

const refPhotos = listing('photos', /^ref\d+_(before|after)\.jpe?g$/i)
if (refPhotos.length) {
  const befores = refPhotos.filter((f) => f.includes('_before'))
  const afters = refPhotos.filter((f) => f.includes('_after'))
  SETS.push({
    name: 'photos',
    path: 'photos',
    files: refPhotos,
    queries: befores.map((f) => ({
      query: f,
      truth: f.replace('_before', '_after'),
      candidates: afters,
    })),
  })
}

const sameCar = listing('samecar', /\.jpe?g$/i)
if (sameCar.length) {
  const befores = sameCar.filter((f) => BEFORE.includes(num(f)) && PAIRS[num(f)])
  const afters = sameCar.filter((f) => AFTER.includes(num(f)))
  SETS.push({
    name: 'samecar',
    path: 'samecar',
    files: sameCar,
    queries: befores.map((f) => ({
      query: f,
      truth: afters.find((g) => num(g) === String(PAIRS[num(f)])),
      candidates: afters,
    })),
  })
}

if (!SETS.length) {
  console.log('No real fixtures present — skipping. (Real photos, deliberately not committed.)')
  process.exit(0)
}

/* Fingerprinting all three sets takes a couple of minutes, and the search
   below gets re-run far more often than the pixels change. */
const CACHE = `${OUT}components.json`
const cached = process.argv.includes('--cached') && existsSync(CACHE)

const dumps = {}
if (cached) {
  Object.assign(dumps, JSON.parse(readFileSync(CACHE, 'utf8')).dumps)
  console.log('Using cached components (drop --cached to re-fingerprint).')
  for (const set of SETS) {
    console.log(`  ${set.name}: ${dumps[set.name].count} photos, ${set.queries.length} queries`)
  }
} else {
const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${PORT}`)
await page.waitForSelector('[data-view=import]')

console.log('Fingerprinting…')
for (const set of SETS) {
  dumps[set.name] = await page.evaluate(
    async ({ path, files }) => {
      const { ingestFiles } = await import('/src/lib/ingest.ts')
      const {
        COARSE_GRID,
        LUMA_GRID,
        chromaDistance,
        colorHistogramSimilarity,
        edgeHistogramSimilarity,
        hamming,
        shiftedNcc,
      } = await import('/src/lib/hash.ts')
      const { matchFeatures } = await import('/src/lib/features.ts')

      const blobs = []
      for (const name of files) {
        const res = await fetch(`/test/fixtures/${path}/${name}`)
        if (!res.ok) throw new Error(`${name} ${res.status}`)
        blobs.push(new File([await res.blob()], name, { type: 'image/jpeg' }))
      }
      const { photos } = await ingestFiles(blobs)
      const by = new Map(photos.map((p) => [p.name, p]))

      const comps = {}
      for (const a of photos) {
        comps[a.name] = {}
        for (const b of photos) {
          if (a.name === b.name) continue
          comps[a.name][b.name] = {
            color: colorHistogramSimilarity(a.colorHist, b.colorHist),
            edge: edgeHistogramSimilarity(a.edgeHist, b.edgeHist),
            hash: 1 - hamming(a.dhash, b.dhash) / 64,
            coarse: (shiftedNcc(a.lumaGridCoarse, b.lumaGridCoarse, COARSE_GRID, 2) + 1) / 2,
            fine: (shiftedNcc(a.lumaGrid, b.lumaGrid, LUMA_GRID, 3) + 1) / 2,
            chroma: 1 - chromaDistance(a.chromaSig, b.chromaSig),
            inliers:
              a.features && b.features ? matchFeatures(a.features, b.features).inliers : 0,
          }
        }
      }
      return { comps, count: by.size }
    },
    { path: set.path, files: set.files },
  )
  console.log(`  ${set.name}: ${dumps[set.name].count} photos, ${set.queries.length} queries`)
}

await browser.close()
server.kill('SIGTERM')

mkdirSync(OUT, { recursive: true })
writeFileSync(CACHE, JSON.stringify({ dumps, at: Date.now() }, null, 1))
console.log(`\nComponents written to test/output/components.json\n`)
}

/* ---------------------------------------------------------------------- */

const TERMS = ['color', 'edge', 'hash', 'coarse', 'fine', 'chroma']

/** Score one candidate under a weighting, plus the geometric bonus. */
const score = (c, w, bonus, minInliers) => {
  let s = 0
  for (const t of TERMS) s += (w[t] ?? 0) * c[t]
  return s + (c.inliers >= minInliers ? bonus : 0)
}

/**
 * Row wins and worst margin for a weighting.
 *
 * Margin is reported alongside the count because two weightings can win the
 * same rows with very different amounts of room to spare, and the one with
 * room is the one that survives the next car.
 */
function evaluate(w, bonus, minInliers) {
  const per = {}
  let wins = 0
  let total = 0
  let worst = Infinity
  const losses = []

  for (const set of SETS) {
    const comps = dumps[set.name].comps
    let setWins = 0
    for (const q of set.queries) {
      total++
      const ranked = q.candidates
        .filter((c) => c !== q.query)
        .map((c) => ({ name: c, s: score(comps[q.query][c], w, bonus, minInliers) }))
        .sort((a, b) => b.s - a.s)
      const truth = ranked.find((r) => r.name === q.truth)
      const best = ranked.find((r) => r.name !== q.truth)
      const margin = truth.s - (best?.s ?? -Infinity)
      if (margin > 0) {
        wins++
        setWins++
      } else {
        losses.push(`${set.name}:${q.query}→${ranked[0].name}`)
      }
      worst = Math.min(worst, margin)
    }
    per[set.name] = `${setWins}/${set.queries.length}`
  }
  return { wins, total, worst, per, losses }
}

const SHIP = { color: 0.48, edge: 0.4, hash: 0.12 }
const base = evaluate(SHIP, 0.3, 12)
console.log('Shipping weights (colour .48, edge .40, hash .12, orb +.30 @12):')
console.log(`  ${base.wins}/${base.total} rows  ${JSON.stringify(base.per)}  worst margin ${base.worst.toFixed(3)}`)
if (base.losses.length) console.log(`  loses: ${base.losses.join(', ')}`)

/* Search over the four terms that measured useful at all, in twentieths. The
   two luma grids are included because their exclusion was measured on sets
   that did not contain this failure, and that decision deserves re-testing
   rather than inheriting. */
console.log('\nSearching…')
const STEP = 0.05
const candidates = []
for (let color = 0; color <= 1.0001; color += STEP) {
  for (let edge = 0; edge <= 1.0001 - color; edge += STEP) {
    for (let hash = 0; hash <= 1.0001 - color - edge; hash += STEP) {
      for (let coarse = 0; coarse <= 1.0001 - color - edge - hash; coarse += STEP) {
        for (let chroma = 0; chroma <= 1.0001 - color - edge - hash - coarse; chroma += STEP) {
          const fine = 1 - color - edge - hash - coarse - chroma
          if (fine < -0.0001) continue
          const w = { color, edge, hash, coarse, chroma, fine: Math.max(0, fine) }
          const r = evaluate(w, 0.3, 12)
          if (r.wins >= base.wins) candidates.push({ w, ...r })
        }
      }
    }
  }
}

candidates.sort((a, b) => b.wins - a.wins || b.worst - a.worst)
console.log(`${candidates.length} weightings match or beat shipping.\n`)

const show = (c) => {
  const terms = TERMS.filter((t) => c.w[t] > 0.001)
    .map((t) => `${t} ${c.w[t].toFixed(2)}`)
    .join('  ')
  return `${String(c.wins).padStart(2)}/${c.total}  worst ${c.worst.toFixed(3).padStart(6)}  ${JSON.stringify(c.per)}  ${terms}`
}

console.log('Best 15 by rows won, then by worst margin:')
for (const c of candidates.slice(0, 15)) console.log(`  ${show(c)}`)

/* A weighting is only interesting if it holds every set. Report the best that
   loses nothing, since that is the one that can actually ship. */
const perfect = candidates.filter((c) => c.wins === c.total)
console.log(`\n${perfect.length} weighting(s) win every row on every set.`)
for (const c of perfect.slice(0, 10)) console.log(`  ${show(c)}`)

/*
 * Nineteen queries cannot pin down five weights, and a quarter of the search
 * space wins all of them — so the top of that list is a spike fitted to noise,
 * not a discovery. Everything below exists to find something that generalises.
 */

console.log('\n── Centroid of the winning region ──')
/* The middle of a wide plateau, rather than its highest point. Every direction
   away from it stays inside the region that works, which is the property that
   matters when the next car arrives. */
const centroid = {}
for (const t of TERMS) {
  centroid[t] = perfect.reduce((s, c) => s + (c.w[t] ?? 0), 0) / perfect.length
}
const sum = TERMS.reduce((s, t) => s + centroid[t], 0)
for (const t of TERMS) centroid[t] = Math.round((centroid[t] / sum) * 100) / 100
const cRes = evaluate(centroid, 0.3, 12)
console.log(`  ${TERMS.map((t) => `${t} ${centroid[t].toFixed(2)}`).join('  ')}`)
console.log(`  ${cRes.wins}/${cRes.total}  worst margin ${cRes.worst.toFixed(3)}  ${JSON.stringify(cRes.per)}`)
if (cRes.losses.length) console.log(`  loses: ${cRes.losses.join(', ')}`)

console.log('\n── Leave-one-set-out: does a weighting fitted elsewhere transfer? ──')
/* The real question. Fit on two sets, score on the third — if a weighting only
   works on the photos it was fitted to, it is not a matcher, it is a lookup. */
for (const held of SETS) {
  const trainSets = SETS.filter((s) => s !== held)
  const fitOn = (sets, w) => {
    let wins = 0
    let total = 0
    let worst = Infinity
    for (const set of sets) {
      const comps = dumps[set.name].comps
      for (const q of set.queries) {
        total++
        const ranked = q.candidates
          .filter((c) => c !== q.query)
          .map((c) => ({ name: c, s: score(comps[q.query][c], w, 0.3, 12) }))
          .sort((a, b) => b.s - a.s)
        const truth = ranked.find((r) => r.name === q.truth)
        const best = ranked.find((r) => r.name !== q.truth)
        const margin = truth.s - (best?.s ?? -Infinity)
        if (margin > 0) wins++
        worst = Math.min(worst, margin)
      }
    }
    return { wins, total, worst }
  }

  /* Best on the training sets, tie-broken by margin — the same procedure a
     tuner would follow with the held-out set unavailable. */
  let best = null
  for (const c of candidates) {
    const t = fitOn(trainSets, c.w)
    if (!best || t.wins > best.t.wins || (t.wins === best.t.wins && t.worst > best.t.worst)) {
      best = { w: c.w, t }
    }
  }
  const test = fitOn([held], best.w)
  console.log(
    `  fit on ${trainSets.map((s) => s.name).join('+')} (${best.t.wins}/${best.t.total}) → ${held.name}: ${test.wins}/${test.total}  worst ${test.worst.toFixed(3)}`,
  )
  console.log(`      ${TERMS.filter((t) => best.w[t] > 0.001).map((t) => `${t} ${best.w[t].toFixed(2)}`).join('  ')}`)

  const shipTest = fitOn([held], SHIP)
  console.log(`      shipping weights on ${held.name}: ${shipTest.wins}/${shipTest.total}  worst ${shipTest.worst.toFixed(3)}`)

  /* The centroid computed above saw every set, so testing it here would be
     marking its own homework. Rebuild it from the training sets alone — the
     same procedure, run as if the held-out photos did not exist. */
  const trainWinners = []
  for (const c of candidates) {
    const t = fitOn(trainSets, c.w)
    if (t.wins === t.total) trainWinners.push(c.w)
  }
  if (trainWinners.length) {
    const cen = {}
    for (const t of TERMS) {
      cen[t] = trainWinners.reduce((s, w) => s + (w[t] ?? 0), 0) / trainWinners.length
    }
    const z = TERMS.reduce((s, t) => s + cen[t], 0)
    for (const t of TERMS) cen[t] = Math.round((cen[t] / z) * 100) / 100
    const cenTest = fitOn([held], cen)
    console.log(
      `      centroid fitted WITHOUT ${held.name}: ${cenTest.wins}/${cenTest.total}  worst ${cenTest.worst.toFixed(3)}  (${TERMS.filter((t) => cen[t] > 0.001).map((t) => `${t} ${cen[t].toFixed(2)}`).join(' ')})`,
    )
  }
}

console.log('\n── How often each term is used by a weighting that works ──')
/* A term present in nearly every winning weighting is carrying real signal; one
   that is usually zero is being tolerated, not used. */
for (const t of TERMS) {
  const used = perfect.filter((c) => (c.w[t] ?? 0) > 0.001).length
  const mean = perfect.reduce((s, c) => s + (c.w[t] ?? 0), 0) / perfect.length
  const bar = '█'.repeat(Math.round((used / perfect.length) * 30))
  console.log(
    `  ${t.padEnd(7)} used by ${String(Math.round((used / perfect.length) * 100)).padStart(3)}%  mean weight ${mean.toFixed(2)}  ${bar}`,
  )
}

console.log('\n── Geometric bonus: is it ever the deciding vote? ──')
{
  let trueMax = 0
  let impostorMax = 0
  let impostorOver = 0
  let trueOver = 0
  let truePairs = 0
  let impostorPairs = 0
  for (const set of SETS) {
    const comps = dumps[set.name].comps
    for (const q of set.queries) {
      for (const c of q.candidates) {
        if (c === q.query) continue
        const n = comps[q.query][c].inliers
        if (c === q.truth) {
          truePairs++
          trueMax = Math.max(trueMax, n)
          if (n >= 12) trueOver++
        } else {
          impostorPairs++
          impostorMax = Math.max(impostorMax, n)
          if (n >= 12) impostorOver++
        }
      }
    }
  }
  console.log(`  true pairs:     ${trueOver}/${truePairs} reach 12 inliers, max ${trueMax}`)
  console.log(`  impostor pairs: ${impostorOver}/${impostorPairs} reach 12 inliers, max ${impostorMax}`)

  const w = cRes.wins === cRes.total ? centroid : perfect[0]?.w
  if (w) {
    console.log('  under the chosen weighting:')
    for (const [bonus, min] of [
      [0, 12],
      [0.15, 12],
      [0.3, 12],
      [0.3, 8],
      [0.3, 20],
      [0.5, 12],
    ]) {
      const r = evaluate(w, bonus, min)
      console.log(
        `    bonus ${bonus.toFixed(2)} @${String(min).padStart(2)} inliers → ${r.wins}/${r.total}  worst ${r.worst.toFixed(3)}`,
      )
    }
  }
}
