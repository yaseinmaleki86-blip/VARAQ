@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js 22.13+ required.
 pause
 exit /b 1
)
echo This tests an ALREADY RUNNING public-readonly instance; it cannot approve real payments.
echo Default: http://127.0.0.1:3030 (local reverse-proxy backend).
node release-smoke.js %*
if errorlevel 1 (
 echo Release smoke did not pass. Review checks above.
 pause
 exit /b 1
)
echo HTTP checks completed. Legal, browser, TLS and payment reviews still required.
pause
