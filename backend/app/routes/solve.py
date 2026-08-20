"""Read-only: solve the whole job fresh from its cached pipeline output plus
whatever's in the constraint log right now. Cheap -- no embeddings or
geometric verification happen here, just the Hungarian assignment -- so the
frontend can call this after every constraint change without a spinner."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app import jobs as jobs_module
from app.models import CarSolution, Photo
from app.solve import solve_job

router = APIRouter()


def _require_job(job_id: str):
    job = jobs_module.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    if job.status != "ready":
        raise HTTPException(409, f"Job is not ready yet (status: {job.status})")
    return job


@router.get("/jobs/{job_id}/solve", response_model=list[CarSolution])
def solve(job_id: str) -> list[CarSolution]:
    job = _require_job(job_id)
    return solve_job(job)


@router.get("/jobs/{job_id}/photos", response_model=list[Photo])
def list_photos(job_id: str) -> list[Photo]:
    job = _require_job(job_id)
    return [
        Photo(
            id=p.id,
            name=p.name,
            path=str(p.path),
            width=p.width,
            height=p.height,
            taken_at=p.taken_at,
            time_is_approximate=p.time_is_approximate,
            thumb_ready=True,
        )
        for p in job.photos.values()
    ]
