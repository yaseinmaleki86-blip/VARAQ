@echo off
setlocal
cd /d "%~dp0"
set "NODE_DB=%DATA_DIR%\varaq.sqlite"
if not defined DATA_DIR set "NODE_DB=%CD%\storage\varaq.sqlite"
python "tools\audit-integrated-v97.py" --node-db "%NODE_DB%"
if errorlevel 1 (echo Audit failed. Check if both stores have been initialized.) else (echo Audit reports are saved in market\data\reports)
pause
