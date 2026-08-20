"""
Ingest a folder: find real photos, pull EXIF capture time, hash content for
caching, and record dimensions. Mirrors src/lib/ingest.ts's readHeader, but
reading straight from disk instead of a browser File.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import exifread
from PIL import Image

# What the app treats as a photo. Videos (.MOV/.MP4) and anything else in an
# iCloud export are skipped, not errored on — a folder is a day's camera roll,
# not a curated set.
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}


@dataclass
class IngestedPhoto:
    path: Path
    content_hash: str
    width: int
    height: int
    taken_at: float  # epoch ms
    time_is_approximate: bool


def _content_hash(path: Path) -> str:
    """SHA-256 of file bytes. This is the cache key everywhere downstream —
    embeddings, thumbnails, verification results — so a re-run of the same
    folder, or a folder sharing photos with a previous job, costs nothing."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _parse_exif_datetime(value: str) -> float | None:
    # EXIF datetimes are "YYYY:MM:DD HH:MM:SS", no timezone. Treated as naive
    # local time, matching what the camera's clock actually recorded and what
    # the browser prototype did with exifr (which also ignores tz offsets).
    import datetime

    try:
        dt = datetime.datetime.strptime(value.strip(), "%Y:%m:%d %H:%M:%S")
        return dt.timestamp() * 1000
    except ValueError:
        return None


def read_header(path: Path) -> tuple[float, bool, tuple[int, int] | None]:
    """(taken_at_ms, is_approximate, (width, height)|None).

    EXIF DateTimeOriginal first, then CreateDate/ModifyDate, then falls back
    to the file's mtime (approximate=True) — same fallback order as
    ingest.ts's readHeader.
    """
    taken_at: float | None = None
    size: tuple[int, int] | None = None

    try:
        with path.open("rb") as f:
            tags = exifread.process_file(f, details=False, stop_tag="JPEGThumbnail")
        for key in ("EXIF DateTimeOriginal", "Image DateTime", "EXIF DateTimeDigitized"):
            if key in tags:
                taken_at = _parse_exif_datetime(str(tags[key]))
                if taken_at is not None:
                    break
        w = tags.get("EXIF ExifImageWidth") or tags.get("Image ImageWidth")
        h = tags.get("EXIF ExifImageLength") or tags.get("Image ImageLength")
        if w is not None and h is not None:
            size = (int(str(w)), int(str(h)))
    except Exception:
        pass

    approximate = taken_at is None
    if taken_at is None:
        taken_at = path.stat().st_mtime * 1000

    if size is None:
        with Image.open(path) as im:
            size = im.size

    return taken_at, approximate, size


def ingest_folder(
    folder: Path,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[IngestedPhoto]:
    """`on_progress(done, total)` fires after every candidate file, `total`
    fixed up front from a directory listing. Reading EXIF and hashing a
    couple hundred photos is seconds, not instant -- without this the whole
    ingest step reports nothing until it's entirely finished, which reads as
    hung on a larger folder."""
    candidates = [
        e for e in sorted(folder.iterdir()) if e.is_file() and e.suffix.lower() in IMAGE_EXTENSIONS
    ]
    photos: list[IngestedPhoto] = []
    for i, entry in enumerate(candidates):
        taken_at, approximate, size = read_header(entry)
        if size is not None:
            photos.append(
                IngestedPhoto(
                    path=entry,
                    content_hash=_content_hash(entry),
                    width=size[0],
                    height=size[1],
                    taken_at=taken_at,
                    time_is_approximate=approximate,
                )
            )
        if on_progress:
            on_progress(i + 1, len(candidates))
    photos.sort(key=lambda p: p.taken_at)
    return photos
