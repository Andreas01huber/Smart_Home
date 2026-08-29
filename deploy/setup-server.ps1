<#
    Firewall-Regel und Autostart fuer den SmartHome-Dauerbetrieb.

    Wird von "Server-PC einrichten.cmd" mit Administratorrechten aufgerufen.
    Laesst sich auch einzeln starten:

        powershell -ExecutionPolicy Bypass -File deploy\setup-server.ps1 -ProjectDir ..

    Der Aufruf ist wiederholbar: Was schon eingerichtet ist, bleibt, was fehlt,
    kommt dazu.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDir,

  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'

function Titel($text) {
  Write-Host ''
  Write-Host "  $text" -ForegroundColor Cyan
}

$root = (Resolve-Path $ProjectDir).Path
$runner = Join-Path $root 'deploy\run-server.cmd'
if (-not (Test-Path $runner)) {
  Write-Host "  FEHLER: $runner nicht gefunden." -ForegroundColor Red
  Read-Host '  Enter zum Schliessen'
  exit 1
}

# Ohne Administratorrechte geht weder Firewall noch Aufgabenplanung.
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host '  FEHLER: Dieses Fenster hat keine Administratorrechte.' -ForegroundColor Red
  Read-Host '  Enter zum Schliessen'
  exit 1
}

# --------------------------------------------------------- Netzwerkprofil ---
# Der haeufigste Grund, warum die App vom Handy aus trotz Firewall-Regel nicht
# erreichbar ist: Windows hat das Heimnetz als "Oeffentlich" eingestuft. Dann
# greift eine Regel fuer das private Profil schlicht nicht. Frisch aufgesetzte
# Rechner stehen fast immer auf "Oeffentlich".
Titel 'Netzwerkprofil'
try {
  $oeffentlich = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }
  if ($oeffentlich) {
    foreach ($p in $oeffentlich) {
      Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private
      Write-Host "  '$($p.Name)' war auf Oeffentlich - auf Privat umgestellt."
    }
  } else {
    Write-Host '  Alle Verbindungen stehen schon auf Privat oder Domaene - passt.'
  }
} catch {
  Write-Host "  Profil konnte nicht umgestellt werden: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '  Von Hand: Einstellungen - Netzwerk und Internet - Verbindung - Privat.'
}

# ---------------------------------------------------------------- Firewall ---
Titel 'Firewall'
$regel = 'SmartHome 4173'
try {
  # Vorhandene Regel neu setzen statt stehen lassen: Eine aeltere Regel koennte
  # ein zu enges Profil haben, und genau daran scheitert der Handy-Zugriff dann.
  Get-NetFirewallRule -DisplayName $regel -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  # Privat und Domaene - nicht Oeffentlich: im Heimnetz erreichbar,
  # im Hotel- oder Bahn-WLAN bleibt der Port zu.
  New-NetFirewallRule -DisplayName $regel -Direction Inbound -LocalPort $Port `
    -Protocol TCP -Action Allow -Profile Private, Domain | Out-Null
  Write-Host "  Regel gesetzt - Port $Port ist im Heimnetz offen."
} catch {
  Write-Host "  Firewall-Regel fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '  Die App laeuft trotzdem, ist aber evtl. nur auf diesem PC erreichbar.'
}

# --------------------------------------------------------------- Autostart ---
Titel 'Autostart'
try {
  $action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

  # Die drei wichtigen Punkte fuer einen Laptop als Dauer-Server:
  #  - kein Zeitlimit (Standard waeren 3 Tage, danach wuerde Windows beenden)
  #  - laeuft auch im Akkubetrieb weiter
  #  - nach einem Absturz neu starten (run-server.cmd faengt das zwar selbst ab,
  #    das hier greift, falls der Prozess ganz verschwindet)
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask -TaskName 'SmartHome' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host '  Aufgabe "SmartHome" eingerichtet - startet ab jetzt beim Hochfahren.'
} catch {
  Write-Host "  Autostart fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host '  Enter zum Schliessen'
  exit 1
}

# ------------------------------------------------------------ sofort starten -
Titel 'Start'
$belegt = $false
try {
  $c = New-Object Net.Sockets.TcpClient
  $c.Connect('127.0.0.1', $Port)
  $c.Close()
  $belegt = $true
} catch { }

if ($belegt) {
  Write-Host "  Auf Port $Port laeuft schon etwas - nicht noch einmal gestartet."
} else {
  Start-ScheduledTask -TaskName 'SmartHome'
  Write-Host '  Server gestartet, warte auf Antwort ...'
}

# Nicht nur "gestartet" melden, sondern nachsehen, ob er wirklich antwortet.
# Beim allerersten Start dauert das laenger: tsx uebersetzt den Code einmal.
$laeuft = $false
foreach ($versuch in 1..60) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port)
    $c.Close()
    $laeuft = $true
    break
  } catch { Start-Sleep -Milliseconds 1000 }
}

Write-Host ''
if ($laeuft) {
  Write-Host "  OK - der Server antwortet auf Port $Port." -ForegroundColor Green
} else {
  Write-Host "  ACHTUNG: Der Server antwortet nach 60 Sekunden nicht." -ForegroundColor Red
  Write-Host '  Zum Nachsehen, woran es liegt, im Projektordner einmal'
  Write-Host '  "SmartHome starten.cmd" doppelklicken - dort stehen die Meldungen.'
}

Write-Host ''
Write-Host '  Aufgabe wieder entfernen:  schtasks /Delete /TN SmartHome /F' -ForegroundColor DarkGray
Write-Host ''
Start-Sleep -Seconds 6
