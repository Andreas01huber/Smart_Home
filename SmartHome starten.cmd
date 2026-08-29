@echo off
title SmartHome
cd /d "%~dp0"
color 0B

echo.
echo   ============================================
echo      SmartHome
echo   ============================================
echo.

rem --- Laeuft die App bereits? Dann nur den Browser oeffnen. ---
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',4173); $c.Close(); exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
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
echo   Zum Beenden dieses Fenster schliessen.
echo.

rem --- Browser oeffnen, sobald Port 4173 wirklich antwortet (max. ~30 s). ---
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',4173); $c.Close(); Start-Process 'http://localhost:4173'; break }catch{ Start-Sleep -Milliseconds 500 } }"

rem --- Server im Vordergrund: haelt die App am Laufen, solange das Fenster offen ist. ---
call npx tsx apps/server/src/index.ts

echo.
echo   SmartHome wurde beendet.
pause
