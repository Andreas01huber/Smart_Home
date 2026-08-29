@echo off
rem ===========================================================================
rem  Richtet DIESEN PC als Dauer-Server fuer SmartHome ein.
rem
rem  Bewusst ohne Umlaute: Die Windows-Eingabeaufforderung stellt sie je nach
rem  Codepage falsch dar. Lieber "laeuft" als ein kaputtes Zeichen.
rem ===========================================================================
setlocal EnableDelayedExpansion
title SmartHome - Server-PC einrichten
cd /d "%~dp0"
color 0B

echo.
echo   ============================================
echo      SmartHome als Dauer-Server einrichten
echo   ============================================
echo.
echo   Dieser Assistent macht aus diesem PC den Server, auf dem
echo   SmartHome durchgehend laeuft:
echo.
echo      1. Node.js pruefen
echo      2. Abhaengigkeiten installieren  (braucht einmal Internet)
echo      3. Firewall fuer das Heimnetz oeffnen (Port 4173)
echo      4. Autostart einrichten - laeuft ab jedem Hochfahren
echo.
echo   Bei Schritt 3 und 4 fragt Windows nach Administratorrechten.
echo.
pause

rem --------------------------------------------------------------- 1. Node ---
echo.
echo   [1/4] Node.js pruefen ...
where node >nul 2>&1
if errorlevel 1 goto :kein_node

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
set "NODEV=!NODEV:v=!"
for /f "tokens=1 delims=." %%a in ("!NODEV!") do set "NODEMAJOR=%%a"
if !NODEMAJOR! LSS 22 goto :node_zu_alt
echo         Node !NODEV! gefunden - passt.

rem ------------------------------------------------------- 2. Abhaengigkeiten ---
echo.
echo   [2/4] Abhaengigkeiten pruefen ...
if exist "node_modules\tsx\" (
  echo         Schon vorhanden - uebersprungen.
) else (
  echo         Werden installiert. Das dauert ein bis zwei Minuten
  echo         und braucht einmalig eine Internetverbindung ...
  echo.
  call npm install
  if errorlevel 1 goto :npm_fehler
  echo.
  echo         Fertig installiert.
)

rem ------------------------------------------- 3. + 4. Firewall und Autostart ---
echo.
echo   [3/4] Firewall und [4/4] Autostart ...
echo         Gleich kommt die Windows-Nachfrage. Bitte mit JA bestaetigen.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0deploy\setup-server.ps1\"','-ProjectDir','\"%~dp0.\"' -Wait"
if errorlevel 1 goto :admin_abgelehnt

rem ------------------------------------------------------------- Ergebnis -----
echo.
echo   ============================================
echo      Fertig. SmartHome laeuft auf diesem PC.
echo   ============================================
echo.
echo   Auf diesem PC:      http://localhost:4173
echo.
echo   Von Handy, Tablet und anderen PCs im gleichen WLAN:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Sort-Object IPAddress | ForEach-Object { '                       http://' + $_.IPAddress + ':4173' }"
echo.
echo   Tipp: Diese Adresse bleibt nur stabil, wenn der Router dem PC
echo         immer dieselbe IP gibt. In der FritzBox unter
echo         Heimnetz - Netzwerk - Geraet - "immer die gleiche IPv4-Adresse".
echo.
echo   Weiteres steht in INSTALLATION.md im gleichen Ordner.
echo.
pause
exit /b 0

rem ------------------------------------------------------------- Fehler -------
:kein_node
echo.
echo   FEHLER: Node.js ist auf diesem PC nicht installiert.
echo.
echo   SmartHome braucht Node.js in Version 22 oder neuer.
echo   Der Browser oeffnet jetzt die Download-Seite. Dort die
echo   Windows-Version "LTS" herunterladen und installieren,
echo   danach diese Datei erneut starten.
echo.
start "" https://nodejs.org/de/download
pause
exit /b 1

:node_zu_alt
echo.
echo   FEHLER: Node !NODEV! ist zu alt - gebraucht wird 22 oder neuer.
echo.
echo   Der Browser oeffnet jetzt die Download-Seite. Die neue Version
echo   ueber die alte installieren, danach diese Datei erneut starten.
echo.
start "" https://nodejs.org/de/download
pause
exit /b 1

:npm_fehler
echo.
echo   FEHLER: Die Installation der Abhaengigkeiten ist fehlgeschlagen.
echo.
echo   Haeufigste Ursache: keine Internetverbindung. Verbindung pruefen
echo   und diese Datei erneut starten. Die Meldungen oben sagen genauer,
echo   woran es lag.
echo.
pause
exit /b 1

:admin_abgelehnt
echo.
echo   Abgebrochen: Ohne Administratorrechte lassen sich Firewall und
echo   Autostart nicht einrichten.
echo.
echo   SmartHome laeuft trotzdem - per Doppelklick auf
echo   "SmartHome starten.cmd". Dann aber nur auf diesem PC und nur,
echo   solange das Fenster offen ist.
echo.
pause
exit /b 1
