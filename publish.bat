@echo off
setlocal DisableDelayedExpansion

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

set "PUBLISH_DATETIME="

for /f "delims=" %%A in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set "PUBLISH_DATETIME=%%A"

set "DEFAULT_MESSAGE=Publish Fermenter Dashboard - %PUBLISH_DATETIME%"

echo.
echo ==========================================
echo              COMMIT MESSAGE
echo ==========================================
echo.
echo Default: %DEFAULT_MESSAGE%
echo.
echo Press ENTER to use the default message.
echo Or type your own message and press ENTER.
echo.

set "PUBLISH_COMMIT_MESSAGE="
set /p "PUBLISH_COMMIT_MESSAGE=Commit message: "

if not defined PUBLISH_COMMIT_MESSAGE set "PUBLISH_COMMIT_MESSAGE=%DEFAULT_MESSAGE%"

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
    pause
    exit /b 1
)

echo.
echo FIREBASE HOSTING DEPLOY SUCCESSFUL.

REM ==================================================
REM 4. GIT ADD
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
REM 5. CHECK FOR CHANGES
REM ==================================================

git diff --cached --quiet

if errorlevel 2 (
    echo.
    echo ERROR: FAILED TO CHECK STAGED CHANGES.
    pause
    exit /b 1
)

if errorlevel 1 goto CREATE_COMMIT

echo.
echo No changes to commit.
goto PUSH_GIT

REM ==================================================
REM 6. CHOOSE COMMIT MESSAGE
REM ==================================================

:CREATE_COMMIT



echo.
echo Creating commit...

REM Pass the message through an environment variable and UTF-8 file.
REM This preserves quotes and special characters in the custom message.

powershell -NoProfile -Command "$p = [IO.Path]::GetTempFileName(); try { [IO.File]::WriteAllText($p, $env:PUBLISH_COMMIT_MESSAGE, (New-Object System.Text.UTF8Encoding($false))); git commit --file $p; $result = $LASTEXITCODE } catch { Write-Error $_; $result = 1 } finally { Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue }; exit $result"

if errorlevel 1 (
    echo.
    echo ERROR: GIT COMMIT FAILED.
    echo Firebase was already deployed.
    pause
    exit /b 1
)

REM ==================================================
REM 7. GIT PUSH
REM ==================================================

:PUSH_GIT

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
    pause
    exit /b 1
)

REM ==================================================
REM 8. COMPLETE
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
endlocal