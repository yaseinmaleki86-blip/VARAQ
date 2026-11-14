@echo off
setlocal
cd /d "%~dp0"
echo Launching VARAQ unified server in a separate window...
start "VARAQ Unified Server" cmd.exe /c ""%~dp0START_UNIFIED_WINDOWS.bat""
echo Connecting private Tailscale Serve once the website is ready...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\tailscale-serve.ps1" -Action connect -WaitSeconds 150
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
 echo Connection was not completed. Check the VARAQ server window.
 pause
 exit /b %RC%
)
echo VARAQ is accessible inside your Tailnet while the site server is running.
pause
exit /b 0
