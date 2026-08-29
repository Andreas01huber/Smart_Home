@echo off
rem ===========================================================================
rem  Richtet eine feste, kostenlose Internetadresse fuer das Dashboard ein
rem  (Tailscale Funnel). Die Adresse aendert sich danach nie wieder.
rem
rem  Wer zugreift, braucht keine App - nur die Adresse und die Zugangsdaten.
rem
rem  Braucht Administratorrechte - die Abfrage kommt automatisch.
rem  Einfach doppelklicken.
rem ===========================================================================
title SmartHome - Feste Adresse einrichten

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Hole Administratorrechte ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\feste-adresse-einrichten.ps1"
echo.
echo   Fenster bleibt offen. Mit einer beliebigen Taste schliessen.
pause >nul
