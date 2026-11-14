@echo off
setlocal
cd /d "%~dp0"
where winget >nul 2>nul
if errorlevel 1 (
 echo WinGet not found. Opening the OFFICIAL Tailscale Windows download page...
 start "" "https://tailscale.com/download/windows"
 echo Install Tailscale, sign in, and then run START_WITH_TAILSCALE_WINDOWS.bat.
 pause
 exit /b 1
)
echo This will install the official Tailscale app using WinGet.
echo Windows may request administrator permission.
choice /c YN /m "Install Tailscale now"
if errorlevel 2 exit /b 0
winget install --id Tailscale.Tailscale --exact --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
 echo Installation failed. Visit https://tailscale.com/download/windows
 pause
 exit /b 1
)
echo Installed. Sign in to Tailscale before connecting VARAQ.
pause
exit /b 0
