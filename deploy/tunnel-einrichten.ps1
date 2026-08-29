# ===========================================================================
#  Richtet den Cloudflare-Tunnel als Autostart-Aufgabe ein.
#
#  Danach laeuft der Tunnel dauerhaft: Er startet mit Windows, ueberlebt das
#  Abmelden und baut sich nach einem Abbruch selbst wieder auf. Ohne das ist
#  der Zugriff von aussen weg, sobald das cloudflared-Fenster geschlossen
#  wird oder der PC neu startet.
#
#  Die Adresse bleibt trotzdem nicht dieselbe: Ein Quick Tunnel bekommt bei
#  jedem Start eine neue. Die jeweils gueltige steht in
#  logs\tunnel-url.txt und in "Server pruefen.cmd".
#
#  Braucht Administratorrechte. Aufruf ueber "Tunnel einrichten.cmd".
# ===========================================================================

param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$Stamm = Split-Path -Parent $PSScriptRoot
$Aufgabe = 'SmartHomeTunnel'

Write-Host ''
Write-Host '  Cloudflare-Tunnel einrichten' -ForegroundColor White
Write-Host '  ============================'
Write-Host ''

$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host '  Bitte als Administrator starten:' -ForegroundColor Red
  Write-Host '  Rechtsklick auf "Tunnel einrichten.cmd" -> Als Administrator ausfuehren.'
  Write-Host ''
  exit 1
}

# --- Ist cloudflared ueberhaupt da? ---------------------------------------
$exe = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $exe) {
  $kandidaten = @(
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
  )
  $gefunden = $kandidaten | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $gefunden) {
    Write-Host '  cloudflared ist nicht installiert.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Installieren mit:'
    Write-Host '      winget install --id Cloudflare.cloudflared'
    Write-Host ''
    Write-Host '  Danach dieses Fenster schliessen und noch einmal starten.'
    Write-Host ''
    exit 1
  }
}
Write-Host '  cloudflared gefunden.' -ForegroundColor Green

# --- Aufgabe anlegen ------------------------------------------------------
$skript = Join-Path $PSScriptRoot 'tunnel-start.ps1'
if (-not (Test-Path $skript)) {
  Write-Host "  tunnel-start.ps1 fehlt unter $skript" -ForegroundColor Red
  exit 1
}

$vorhanden = Get-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
if ($vorhanden) {
  Write-Host '  Aufgabe war schon da - wird neu angelegt.'
  Stop-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Aufgabe -Confirm:$false
}

$aktion = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$skript`" -Port $Port" `
  -WorkingDirectory $Stamm

# Beim Systemstart, nicht beim Anmelden: Der Server soll auch erreichbar sein,
# wenn sich niemand an dem PC anmeldet.
$ausloeser = New-ScheduledTaskTrigger -AtStartup

$konto = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# Ohne Zeitlimit - der Tunnel soll dauerhaft laufen. Die Voreinstellung von
# Windows waere drei Tage, danach wuerde er kommentarlos beendet.
$einstellungen = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $Aufgabe -Action $aktion -Trigger $ausloeser `
  -Principal $konto -Settings $einstellungen | Out-Null

Write-Host "  Aufgabe `"$Aufgabe`" angelegt." -ForegroundColor Green

Start-ScheduledTask -TaskName $Aufgabe
Write-Host '  Tunnel gestartet. Warte auf die Adresse ...'

# --- Auf die Adresse warten -----------------------------------------------
$urlDatei = Join-Path $Stamm 'logs\tunnel-url.txt'
$adresse = $null
foreach ($i in 1..40) {
  Start-Sleep -Seconds 2
  if (Test-Path $urlDatei) {
    $adresse = (Get-Content $urlDatei -Raw).Trim()
    if ($adresse) { break }
  }
}

Write-Host ''
if ($adresse) {
  Write-Host '  Erreichbar unter:' -ForegroundColor Green
  Write-Host "      $adresse" -ForegroundColor White
  Write-Host ''
  Write-Host '  Diese Adresse aendert sich bei jedem Neustart des Tunnels.'
  Write-Host '  Die jeweils gueltige steht in logs\tunnel-url.txt und wird'
  Write-Host '  von "Server pruefen.cmd" mit angezeigt.'
} else {
  Write-Host '  Nach 80 Sekunden noch keine Adresse.' -ForegroundColor Yellow
  Write-Host '  Nachsehen in logs\tunnel.log - dort steht, woran es haengt.'
}
Write-Host ''
