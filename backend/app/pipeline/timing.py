"""
EXIF-time-based structure: splitting a car's photos into a before batch and
an after batch, and grouping photos taken seconds apart into one burst.

Direct port of the timing half of src/lib/cluster.ts (splitIntoCars,
splitBeforeAfter) — the reasoning there (car boundaries aren't visually
distinguishable; time gaps are what a person would use) doesn't change by
moving the code server-side, so the logic isn't rederived, just translated.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import BURST_WINDOW_SECONDS, MIN_JOB_GAP_SECONDS


@dataclass
class TimedPhoto:
    id: str
    taken_at: float  # epoch ms


def split_into_cars(ordered: list[TimedPhoto], new_car_gap_minutes: float, max_car_span_hours: float) -> list[list[TimedPhoto]]:
    if not ordered:
        return []
    gap_ms = new_car_gap_minutes * 60_000
    span_ms = max_car_span_hours * 3_600_000

    cars: list[list[TimedPhoto]] = [[ordered[0]]]
    for photo in ordered[1:]:
        current = cars[-1]
        since_last = photo.taken_at - current[-1].taken_at
        span_if_added = photo.taken_at - current[0].taken_at
        if since_last > gap_ms or span_if_added > span_ms:
            cars.append([photo])
        else:
            current.append(photo)
    return cars


def split_before_after(photos: list[TimedPhoto]) -> tuple[list[TimedPhoto], list[TimedPhoto]] | None:
    """The job itself is the widest internal gap. Below MIN_JOB_GAP_SECONDS
    there's no meaningful gap -- one continuous walk-around, not a job."""
    if len(photos) < 2:
        return None

    widest = 0.0
    at = -1
    for i in range(1, len(photos)):
        gap = photos[i].taken_at - photos[i - 1].taken_at
        if gap > widest:
            widest = gap
            at = i

    if at < 0 or widest < MIN_JOB_GAP_SECONDS * 1000:
        return None
    return photos[:at], photos[at:]


def group_bursts(ordered: list[TimedPhoto], window_seconds: float = BURST_WINDOW_SECONDS) -> list[list[TimedPhoto]]:
    """Consecutive photos within `window_seconds` of the previous photo in
    the run form one burst. Purely time-based grouping; bursts.py folds in
    hash/geometric agreement on top of this."""
    groups: list[list[TimedPhoto]] = []
    for photo in ordered:
        if groups and photo.taken_at - groups[-1][-1].taken_at <= window_seconds * 1000:
            groups[-1].append(photo)
        else:
            groups.append([photo])
    return groups
