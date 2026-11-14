@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not defined VARAQ_CURATED_SEED set "VARAQ_CURATED_SEED=1"
echo VARAQ local server. Close safely with STOP_ALL.bat.
node server.js
set "VARAQ_EXIT=%ERRORLEVEL%"
if not "%VARAQ_EXIT%"=="0" (
 echo.
 echo Server stopped unexpectedly. Read the error above; files and data were not removed.
 pause
)
exit /b %VARAQ_EXIT%
