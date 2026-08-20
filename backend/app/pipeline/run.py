"""
Orchestrates the whole pipeline (ingest -> near-dup -> embed -> shortlist ->
verify -> fuse -> bursts) over a job's folder, mutating the Job in place so
routes/jobs.py's status polling can report progress.

Car/before-after splitting reuses cluster.ts's defaults (a new car starts
after a 300-minute gap, no car spans more than 6 hours, no job/pair split
inside a car below a 3-minute gap) -- see timing.py's module docstring for
why that stays time-only rather than vision-based.
"""

from __future__ import annotations

import math

from app.jobs import CarData, Job, PhotoRecord
from app.pipeline import neardup, timing
from app.pipeline.bursts import BurstMember, group_bursts_transitive, same_take_evidence
from app.pipeline.cleanliness import cleanliness_features
from app.pipeline.embed import embed_photos
from app.pipeline.ingest import ingest_folder
from app.pipeline.score import fuse
from app.pipeline.shortlist import cosine_matrix, shortlist_pairs, top_k_per_row
from app.pipeline.verify import verify_pair
from app.config import BURST_HAMMING_MAX, BURST_INLIER_RATIO_MIN, NEARDUP_HAMMING_MAX

NEW_CAR_GAP_MINUTES = 300
MAX_CAR_SPAN_HOURS = 6


def _quality_from_laplacian(variance: float) -> float:
    # Same saturating shape as hash.ts's qualityFromImageData's focus term,
    # re-fit for cv2.Laplacian's scale (measured empirically on this job's
    # real photos: sharp handheld phone shots land ~200-1500).
    return 1 - math.exp(-max(0.0, variance) / 500)


def run_pipeline(job: Job) -> None:
    try:
        job.status = "scanning"
        job.message = "Reading photos"
        ingested = ingest_folder(job.folder)
        if not ingested:
            job.status = "error"
            job.error = "No photos found in that folder."
            return

        for i, p in enumerate(ingested):
            job.photos[p.content_hash] = PhotoRecord(
                id=p.content_hash,
                path=p.path,
                name=p.path.name,
                width=p.width,
                height=p.height,
                taken_at=p.taken_at,
                time_is_approximate=p.time_is_approximate,
                content_hash=p.content_hash,
            )
            job.progress = 0.05 * (i + 1) / len(ingested)

        job.message = "Hashing for near-duplicates"
        hashes = {p.content_hash: neardup.phash(p.path) for p in ingested}

        job.message = "Measuring sharpness"
        for p in ingested:
            feats = cleanliness_features(p.path)
            job.photos[p.content_hash].quality = _quality_from_laplacian(feats.laplacian_variance)
        job.progress = 0.15

        job.status = "embedding"
        job.message = f"Embedding {len(ingested)} photos (DINOv2)"
        content_items = [(p.path, p.content_hash) for p in ingested]
        embeddings = embed_photos(content_items)
        job.progress = 0.55

        job.status = "verifying"
        job.message = "Splitting into cars"
        ordered = sorted(ingested, key=lambda p: p.taken_at)
        cars_photos = timing.split_into_cars(
            [timing.TimedPhoto(id=p.content_hash, taken_at=p.taken_at) for p in ordered],
            NEW_CAR_GAP_MINUTES,
            MAX_CAR_SPAN_HOURS,
        )

        job.cars = []
        total_cars = max(1, len(cars_photos))
        for car_idx, car_timed in enumerate(cars_photos):
            car_ids = [tp.id for tp in car_timed]
            car_photos = [job.photos[i] for i in car_ids]

            same_take: set[tuple[str, str]] = set()
            for i in range(len(car_timed)):
                for j in range(i + 1, min(i + 7, len(car_timed))):
                    a, b = car_timed[i].id, car_timed[j].id
                    if same_take_evidence(neardup.hamming(hashes[a], hashes[b]), NEARDUP_HAMMING_MAX, None, BURST_INLIER_RATIO_MIN):
                        key = (a, b) if a < b else (b, a)
                        same_take.add(key)

            burst_members = [BurstMember(id=p.id, taken_at=p.taken_at, quality=p.quality) for p in car_photos]
            burst_groups = group_bursts_transitive(burst_members, same_take)
            base_bursts = [[m.id for m in g] for g in burst_groups]

            split = timing.split_before_after(car_timed)
            if split is None:
                for p in car_photos:
                    p.side = "unknown"
            else:
                before_ids = {tp.id for tp in split[0]}
                for p in car_photos:
                    p.side = "before" if p.id in before_ids else "after"

            before_reps = [g[0].id for g in burst_groups if job.photos[g[0].id].side == "before"] if split else []
            after_reps = [g[0].id for g in burst_groups if job.photos[g[0].id].side == "after"] if split else []

            pair_scores: dict[tuple[str, str], object] = {}
            if before_reps and after_reps:
                all_reps = before_reps + after_reps
                vecs = [embeddings[i] for i in all_reps]
                mat = cosine_matrix(vecs)
                candidate_idx = [
                    (bi, len(before_reps) + ai)
                    for bi in range(len(before_reps))
                    for ai in range(len(after_reps))
                ]
                scored = shortlist_pairs(all_reps, embeddings, candidate_idx)
                shortlisted = top_k_per_row(scored)

                for bi, aj, cosine in shortlisted:
                    before_id, after_id = all_reps[bi], all_reps[aj]
                    result = verify_pair(job.photos[before_id].path, job.photos[after_id].path)
                    pair_scores[(before_id, after_id)] = fuse(cosine, result.inliers)

            car_name = _car_label(car_photos)
            job.cars.append(
                CarData(
                    id=f"car_{car_idx}",
                    name=car_name,
                    photo_ids=car_ids,
                    base_bursts=base_bursts,
                    pair_scores=pair_scores,
                )
            )
            job.progress = 0.55 + 0.45 * (car_idx + 1) / total_cars

        job.status = "ready"
        job.message = f"{len(job.photos)} photos, {len(job.cars)} cars"
        job.progress = 1.0
    except Exception as exc:  # pragma: no cover - surfaced to the UI, not swallowed
        job.status = "error"
        job.error = str(exc)
        raise


def _car_label(photos: list[PhotoRecord]) -> str:
    import datetime

    if not photos:
        return "Car"
    t = min(p.taken_at for p in photos)
    d = datetime.datetime.fromtimestamp(t / 1000)
    return d.strftime("Car — %b %d, %I:%M %p").replace(" 0", " ")
