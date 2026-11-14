@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org/
 pause
 exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13)){console.error('Node.js 22.13+ required.');process.exit(1)}"
if errorlevel 1 (pause & exit /b 1)
if not defined PORT set "PORT=3030"
node tools\startup-guard.js check
if errorlevel 1 (pause & exit /b 1)
start "VARAQ server" /D "%~dp0" cmd /c "call RUN_SERVER_WINDOWS.bat"
node tools\startup-guard.js wait
if errorlevel 1 (
 echo VARAQ launch was not verified. The browser was NOT opened.
 pause
 exit /b 1
)
start "" "http://127.0.0.1:%PORT%/"
echo VARAQ passed its local health check. Payment remains disabled.
exit /b 0
