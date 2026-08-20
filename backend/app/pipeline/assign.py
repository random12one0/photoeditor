"""
Optimal one-to-one before/after assignment via scipy's Hungarian algorithm
(linear_sum_assignment) -- the same reasoning as assign.ts's assignMax
(maximise total score across the whole car, not a greedy best-pair-first
walk that leaves the leftovers to fight over scraps), just handed to a
battle-tested library now that this runs server-side instead of hand-rolled
for a browser bundle.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import linear_sum_assignment


def assign_max(score: np.ndarray, forbid_below: float = float("-inf")) -> list[int]:
    """score[i][j] = how good a match before-i/after-j is, higher better.
    Returns, for each row, the assigned column index or -1 if the row ended
    up on a forbidden cell (scipy always fully matches the smaller side, so
    a forbidden assignment is caught and unwound afterwards rather than
    prevented up front -- same net effect as assign.ts's Infinity-cost
    approach, without relying on inf surviving the solver).
    """
    if score.size == 0:
        return [-1] * score.shape[0]

    finite = score[np.isfinite(score) & (score > forbid_below)]
    # A cost large enough that the solver only picks a forbidden cell when a
    # row genuinely has no legal column left.
    penalty = (float(finite.max()) - float(finite.min()) + 1) * score.shape[0] * 4 if finite.size else 1.0

    cost = np.where(np.isfinite(score) & (score > forbid_below), -score, penalty)
    row_idx, col_idx = linear_sum_assignment(cost)

    result = [-1] * score.shape[0]
    for r, c in zip(row_idx, col_idx):
        if score[r, c] > forbid_below and np.isfinite(score[r, c]):
            result[r] = int(c)
    return result
