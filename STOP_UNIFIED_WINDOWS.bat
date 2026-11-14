@echo off
setlocal
cd /d "%~dp0"
call STOP_ALL.bat
call market\STOP_ALL.bat
echo Requested both services to stop. If an instance remains running, close its unified server console.
endlocal
