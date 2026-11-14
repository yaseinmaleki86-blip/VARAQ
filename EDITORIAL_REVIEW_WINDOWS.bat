@echo off
setlocal
cd /d "%~dp0"
echo Preparing editorial review of all catalogue introductions...
node tools\generated-editorial-report.js
if errorlevel 1 (echo Editorial report failed. & pause & exit /b 1)
echo Editorial report was saved to the project folder.
pause
