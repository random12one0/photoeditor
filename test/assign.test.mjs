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

  /** Exhaustive best assignment, for matrices small enough to enumerate. */
  function brute(cost) {
    const rows = cost.length, cols = cost[0].length
    let best = Infinity
    const used = new Array(cols).fill(false)
    const walk = (i, acc) => {
      if (acc >= best) return
      if (i === rows) { best = Math.min(best, acc); return }
      let any = false
      for (let j = 0; j < cols; j++) {
        if (used[j] || cost[i][j] === Infinity) continue
        any = true
        used[j] = true
        walk(i + 1, acc + cost[i][j])
        used[j] = false
      }
      if (!any) walk(i + 1, acc)
    }
    walk(0, 0)
    return best
  }

  // A textbook case with a known answer.
  const known = [[4, 1, 3], [2, 0, 5], [3, 2, 2]]
  out.push({ name: 'known 3x3 optimum = 5', pass: total(known, assign(known)) === 5 })

  // Greedy would take the 0 first and lose; optimal must not.
  const trap = [[0, 9], [1, 9]]
  out.push({ name: 'greedy trap', pass: total(trap, assign(trap)) === 9 })

  // Random matrices, square and rectangular, against brute force.
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  let mismatches = 0
  for (let t = 0; t < 300; t++) {
    const r = 1 + Math.floor(rnd() * 5)
    const c = 1 + Math.floor(rnd() * 5)
    const m = Array.from({ length: r }, () =>
      Array.from({ length: c }, () => Math.round(rnd() * 20)))
    const got = total(m, assign(m))
    const want = brute(m)
    if (Math.abs(got - want) > 1e-9) mismatches++
  }
  out.push({ name: '300 random matrices match brute force', pass: mismatches === 0, detail: `${mismatches} mismatches` })

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
