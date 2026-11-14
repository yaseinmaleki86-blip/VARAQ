@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
 py -3 VERIFY_V98.py
) else (
 python VERIFY_V98.py
)
if errorlevel 1 (echo Integrity check failed. & pause & exit /b 1)
echo Integrity check passed.
pause
endlocal
