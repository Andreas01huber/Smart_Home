# ===========================================================================
#  Stellt den GitHub-Runner-Dienst auf das lokale Systemkonto um.
#
#  Warum das noetig ist: Der SmartHome-Server laeuft als geplante Aufgabe
#  unter SYSTEM, damit er schon vor dem Anmelden startet. Ein Runner unter
#  "NETWORK SERVICE" (die Voreinstellung) darf einen SYSTEM-Prozess weder
#  beenden noch dessen Aufgabe steuern. Der Deploy scheitert dann im Schritt
#  "Server anhalten" - und die neuen Dateien werden nie kopiert.
#
#  Zu den Rechten: Danach laeuft der Runner mit vollen Rechten auf diesem PC.
#  Das ist bei einem privaten Repository vertretbar - wer dort pushen darf,
#  koennte ohnehin beliebigen Code im Workflow ausfuehren lassen. Bei einem
#  oeffentlichen Repository waere es das nicht.
#
#  Braucht Administratorrechte. Aufruf ueber "Runner reparieren.cmd".
# ===========================================================================

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '  Runner auf das Systemkonto umstellen' -ForegroundColor White
Write-Host '  ===================================='
Write-Host ''

$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host '  Bitte als Administrator starten:' -ForegroundColor Red
  Write-Host '  Rechtsklick auf "Runner reparieren.cmd" -> Als Administrator ausfuehren.'
  Write-Host ''
  exit 1
}

$dienste = @(Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue)
if ($dienste.Count -eq 0) {
  Write-Host '  Kein Runner-Dienst gefunden.' -ForegroundColor Red
  Write-Host '  Der Runner ist entweder nicht installiert oder laeuft nur im Fenster'
  Write-Host '  (run.cmd) statt als Dienst. Einrichtung: deploy\GIT-WORKFLOW.md'
  Write-Host ''
  exit 1
}

foreach ($d in $dienste) {
  $wmi = Get-CimInstance Win32_Service -Filter "Name='$($d.Name)'"
  Write-Host "  Dienst : $($d.Name)"
  Write-Host "  Bisher : $($wmi.StartName)"

  if ($wmi.StartName -match 'LocalSystem|NT AUTHORITY\\SYSTEM') {
    Write-Host '  Laeuft bereits als System - nichts zu tun.' -ForegroundColor Green
    Write-Host ''
    continue
  }

  Write-Host '  Stelle um auf LocalSystem ...'
  # sc.exe statt Set-Service: Set-Service kann in PowerShell 5.1 das Konto
  # nicht aendern. Die Leerzeichen nach "obj=" und "start=" gehoeren zur
  # Syntax von sc.exe und duerfen nicht weg.
  $ausgabe = & sc.exe config $d.Name obj= LocalSystem 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Fehlgeschlagen: $ausgabe" -ForegroundColor Red
    exit 1
  }

  # Automatisch starten, damit der Runner einen Neustart des Servers ueberlebt.
  & sc.exe config $d.Name start= auto | Out-Null

  Write-Host '  Starte den Dienst neu ...'
  Restart-Service -Name $d.Name -Force
  Start-Sleep -Seconds 3

  $neu = Get-CimInstance Win32_Service -Filter "Name='$($d.Name)'"
  Write-Host "  Jetzt  : $($neu.StartName)   Status: $((Get-Service $d.Name).Status)" -ForegroundColor Green
  Write-Host ''
}

Write-Host '  Fertig.' -ForegroundColor Green
Write-Host ''
Write-Host '  Naechster Schritt: auf GitHub unter Actions den Workflow'
Write-Host '  "Test und Deploy" von Hand starten (Run workflow) - oder einfach'
Write-Host '  den naechsten Push abwarten.'
Write-Host ''
