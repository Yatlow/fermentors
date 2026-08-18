@echo off
setlocal

title Fermenter Dashboard - Publish

echo.
echo ==========================================
echo       FERMENTER DASHBOARD PUBLISH
echo ==========================================
echo.

REM ==================================================
REM 1. CHECK PROJECT DIRECTORY
REM ==================================================

if not exist "package.json" (
    echo ERROR: package.json not found.
    echo Please run this file from the Fermenter project folder.
    pause
    exit /b 1
)

if not exist "firebase.json" (
    echo ERROR: firebase.json not found.
    echo Please check your Firebase project configuration.
    pause
    exit /b 1
)

REM ==================================================
REM 2. BUILD
REM ==================================================

echo.
echo ==========================================
echo [1/4] BUILDING PROJECT
echo ==========================================
echo.

call npm run build

if errorlevel 1 (
    echo.
    echo ERROR: BUILD FAILED.
    echo Firebase was NOT deployed.
    echo Git was NOT updated.
    echo.
    pause
    exit /b 1
)

echo.
echo BUILD SUCCESSFUL.

REM ==================================================
REM 3. FIREBASE HOSTING DEPLOY
REM ==================================================

echo.
echo ==========================================
echo [2/4] DEPLOYING TO FIREBASE HOSTING
echo ==========================================
echo.

call firebase deploy --only hosting

if errorlevel 1 (
    echo.
    echo ERROR: FIREBASE DEPLOY FAILED.
    echo Git was NOT updated.
    echo.
    pause
    exit /b 1
)

echo.
echo FIREBASE HOSTING DEPLOY SUCCESSFUL.

REM ==================================================
REM 4. GIT
REM ==================================================

echo.
echo ==========================================
echo [3/4] UPDATING GIT
echo ==========================================
echo.

git status

echo.
echo Adding changes...

git add .

if errorlevel 1 (
    echo.
    echo ERROR: GIT ADD FAILED.
    pause
    exit /b 1
)

REM ==================================================
REM 5. GIT COMMIT WITH DATE AND TIME
REM ==================================================

echo.
echo Creating commit...

git diff --cached --quiet

if errorlevel 1 (

    for /f "delims=" %%A in ('powershell -NoProfile -Command "Get-Date -Format ''yyyy-MM-dd HH:mm''"') do set "DATETIME=%%A"

    echo Commit time: %DATETIME%

    git commit -m "Publish Fermenter Dashboard - %DATETIME%"

    if errorlevel 1 (
        echo.
        echo ERROR: GIT COMMIT FAILED.
        pause
        exit /b 1
    )

) else (

    echo No changes to commit.

)

REM ==================================================
REM 6. GIT PUSH
REM ==================================================

echo.
echo ==========================================
echo [4/4] PUSHING TO GITHUB
echo ==========================================
echo.

git push

if errorlevel 1 (
    echo.
    echo ERROR: GIT PUSH FAILED.
    echo.
    echo Firebase was successfully deployed,
    echo but GitHub was NOT updated.
    echo.
    pause
    exit /b 1
)

REM ==================================================
REM 7. COMPLETE
REM ==================================================

echo.
echo ==========================================
echo       PUBLISH COMPLETED SUCCESSFULLY
echo ==========================================
echo.
echo   Firebase Hosting : DEPLOYED
echo   GitHub            : UPDATED
echo.
echo ==========================================
echo.

pause