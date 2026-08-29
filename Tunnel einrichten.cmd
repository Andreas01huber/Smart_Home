@echo off
rem ===========================================================================
rem  Richtet den Cloudflare-Tunnel als Autostart ein, damit der Zugriff von
rem  aussen einen Neustart und ein geschlossenes Fenster ueberlebt.
rem
rem  Braucht Administratorrechte - die Abfrage kommt automatisch.
rem  Einfach doppelklicken.
rem ===========================================================================
title SmartHome - Tunnel einrichten

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Hole Administratorrechte ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\tunnel-einrichten.ps1"
echo.
echo   Fenster bleibt offen. Mit einer beliebigen Taste schliessen.
pause >nul
