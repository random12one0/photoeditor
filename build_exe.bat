@echo off
setlocal
cd /d "%~dp0"

set VENV_PY=%~dp0backend\.venv\Scripts\python.exe

if not exist "%VENV_PY%" (
    echo No backend\.venv found. Run run.bat first to set up the Python environment.
    pause
    exit /b 1
)

echo Installing PyInstaller into the existing environment ^(build tool only, not part of the shipped app^)...
"%VENV_PY%" -m pip install -q --no-cache-dir pyinstaller

if not exist "dist\index.html" (
    echo Building the frontend first...
    call npm install
    call npm run build
)

echo Building BeforeAndAfter.exe -- this bundles PyTorch/CUDA, expect several minutes and a few GB.
"%VENV_PY%" -m PyInstaller BeforeAndAfter.spec --noconfirm --distpath dist_exe --workpath build_exe

echo.
echo Done. dist_exe\BeforeAndAfter\BeforeAndAfter.exe is the app -- copy the whole
echo BeforeAndAfter folder together, the exe doesn't work standalone without it.
pause
endlocal
