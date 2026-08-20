"""Create a job for a folder and poll its progress. The actual pipeline run
happens in a background thread (run_pipeline does synchronous, blocking
work -- torch/opencv calls, not asyncio-friendly) so the create call returns
immediately and the frontend polls GET .../jobs/{id} for status."""

from __future__ import annotations

import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import jobs as jobs_module
from app.models import JobSummary
from app.pipeline.run import run_pipeline

router = APIRouter()


class CreateJobRequest(BaseModel):
    folder: str


@router.post("/jobs", response_model=JobSummary)
def create_job(req: CreateJobRequest) -> JobSummary:
    folder = Path(req.folder)
    if not folder.is_dir():
        raise HTTPException(400, f"Not a folder: {req.folder}")

    job = jobs_module.create_job(folder)
    thread = threading.Thread(target=run_pipeline, args=(job,), daemon=True)
    thread.start()
    return JobSummary(**job.summary())


@router.get("/jobs/{job_id}", response_model=JobSummary)
def get_job(job_id: str) -> JobSummary:
    job = jobs_module.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    summary = job.summary()
    if job.status == "error":
        summary["message"] = job.error or "Something went wrong"
    return JobSummary(**summary)
