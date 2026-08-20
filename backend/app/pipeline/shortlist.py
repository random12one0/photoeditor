"""
Rank same-spot candidates by DINOv2 cosine similarity. Cheap (pure linear
algebra over already-computed embeddings) so it runs over every photo pair in
a car; XFeat+LightGlue verification only runs on what this shortlists.
"""

from __future__ import annotations

import numpy as np

from app.config import SHORTLIST_FLOOR, SHORTLIST_TOP_K


def cosine_matrix(vecs: list[np.ndarray]) -> np.ndarray:
    """vecs are already L2-normalised (embed.py guarantees this), so cosine
    similarity is just the Gram matrix."""
    mat = np.stack(vecs, axis=0)
    return mat @ mat.T


def shortlist_pairs(
    ids: list[str],
    embeddings: dict[str, np.ndarray],
    candidate_pairs: list[tuple[int, int]],
    floor: float = SHORTLIST_FLOOR,
) -> list[tuple[int, int, float]]:
    """Score a specific set of (i, j) index pairs into `ids` — callers
    restrict this to cross-side pairs (before x after) within a car, since a
    same-spot match is only ever asked for across the wash, not within it.
    Returns (i, j, cosine) sorted by score desc, floor-filtered."""
    scored: list[tuple[int, int, float]] = []
    for i, j in candidate_pairs:
        a, b = embeddings[ids[i]], embeddings[ids[j]]
        s = float(np.dot(a, b))
        if s >= floor:
            scored.append((i, j, s))
    scored.sort(key=lambda t: -t[2])
    return scored


def top_k_per_row(
    scored: list[tuple[int, int, float]], top_k: int = SHORTLIST_TOP_K
) -> list[tuple[int, int, float]]:
    """Cap how many candidates each row (before-side photo) carries forward
    into geometric verification — the expensive stage. 15 per photo is
    generous headroom for even a car with a large after batch."""
    per_row: dict[int, list[tuple[int, int, float]]] = {}
    for i, j, s in scored:
        per_row.setdefault(i, []).append((i, j, s))
    out: list[tuple[int, int, float]] = []
    for i, rows in per_row.items():
        rows.sort(key=lambda t: -t[2])
        out.extend(rows[:top_k])
    out.sort(key=lambda t: -t[2])
    return out
