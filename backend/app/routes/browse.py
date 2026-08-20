"""Native OS folder picker -- step 0 of the wizard. tkinter ships with the
Python standard library, so this needs no extra dependency, matching the
plan doc's call for "no upload, no accounts"."""

from __future__ import annotations

from fastapi import APIRouter

from app.models import BrowseResult

router = APIRouter()


@router.post("/browse", response_model=BrowseResult)
def browse_folder() -> BrowseResult:
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        path = filedialog.askdirectory(title="Choose a folder of photos")
    finally:
        root.destroy()

    if not path:
        return BrowseResult(cancelled=True)
    return BrowseResult(path=path)
