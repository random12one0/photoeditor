"""
In-memory per-folder job state. Single user, single machine, no database --
a job lives as long as the server process does, same as the constraint log
it holds (docs/local-desktop-plan.md: "no accounts, no auth").
"""

from __future__ import annotations

import itertools
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.models import Constraint
from app.pipeline.score import PairScore


@dataclass
class CarData:
    id: str
    name: str
    photo_ids: list[str]
    base_bursts: list[list[str]]
    pair_scores: dict[tuple[str, str], PairScore] = field(default_factory=dict)


@dataclass
class PhotoRecord:
    id: str
    path: Path
    name: str
    width: int
    height: int
    taken_at: float
    time_is_approximate: bool
    content_hash: str
    quality: float = 0.5
    side: str = "unknown"


@dataclass
class Job:
    id: str
    folder: Path
    status: str = "scanning"  # scanning|embedding|verifying|ready|error
    progress: float = 0.0
    message: str = ""
    photos: dict[str, PhotoRecord] = field(default_factory=dict)
    cars: list[CarData] = field(default_factory=list)
    constraints: list[Constraint] = field(default_factory=list)
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "folder": str(self.folder),
            "photo_count": len(self.photos),
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
        }


_jobs: dict[str, Job] = {}
_counter = itertools.count(1)


def create_job(folder: Path) -> Job:
    job_id = f"job_{int(time.time())}_{next(_counter)}"
    job = Job(id=job_id, folder=folder)
    _jobs[job_id] = job
    return job


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def new_constraint_id() -> str:
    return uuid.uuid4().hex[:12]
