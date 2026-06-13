@echo off
REM ============================================================
REM  DeepCode - One-Click-Publish
REM  Legt (einmalig) das private GitHub-Repo an, pusht den Code
REM  und veroeffentlicht ein Release mit Installer - danach
REM  funktioniert der Auto-Updater in der App.
REM
REM  Voraussetzung (einmalig): GitHub CLI installieren + einloggen
REM    winget install GitHub.cli
REM    gh auth login
REM ============================================================
setlocal enabledelayedexpansion
title DeepCode Publish
cd /d "%~dp0"

REM prefer the portable gh if present, else the one on PATH
set "GH=gh"
if exist "tools\bin\gh.exe" set "GH=tools\bin\gh.exe"

where gh >nul 2>nul
if errorlevel 1 if not exist "tools\bin\gh.exe" (
  echo.
  echo  GitHub CLI fehlt. Bitte einmalig installieren und einloggen:
  echo    winget install GitHub.cli
  echo    gh auth login
  echo  Danach PUBLISH.bat erneut starten.
  pause
  exit /b 1
)

%GH% auth status >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Nicht eingeloggt. Bitte ausfuehren:  gh auth login
  pause
  exit /b 1
)

for /f "delims=" %%u in ('%GH% api user --jq .login') do set OWNER=%%u
echo  GitHub-Account: %OWNER%

REM Owner in die Updater-Config schreiben
call npm pkg set "build.publish[0].owner=%OWNER%" >nul

REM Version auslesen
for /f "delims=" %%v in ('npm pkg get version') do set VRAW=%%v
set VERSION=%VRAW:"=%
echo  Version: v%VERSION%

REM Repo anlegen (falls noch nicht vorhanden) + Remote setzen
%GH% repo view %OWNER%/deepcode >nul 2>nul
if errorlevel 1 (
  echo  Lege privates Repo %OWNER%/deepcode an...
  %GH% repo create deepcode --private --source . --remote origin
) else (
  git remote get-url origin >nul 2>nul || git remote add origin https://github.com/%OWNER%/deepcode.git
)

echo  Committe und pushe...
git add -A
git commit -m "Release v%VERSION%" 2>nul
git branch -M main
git push -u origin main
if errorlevel 1 (
  echo  Push fehlgeschlagen.
  pause
  exit /b 1
)

echo  Baue Installer (das dauert 1-2 Minuten)...
call npm run package:win
if errorlevel 1 (
  echo  Build fehlgeschlagen.
  pause
  exit /b 1
)

REM latest.yml references the hyphenated asset name; GitHub turns spaces into dots,
REM so upload copies named exactly like the manifest or auto-update 404s.
copy /y "release\DeepCode Setup %VERSION%.exe" "release\DeepCode-Setup-%VERSION%.exe" >nul
copy /y "release\DeepCode Setup %VERSION%.exe.blockmap" "release\DeepCode-Setup-%VERSION%.exe.blockmap" >nul

echo  Erstelle Release v%VERSION% mit Installer + Update-Manifest...
%GH% release create v%VERSION% "release\DeepCode-Setup-%VERSION%.exe" "release\DeepCode-Setup-%VERSION%.exe.blockmap" "release\latest.yml" --title "DeepCode v%VERSION%" --notes "Automatisches Release via PUBLISH.bat" 2>nul
if errorlevel 1 (
  echo  Release existiert evtl. schon - versuche Upload der Dateien...
  %GH% release upload v%VERSION% "release\DeepCode-Setup-%VERSION%.exe" "release\DeepCode-Setup-%VERSION%.exe.blockmap" "release\latest.yml" --clobber
)

echo.
echo  ==========================================================
echo   FERTIG! Repo: https://github.com/%OWNER%/deepcode
echo.
echo   WICHTIG fuer Auto-Update in der installierten App:
echo   GitHub-Releases muessen oeffentlich erreichbar sein.
echo   Entweder Repo public stellen:
echo     %GH% repo edit %OWNER%/deepcode --visibility public
echo   ...oder privat lassen (Code geschuetzt) und Updates
echo   weiterhin manuell ueber PUBLISH.bat + Installer beziehen.
echo  ==========================================================
pause
