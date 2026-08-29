@echo off
rem ===========================================================================
rem  Prueft, warum auf dem Server nicht ankommt, was gepusht wurde.
rem  Aendert nichts - liest nur und gibt eine Bewertung aus.
rem
rem  Einfach doppelklicken.
rem ===========================================================================
title SmartHome - Server pruefen
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\diagnose.ps1"
echo.
echo   Fenster bleibt offen. Mit einer beliebigen Taste schliessen.
pause >nul
