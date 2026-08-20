"""Serve photo bytes straight off disk -- thumbnails for review screens,
full-resolution for the client-side renderer's export pass. No upload ever
happens; this is the read side of "photos never leave the machine's own
filesystem" (they don't leave it now either -- they're served to a browser
tab on the same machine)."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from PIL import Image

from app import jobs as jobs_module
from app.config import CACHE_DIR, THUMB_MAX_EDGE

router = APIRouter()


def _thumb_path(content_hash: str) -> Path:
    return CACHE_DIR / "thumbs" / f"{content_hash}.jpg"


@router.get("/jobs/{job_id}/images/{photo_id}")
def get_image(job_id: str, photo_id: str, full: bool = False):
    job = jobs_module.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    photo = job.photos.get(photo_id)
    if photo is None:
        raise HTTPException(404, "No such photo")

    if full:
        return FileResponse(photo.path)

    thumb = _thumb_path(photo_id)
    if not thumb.exists():
        thumb.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(photo.path) as im:
            im = im.convert("RGB")
            w, h = im.size
            scale = THUMB_MAX_EDGE / max(w, h)
            if scale < 1:
                im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.BILINEAR)
            im.save(thumb, "JPEG", quality=85)
    return FileResponse(thumb)
