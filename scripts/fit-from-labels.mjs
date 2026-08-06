/**
 * Re-fit the scoring weights from an exported set of judgements.
 *
 * The Lab screen writes down every verdict the user makes and exports them as
 * measurements — component scores and a yes or no, never image data. This reads
 * that file back and works out what the weights should have been.
 *
 * It is the same procedure as test/diagnose-weights.mjs, which fits against the
 * fixture photographs, and it exists separately because the two have different
 * inputs and different reach. The fixtures are nineteen rows that live on one
 * machine. An export is however many judgements the user has made, on their own
 * cars, and it can be sent by anyone to anyone because there is nothing in it to
 * protect.
 *
 * ## The objective, and why it is not accuracy
 *
 * Labels arrive unbalanced and sparse — mostly yes, often only one judgement per
 * photo — so "how many does it get right" is a bad target: predicting yes for
 * everything can score 80% and be useless. What matters is *ordering*: a true
 * pair must outrank a false one. So the objective is the fraction of yes/no
 * combinations put in the right order, counted twice over:
 *
 *   same-before   yes and no sharing one before shot. This is the real
 *                 decision the matcher makes, and it is weighted accordingly.
 *   overall       every yes against every no. Coarser, but there is far more
 *                 of it, and it stops a weighting overfitting the few photos
 *                 that happen to have both verdicts.
 *
 * ## Reading the output
 *
 * Take the centroid, not the top line. The top line is the best weighting on
 * *these* labels, which on the fixture sets was measurably a spike fitted to
 * noise — it lost every leave-one-out fold while the centroid of the winning
 * region won all three. Middle of the plateau beats top of the peak.
 *
 * Usage: node scripts/fit-from-labels.mjs <export.json> [more.json …]
 */

import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('Usage: node scripts/fit-from-labels.mjs <export.json> [more.json …]')
  process.exit(1)
}

const TERMS = ['color', 'edge', 'hash', 'coarse', 'fine', 'chroma']

/** What similarity() currently ships with, for comparison. */
const SHIP = { color: 0.16, edge: 0.17, hash: 0.17, coarse: 0.05, fine: 0.27, chroma: 0.18 }
const FEATURE_BONUS = 0.3
const FEATURE_MIN_INLIERS = 12

const labels = []
const schemas = new Set()
const versions = new Set()
for (const file of files) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`${file}: not readable as JSON — ${e.message}`)
    process.exit(1)
  }
  if (!Array.isArray(parsed.labels)) {
    console.error(`${file}: no "labels" array — is this an export from the Lab screen?`)
    process.exit(1)
  }
  for (const l of parsed.labels) {
    if (!l?.components || !['yes', 'no'].includes(l.verdict)) continue
    if (TERMS.some((t) => typeof l.components[t] !== 'number')) continue
    labels.push(l)
    schemas.add(l.schema)
    versions.add(l.appVersion)
  }
}

/* One judgement per combination, latest wins — the same rule the store uses. */
const byKey = new Map()
for (const l of labels.sort((a, b) => a.at - b.at)) byKey.set(l.key, l)
const data = [...byKey.values()]

const yes = data.filter((l) => l.verdict === 'yes')
const no = data.filter((l) => l.verdict === 'no')

console.log(`${data.length} judgements — ${yes.length} yes, ${no.length} no`)
console.log(`from app version(s) ${[...versions].join(', ')}, descriptor schema ${[...schemas].join(', ')}`)
if (schemas.size > 1) {
  console.log(
    '! Mixed descriptor schemas. Components measured under different schemas are not\n' +
      '  strictly comparable; consider fitting only the newest.',
  )
}
if (!yes.length || !no.length) {
  console.error('\nNeed judgements of both kinds to fit anything. Reject a few suggestions.')
  process.exit(1)
}

/* Pairs of judgements that share a before photo and disagree — the actual
   decisions the matcher gets right or wrong. */
const contested = []
for (const y of yes) {
  for (const n of no) {
    if (y.before.id === n.before.id) contested.push([y, n])
  }
}
console.log(`${contested.length} contested comparison(s) sharing a before shot`)

const score = (l, w, bonus, minInliers) => {
  let s = 0
  for (const t of TERMS) s += (w[t] ?? 0) * l.components[t]
  return s + (l.components.inliers >= minInliers ? bonus : 0)
}

/**
 * Ordering quality: how often a yes outranks a no.
 *
 * `same` counts only comparisons within one before shot and is what the matcher
 * is really judged on; `all` counts every yes against every no and is the
 * steadier of the two. Ranked by `same` first, because getting the real decision
 * right is the point, with `all` as the tie-break — and there are always ties.
 */
