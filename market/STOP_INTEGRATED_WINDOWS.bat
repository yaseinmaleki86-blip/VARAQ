@echo off
setlocal
cd /d "%~dp0.."
call "%~dp0..\STOP_ALL_WINDOWS.bat"
call "%~dp0STOP_ALL.bat"
echo VARAQ legacy and retail servers have been requested to stop.
endlocal
