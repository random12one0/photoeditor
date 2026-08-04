/**
 * Optimal one-to-one assignment (Hungarian / Kuhn-Munkres, O(n³)).
 *
 * Pairing before shots to after shots is an assignment problem, and it was
 * being solved greedily: sort every candidate by score, walk the list, take a
 * pair whenever both photos are still free. That is not the same answer. Greedy
 * commits to the single best-looking pair first, and if that photo was actually
 * the better partner for something else, everything downstream shifts onto
 * whatever is left — which is how a wheel ends up matched to a centre console.
 *
 * This maximises the total score across the whole set instead, so one strong
 * match can be given up when it buys two better ones. With a few dozen photos
 * per car the cubic cost is microseconds.
 *
 * Implemented over a rectangular cost matrix using the shortest-augmenting-path
 * formulation, which needs no padding to square and no explicit matrix updates.
 */

const INF = Number.POSITIVE_INFINITY

/**
 * Solve, and make as many assignments as possible before minimising cost.
 *
 * That order matters and the second half is meaningless without the first:
 * costs are non-negative here, so "cheapest" on its own is achieved by matching
 * nothing at all.
 *
 * @param cost  cost[i][j] — the cost of assigning row i to column j. Lower is
 *              better. Use Infinity to forbid a pairing outright.
 * @returns For each row, the column it was assigned, or -1 when the row was
 *          left unassigned (only possible when there are more rows than
 *          columns, or every option for that row was forbidden).
 */
export function assign(cost: number[][]): number[] {
  const rows = cost.length
  if (rows === 0) return []
  const cols = cost[0].length
  if (cols === 0) return new Array<number>(rows).fill(-1)

  /* More rows than columns: solve it the other way up.
   *
   * The routine below walks the rows in order and augments each one in turn.
   * When there are more rows than columns some row must go unassigned, and what
   * it does is give up on whichever row it happens to reach with no free column
   * left — so *which* row loses is decided by position rather than by cost.
   *
   * Measured on a real set of five before shots and four after shots, that
   * dropped the last before shot rather than the worst one: the dirty console
   * lost its own clean console, and the driver's seat — which had no partner at
   * all — took it. The total was 2.869 against the correct 2.940.
   *
   * Transposing puts the short side on the rows, where every row genuinely can
   * be assigned and the algorithm's own optimisation decides which columns miss
   * out. It cost 127 of 171 randomly generated tall matrices before this. */
  if (rows > cols) {
    const flipped: number[][] = []
    for (let j = 0; j < cols; j++) {
      flipped[j] = []
      for (let i = 0; i < rows; i++) flipped[j][i] = cost[i][j]
    }
    const colToRowResult = assign(flipped)
    const rowToCol = new Array<number>(rows).fill(-1)
    colToRowResult.forEach((i, j) => {
      if (i >= 0) rowToCol[i] = j
    })
    return rowToCol
  }

  // Potentials (dual variables) and the column -> row matching. Index 0 is a
  // virtual row/column used to seed each augmentation, hence the +1 sizes.
  const u = new Float64Array(rows + 1)
  const v = new Float64Array(cols + 1)
  const colToRow = new Int32Array(cols + 1).fill(0)
  const way = new Int32Array(cols + 1).fill(0)

  for (let i = 1; i <= rows; i++) {
    colToRow[0] = i
    let j0 = 0

    const minv = new Float64Array(cols + 1).fill(INF)
    const used = new Uint8Array(cols + 1)

    // Grow a shortest-path tree until it reaches a free column.
    do {
      used[j0] = 1
      const i0 = colToRow[j0]
      let delta = INF
      let j1 = 0

      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue
        const c = cost[i0 - 1][j - 1]
        // Infinity marks a forbidden pairing; leave it unreachable.
        const cur = c === INF ? INF : c - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }

      // Every remaining column is unreachable — this row cannot be assigned.
      if (delta === INF) {
        j0 = 0
        break
      }

      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[colToRow[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (colToRow[j0] !== 0)

    if (j0 === 0) continue

    // Walk the alternating path back, flipping the matching as we go.
    do {
      const j1 = way[j0]
      colToRow[j0] = colToRow[j1]
      j0 = j1
    } while (j0)
  }

  const rowToCol = new Array<number>(rows).fill(-1)
  for (let j = 1; j <= cols; j++) {
    const i = colToRow[j]
    if (i > 0 && i <= rows) rowToCol[i - 1] = j - 1
  }
  return rowToCol
}

/**
 * Convenience wrapper: maximise a score matrix instead of minimising a cost.
 * Scores at or below `forbidBelow` are treated as impossible rather than
 * merely bad, so nothing is paired just because it was the last option left.
 */
export function assignMax(score: number[][], forbidBelow = -Infinity): number[] {
  if (!score.length) return []
  let best = -Infinity
  for (const row of score) for (const s of row) if (s > best) best = s
  const cost = score.map((row) =>
    row.map((s) => (s <= forbidBelow ? INF : best - s)),
  )
  return assign(cost)
}
