@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. & pause & exit /b 1)
node clean-temp.js
if errorlevel 1 (pause & exit /b 1)
pause
