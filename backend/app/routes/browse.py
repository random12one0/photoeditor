"""Native OS folder picker -- step 0 of the wizard.

Two implementations, chosen at request time:

Running as the desktop app (app/desktop.py -- the shipped launcher and the
packaged .exe), pywebview already owns the OS window and its native message
loop on the main thread. tkinter's dialog was tried first here because it
needs no extra dependency, but it doesn't work in that setup: creating a Tk
root and calling askdirectory() from this route's threadpool worker thread
never produces a visible window -- confirmed by reproducing it directly
(a background thread stuck inside askdirectory() forever, no window, no
error, while a webview window created on the main thread in the same
process shows up fine). Two native GUI toolkits, two competing ideas about
who owns the message loop. Since pywebview already has a working native
folder dialog built in (window.create_file_dialog), and it's designed to be
called safely from any thread, that's what desktop mode uses instead --
one GUI toolkit, not two.

Running as a plain browser tab (`npm run dev`, or uvicorn without desktop.py
-- no competing window to conflict with) tkinter works fine and stays as
the fallback, so this route doesn't hard-depend on pywebview.
"""

from __future__ import annotations

from fastapi import APIRouter

from app import desktop_state
from app.models import BrowseResult

router = APIRouter()


def _browse_via_webview() -> str | None:
    import webview

    window = desktop_state.window
    assert window is not None
    result = window.create_file_dialog(webview.FileDialog.FOLDER)
    return result[0] if result else None


def _browse_via_tkinter() -> str | None:
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return filedialog.askdirectory(title="Choose a folder of photos") or None
    finally:
        root.destroy()


@router.post("/browse", response_model=BrowseResult)
def browse_folder() -> BrowseResult:
    path = _browse_via_webview() if desktop_state.window is not None else _browse_via_tkinter()
    if not path:
        return BrowseResult(cancelled=True)
    return BrowseResult(path=path)
