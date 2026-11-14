@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 START_AND_RUN.py
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (python START_AND_RUN.py) else (echo Python 3.10+ is required. Install Python first.)
)
pause
