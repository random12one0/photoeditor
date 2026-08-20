"""Glue between jobs.Job's stored pipeline output and pipeline.solver's pure
solve_car function, producing the wire-shaped models.CarSolution list."""

from __future__ import annotations

from app.jobs import Job
from app.models import Burst, CarSolution, SolvedPair
from app.pipeline.solver import SolverPhoto, solve_car


def solve_job(job: Job) -> list[CarSolution]:
    out: list[CarSolution] = []
    for car in job.cars:
        photos = [
            SolverPhoto(
                id=pid,
                taken_at=job.photos[pid].taken_at,
                quality=job.photos[pid].quality,
                side=job.photos[pid].side,
            )
            for pid in car.photo_ids
        ]
        solution = solve_car(photos, car.pair_scores, car.base_bursts, job.constraints)

        out.append(
            CarSolution(
                id=car.id,
                name=car.name,
                bursts=[
                    Burst(id=b.id, photo_ids=b.photo_ids, representative_id=b.representative_id, side=b.side)
                    for b in solution.bursts
                ],
                pairs=[
                    SolvedPair(
                        id=p.id,
                        before_id=p.before_id,
                        after_id=p.after_id,
                        score=p.score,
                        tier=p.tier,
                        car_id=car.id,
                        inliers=p.inliers,
                    )
                    for p in solution.pairs
                ],
                orphan_afters=solution.orphan_afters,
                orphan_befores=solution.orphan_befores,
                unknown_side=solution.unknown_side,
            )
        )
    return out
