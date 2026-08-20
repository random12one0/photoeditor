"""
Tunable constants, in one place.

Every number here either comes from the research the app was designed
against (see the matching-pipeline spec this backend implements) or is a
documented default awaiting real calibration data — never a silent guess.
"""

from __future__ import annotations

import os
from pathlib import Path

# Where cached embeddings, verification results, and thumbnails live. Keyed
# by content hash, never by job, so re-running the same folder — or a folder
# that shares photos with another job — costs nothing the second time.
CACHE_DIR = Path(os.environ.get("BEFORE_AFTER_CACHE", Path.home() / ".before-after-cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
(CACHE_DIR / "embeddings").mkdir(exist_ok=True)
(CACHE_DIR / "thumbs").mkdir(exist_ok=True)

# Long edge of the in-browser preview. Matches the old client-side constant —
# big enough to review, small enough that 150 of them load instantly.
THUMB_MAX_EDGE = 1000

# --- Global embedding -------------------------------------------------------
# Apache-2.0. facebook/dinov2-large: 1024-d CLS token, self-supervised,
# empirically the most appearance-invariant free option available (see
# DINO-Mix, MegaLoc, AnyLoc — the VPR literature this stack borrows from).
DINOV2_MODEL = os.environ.get("BEFORE_AFTER_DINOV2_MODEL", "facebook/dinov2-large")
EMBED_IMAGE_SIZE = 518  # DINOv2's native patch grid resolution

# --- Near-duplicate pre-pass -------------------------------------------------
HASH_SIZE = 8
NEARDUP_HAMMING_MAX = 6

# --- Shortlist ---------------------------------------------------------------
SHORTLIST_FLOOR = 0.5  # cosine similarity
SHORTLIST_TOP_K = 15

# --- Geometric verification --------------------------------------------------
# XFeat + its own bundled matcher (match_xfeat_star) via kornia, then
# OpenCV RANSAC. Deviation from the original plan, found by testing rather
# than assumed: kornia's LightGlueMatcher only has weights for
# aliked/disk/superpoint/sift-family extractors (`known_modes`), not xfeat,
# so it cannot consume XFeat descriptors. XFeat's own matcher is part of the
# same Apache-2.0 package and gives the same kind of evidence (RANSAC inlier
# count). Still no SuperPoint/SuperGlue weights anywhere.
VERIFY_LONG_EDGE = 1024
RANSAC_REPROJ_THRESHOLD = 4.0
LOWE_RATIO = 0.82

# Checked against real photos from a live job folder (2026-08-19 local
# session): a genuine before/after pair (same trunk, debris vs vacuumed)
# scored 60-313 inliers across 4 sampled pairs; unrelated pairs from the same
# folder scored 5-11. 20 sits in the gap, close to the unrelated side since
# the sample is still small (same "don't trust a single small label set"
# caution as hash.ts's FEATURE_MIN_INLIERS) — revisit once LabView judgements
# accumulate.
VERIFY_MIN_INLIERS = 20

# --- Burst grouping ------------------------------------------------------
# 8s default per the matching spec, falling back to 20s when sub-second EXIF
# is missing — which, per the same spec, it very often is once a photo has
# been through any re-encoding step. 45s is used instead here, the same
# measured number the browser prototype settled on from a real report of
# close-up shots (different spots on one panel, deliberately a bit apart)
# being wrongly collapsed under a shorter window.
BURST_WINDOW_SECONDS = 45
BURST_HAMMING_MAX = 6  # perceptual-hash agreement, OR:
BURST_INLIER_RATIO_MIN = 0.6  # geometric agreement — either is enough

# --- Time clustering -----------------------------------------------------
MIN_JOB_GAP_SECONDS = 180  # under this, a car has no detected before/after job

# --- Score fusion & tiers --------------------------------------------------
# No labelled-enough set exists yet to fit Platt/isotonic calibration on —
# see routes/constraints.py, which is exactly how one gets built (every
# confirm/reject is written to the label store). Until then these are
# documented defaults per the matching spec's own guidance ("ship sensible
# default thresholds if no labels yet"), not a trained probability.
DEFAULT_SAME_SPOT_AUTO_ACCEPT = 0.85
DEFAULT_SAME_SPOT_REVIEW_FLOOR = 0.55
CALIBRATION_MIN_LABELS_FOR_ISOTONIC = 300

# --- Snow-foam shots -------------------------------------------------------
# A car fully coated in cannon foam (a fun/Instagram shot, not a wash step)
# has no real "after" partner and shouldn't be offered as one. Tried to
# detect this automatically from color/brightness/texture statistics and it
# doesn't hold up: checked against a real foam photo and a real glossy-white
# close-up from the same job, and the white paint scored *more* foam-like
# than the actual foam on every measure tried (specular coverage, whole-
# frame desaturation, edge density, gradient-orientation entropy) -- foam
# and bright neutral paint are too close in basic pixel statistics to tell
# apart this way, which is exactly the false-positive this would have to
# avoid. No constant here; handled instead by a manual "not part of the
# wash" flag in the Bursts screen (routes/constraints.py's plain `exclude`),
# which a person can apply in one click with zero false-positive risk.
