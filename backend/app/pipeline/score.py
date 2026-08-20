"""
Score fusion: DINOv2 cosine similarity plus whatever XFeat/RANSAC can prove
on top of it, into one same-spot score and a confidence tier.

Bonus, not blend -- same shape and same reasoning as hash.ts's pairScore /
FEATURE_BONUS: geometric agreement is close to proof when present, and
proves nothing when absent (a dull painted panel has no corners to find), so
averaging it in would let its absence drag a good appearance match down.
Verified again here rather than assumed: on the real photos checked in
config.py's VERIFY_MIN_INLIERS comment, the geometric signal and the
appearance signal already agreed on every example seen (both high or both
low), so a bonus-not-blend is at worst neutral and at best a tie-breaker
between otherwise-similar candidates -- the same shape carrying over is not
a coincidence, it's the same kind of evidence (do these two frames show one
physical thing) arrived at two independent ways.

No time-proximity term. cluster.ts's orderWeight was tried at various
weights and found to actively hurt -- a 15% weight was enough to marry a
wheel shot to a centre console on a real car -- and set to 0 by default.
Within an already-split before/after batch, capture time says nothing about
which before matches which after, so it isn't resurrected here.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import (
    DEFAULT_SAME_SPOT_AUTO_ACCEPT,
    DEFAULT_SAME_SPOT_REVIEW_FLOOR,
    VERIFY_MIN_INLIERS,
)

GEOMETRIC_BONUS = 0.15


@dataclass
class PairScore:
    cosine: float
    inliers: int
    same_spot: float  # fused score, 0-1
    tier: str  # 'confirmed' | 'high' | 'uncertain' | 'unmatched'


def fuse(cosine: float, inliers: int) -> PairScore:
    same_spot = cosine
    if inliers >= VERIFY_MIN_INLIERS:
        same_spot = min(1.0, same_spot + GEOMETRIC_BONUS)

    if same_spot < DEFAULT_SAME_SPOT_REVIEW_FLOOR:
        tier = "unmatched"
    elif same_spot >= DEFAULT_SAME_SPOT_AUTO_ACCEPT:
        tier = "confirmed"
    elif inliers >= VERIFY_MIN_INLIERS:
        # Geometric proof plus a merely-plausible appearance score is worth
        # more confidence than appearance alone at the same score -- proof
        # of shared structure is proof, even if the wash also changed a lot
        # of what DINOv2 sees.
        tier = "high"
    else:
        tier = "uncertain"

    return PairScore(cosine=cosine, inliers=inliers, same_spot=same_spot, tier=tier)
