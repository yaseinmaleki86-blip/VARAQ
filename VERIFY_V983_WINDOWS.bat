@echo off
cd /d "%~dp0"
where python >nul 2>&1
if %errorlevel% neq 0 (echo Python 3 is required for verification.&pause&exit /b 1)
python VERIFY_V983.py
pause
