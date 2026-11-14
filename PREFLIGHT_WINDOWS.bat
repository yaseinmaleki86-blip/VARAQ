@echo off
chcp 65001 >nul
cd /d "%~dp0"
node preflight.js
if errorlevel 1 (echo Preflight command reported an error.)
pause
