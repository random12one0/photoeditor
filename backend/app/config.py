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
# XFeat + LightGlueMatcher via kornia. Apache-2.0 — SuperPoint/SuperGlue
# weights are never loaded anywhere in this codebase; that's a licensing
# rule, not a cost-driven choice, and it doesn't change now that this runs
# locally.
VERIFY_LONG_EDGE = 1024
RANSAC_REPROJ_THRESHOLD = 4.0
LOWE_RATIO = 0.82

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
