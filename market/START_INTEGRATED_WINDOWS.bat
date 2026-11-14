@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
echo ============================================
echo VARAQ complete assets + retail backend
 echo Legacy catalogue: http://127.0.0.1:3030/
 echo Retail store:     http://127.0.0.1:8765/
echo ============================================
where node >nul 2>nul
if errorlevel 1 (echo Node.js 22.13 or newer is required. & pause & exit /b 1)
where py >nul 2>nul
if not errorlevel 1 (
 start "VARAQ Retail - leave this window open" /D "%~dp0" cmd /k "py -3 FIRST_RUN.py"
) else (
 where python >nul 2>nul
 if errorlevel 1 (echo Python 3.10+ is required. & pause & exit /b 1)
 start "VARAQ Retail - leave this window open" /D "%~dp0" cmd /k "python FIRST_RUN.py"
)
call "%~dp0..\START_WINDOWS.bat"
 echo Open the retail store at http://127.0.0.1:8765/
 echo For first login, finish creating the admin in the retail window.
endlocal
