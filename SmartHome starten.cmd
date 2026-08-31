@echo off
setlocal EnableDelayedExpansion
title SmartHome
cd /d "%~dp0"
color 0B

echo.
echo   ============================================
echo      SmartHome
echo   ============================================
echo.

rem --- Laeuft die App bereits? ---
rem Wird weiter unten gebraucht, steht aber hier oben, weil auch die
rem Kontoabfrage wissen muss, ob gerade schon ein Server laeuft.
set "LAEUFT="
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',4173); $c.Close(); exit 0 } catch { exit 1 }"
if %errorlevel%==0 set "LAEUFT=ja"

rem --- Konto fuer die Anmeldung. Fehlt es, laeuft die App ohne Anmeldung. ---
rem Im Heimnetz ist das in Ordnung, zum Ausprobieren der Benutzerverwaltung
rem aber nicht: Ohne Konto gibt es weder Anmeldeseite noch /admin.
set "HATKONTO="
if exist "secrets.json" (
  findstr /c:"passwordHash" "secrets.json" >nul 2>&1
  if not errorlevel 1 set "HATKONTO=ja"
)

set "NEUESKONTO="
if not defined HATKONTO (
  echo   Es ist noch kein Konto angelegt. Ohne Konto laeuft SmartHome ohne
  echo   Anmeldung - im Heimnetz in Ordnung, aber Anmeldeseite und
  echo   Benutzerverwaltung gibt es dann nicht.
  echo.
  echo   Das erste Konto wird automatisch Administrator.
  echo.
  set "WILLKONTO="
  set /p "WILLKONTO=   Jetzt eines anlegen? [J/n] "
  if /i not "!WILLKONTO!"=="n" (
    echo.
    call npm run passwort
    if errorlevel 1 (
      echo.
      echo   Abgebrochen - es wurde nichts geaendert.
    ) else (
      set "NEUESKONTO=ja"
    )
    echo.
  )
)

rem --- Konto neu, aber ein alter Server laeuft noch? Dann kennt der es nicht. ---
if defined NEUESKONTO if defined LAEUFT (
  echo   Es laeuft noch ein aelterer SmartHome-Vorgang. Der kennt das neue
  echo   Konto nicht - die Konten werden beim Start gelesen.
  echo.
  echo   Bitte das andere SmartHome-Fenster schliessen und diese Datei
  echo   erneut starten.
  echo.
  pause
  exit /b 1
)

rem --- Laeuft bereits? Dann nur den Browser oeffnen. ---
if defined LAEUFT (
  echo   SmartHome laeuft bereits. Browser wird geoeffnet ...
  start "" http://localhost:4173
  timeout /t 2 /nobreak >nul
  exit /b
)

rem --- Erstmalige Einrichtung, falls noch keine Abhaengigkeiten da sind. ---
if not exist "node_modules\" (
  echo   Erstmalige Einrichtung, das dauert einen Moment ...
  echo.
  call npm install
  echo.
)

echo   Die App wird gestartet. Der Browser oeffnet sich automatisch.
echo.
if defined HATKONTO echo   Benutzer verwalten: http://localhost:4173/admin
if defined NEUESKONTO echo   Benutzer verwalten: http://localhost:4173/admin
echo   Zum Beenden dieses Fenster schliessen.
echo.

rem --- Browser oeffnen, sobald Port 4173 wirklich antwortet (max. ~30 s). ---
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',4173); $c.Close(); Start-Process 'http://localhost:4173'; break }catch{ Start-Sleep -Milliseconds 500 } }"

rem --- Server im Vordergrund: haelt die App am Laufen, solange das Fenster offen ist. ---
call npx tsx apps/server/src/index.ts

echo.
echo   SmartHome wurde beendet.
pause
