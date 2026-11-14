@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
 py -3 market\START_UNIFIED.py
) else (
 where python >nul 2>nul
 if errorlevel 1 (echo Python 3.10 or newer is required. & pause & exit /b 1)
 python market\START_UNIFIED.py
)
if errorlevel 1 (echo Server stopped or setup failed. & pause & exit /b 1)
endlocal
