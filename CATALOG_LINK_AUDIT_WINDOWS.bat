@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
 py -3 market\CATALOG_LINK_V98.py
) else (
 python market\CATALOG_LINK_V98.py
)
echo.
echo Read-only preview done. No order, price, or stock was changed.
pause
endlocal
