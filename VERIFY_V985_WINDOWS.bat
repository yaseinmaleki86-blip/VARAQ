@echo off
cd /d "%~dp0"
py -3 VERIFY_V985.py
if errorlevel 1 pause
