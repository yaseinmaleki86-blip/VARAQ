@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>&1
if errorlevel 1 (
  echo Optional visual layout audit requires Python 3 plus playwright and Chromium.
  echo The bookstore itself does not need Python to run.
  pause
  exit /b 1
)
python tools\mobile-layout-audit.py
set "RESULT=%ERRORLEVEL%"
echo.
echo This offline Chromium check does not replace real iPhone/Android testing.
pause
exit /b %RESULT%
