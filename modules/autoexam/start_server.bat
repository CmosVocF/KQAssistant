@echo off
chcp 65001 >nul
setlocal
rem Pure-ASCII launcher (avoids codepage issues on Chinese Windows).
rem It runs backend\server.py by absolute path, so the working directory does not matter
rem (server.py resolves the bank folder from its own location, not from the CWD).
set "SCRIPT=%~dp0backend\server.py"
set "PYTHONIOENCODING=utf-8"
echo ============================================================
echo   Autoanswer backend   (API: http://127.0.0.1:8765)
echo   Bank folder : see backend\config.json (bank_folder)
echo   After swapping banks, call POST /api/reload or restart this.
echo ============================================================
where python >nul 2>nul
if %errorlevel%==0 (
    echo   Starting with python...
    python "%SCRIPT%"
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        echo   Starting with py launcher...
        py "%SCRIPT%"
    ) else (
        echo   [ERROR] python was not found on PATH. Install Python 3.9+ first.
    )
)
echo.
pause
endlocal
