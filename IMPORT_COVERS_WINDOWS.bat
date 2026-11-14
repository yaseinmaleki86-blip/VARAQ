@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo VARAQ - import your licensed real book cover photos
if not exist "cover-import\manifest.csv" (
 echo Please create cover-import\manifest.csv from data\COVER_BATCH_TEMPLATE.csv
 echo Place your actual photos in cover-import\images\
 pause
 exit /b 1
)
node import-covers.js --manifest "cover-import\manifest.csv" --folder "cover-import\images"
if errorlevel 1 (
 echo Validation failed. Nothing should be applied by this dry run.
 pause
 exit /b 1
)
echo.
echo REVIEW THE RESULT. Type APPLY to import approved photos.
set /p CONFIRM=Confirmation: 
if /I not "%CONFIRM%"=="APPLY" exit /b 0
node import-covers.js --manifest "cover-import\manifest.csv" --folder "cover-import\images" --apply
pause
