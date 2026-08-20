"""
The solver: a pure function `(photos, pairwise scores, bursts, constraints)
-> CarSolution`. Same property the browser prototype's constraint-log design
was built around (see docs/local-desktop-plan.md) -- nothing is ever
destructively consumed, everything is re-derived fresh from the append-only
constraint log on every call, so undo is just popping the log and re-solving.

Constraint semantics (ConstraintType in app/models.py):
  pin(before, after)      force this pair, bypassing assignment.
  unpin(before, after)    cancel an earlier pin for this same combination.
  forbid(before, after)   exclude this combination from assignment, like
                          hash.ts's rejectionKey -- frees both photos to
                          match elsewhere on re-solve.
  side(photo_id, side)     override which batch (before/after) a photo
                          belongs to, for photos the timing split got wrong.
  exclude(photo_id)        remove a photo from consideration entirely.
  include(photo_id)        cancel an earlier exclude.
  burstSplit(photo_id)     pull a photo out of its burst into a singleton --
                          for a burst that wrongly collapsed distinct shots.
  burstMerge(a, b)         merge the bursts containing photo a and photo b.
  represent(photo_id)      override which photo in a burst is the pick,
                          instead of the highest-quality one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.config import DEFAULT_SAME_SPOT_REVIEW_FLOOR
from app.pipeline.assign import assign_max
from app.pipeline.score import PairScore


@dataclass
class SolverPhoto:
    id: str
    taken_at: float
    quality: float
    side: str  # 'before' | 'after' | 'unknown' -- the *base* side from timing.py


@dataclass
class SolvedBurst:
    id: str
    photo_ids: list[str]
    representative_id: str
    side: str


@dataclass
class SolvedPairOut:
    id: str
    before_id: str
    after_id: str
    score: float
    tier: str
    inliers: int


@dataclass
class CarSolution:
    bursts: list[SolvedBurst]
    pairs: list[SolvedPairOut]
    orphan_afters: list[str]
    orphan_befores: list[str]
    unknown_side: list[str]


def _rejection_key(before: str, after: str) -> str:
    return f"{before}|{after}"


def _apply_constraints(
    photos: dict[str, SolverPhoto],
    base_bursts: list[list[str]],
    constraints: list,
) -> tuple[
    set[str],  # excluded
    set[str],  # forbidden keys
    dict[str, str],  # pinned before -> after
    dict[str, str],  # side overrides photo_id -> side
    list[list[str]],  # effective bursts (post split/merge)
    list[str],  # represent requests, oldest first -- last one covering a
                # given burst's members wins, so the caller scans in reverse
]:
    excluded: set[str] = set()
    forbidden: set[str] = set()
    pinned: dict[str, str] = {}
    side_override: dict[str, str] = {}
    represent_requests: list[str] = []

    # Union-find over photo ids, seeded from base_bursts, so split/merge can
    # be applied as plain graph edits regardless of log order.
    parent: dict[str, str] = {}
    for group in base_bursts:
        for pid in group:
            parent[pid] = group[0]
    for pid in photos:
        parent.setdefault(pid, pid)

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    split_out: set[str] = set()

    for c in constraints:
        t = c.type
        if t == "forbid" and c.before and c.after:
            forbidden.add(_rejection_key(c.before, c.after))
        elif t == "pin" and c.before and c.after:
            pinned[c.before] = c.after
        elif t == "unpin" and c.before and c.after:
            if pinned.get(c.before) == c.after:
                del pinned[c.before]
        elif t == "side" and c.photo_id and c.side:
            side_override[c.photo_id] = c.side
        elif t == "exclude" and c.photo_id:
            excluded.add(c.photo_id)
        elif t == "include" and c.photo_id:
            excluded.discard(c.photo_id)
        elif t == "burstSplit" and c.photo_id:
            split_out.add(c.photo_id)
            parent[c.photo_id] = c.photo_id  # becomes its own root
        elif t == "burstMerge" and c.a and c.b:
            split_out.discard(c.a)
            split_out.discard(c.b)
            union(c.a, c.b)
        elif t == "represent" and c.photo_id:
            represent_requests.append(c.photo_id)

    groups: dict[str, list[str]] = {}
    for pid in photos:
        if pid in split_out:
            groups.setdefault(pid, []).append(pid)
        else:
            groups.setdefault(find(pid), []).append(pid)

    effective_bursts = list(groups.values())
    return excluded, forbidden, pinned, side_override, effective_bursts, represent_requests


def solve_car(
    photos: list[SolverPhoto],
    pair_scores: dict[tuple[str, str], PairScore],
    base_bursts: list[list[str]],
    constraints: list,
    min_pair_score: float = DEFAULT_SAME_SPOT_REVIEW_FLOOR,
) -> CarSolution:
    photo_map = {p.id: p for p in photos}
    excluded, forbidden, pinned, side_override, eff_bursts, represent_requests = _apply_constraints(
        photo_map, base_bursts, constraints
    )

    def effective_side(pid: str) -> str:
        return side_override.get(pid, photo_map[pid].side)

    solved_bursts: list[SolvedBurst] = []
    burst_side: dict[str, str] = {}
    burst_rep: dict[str, str] = {}
    for group in eff_bursts:
        alive = [pid for pid in group if pid not in excluded]
        if not alive:
            continue
        sides = {effective_side(pid) for pid in alive}
        # A burst photographed as one take shares one side; if a `side`
        # override splits it, the burst itself splits too rather than
        # silently picking one.
        for side_value in sides or {"unknown"}:
            members = [pid for pid in alive if effective_side(pid) == side_value] if len(sides) > 1 else alive
            if not members:
                continue
            rep = next((r for r in reversed(represent_requests) if r in members), None)
            if rep is None:
                rep = max(members, key=lambda pid: (photo_map[pid].quality, -photo_map[pid].taken_at))
            burst_id = f"b_{members[0]}"
            solved_bursts.append(SolvedBurst(id=burst_id, photo_ids=members, representative_id=rep, side=side_value))
            burst_side[rep] = side_value
            burst_rep[burst_id] = rep

    before_reps = [b.representative_id for b in solved_bursts if b.side == "before"]
    after_reps = [b.representative_id for b in solved_bursts if b.side == "after"]
    unknown_side = [b.representative_id for b in solved_bursts if b.side == "unknown"]

    pairs: list[SolvedPairOut] = []
    taken_before: set[str] = set()
    taken_after: set[str] = set()
    for b, a in pinned.items():
        if b in before_reps and a in after_reps and b not in excluded and a not in excluded:
            ps = pair_scores.get((b, a))
            pairs.append(
                SolvedPairOut(
                    id=f"pair_{b}_{a}",
                    before_id=b,
                    after_id=a,
                    score=ps.same_spot if ps else 1.0,
                    tier="confirmed",
                    inliers=ps.inliers if ps else 0,
                )
            )
            taken_before.add(b)
            taken_after.add(a)

    free_before = [b for b in before_reps if b not in taken_before]
    free_after = [a for a in after_reps if a not in taken_after]

    if free_before and free_after:
        matrix = np.full((len(free_before), len(free_after)), -np.inf)
        for i, b in enumerate(free_before):
            for j, a in enumerate(free_after):
                if _rejection_key(b, a) in forbidden:
                    continue
                ps = pair_scores.get((b, a))
                if ps is not None:
                    matrix[i, j] = ps.same_spot

        assignment = assign_max(matrix, forbid_below=min_pair_score)
        for i, j in enumerate(assignment):
            if j < 0:
                continue
            b, a = free_before[i], free_after[j]
            ps = pair_scores.get((b, a))
            pairs.append(
                SolvedPairOut(
                    id=f"pair_{b}_{a}",
                    before_id=b,
                    after_id=a,
                    score=ps.same_spot if ps else 0.0,
                    tier=ps.tier if ps else "uncertain",
                    inliers=ps.inliers if ps else 0,
                )
            )
            taken_before.add(b)
            taken_after.add(a)

    pairs.sort(key=lambda p: -p.score)
    orphan_befores = [b for b in before_reps if b not in taken_before]
    orphan_afters = [a for a in after_reps if a not in taken_after]

    return CarSolution(
        bursts=solved_bursts,
        pairs=pairs,
        orphan_befores=orphan_befores,
        orphan_afters=orphan_afters,
        unknown_side=unknown_side,
    )
