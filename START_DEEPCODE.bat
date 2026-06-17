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

REM ALWAYS build before starting. `npm run start` is electron-vite preview, which only
REM SERVES out\ and never builds — so without this, relaunching after a code change would
REM keep running the stale bundle (a fixed bug would look "still broken" until out\ is rebuilt).
REM The build is fast (~1-2s); this guarantees every launch runs the current source.
echo  Baue die App ^(aktueller Stand^)...
call npm run build
if errorlevel 1 (
  echo.
  echo  FEHLER beim Build.
  pause
  exit /b 1
)

echo  Starte die App...
call npm run start

if errorlevel 1 (
  echo.
  echo  Die App wurde beendet oder es gab einen Fehler.
  pause
)
