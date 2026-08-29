@echo off
rem ===========================================================================
rem  Startet den SmartHome-Server OHNE Browser (fuer den Dauerbetrieb) und
rem  startet ihn bei einem Absturz automatisch neu. Wird von der Autostart-
rem  Aufgabe "SmartHome" aufgerufen.
rem
rem  Ohne Umlaute, weil die Eingabeaufforderung sie je nach Codepage zerlegt.
rem ===========================================================================
setlocal
cd /d "%~dp0.."

set "LOGDIR=%CD%\logs"
set "LOG=%LOGDIR%\server.log"
if not exist "%LOGDIR%\" mkdir "%LOGDIR%"

rem Als geplante Aufgabe gibt es keine Konsole - ohne Logdatei waere im
rem Fehlerfall nichts zu sehen. Ab etwa 5 MB wird einmal weggerollt, damit die
rem Datei ueber Monate nicht unbegrenzt waechst.
if exist "%LOG%" (
  for %%A in ("%LOG%") do if %%~zA GTR 5000000 (
    if exist "%LOG%.old" del "%LOG%.old"
    move /y "%LOG%" "%LOG%.old" >nul
  )
)

rem Direkter Aufruf statt npx: braucht kein Netz und startet schneller.
rem npx bleibt als Rueckfalloption, falls node_modules anders aufgebaut ist.
set "TSX=%CD%\node_modules\.bin\tsx.cmd"

:loop
echo. >> "%LOG%"
echo ===== Start %DATE% %TIME% ===== >> "%LOG%"
if exist "%TSX%" (
  call "%TSX%" apps/server/src/index.ts >> "%LOG%" 2>&1
) else (
  call npx tsx apps/server/src/index.ts >> "%LOG%" 2>&1
)
echo ----- beendet %DATE% %TIME%, Neustart in 10 Sekunden ----- >> "%LOG%"
timeout /t 10 /nobreak >nul
goto loop
