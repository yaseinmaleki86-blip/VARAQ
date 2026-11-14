@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo This tool only proposes candidate metadata; it does not publish or edit the database.
echo An Internet connection is required.
node tools\collect_google_books_candidates.js 0 200
pause
