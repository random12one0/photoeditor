# Before & After — local desktop plan

Status: **planning document, not yet built.** Written from a cloud sandbox
with no GPU and no access to your machine — real implementation and testing
starts once this session (or a new one) is running locally on your computer,
where I can actually exercise the pipeline against your GPU and your photos.
Everything below is the target to build toward.

## The big picture

The app becomes a **local desktop tool**, not a hosted website:

- A **Python backend** (FastAPI + uvicorn) runs as an ordinary process on
  your computer, bound to `127.0.0.1` only — never reachable from the
  internet, so there's no hosting cost and no exposed attack surface.
- The **frontend is the same browser UI**, served by that same process and
  opened automatically in a normal browser tab at `http://localhost:PORT`.
  It isn't deployed anywhere; it's just how the app draws its screen.
- **Photos are read straight off disk.** You point the app at a folder; the
  backend reads files directly. No upload, no file-size limit, no network
  transfer at all — the photos never leave your machine's own filesystem.
- **One command starts it.** A launcher script creates a virtual
  environment if one doesn't exist, installs dependencies, starts the
  server, and opens the browser tab — so using it feels like opening an
  app, not running a script.

This is a local full-stack app, not a research project. It doesn't need
Electron or Tauri to get started — a local server plus a browser tab is
simpler to build, simpler to debug, and looks identical to the user either
way. If a real native window matters later, wrapping the same backend in
Tauri is a small follow-up, not a rewrite.

## What your hardware buys back

Every constraint that forced compromises earlier (512MB RAM, no GPU, a
paid-or-nothing host, photos leaving the device) is gone. An RTX 3050 with
64GB of system RAM comfortably runs the strongest free stack available,
with room to spare:

| Stage | Model | Fits an RTX 3050? |
|---|---|---|
| Global embedding | **DINOv2-Large** (300M params, Apache-2.0) | Yes, easily — a few ms/photo on GPU |
| Geometric verification | **XFeat + LightGlue** via kornia (Apache-2.0) | Yes — XFeat is designed to be fast even on CPU; GPU makes it faster still |
| Everything else | classical CV (OpenCV, scikit-image) + scikit-learn | Runs on CPU regardless, negligible cost |

