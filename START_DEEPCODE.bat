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

echo  Baue und starte die App...
call npm run start

if errorlevel 1 (
  echo.
  echo  Die App wurde beendet oder es gab einen Fehler.
  pause
)
