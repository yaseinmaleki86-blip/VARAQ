@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\tailscale-serve.ps1" -Action disconnect
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
