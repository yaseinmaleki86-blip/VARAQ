@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js is required for safe VARAQ shutdown.
 pause
 exit /b 1
)
node stop-all.js
if errorlevel 1 (
 echo Some VARAQ services did not confirm shutdown. Check the message above.
 pause
 exit /b 1
)
echo VARAQ stop requests completed. You can close the VARAQ server console.
pause
