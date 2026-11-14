@echo off
setlocal
cd /d "%~dp0"
call "%~dp0TAILSCALE_DISCONNECT_WINDOWS.bat"
if errorlevel 1 (
 echo Tailscale share could not be disabled automatically; site is NOT stopped.
 pause
 exit /b 1
)
call "%~dp0STOP_UNIFIED_WINDOWS.bat"
echo Tailscale Serve removed and VARAQ stop requested.
pause
exit /b 0
