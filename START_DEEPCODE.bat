@echo off
REM ============================================================
REM  DeepCode - One-Click-Start
REM  Startet die Desktop-App (DeepSeek-Coding-Assistent).
REM ============================================================
title DeepCode
cd /d "%~dp0"

echo.
echo  ==== DeepCode wird gestartet ====
echo.

REM Abhaengigkeiten installieren, falls noch nicht vorhanden
if not exist "node_modules" (
  echo  Erstmaliger Start: installiere Abhaengigkeiten ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo  FEHLER bei npm install. Bitte Node.js pruefen.
    pause
    exit /b 1
  )
)

REM Build if there is no bundle yet (fresh clone / out\ deleted). `npm run start`
REM is electron-vite preview, which only serves out\ and does NOT build itself.
if not exist "out\main\index.js" (
  echo  Baue die App ^(erstmalig^)...
  call npm run build
  if errorlevel 1 (
    echo.
    echo  FEHLER beim Build.
    pause
    exit /b 1
  )
)

echo  Starte die App...
call npm run start

if errorlevel 1 (
  echo.
  echo  Die App wurde beendet oder es gab einen Fehler.
  pause
)
