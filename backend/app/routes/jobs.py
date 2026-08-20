"""Create a job for a folder and track its progress. The actual pipeline run
happens in a background thread (run_pipeline does synchronous, blocking
work -- torch/opencv calls, not asyncio-friendly) so the create call returns
immediately."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
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
    return JobSummary(**_summary_with_error(job))


def _summary_with_error(job: jobs_module.Job) -> dict:
    summary = job.summary()
    if job.status == "error":
        summary["message"] = job.error or "Something went wrong"
    return summary


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    """Server-push status, over SSE, in place of the frontend polling on its
    own timer -- a plain client-side setTimeout loop turned out to be
    fragile in at least one real browser session (silently stopped
    advancing even though the job had actually finished; not reproducible
    in testing, so rather than keep guessing at the cause, this removes the
    class of bug by having the server announce state changes instead of the
    client having to keep asking). EventSource reconnects on its own if the
    connection drops, which a hand-rolled retry loop doesn't get for free.

    The generator only *reads* job attributes, mutated from run_pipeline's
    background thread -- safe without a lock for simple attribute reads
    (each read is atomic under the GIL); nothing here writes to the job.
    """

    async def stream():
        job = jobs_module.get_job(job_id)
        if job is None:
            yield f"data: {json.dumps({'error': 'No such job'})}\n\n"
            return

        last: dict | None = None
        while True:
            summary = _summary_with_error(job)
            if summary != last:
                yield f"data: {json.dumps(summary)}\n\n"
                last = summary
            if job.status in ("ready", "error"):
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
