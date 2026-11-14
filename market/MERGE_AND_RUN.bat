@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 AUTO_MERGE_AND_RUN.py
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        python AUTO_MERGE_AND_RUN.py
    ) else (
        echo Python 3.10 or newer is required.
        echo Install Python with Add to PATH enabled.
    )
)
pause
