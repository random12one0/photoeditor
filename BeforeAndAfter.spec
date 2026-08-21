# -*- mode: python ; coding: utf-8 -*-
#
# Folder build (COLLECT), not one-file: a one-file exe would have to
# self-extract several GB of torch/CUDA on every single launch, which turns
# "double-click to open" into a multi-minute wait every time. This produces
# dist_exe/BeforeAndAfter/BeforeAndAfter.exe plus its dependencies alongside
# it -- still just one thing to double-click, opens instantly every time
# after the first.
#
# Build with: pyinstaller BeforeAndAfter.spec --noconfirm
# (run from the repo root, with backend/.venv activated or referenced by
# the venv's own pyinstaller -- see run.bat for the build helper)

import os

from PyInstaller.utils.hooks import collect_all

ROOT = os.getcwd()
BACKEND = os.path.join(ROOT, "backend")
FRONTEND_DIST = os.path.join(ROOT, "dist")

datas = [(FRONTEND_DIST, "dist")]
binaries = []
hiddenimports = []

# Packages known for dynamic/lazy imports that PyInstaller's static analysis
# alone tends to miss -- collect_all is a sledgehammer (bundles more than is
# strictly used) but reliable, and bundle size is already dominated by torch
# regardless. torch/torchvision itself is deliberately NOT collect_all'd
# here -- pyinstaller-hooks-contrib ships a maintained hook for it, and
# collect_all-ing torch on top of that hook has been a known source of
# duplicate/broken CUDA DLL bundling in other projects.
for pkg in ("transformers", "kornia", "timm", "torchvision", "uvicorn", "webview", "exifread", "imagehash"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(BACKEND, "app", "desktop.py")],
    pathex=[BACKEND],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    # tkinter is NOT excluded -- routes/browse.py uses it for the native
    # folder picker, easy to miss since nothing imports it at module level.
    excludes=["matplotlib", "notebook", "IPython", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BeforeAndAfter",
    console=False,
    icon=os.path.join(BACKEND, "app", "icon.ico") if os.path.exists(os.path.join(BACKEND, "app", "icon.ico")) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="BeforeAndAfter",
)
