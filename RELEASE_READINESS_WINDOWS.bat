@echo off
chcp 65001 >nul
cd /d "%~dp0"
node preflight.js
if errorlevel 1 (echo Release readiness reported an error.)
pause
