"""
Native window entry point. run.bat (and the packaged .exe) launch this
instead of opening a browser tab -- pywebview wraps the same FastAPI app in
an OS window (Edge's WebView2 engine on Windows, already installed on any
modern Windows 10/11 machine since it ships with Edge), so this reads as
its own app: a taskbar entry, no address bar, no sense of "a browser tab
pointed at a server".

The server and the window share one Python process. Closing the window
ends the process -- the server thread is a daemon thread, so nothing needs
an explicit shutdown call.

Everything in here is wrapped to actually surface a failure. The packaged
build runs with no console window (so nothing prints anywhere by default)
and no window ever appeared for a real failed launch with nothing in
Windows' own crash log either -- console=False had made every failure mode
silent, for the user and for anyone trying to debug it after the fact. Now
a log file is always written, and startup failures show a native message
box pointing at it, rather than a process that just sits there.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.request

import uvicorn
import webview

from app import desktop_state
from app.config import CACHE_DIR
from app.main import app

HOST = "127.0.0.1"
PORT = int(os.environ.get("BEFORE_AFTER_PORT", "8420"))
LOG_PATH = CACHE_DIR / "desktop.log"

_server_error: BaseException | None = None


def _setup_logging() -> None:
    logging.basicConfig(
        filename=str(LOG_PATH),
        filemode="w",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # uvicorn/starlette log through their own named loggers -- send those to
    # the same file instead of nowhere (console=False has no console for
    # them to reach otherwise).
    root_handlers = logging.getLogger().handlers
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers = root_handlers
        logger.propagate = False


def _run_server() -> None:
    global _server_error
    try:
        # log_config=None -- otherwise uvicorn's own startup reconfigures
        # logging via dictConfig and replaces the file-based setup above
        # with its TTY-oriented colourized formatter, which then throws
        # (ValueError: not enough values to unpack) the moment it tries to
        # format a record for a plain FileHandler. Confirmed by testing: the
        # detection/error-reporting logic below worked regardless, but every
        # log line after the first was lost to that formatter crashing.
        config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info", log_config=None)
        uvicorn.Server(config).run()
    except BaseException as exc:  # noqa: BLE001 -- must reach main(), not vanish in a daemon thread
        _server_error = exc
        logging.exception("Server thread failed")


def _wait_until_up(timeout_s: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout_s
    url = f"http://{HOST}:{PORT}/api/health"
    while time.monotonic() < deadline:
        if _server_error is not None:
            return False  # no point waiting out the full timeout on a thread that already died
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.15)
    return False


def _show_error(title: str, message: str) -> None:
    logging.error("%s: %s", title, message)
    if sys.platform == "win32":
        try:
            MB_ICONERROR = 0x10
            ctypes.windll.user32.MessageBoxW(0, message, title, MB_ICONERROR)
        except Exception:
            pass  # the log file is the fallback if even this doesn't work


def main() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _setup_logging()
    logging.info("Starting Before & After on %s:%s", HOST, PORT)

    threading.Thread(target=_run_server, daemon=True).start()

    if not _wait_until_up():
        detail = str(_server_error) if _server_error else "it didn't respond within 20 seconds"
        _show_error(
            "Before & After couldn't start",
            "The local server didn't come up: "
            f"{detail}\n\n"
            "If another copy of this app is already running, close it first "
            "(check the taskbar and Task Manager for \"BeforeAndAfter\").\n\n"
            f"Details were written to:\n{LOG_PATH}",
        )
        return

    try:
        desktop_state.window = webview.create_window(
            "Before & After",
            f"http://{HOST}:{PORT}/",
            width=1320,
            height=880,
            min_size=(760, 600),
        )
        # private_mode=False + an explicit storage_path -- otherwise pywebview
        # defaults to an incognito-style profile that forgets everything
        # (style presets, saved cluster settings -- all localStorage)
        # between launches, which would make "Save as preset" pointless in
        # the packaged app even though it works fine in a regular browser tab.
        webview.start(private_mode=False, storage_path=str(CACHE_DIR / "webview_profile"))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Window failed to start")
        _show_error("Before & After window failed", f"{exc}\n\nDetails were written to:\n{LOG_PATH}")


if __name__ == "__main__":
    main()
