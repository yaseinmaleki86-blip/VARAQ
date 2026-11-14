@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Node.js 22.13+ is required. & pause & exit /b 1)
node tools\operations-check.js
set "RESULT=%ERRORLEVEL%"
echo.
echo This check uses temporary test orders; it does not process real sales or change installed data.
pause
exit /b %RESULT%
