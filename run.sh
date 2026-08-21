#!/usr/bin/env bash
# One-command launcher for Linux (and macOS, via run.command). Creates the
# Python venv and builds the frontend the first time, then just starts the
# server on every run after that.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Before & After -- starting up..."

ROOT="$(pwd)"
VENV_PY="$ROOT/backend/.venv/bin/python"

if [ ! -x "$VENV_PY" ]; then
    echo "Setting up the Python environment for the first time -- this happens once."
    PY=python3
    command -v python3 >/dev/null 2>&1 || PY=python
    "$PY" -m venv backend/.venv
    "$VENV_PY" -m pip install --upgrade pip >/dev/null

    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "NVIDIA GPU detected -- installing the CUDA build of PyTorch (this is the big download, one time only)."
        "$VENV_PY" -m pip install "torch>=2.2,<3" "torchvision>=0.17,<1" --index-url https://download.pytorch.org/whl/cu124
    else
        echo "No NVIDIA GPU detected -- installing the CPU build of PyTorch. Matching will be slower."
    fi

    echo "Installing the rest of the backend..."
    "$VENV_PY" -m pip install -r backend/requirements.txt
fi

# Always re-check, not just on first setup -- pip skips anything already
# satisfied in a couple seconds, and it means a requirements.txt change
# (like adding pywebview) actually reaches an existing install.
"$VENV_PY" -m pip install -q -r backend/requirements.txt

if [ ! -f "dist/index.html" ]; then
    command -v npm >/dev/null 2>&1 || {
        echo "npm was not found on PATH. Install Node.js from nodejs.org, then run this again."
        exit 1
    }
    echo "Building the app -- this happens once, or after an update."
    npm install
    npm run build
fi

echo "Opening Before & After..."
# app/desktop.py opens a native window via pywebview instead of a browser
# tab. On macOS this needs PyObjC (pulled in by pywebview's own deps); on
# Linux it needs a GTK+WebKit2 stack that isn't always present out of the
# box (`pip install pywebview[gtk]` plus your distro's webkit2gtk package).
# Windows is the tested platform (WebView2 ships with Edge); this hasn't
# been run on Mac or Linux.
cd "$ROOT/backend"
exec "$VENV_PY" -m app.desktop
