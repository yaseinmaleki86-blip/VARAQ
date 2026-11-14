@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  pause
  exit /b 1
)
node tools\mobile-check.js
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Mobile HTTP QA found failed checks.
echo Note: this tool does not replace real Android/iPhone browser testing.
pause
exit /b %RESULT%
