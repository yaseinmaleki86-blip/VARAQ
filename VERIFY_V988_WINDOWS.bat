@echo off
cd /d "%~dp0"
py -3 VERIFY_V988.py
if errorlevel 1 (pause & exit /b 1)
pause
