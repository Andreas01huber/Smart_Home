@echo off
title SmartHome - Autostart einrichten
color 0B

echo.
echo   ============================================
echo      SmartHome als Dauerdienst einrichten
echo   ============================================
echo.
echo   Richtet eine Aufgabe ein, die den SmartHome-Server bei jedem
echo   Windows-Start automatisch startet - auch ohne Anmeldung.
echo.
echo   Es kommt gleich eine Windows-Nachfrage ("Zulassen?").
echo   Bitte mit JA bestaetigen.
echo.
pause

set "RUNNER=%~dp0run-server.cmd"

rem Mit Administratorrechten die geplante Aufgabe anlegen (Start beim Booten, als SYSTEM).
powershell -NoProfile -Command "Start-Process schtasks -Verb RunAs -ArgumentList '/Create','/TN','SmartHome','/TR','\"%RUNNER%\"','/SC','ONSTART','/RU','SYSTEM','/RL','HIGHEST','/F'"

echo.
echo   Fertig. Der Server startet ab jetzt automatisch beim Hochfahren.
echo   Zum sofortigen Start jetzt einmal "run-server.cmd" doppelklicken
echo   oder den PC neu starten.
echo.
echo   Aufgabe wieder entfernen: in einer Eingabeaufforderung (als Admin)
echo      schtasks /Delete /TN SmartHome /F
echo.
pause
