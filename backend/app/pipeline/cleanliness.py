"""
Cleanliness features: a rough "how clean does this surface look" score,
used to break before/after direction ties when geometry and appearance are
otherwise symmetric (verify.py's inlier count says two photos are the same
framing, but says nothing about which one is the dirty one).

Five cheap per-photo numbers, computed once and cached like everything else
in the pipeline is meant to be:

  saturation        mean HSV saturation. Clean paint reflects colour more
                     cleanly; a dust/grime film desaturates it.
  contrast           std of luma. Dirt flattens local contrast.
  edge_density        fraction of pixels Canny calls an edge. A clean panel
                     still has real edges (trim, seams); a dusty one adds a
                     lot of weak, directionless texture that Canny's
                     hysteresis mostly rejects, so this leans mildly
                     positive for clean, not a strong signal alone.
  laplacian_variance   focus measure (blur detector), included so a soft/
                     motion-blurred shot doesn't get misread as "dirty" by
                     the other four.
  specular_fraction    fraction of near-white, low-saturation pixels — wet
                     or freshly-waxed paint throws these; dry dirty paint
                     doesn't. Kept separate rather than folded into
                     saturation because it points the opposite direction
                     from grime (dirty = desaturated AND non-specular; wet
                     clean = high specular).

No fusion weights here — score.py decides how (or whether) to use these;
this module only measures.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

FEATURE_EDGE = 640  # downscale target; these are coarse statistics, not detection


@dataclass
class CleanlinessFeatures:
    saturation: float
    contrast: float
    edge_density: float
    laplacian_variance: float
    specular_fraction: float


def _load_bgr(path: Path, long_edge: int = FEATURE_EDGE) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    h, w = img.shape[:2]
    scale = long_edge / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    return img


def cleanliness_features(path: Path) -> CleanlinessFeatures:
    bgr = _load_bgr(path)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

    saturation = float(hsv[:, :, 1].mean()) / 255.0
    contrast = float(gray.std()) / 255.0

    edges = cv2.Canny(gray, 80, 160)
    edge_density = float((edges > 0).mean())

    laplacian_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    v = hsv[:, :, 2].astype(np.float32) / 255.0
    s = hsv[:, :, 1].astype(np.float32) / 255.0
    specular_mask = (v > 0.85) & (s < 0.25)
    specular_fraction = float(specular_mask.mean())

    return CleanlinessFeatures(
        saturation=saturation,
        contrast=contrast,
        edge_density=edge_density,
        laplacian_variance=laplacian_variance,
        specular_fraction=specular_fraction,
    )
