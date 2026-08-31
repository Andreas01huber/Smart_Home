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
echo      5. Administrator-Konto anlegen (Benutzername + Passwort)
echo      6. Feste Internetadresse einrichten (auf Wunsch)
echo.
echo   Was schon eingerichtet ist, wird uebersprungen. Das Skript
echo   laesst sich also gefahrlos mehrfach starten.
echo.
echo   Bei Schritt 3, 4 und 6 fragt Windows nach Administratorrechten.
echo.
pause

rem --------------------------------------------------------------- 1. Node ---
echo.
echo   [1/6] Node.js pruefen ...
where node >nul 2>&1
if errorlevel 1 goto :kein_node

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
set "NODEV=!NODEV:v=!"
for /f "tokens=1 delims=." %%a in ("!NODEV!") do set "NODEMAJOR=%%a"
if !NODEMAJOR! LSS 22 goto :node_zu_alt
echo         Node !NODEV! gefunden - passt.

rem ------------------------------------------------------- 2. Abhaengigkeiten ---
echo.
echo   [2/6] Abhaengigkeiten pruefen ...
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
echo   [3/6] Firewall und [4/6] Autostart ...
echo         Gleich kommt die Windows-Nachfrage. Bitte mit JA bestaetigen.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0deploy\setup-server.ps1\"','-ProjectDir','\"%~dp0.\"' -Wait"
if errorlevel 1 goto :admin_abgelehnt

rem ---------------------------------------------------------------- 5. Konto ---
echo.
echo   [5/6] Administrator-Konto ...

rem Schon vorhanden? Dann nicht noch einmal fragen - ein neues Passwort wuerde
rem alle angemeldeten Geraete hinauswerfen.
set "HATPASSWORT="
if exist "secrets.json" (
  findstr /c:"passwordHash" "secrets.json" >nul 2>&1
  if not errorlevel 1 set "HATPASSWORT=ja"
)

if defined HATPASSWORT (
  echo         Schon vorhanden - uebersprungen.
  echo         Weitere Konten legst du im Browser an, unter /admin.
) else (
  echo.
  echo         Im Heimnetz ist die Anmeldung freiwillig. Sobald die App
  echo         aus dem Internet erreichbar ist, ist sie Pflicht.
  echo.
  echo         Das erste Konto wird automatisch Administrator. Konten fuer
  echo         weitere Personen legst du danach im Browser an - unter /admin
  echo         siehst du auch, wer gerade angemeldet ist.
  echo.
  set "WILLPW="
  set /p "WILLPW=        Jetzt anlegen? [J/n] "
  if /i "!WILLPW!"=="n" (
    echo         Uebersprungen. Nachholen mit:  npm run passwort
  ) else (
    echo.
    call npm run passwort
    if errorlevel 1 (
      echo.
      echo         Abgebrochen - es wurde nichts geaendert.
      echo         Nachholen mit:  npm run passwort
    )
  )
)

rem ------------------------------------------------------- 6. Feste Adresse ---
echo.
echo   [6/6] Feste Internetadresse ...
echo.
echo         Damit erreichst du das Dashboard auch von unterwegs, unter
echo         einer Adresse, die sich nie aendert. Kostenlos, ohne eigene
echo         Domain, ohne Portfreigabe im Router. Wer zugreift, braucht
echo         nur Adresse und Zugangsdaten - keine App.
echo.
set "WILLADR="
set /p "WILLADR=        Jetzt einrichten? [j/N] "
if /i "!WILLADR!"=="j" (
  echo.
  echo         Gleich kommt wieder die Windows-Nachfrage.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0deploy\feste-adresse-einrichten.ps1\"' -Wait"
) else (
  echo         Uebersprungen. Nachholen mit "Feste Adresse einrichten.cmd".
)

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

if exist "logs\feste-adresse.txt" (
  echo.
  echo   Von unterwegs, feste Adresse:
  for /f "usebackq delims=" %%a in ("logs\feste-adresse.txt") do echo                        %%a
)

echo.
echo   Benutzer verwalten:  http://localhost:4173/admin
echo         Dort siehst du, wer angemeldet ist, und legst Konten fuer
echo         weitere Personen an. Nur als Administrator sichtbar.

echo.
echo   Wie es weitergeht, wenn etwas klemmt: "Server pruefen.cmd"
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
