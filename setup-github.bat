@echo off
title MelodyBox - Push to GitHub

echo ============================================
echo   MelodyBox - GitHub Cloud Build APK
echo ============================================
echo.
echo This script will:
echo   1. Init git repo
echo   2. Push to your GitHub repo
echo   3. GitHub Actions auto-builds the APK
echo.

set /p REPO_URL="Enter your GitHub repo URL (e.g. https://github.com/yourname/music-player.git): "

if "%REPO_URL%"=="" (
    echo [ERROR] No URL entered
    pause
    exit /b 1
)

echo.
echo [1/3] Init git...
git init
git checkout -b main

echo [2/3] Commit code...
git add .
git commit -m "MelodyBox music player - init"

echo [3/3] Push to GitHub...
git remote add origin %REPO_URL%
git push -u origin main

echo.
echo ============================================
echo   Push complete!
echo.
echo   Check build status:
echo   %REPO_URL%/actions
echo.
echo   Download APK from Actions page when done
echo ============================================
pause
