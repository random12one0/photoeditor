# Kickoff prompt for the local session

Paste everything below the line into the first message of a Claude Code
session running **locally on this machine** (not a cloud sandbox), opened
in this repo, on branch `claude/card-detailing-photo-editor-2m3w72`.

---

Read `docs/local-desktop-plan.md` first — it's the plan for what we're
building and why. Some context that doesn't fit in that file:

**What this app is.** A free tool for a car-detailing business: import a
day's photos (50–150, multiple cars), automatically group them by car,
match before/after pairs, composite them into Instagram-ready before/after
posts matching the owner's own hand-made editing style, export. No AI-
generated content, no ongoing cost, works well on a phone.

**Where it stands.** `src/` on disk is the currently-shipped v1.5.0
browser-only app — everything runs client-side in JS/TS, no backend. It
works and is reasonably good: `GroupsView` groups photos into cars on a
clock-gap heuristic, `PairView`/`PairByHand` do before/after matching with
a hand-rolled scorer (`src/lib/hash.ts`'s `similarity()` — a weighted blend
of an HSV colour histogram, an edge histogram, a difference hash, and two
luma-correlation grids) plus an ORB-based geometric bonus
(`src/lib/features.ts`, `src/lib/cluster.ts`), `StyleView`/`ExportView`
render and export the composites. `test/` has real-photo fixtures
(gitignored — they're photos of real cars with plates, ask before assuming
you can regenerate them) and diagnostic scripts (`test/diagnose-weights.mjs`
is worth reading — it's how the current scoring weights were fit, and it
found something worth knowing: **19 labelled rows across three photo sets is
not enough to pin down 6 weights.** ~9,000 of 40,000 candidate weightings
tied for best. Picking the single top-scoring one measurably overfits —
proven by leave-one-set-out, where the "best" weighting on two sets scored
8/10, 4/5, 3/4 on the third. What shipped instead is the *centroid* of every
weighting that won every row, which held up under the same test. **Apply the
same discipline to whatever you calibrate now** — don't trust a single best
fit on a small label set; check it generalizes before shipping it.

**Why we're moving to local-desktop.** The obvious next step — a much
stronger matcher (DINOv2 for appearance-invariant global embeddings, XFeat+
LightGlue+RANSAC for real geometric verification instead of hand-rolled
ORB) — needs PyTorch inference, which can't run in a browser or on a free
static host. Rather than compromise the model or pay for hosting, this
becomes a local app: a FastAPI backend on the user's own machine (**RTX
3050, 64GB RAM** — plenty for DINOv2-Large + XFeat/LightGlue on GPU) serving
the same browser UI at `localhost`, reading photos straight off disk. No
upload, no hosting cost, no RAM ceiling.

**What survived vs. what didn't.** The matching-pipeline research and the
UI/architecture spec (constraint log — PIN/FORBID/SIDE/EXCLUDE/BURST_SPLIT/
BURST_MERGE, append-only, undo = pop; a pure re-runnable solver; the four-
step wizard: Bursts → Verify pairs → Fix leftovers → Export) are both
carried forward faithfully in `docs/local-desktop-plan.md`. An earlier
cloud-sandbox attempt at building that rewrite did not survive (see the
plan doc's correction note) — treat `src/` as starting from v1.5.0, not
from any half-finished constraint-log code, because none exists.

**What to actually do:**
1. Verify the three `backend/` scaffold files (`requirements.txt`,
   `config.py`, `models.py`) fit before building on them — they were written
   blind, with no way to test imports or install the dependencies.
2. Set up the Python environment, install `backend/requirements.txt`
   (torch/torchvision — let pip pick CPU or install CUDA build yourself
   first for GPU; kornia; opencv-contrib-python; etc.), confirm
   `torch.cuda.is_available()` sees the 3050.
3. Build and test the pipeline stage by stage against real photos from
   `test/fixtures/` (gitignored, already on disk if this clone has them —
   otherwise ask for a folder of real before/after photos to test against):
   ingest/EXIF → near-dup pre-pass → DINOv2 embedding (cache by content
   hash) → shortlist → XFeat+LightGlue+RANSAC verification → cleanliness/
   time features → score fusion → burst grouping → Hungarian assignment
   (scipy) → tiers.
4. Only once the pipeline actually produces sane rankings on real photos,
   build the FastAPI routes and rewrite the frontend as a thin client
   against them — the four wizard screens, the constraint log, the folder
   picker (Step 0), replacing upload with a native OS dialog.
5. Keep what doesn't need to change: the renderer (`src/lib/render.ts`,
   tuned to match the owner's own reference collages — don't touch its
   defaults without new measurements), the Lab/labelling system
   (`src/lib/labels.ts`, `src/components/LabView.tsx` — this is exactly
   the mechanism to grow past the 19-row calibration problem, keep
   recording judgements and reuse it for real calibration once enough
   accumulate), the Instagram export rules already researched (Original/
   Mixed caps at 3:4, pad don't crop, 20-slide manual-post cap, no API
   posting).
6. Write the launcher scripts (Windows/Mac/Linux) last, once there's an
   actual server worth launching.

Standing rules from earlier work, still in force: Apache-2.0/BSD stack only
(DINOv2, XFeat, LightGlue, kornia, OpenCV, scikit-learn — never SuperPoint/
SuperGlue weights, that's a license rule not a cost one). Measure, don't
guess — every threshold in this codebase so far has a comment explaining
what real photos it was checked against and why; keep that up. Commit and
push to `claude/card-detailing-photo-editor-2m3w72` as you go so work
survives between sessions — nothing here persists otherwise, which is
exactly the failure mode that produced this prompt.

Start with step 1–2 (verify the scaffold, get the environment running) and
report back before going further into the pipeline.
