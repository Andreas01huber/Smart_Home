@echo off
rem Startet den SmartHome-Server OHNE Browser (fuer den Dauerbetrieb) und startet
rem ihn bei einem Absturz automatisch neu. Wird von der Autostart-Aufgabe aufgerufen.
cd /d "%~dp0.."
:loop
call npx tsx apps/server/src/index.ts
echo.
echo   Server beendet - Neustart in 10 Sekunden ...
timeout /t 10 /nobreak >nul
goto loop