function evaluate(w, bonus = FEATURE_BONUS, minInliers = FEATURE_MIN_INLIERS) {
  let sameOk = 0
  for (const [y, n] of contested) {
    if (score(y, w, bonus, minInliers) > score(n, w, bonus, minInliers)) sameOk++
  }

  let allOk = 0
  let allTotal = 0
  let worst = Infinity
  for (const y of yes) {
    const ys = score(y, w, bonus, minInliers)
    for (const n of no) {
      allTotal++
      const ns = score(n, w, bonus, minInliers)
      if (ys > ns) allOk++
      worst = Math.min(worst, ys - ns)
    }
  }

  return {
    same: contested.length ? sameOk / contested.length : 1,
    sameOk,
    all: allTotal ? allOk / allTotal : 1,
    allOk,
    allTotal,
    worst,
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`
const showW = (w) =>
  TERMS.filter((t) => (w[t] ?? 0) > 0.001)
    .map((t) => `${t} ${w[t].toFixed(2)}`)
    .join('  ')

const base = evaluate(SHIP)
console.log('\n── What ships today ──')
console.log(`  ${showW(SHIP)}`)
console.log(
  `  same-before ${pct(base.same)} (${base.sameOk}/${contested.length})   overall ${pct(base.all)} (${base.allOk}/${base.allTotal})`,
)

console.log('\n── Searching ──')
const STEP = 0.05
const results = []
for (let color = 0; color <= 1.0001; color += STEP) {
  for (let edge = 0; edge <= 1.0001 - color; edge += STEP) {
    for (let hash = 0; hash <= 1.0001 - color - edge; hash += STEP) {
      for (let coarse = 0; coarse <= 1.0001 - color - edge - hash; coarse += STEP) {
        for (let chroma = 0; chroma <= 1.0001 - color - edge - hash - coarse; chroma += STEP) {
          const fine = 1 - color - edge - hash - coarse - chroma
          if (fine < -0.0001) continue
          const w = { color, edge, hash, coarse, chroma, fine: Math.max(0, fine) }
          results.push({ w, ...evaluate(w) })
        }
      }
    }
  }
}
results.sort((a, b) => b.same - a.same || b.all - a.all)
console.log(`${results.length} weightings evaluated.`)

console.log('\nBest 10 on these labels — do NOT ship these, see the centroid below:')
for (const r of results.slice(0, 10)) {
  console.log(`  same ${pct(r.same)}  all ${pct(r.all)}  ${showW(r.w)}`)
}

/* The plateau: everything that matches the best score on both measures. */
const bestSame = results[0].same
const bestAll = Math.max(...results.filter((r) => r.same === bestSame).map((r) => r.all))
const plateau = results.filter((r) => r.same === bestSame && r.all >= bestAll - 0.005)

console.log(`\n── Centroid of the ${plateau.length} best weightings — this is the answer ──`)
const centroid = {}
for (const t of TERMS) {
  centroid[t] = plateau.reduce((s, r) => s + (r.w[t] ?? 0), 0) / plateau.length
}
const z = TERMS.reduce((s, t) => s + centroid[t], 0)
for (const t of TERMS) centroid[t] = Math.round((centroid[t] / z) * 100) / 100
const cen = evaluate(centroid)
console.log(`  ${showW(centroid)}`)
console.log(
  `  same-before ${pct(cen.same)} (${cen.sameOk}/${contested.length})   overall ${pct(cen.all)} (${cen.allOk}/${cen.allTotal})`,
)
const delta = cen.all - base.all
console.log(
  `  versus shipping: ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} points overall, ` +
    `${((cen.same - base.same) * 100).toFixed(1)} on contested`,
)
if (Math.abs(delta) < 0.01 && Math.abs(cen.same - base.same) < 0.01) {
  console.log('  → No meaningful improvement available. The weights are not the problem.')
}

console.log('\n── How each term is used across the plateau ──')
for (const t of TERMS) {
  const used = plateau.filter((r) => (r.w[t] ?? 0) > 0.001).length
  const mean = plateau.reduce((s, r) => s + (r.w[t] ?? 0), 0) / plateau.length
  console.log(
    `  ${t.padEnd(7)} used by ${String(Math.round((used / plateau.length) * 100)).padStart(3)}%  mean ${mean.toFixed(2)}  ${'█'.repeat(Math.round((used / plateau.length) * 30))}`,
  )
}

console.log('\n── Geometric evidence ──')
const inliersOf = (set) => set.map((l) => l.components.inliers).sort((a, b) => a - b)
const yi = inliersOf(yes)
const ni = inliersOf(no)
const at = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0)
console.log(`  yes: median ${at(yi, 0.5)}  90th ${at(yi, 0.9)}  max ${yi[yi.length - 1] ?? 0}`)
console.log(`  no:  median ${at(ni, 0.5)}  90th ${at(ni, 0.9)}  max ${ni[ni.length - 1] ?? 0}`)
console.log('  thresholds, on the centroid weighting:')
for (const min of [6, 8, 10, 12, 16, 20]) {
  const r = evaluate(centroid, FEATURE_BONUS, min)
  const firing = no.filter((l) => l.components.inliers >= min).length
  console.log(
    `    @${String(min).padStart(2)}: same ${pct(r.same)}  all ${pct(r.all)}  (fires on ${firing} wrong pair(s))`,
  )
}

console.log('\n── Where it still gets it wrong ──')
/* Named, so the next round of work has somewhere to start. */
const wrong = []
for (const [y, n] of contested) {
  if (score(y, centroid) <= score(n, centroid)) {
    wrong.push(
      `  ${y.before.name} → wanted ${y.after.name} (${score(y, centroid).toFixed(3)}), ` +
        `preferred ${n.after.name} (${score(n, centroid).toFixed(3)})`,
    )
  }
}
console.log(wrong.length ? wrong.slice(0, 20).join('\n') : '  Nothing contested is misordered.')
if (wrong.length > 20) console.log(`  …and ${wrong.length - 20} more`)

console.log(
  '\nTo adopt: put the centroid weights into similarity() in src/lib/hash.ts,\n' +
    'bump SCHEMA_VERSION in src/lib/db.ts so saved sessions recompute, and run\n' +
    'npm run test:all to confirm the fixture sets still pass.',
)