150 photos through the full pipeline — embed, shortlist, geometrically
verify every shortlisted pair, fuse scores, assign — should run in well
under a minute on that GPU, most of it spent on embedding. There's no
reason to fall back to a smaller model or a CPU-only path; DINOv2-Large is
the right default. (DINOv2-**giant** — 1.1B params — is available if you
ever want to push further, but Large already matches or beats it on the
appearance-invariance benchmarks that matter here, at a third of the
compute, so it isn't the default.)

## The matching pipeline — final version, no compromises

This is the two-stage hybrid from the original research, unmodified:

```
Ingest & EXIF
   ↓
Near-duplicate pre-pass (dHash/pHash) ──► burst candidates
   ↓
Global embedding (DINOv2-Large) ──► shortlist same-spot candidates
   ↓
Geometric verification (XFeat + LightGlue + RANSAC) ──► inlier count = evidence
   ↓
Cleanliness features (specular highlight, saturation, contrast, edge density,
Laplacian variance) + soft EXIF time clustering
   ↓
Score fusion (logistic regression) + calibration (Platt now, isotonic once
enough labels exist) ──► same-spot probability, direction probability
   ↓
Burst grouping (transitively closed) ──► one representative per burst
   ↓
Hungarian assignment (scipy) within each car ──► pairs / orphans
   ↓
Confidence tiers: confirmed / high / uncertain / unmatched
```

License-wise, nothing changes from the earlier research: DINOv2, XFeat,
LightGlue, kornia, OpenCV, scikit-learn are all Apache-2.0/BSD and fine for
commercial use. SuperPoint/SuperGlue weights are still never loaded
anywhere — that's a licensing rule, not a cost-driven substitution, and it
doesn't relax just because this runs locally now.

**Honest ceiling, restated:** 100% accuracy isn't achievable — before/after
pairs are the hardest positive class by construction (same geometry,
opposite appearance) and orphans create real ambiguity. The design goal is
a small, shrinking review pile, not a perfect first pass. That's what the
confidence tiers and the review screens are for.

## The constraint-log architecture (unchanged from the browser prototype)

This is the actual fix for "rejecting a pair used to delete it forever" —
and it doesn't depend on where matching runs. It moves server-side wholesale:

- **Solver layer** — a pure function: `(photos, score matrix, constraints)
  → complete solution`. Same inputs, same output, every time. Runs on the
  backend now, but the property that matters is unchanged: nothing is ever
  consumed, everything is re-derived fresh on every call.
- **Constraint layer** — the only thing the UI edits: `PIN`, `FORBID`,
  `SIDE`, `EXCLUDE`, `BURST_SPLIT`/`BURST_MERGE`. An append-only log;
  undo is popping it.
- **Presentation layer** — the four-step wizard (Bursts → Verify pairs →
  Fix leftovers → Export), now a thin client that reads solutions from the
  backend and posts constraints to it, instead of computing anything itself.

Two adjustments from the original UI spec, both purely about no longer
having a network step:

1. **Step 0 is "Choose a folder"**, not "Upload." A native OS folder picker
   (Python's `tkinter.filedialog`, no extra dependency) hands the backend a
   path; it reads that folder directly. No progress bar for a transfer that
   isn't happening.
2. **No accounts, no auth.** Single user, single machine — anything in the
   original spec that implied multiple people or remote jobs is dropped.

Export is unchanged from the earlier plan: composites (or standalone
"money shot" singles, padded to 3:4 only when Instagram's own uploader
would otherwise crop them) land in a local folder or a ZIP, get carried to
your phone by AirDrop or a cable, and get posted through the Instagram app
by hand — the API route was already ruled out (forces uniform cropping,
needs Meta review, isn't worth it for one photographer's own account).

## What ships in the repo

```
backend/
  requirements.txt
  app/
    main.py            FastAPI app, serves the built frontend + the API
    config.py           thresholds, cache paths, model names
    models.py            wire types — mirrors the frontend's Photo/Burst/
                          Constraint/CarSolution shapes directly
    constraints.py       append-only log + resolver (server-side port of
                          the browser prototype's constraints.ts)
    jobs.py               in-memory per-folder job state
    browse.py              native folder-picker endpoint
    pipeline/
      ingest.py, neardup.py, embed.py, shortlist.py, verify.py,
      cleanliness.py, timing.py, score.py, bursts.py, assign.py, solver.py
    routes/
      jobs.py, solve.py, constraints.py, images.py, export.py, browse.py
run.sh / run.command / run.bat     one-command launchers, all three platforms
src/                                the existing Vite/React frontend, cut
                                     over from local computation to an API
                                     client hitting the backend above
```

The frontend keeps its existing look and the wizard screens already
sketched (Bursts, Pairs) — those get finished and adapted to pull data from
the API instead of computing it in the browser, rather than rebuilt from
scratch.

## Sequencing

1. **This planning doc** — done.
2. **Move to your machine.** Once a session is running locally (rather than
   this cloud sandbox), I can install the real dependencies, use your GPU,
   and test against actual photos end to end — which is the only way any
   of this gets *validated*, not just written.
3. **Backend pipeline**, built and tested stage by stage against a handful
   of your real jobs — embeddings and shortlisting first (cheap to verify),
   then geometric verification, then the full fusion + assignment.
4. **Frontend cutover** — wire the wizard to the running backend, finish
   the two screens not yet built (Leftovers, Export).
5. **Launcher scripts**, tested actually double-clicking them.
6. **A real job, start to finish** — folder in, review, export, post.

Nothing here is committed as working code yet. The three small backend
scaffold files already in `backend/` (`requirements.txt`, `config.py`,
`models.py`) are groundwork for step 3, not a finished implementation.
