"""FastAPI app: binds to 127.0.0.1 only (see run.py at the repo root / the
launcher scripts) -- never reachable from the internet, so no auth, no
hosting cost, no exposed attack surface. Serves the API under /api and,
once the frontend is built, the built static site at /."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.routes import browse, constraints, images, jobs, solve

app = FastAPI(title="Before & After")

# Only matters for `npm run dev` (Vite on :5173) talking to this server on
# :8420 during development. The built frontend is served from this same
# origin in the shipped launcher, so no CORS is needed there.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(browse.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(solve.router, prefix="/api")
app.include_router(constraints.router, prefix="/api")
app.include_router(images.router, prefix="/api")


@app.get("/api/health")
def health() -> dict:
    import torch

    return {"ok": True, "cuda": torch.cuda.is_available()}


_frontend_dist = Path(__file__).resolve().parent.parent.parent / "dist"
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
