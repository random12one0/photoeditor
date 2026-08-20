"""
Burst grouping: collapse near-identical re-shots of one angle into a single
representative, transitively closed. Same purpose as cluster.ts's
groupSameTake, ported to the new evidence: near-dup pHash agreement OR
geometric agreement from verify.py, either is enough (config.BURST_HAMMING_MAX
/ BURST_INLIER_RATIO_MIN), gated by BURST_WINDOW_SECONDS so two genuinely
different close-ups taken minutes apart never collapse just because they
look similar.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import BURST_WINDOW_SECONDS


@dataclass
class BurstMember:
    id: str
    taken_at: float
    quality: float  # higher = better representative (e.g. laplacian_variance, normalised)


def group_bursts_transitive(
    ordered: list[BurstMember],
    same_take: set[tuple[str, str]],
    window_seconds: float = BURST_WINDOW_SECONDS,
) -> list[list[BurstMember]]:
    """`same_take` holds unordered id pairs already judged "same take" by
    hash agreement or geometric agreement (bursts.same_take_evidence).
    Adjacency is transitively closed via union-find so a 5-shot pan of one
    wheel collapses to one burst even though shot 1 and shot 5 alone might
    not clear the bar.
    """
    parent: dict[str, str] = {m.id: m.id for m in ordered}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    by_id = {m.id: m for m in ordered}
    for i in range(len(ordered)):
        for j in range(i + 1, len(ordered)):
            a, b = ordered[i], ordered[j]
            if abs(a.taken_at - b.taken_at) > window_seconds * 1000:
                continue
            key = (a.id, b.id) if a.id < b.id else (b.id, a.id)
            if key in same_take:
                union(a.id, b.id)

    groups: dict[str, list[BurstMember]] = {}
    for m in ordered:
        groups.setdefault(find(m.id), []).append(m)

    result = list(groups.values())
    for g in result:
        g.sort(key=lambda m: (-m.quality, m.taken_at))
    result.sort(key=lambda g: g[0].taken_at)
    return result


def same_take_evidence(
    hamming_distance: int | None,
    hamming_max: int,
    geometric_inlier_ratio: float | None,
    inlier_ratio_min: float,
) -> bool:
    """Either signal is enough -- see config.py's comment on BURST_HAMMING_MAX
    / BURST_INLIER_RATIO_MIN for why an OR rather than a blend."""
    if hamming_distance is not None and hamming_distance <= hamming_max:
        return True
    if geometric_inlier_ratio is not None and geometric_inlier_ratio >= inlier_ratio_min:
        return True
    return False
