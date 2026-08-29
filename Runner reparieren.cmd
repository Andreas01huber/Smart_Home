@echo off
rem ===========================================================================
rem  Stellt den GitHub-Runner-Dienst auf das Systemkonto um, damit er den
rem  SmartHome-Server anhalten und neu starten darf.
rem
rem  Braucht Administratorrechte - die Abfrage von Windows kommt automatisch.
rem  Einfach doppelklicken.
rem ===========================================================================
title SmartHome - Runner reparieren

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Hole Administratorrechte ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\runner-auf-system.ps1"
echo.
echo   Fenster bleibt offen. Mit einer beliebigen Taste schliessen.
pause >nul
