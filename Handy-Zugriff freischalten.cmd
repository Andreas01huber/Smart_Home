@echo off
title SmartHome - Handy-Zugriff freischalten
color 0B

echo.
echo   ============================================
echo      Handy-Zugriff freischalten
echo   ============================================
echo.
echo   Diese Datei erlaubt dem Handy den Zugriff auf SmartHome
echo   im Heimnetz (Windows-Firewall, Port 4173).
echo.
echo   Es erscheint gleich eine Windows-Nachfrage ("Zulassen?").
echo   Bitte mit JA / Ja bestaetigen.
echo.
pause

rem Selbst mit Administratorrechten neu starten und die Firewall-Regel setzen.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','if (-not (Get-NetFirewallRule -DisplayName ''SmartHome 4173'' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName ''SmartHome 4173'' -Direction Inbound -LocalPort 4173 -Protocol TCP -Action Allow -Profile Private | Out-Null }; Write-Host ''Fertig. Das Handy kann die App jetzt im WLAN oeffnen.''; Start-Sleep 3'"

echo.
echo   Erledigt. Dieses Fenster kann geschlossen werden.
echo.
pause
