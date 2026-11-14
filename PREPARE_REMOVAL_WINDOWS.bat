@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. & pause & exit /b 1)
echo This will STOP VARAQ and COPY all storage to a different folder.
echo It will NOT delete the project, books, SQLite, photos or backups.
set /p "ANSWER=Type PREPARE to proceed: "
if /I not "%ANSWER%"=="PREPARE" (echo Cancelled. & pause & exit /b 1)
node stop-all.js
if errorlevel 1 (echo Stop not confirmed. Removal preparation aborted. & pause & exit /b 1)
node prepare-removal.js
if errorlevel 1 (echo Preservation failed: do not delete any project folder. & pause & exit /b 1)
echo Review the preserved storage folder before deleting the app directory manually.
pause
