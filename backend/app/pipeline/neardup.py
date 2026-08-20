"""
Near-duplicate pre-pass: a cheap perceptual-hash pass that flags photos which
might be the same take, re-shot handheld a second later. Cheap enough to run
on every photo before anything touches the GPU; bursts.py combines this with
geometric agreement to make the real call.
"""

from __future__ import annotations

from pathlib import Path

import imagehash
from PIL import Image

from app.config import HASH_SIZE, NEARDUP_HAMMING_MAX


def phash(path: Path) -> imagehash.ImageHash:
    with Image.open(path) as im:
        im = im.convert("RGB")
        return imagehash.phash(im, hash_size=HASH_SIZE)


def hamming(a: imagehash.ImageHash, b: imagehash.ImageHash) -> int:
    return a - b


def near_dup_candidates(
    hashes: dict[str, imagehash.ImageHash],
    order: list[str],
    max_distance: int = NEARDUP_HAMMING_MAX,
) -> list[tuple[str, str]]:
    """Pairs of content hashes worth treating as possible same-take burst
    members. Only checks adjacent-in-time photos (`order`) against a small
    lookahead window — an O(n) pass, not O(n^2), since a burst is by
    definition consecutive in time."""
    pairs: list[tuple[str, str]] = []
    lookahead = 6
    for i, a in enumerate(order):
        for j in range(i + 1, min(i + 1 + lookahead, len(order))):
            b = order[j]
            if hamming(hashes[a], hashes[b]) <= max_distance:
                pairs.append((a, b))
    return pairs
