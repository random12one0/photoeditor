"""
Geometric verification: does a shortlisted pair actually show the same
physical framing, not just similar colours/texture?

Deviation from the plan doc, found by testing rather than assumed: kornia's
`LightGlueMatcher` (kornia.feature) only ships weights trained for
aliked/disk/superpoint/sift/etc — `known_modes` has no 'xfeat' entry, so it
cannot consume XFeat descriptors. The XFeat authors' own answer to this is
their bundled matcher (`match_xfeat_star`, coarse-to-fine, mutual nearest
neighbour + local refinement — part of the same Apache-2.0 XFeat package),
which is what this module uses instead. RANSAC-verified inlier count is the
same evidence either way; only the matcher underneath it changed. Still
Apache-2.0 end to end (XFeat + OpenCV), still no SuperPoint/SuperGlue weights
anywhere.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import kornia.feature as KF
import numpy as np
import torch
from PIL import Image

from app.config import RANSAC_REPROJ_THRESHOLD, VERIFY_LONG_EDGE

_xfeat = None
_device = None


def _load():
    global _xfeat, _device
    if _xfeat is not None:
        return
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    # KF.XFeat() alone builds an untrained network -- from_pretrained() is
    # what actually loads the released weights. Confirmed by testing: without
    # it, mutual-NN matching on two literal near-duplicate frames returns 1
    # match out of ~4096 keypoints each, because the descriptors are random.
    _xfeat = KF.XFeat.from_pretrained().to(_device).eval()


def _load_resized_tensor(path: Path, long_edge: int = VERIFY_LONG_EDGE) -> torch.Tensor:
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        scale = long_edge / max(w, h)
        if scale < 1:
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.BILINEAR)
        arr = np.asarray(im, dtype=np.float32) / 255.0
    t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
    return t


class VerifyResult:
    __slots__ = ("inliers", "candidates", "homography")

    def __init__(self, inliers: int, candidates: int, homography: np.ndarray | None):
        self.inliers = inliers
        self.candidates = candidates
        self.homography = homography

    @property
    def score(self) -> float:
        # Same saturating shape as the browser prototype's ORB score
        # (features.ts), so downstream fusion code can treat the two
        # interchangeably. Never below 0 even for candidates < 2.
        import math

        return 1 - math.exp(-max(0, self.inliers - 2) / 12)


@torch.inference_mode()
def verify_pair(path_a: Path, path_b: Path) -> VerifyResult:
    _load()
    t1 = _load_resized_tensor(path_a).to(_device)
    t2 = _load_resized_tensor(path_b).to(_device)

    mkpts0, mkpts1 = _xfeat.match_xfeat_star(t1, t2)
    mkpts0 = mkpts0.cpu().numpy() if torch.is_tensor(mkpts0) else np.asarray(mkpts0)
    mkpts1 = mkpts1.cpu().numpy() if torch.is_tensor(mkpts1) else np.asarray(mkpts1)

    candidates = int(mkpts0.shape[0])
    if candidates < 4:
        return VerifyResult(inliers=0, candidates=candidates, homography=None)

    H, mask = cv2.findHomography(
        mkpts0, mkpts1, cv2.USAC_MAGSAC, RANSAC_REPROJ_THRESHOLD, confidence=0.999, maxIters=5000
    )
    if H is None or mask is None:
        return VerifyResult(inliers=0, candidates=candidates, homography=None)
    inliers = int(mask.sum())
    return VerifyResult(inliers=inliers, candidates=candidates, homography=H)
