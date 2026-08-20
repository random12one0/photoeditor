@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Before ^& After -- starting up...

set VENV_PY=backend\.venv\Scripts\python.exe

if not exist "%VENV_PY%" (
    echo Setting up the Python environment for the first time -- this happens once.
    where py >nul 2>nul
    if !errorlevel! == 0 (
        py -3 -m venv backend\.venv
    ) else (
        python -m venv backend\.venv
    )
    if not exist "%VENV_PY%" (
        echo Could not create a Python virtual environment. Is Python 3.10+ installed and on PATH?
        pause
        exit /b 1
    )

    "%VENV_PY%" -m pip install --upgrade pip >nul

    where nvidia-smi >nul 2>nul
    if !errorlevel! == 0 (
        echo NVIDIA GPU detected -- installing the CUDA build of PyTorch ^(this is the big download, one time only^).
        "%VENV_PY%" -m pip install "torch>=2.2,<3" "torchvision>=0.17,<1" --index-url https://download.pytorch.org/whl/cu124
    ) else (
        echo No NVIDIA GPU detected -- installing the CPU build of PyTorch. Matching will be slower.
    )

    echo Installing the rest of the backend...
    "%VENV_PY%" -m pip install -r backend\requirements.txt
)

if not exist "dist\index.html" (
    where npm >nul 2>nul
    if !errorlevel! neq 0 (
        echo npm was not found on PATH. Install Node.js from nodejs.org, then run this again.
        pause
        exit /b 1
    )
    echo Building the app -- this happens once, or after an update.
    call npm install
    call npm run build
)

echo Starting the local server on http://127.0.0.1:8420 ...
start "" http://127.0.0.1:8420/
"%VENV_PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8420 --app-dir backend

endlocal
