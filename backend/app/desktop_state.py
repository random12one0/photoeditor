"""Shared handle to the pywebview window, when running as the desktop app
(app/desktop.py) rather than a plain browser tab. routes/browse.py checks
this to decide which native folder picker to use -- see its module
docstring for why tkinter alone isn't enough."""

from __future__ import annotations

import webview

window: webview.Window | None = None
