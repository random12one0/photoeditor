"""The constraint log: append a user decision, or undo (pop) the most recent
one. Never rewritten, never edited in place -- see pipeline/solver.py's
docstring for why that's the whole point."""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException

from app import jobs as jobs_module
from app.models import CarSolution, Constraint, ConstraintIn
from app.solve import solve_job

router = APIRouter()


@router.get("/jobs/{job_id}/constraints", response_model=list[Constraint])
def list_constraints(job_id: str) -> list[Constraint]:
    job = jobs_module.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    return job.constraints


@router.post("/jobs/{job_id}/constraints", response_model=list[CarSolution])
def add_constraint(job_id: str, body: ConstraintIn) -> list[CarSolution]:
    job = jobs_module.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    with job.lock:
        job.constraints.append(
            Constraint(
                id=jobs_module.new_constraint_id(),
                at=time.time() * 1000,
                type=body.type,
                before=body.before,
                after=body.after,
                photo_id=body.photo_id,
                side=body.side,
                a=body.a,
                b=body.b,
            )
        )
    return solve_job(job)


@router.delete("/jobs/{job_id}/constraints/last", response_model=list[CarSolution])
def undo_last_constraint(job_id: str) -> list[CarSolution]:
    job = jobs_module.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    with job.lock:
        if job.constraints:
            job.constraints.pop()
    return solve_job(job)
