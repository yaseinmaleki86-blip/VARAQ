@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Enter the full path to a completed backup folder (not the backups parent directory):
set /p "BACKUP_DIR=Backup folder: "
node verify-backup.js "%BACKUP_DIR%"
pause
