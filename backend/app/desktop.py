"""
Native window entry point. run.bat launches this instead of opening a
browser tab -- pywebview wraps the same FastAPI app in an OS window (Edge's
WebView2 engine on Windows, already installed on any modern Windows 10/11
machine since it ships with Edge), so this reads as its own app: a taskbar
entry, no address bar, no sense of "a browser tab pointed at a server".

The server and the window share one Python process. Closing the window
ends the process -- the server thread is a daemon thread, so nothing needs
an explicit shutdown call.
"""

from __future__ import annotations

import os
import threading
import time
import urllib.error
import urllib.request

import uvicorn
import webview

from app.config import CACHE_DIR
from app.main import app

HOST = "127.0.0.1"
PORT = int(os.environ.get("BEFORE_AFTER_PORT", "8420"))


def _run_server() -> None:
    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="warning")
    uvicorn.Server(config).run()


def _wait_until_up(timeout_s: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout_s
    url = f"http://{HOST}:{PORT}/api/health"
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.15)
    return False


def main() -> None:
    threading.Thread(target=_run_server, daemon=True).start()
    _wait_until_up()  # best-effort; the window still shows a retry-able page if this times out

    webview.create_window(
        "Before & After",
        f"http://{HOST}:{PORT}/",
        width=1320,
        height=880,
        min_size=(760, 600),
    )
    # private_mode=False + an explicit storage_path -- otherwise pywebview
    # defaults to an incognito-style profile that forgets everything (style
    # presets, saved cluster settings -- all localStorage) between launches,
    # which would make "Save as preset" pointless in the packaged app even
    # though it works fine in a regular browser tab.
    webview.start(private_mode=False, storage_path=str(CACHE_DIR / "webview_profile"))


if __name__ == "__main__":
    main()
