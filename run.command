#!/usr/bin/env bash
# Double-clickable macOS launcher -- Finder runs .command files in Terminal.
# Identical logic to run.sh; kept as a separate file because macOS's file
# association for "run in Terminal on double-click" is keyed off this
# extension, not off the shebang or the executable bit alone.
cd "$(dirname "${BASH_SOURCE[0]}")"
exec ./run.sh
