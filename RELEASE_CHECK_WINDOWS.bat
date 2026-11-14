@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Node.js 22.13+ required.& pause & exit /b 1)
echo [1/3] Verifying release source files...
node verify-release.js
if errorlevel 1 (echo Release source verification FAILED.& pause & exit /b 1)
echo [2/3] Checking release blockers (read-only)...
node preflight.js
echo [3/3] Rehearsing recovery from latest verified backup...
node recovery-rehearsal.js
if errorlevel 1 (echo Backup rehearsal FAILED. Do NOT deploy yet.& pause & exit /b 1)
echo Package and recovery checks passed. These do NOT approve live sales.
pause
