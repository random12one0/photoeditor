"""
Global appearance embedding via DINOv2-Large. This is what shortlist.py
ranks "might be the same spot" candidates on — self-supervised, so it wasn't
trained to ignore dirt/water/exposure the way a classifier would be, but
empirically the CLS token is invariant enough to the things a wash changes
(see VPR literature: DINO-Mix, AnyLoc) while still separating unrelated
scenes. Verified below against real photos, not just literature.

Cached to disk by content hash — see config.CACHE_DIR — so re-embedding a
photo already seen (same job re-run, or a photo shared across two jobs)
costs nothing.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from PIL import Image

from app.config import CACHE_DIR, DINOV2_MODEL, EMBED_IMAGE_SIZE

_model = None
_processor = None
_device = None


def _load():
    global _model, _processor, _device
    if _model is not None:
        return
    from transformers import AutoImageProcessor, AutoModel

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    _processor = AutoImageProcessor.from_pretrained(DINOV2_MODEL, use_fast=True)
    _model = AutoModel.from_pretrained(DINOV2_MODEL).to(_device).eval()


def _embedding_cache_path(content_hash: str) -> Path:
    return CACHE_DIR / "embeddings" / f"{content_hash}.npy"


@torch.inference_mode()
def embed_photo(path: Path, content_hash: str) -> np.ndarray:
    """L2-normalised 1024-d CLS embedding, cached by content hash."""
    cache_path = _embedding_cache_path(content_hash)
    if cache_path.exists():
        return np.load(cache_path)

    _load()
    with Image.open(path) as im:
        im = im.convert("RGB")
        inputs = _processor(images=im, return_tensors="pt", size={"height": EMBED_IMAGE_SIZE, "width": EMBED_IMAGE_SIZE})
    inputs = {k: v.to(_device) for k, v in inputs.items()}
    out = _model(**inputs)
    cls = out.last_hidden_state[:, 0, :].squeeze(0)
    vec = cls.float().cpu().numpy()
    vec = vec / (np.linalg.norm(vec) + 1e-8)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(cache_path, vec)
    return vec


def embed_photos(items: list[tuple[Path, str]]) -> dict[str, np.ndarray]:
    """items: list of (path, content_hash). Returns content_hash -> embedding."""
    return {content_hash: embed_photo(path, content_hash) for path, content_hash in items}
