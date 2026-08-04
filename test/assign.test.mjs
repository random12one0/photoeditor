/**
 * Unit tests for the assignment solver.
 *
 * This is the one piece of the app that is pure algorithm with a checkable
 * answer, so it gets checked directly rather than only through the UI — and
 * against brute force, which is the only way to be sure "optimal" really is.
 */
import { launchBrowser, startServer } from './lib/harness.mjs'

const PORT = 4326
const { proc: server } = await startServer(PORT, { mode: 'dev' })
const browser = await launchBrowser()
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await page.goto(`http://127.0.0.1:${PORT}`)

const results = await page.evaluate(async () => {
  const { assign, assignMax } = await import('/src/lib/assign.ts')
  const out = []

  const total = (cost, res) =>
    res.reduce((s, c, i) => (c >= 0 ? s + cost[i][c] : s), 0)

  /**
   * Exhaustive best assignment, for matrices small enough to enumerate.
   *
   * The contract is maximum cardinality first, minimum cost second. Both halves
   * matter and the second is useless without the first: costs here are all
   * non-negative, so "minimum cost" alone is minimised by assigning nothing.
   *
   * This is the second version. The first walked the rows in order and let a row
   * go unassigned only when every column was already taken — which quietly
   * forces the *first* `cols` rows to be the ones that get assigned. The solver
   * had exactly the same bias, so the two agreed with each other for 300 random
   * matrices while both were wrong, and a real 5-before/4-after set came back
   * with the last before shot dropped instead of the worst one.
   *
   * So this enumerates which rows are used rather than assuming it.
   */
  function brute(cost) {
    const rows = cost.length, cols = cost[0].length
    let bestCount = -1
    let bestCost = Infinity
    const usedRow = new Array(rows).fill(false)

    // Walk the columns, giving each one a free row or leaving it unassigned.
    const walk = (j, count, acc) => {
      if (j === cols) {
        if (count > bestCount || (count === bestCount && acc < bestCost)) {
          bestCount = count
          bestCost = acc
        }
        return
      }
      walk(j + 1, count, acc)
      for (let i = 0; i < rows; i++) {
        if (usedRow[i] || cost[i][j] === Infinity) continue
        usedRow[i] = true
        walk(j + 1, count + 1, acc + cost[i][j])
        usedRow[i] = false
      }
    }
    walk(0, 0, 0)
    return { count: bestCount, cost: bestCost }
  }

  // A textbook case with a known answer.
  const known = [[4, 1, 3], [2, 0, 5], [3, 2, 2]]
  out.push({ name: 'known 3x3 optimum = 5', pass: total(known, assign(known)) === 5 })

  // Greedy would take the 0 first and lose; optimal must not.
  const trap = [[0, 9], [1, 9]]
  out.push({ name: 'greedy trap', pass: total(trap, assign(trap)) === 9 })

  const count = (res) => res.filter((c) => c >= 0).length

  // Random matrices, square and rectangular, against brute force.
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  let mismatches = 0
  let tallMismatches = 0
  let tallSeen = 0
  for (let t = 0; t < 400; t++) {
    const r = 1 + Math.floor(rnd() * 5)
    const c = 1 + Math.floor(rnd() * 5)
    const m = Array.from({ length: r }, () =>
      Array.from({ length: c }, () => Math.round(rnd() * 20)))
    const res = assign(m)
    const want = brute(m)
    const bad = count(res) !== want.count || Math.abs(total(m, res) - want.cost) > 1e-9
    if (bad) mismatches++
    // Tracked separately: more rows than columns is the shape that was broken.
    if (r > c) {
      tallSeen++
      if (bad) tallMismatches++
    }
  }
  out.push({ name: '400 random matrices match brute force', pass: mismatches === 0, detail: `${mismatches} mismatches` })
  out.push({
    name: 'including more rows than columns',
    pass: tallMismatches === 0 && tallSeen > 20,
    detail: `${tallSeen} such matrices, ${tallMismatches} wrong`,
  })

  /* The reported case, from real photographs: five before shots, four after
     shots. Leaving a row out is unavoidable; leaving out the *last* one rather
     than the worst one is not. Scores are the measured similarities, negated
     into costs. Rows: 7986 exterior, 7993 wheel, 7996 trunk, 8001 seat,
     8003 console. Columns: 8005 console, 8006 trunk, 8009 wheel, 8011 exterior. */
  const jeep = [
    [0.616, 0.620, 0.617, 0.721],
    [0.634, 0.685, 0.667, 0.592],
    [0.633, 0.858, 0.640, 0.638],
    [0.623, 0.696, 0.622, 0.646],
    [0.694, 0.622, 0.616, 0.618],
  ].map((row) => row.map((v) => -v))
  const jeepRes = assign(jeep)
  const jeepWant = brute(jeep)
  out.push({
    name: 'five befores, four afters: the right one is dropped',
    pass:
      count(jeepRes) === 4 &&
      Math.abs(total(jeep, jeepRes) - jeepWant.cost) < 1e-9 &&
      jeepRes[3] === -1,
    detail: `dropped row ${jeepRes.indexOf(-1)}, wanted row 3 (the seat)`,
  })

  // No column may be used twice.
  const dup = Array.from({ length: 6 }, () =>
    Array.from({ length: 6 }, () => Math.round(rnd() * 10)))
  const res = assign(dup)
  const seen = res.filter((c) => c >= 0)
  out.push({ name: 'assignments are one-to-one', pass: new Set(seen).size === seen.length })

  // Forbidden entries are never chosen, and leave rows unassigned.
  const forbid = [[Infinity, Infinity], [1, 2]]
  const fres = assign(forbid)
  out.push({ name: 'forbidden pairs are refused', pass: fres[0] === -1 && fres[1] >= 0 })

  // assignMax maximises, and its floor forbids weak matches.
  const scores = [[0.9, 0.1], [0.2, 0.8]]
  const maxRes = assignMax(scores)
  out.push({ name: 'assignMax picks the diagonal', pass: maxRes[0] === 0 && maxRes[1] === 1 })

  const weak = [[0.9, 0.05], [0.04, 0.03]]
  const floored = assignMax(weak, 0.1)
  out.push({ name: 'assignMax floor leaves weak rows unpaired', pass: floored[0] === 0 && floored[1] === -1 })

  // Degenerate shapes must not throw.
  try {
    assign([]); assign([[]]); assignMax([])
    out.push({ name: 'empty inputs are safe', pass: true })
  } catch (e) {
    out.push({ name: 'empty inputs are safe', pass: false, detail: String(e) })
  }

  return out
})

await browser.close()
server.kill('SIGTERM')

let failed = 0
for (const r of results) {
  console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  if (!r.pass) failed++
}
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed ? 1 : 0)
