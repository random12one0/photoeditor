"""
Wire types — what the frontend and backend agree on.

These mirror src/types.ts from the browser-only prototype almost field for
field, on purpose: the constraint-log architecture (append-only facts, a pure
re-runnable solver, nothing ever destructively consumed) was designed and
UI-tested there first, and porting the *shape* rather than reinventing it is
what makes the existing wizard screens portable to this server instead of a
rewrite of their own.

What moved server-side is the *content* of a Photo — no browser-computed
dHash/colour-histogram/ORB descriptors here. A photo is a path on disk; the
pipeline computes a DINOv2 embedding, XFeat keypoints, and cleanliness/timing
features from it, cached by content hash so a second solve of the same job
costs nothing.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Side = Literal["before", "after", "unknown"]
Tier = Literal["confirmed", "high", "uncertain"]
ConstraintType = Literal[
    "pin", "unpin", "forbid", "side", "exclude", "include", "burstSplit", "burstMerge", "represent"
]


class Photo(BaseModel):
    id: str
    name: str
    path: str
    width: int
    height: int
    taken_at: float  # epoch ms, matching the frontend's convention
    time_is_approximate: bool
    thumb_ready: bool = False


class Constraint(BaseModel):
    """One user decision, appended to a log that is never rewritten.

    See src/types.ts's Constraint union for the full rationale — this is the
    same fix for the same bug, just enforced server-side now that matching
    runs here. `before`/`after`/`photo_id`/`a`/`b` are used depending on
    `type`; unused fields are simply absent, which pydantic's `Optional`
    below models faithfully rather than forcing every constraint to carry
    fields it doesn't mean anything for.
    """

    id: str
    at: float
    type: ConstraintType
    before: Optional[str] = None
    after: Optional[str] = None
    photo_id: Optional[str] = None
    side: Optional[Side] = None
    a: Optional[str] = None
    b: Optional[str] = None


class Burst(BaseModel):
    id: str
    photo_ids: list[str]
    representative_id: str
    side: Side


class SolvedPair(BaseModel):
    id: str
    before_id: str
    after_id: str
    score: float
    tier: Tier
    car_id: str
    inliers: int = 0


class CarSolution(BaseModel):
    id: str
    name: str
    bursts: list[Burst]
    pairs: list[SolvedPair]
    orphan_afters: list[str]
    orphan_befores: list[str]
    unknown_side: list[str]


class ClusterSettings(BaseModel):
    new_car_gap_minutes: float = 300
    max_car_span_hours: float = 6
    min_pair_score: float = 0.55  # calibrated-probability floor, not the raw-score one
    high_confidence: float = 0.85


class JobSummary(BaseModel):
    id: str
    folder: str
    photo_count: int
    status: Literal["scanning", "embedding", "verifying", "ready", "error"]
    progress: float = 0
    message: str = ""


class ConstraintIn(BaseModel):
    type: ConstraintType
    before: Optional[str] = None
    after: Optional[str] = None
    photo_id: Optional[str] = None
    side: Optional[Side] = None
    a: Optional[str] = None
    b: Optional[str] = None


class BrowseResult(BaseModel):
    path: Optional[str] = None
    cancelled: bool = False


class ExportSelection(BaseModel):
    """What the export screen chose to include, per car — see routes/export.py."""

    car_id: str
    pair_ids: list[str] = Field(default_factory=list)
    single_ids: list[str] = Field(default_factory=list)


class ExportRequest(BaseModel):
    selections: list[ExportSelection]
    out_folder: Optional[str] = None  # None -> a ZIP is returned instead
    ratio: Literal["4:5", "1:1", "9:16", "3:4"] = "4:5"
    layout: Literal["stacked", "side-by-side"] = "stacked"
    order: Literal["after-first", "before-first"] = "after-first"
