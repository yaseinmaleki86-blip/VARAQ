@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js 22.13 or newer is required.
 pause
 exit /b 1
)
node tools\ops-status.js --strict
set "RESULT=%ERRORLEVEL%"
echo.
echo This is a local diagnostic only. Payments are disabled.
pause
exit /b %RESULT%
