@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\tailscale-serve.ps1" -Action status
pause
exit /b %ERRORLEVEL%
