@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Restore creates a NEW storage folder and NEVER overwrites existing storage.
echo STOP THE SERVER before switching to the recovered directory.
set /p "BACKUP_DIR=Backup folder: "
set /p "RESTORE_DIR=NEW target folder path: "
node restore-backup.js "%BACKUP_DIR%" "%RESTORE_DIR%"
pause
