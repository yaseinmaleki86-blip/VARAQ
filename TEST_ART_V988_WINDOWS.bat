@echo off
cd /d "%~dp0"
node --test tests\phase988-story-cover.test.js
if errorlevel 1 (pause & exit /b 1)
pause
