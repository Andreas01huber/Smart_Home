# ===========================================================================
#  Haelt den Cloudflare-Tunnel am Laufen und schreibt die aktuelle Adresse
#  dorthin, wo man sie nachlesen kann.
#
#  Hintergrund: Ein "Quick Tunnel" (die kostenlose Variante ohne eigene
#  Domain) bekommt bei JEDEM Start eine neue Zufallsadresse unter
#  trycloudflare.com. Wird cloudflared beendet - Fenster zu, Neustart des
#  PCs, Absturz - ist die alte Adresse tot und kommt nie wieder. Genau das
#  ist der haeufigste Grund, warum der Zugriff von aussen ploetzlich nicht
#  mehr geht.
#
#  Dieses Skript startet den Tunnel neu, wenn er abbricht, und legt die
#  jeweils gueltige Adresse in logs\tunnel-url.txt ab.
#
#  Ohne Umlaute: PowerShell 5.1 liest eine .ps1 ohne BOM als ANSI.
# ===========================================================================

param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Continue'

# Vom Skript aus eine Ebene hoch ist der Projektstamm.
$Stamm = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Stamm 'logs'
$Log = Join-Path $LogDir 'tunnel.log'
$UrlDatei = Join-Path $LogDir 'tunnel-url.txt'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Schreibe($text) {
  $zeile = "$(Get-Date -Format 'dd.MM.yyyy HH:mm:ss')  $text"
  Add-Content -Path $Log -Value $zeile -Encoding utf8
  Write-Host $zeile
}

# --- cloudflared finden ---------------------------------------------------
function FindeCloudflared {
  $imPfad = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($imPfad) { return $imPfad.Source }

  $kandidaten = @(
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe",
    "$env:USERPROFILE\.cloudflared\cloudflared.exe",
    "$env:ProgramData\chocolatey\bin\cloudflared.exe"
  )
  foreach ($k in $kandidaten) {
    if ($k -and (Test-Path $k)) { return $k }
  }
  return $null
}

$exe = FindeCloudflared
if (-not $exe) {
  Schreibe 'FEHLER: cloudflared.exe nicht gefunden.'
  Schreibe 'Installieren mit:  winget install --id Cloudflare.cloudflared'
  exit 1
}
Schreibe "cloudflared: $exe"

# --- Neustart-Schleife ----------------------------------------------------
while ($true) {
  Schreibe "Starte Tunnel auf http://127.0.0.1:$Port ..."

  # Adresse aus dem letzten Lauf loeschen, damit niemand eine tote Adresse
  # abliest, waehrend der Tunnel gerade neu aufbaut.
  if (Test-Path $UrlDatei) { Remove-Item $UrlDatei -Force -ErrorAction SilentlyContinue }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  # --no-autoupdate: ein Update mitten im Betrieb wuerde den Tunnel
  # unangekuendigt beenden und die Adresse wechseln.
  $psi.Arguments = "tunnel --no-autoupdate --url http://127.0.0.1:$Port"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardOutput = $true
  $psi.CreateNoWindow = $true

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()

  # cloudflared schreibt seine Meldungen auf die Fehlerausgabe - auch die
  # Adresse. Zeilenweise mitlesen, statt am Ende alles auf einmal.
  while (-not $p.StandardError.EndOfStream) {
    $zeile = $p.StandardError.ReadLine()
    if ($null -eq $zeile) { break }
    Add-Content -Path $Log -Value $zeile -Encoding utf8

    $treffer = [regex]::Match($zeile, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($treffer.Success) {
      Set-Content -Path $UrlDatei -Value $treffer.Value -Encoding ascii
      Schreibe "Adresse: $($treffer.Value)"
    }
  }

  $p.WaitForExit()
  Schreibe "Tunnel beendet (Code $($p.ExitCode)). Neustart in 15 Sekunden."
  Start-Sleep -Seconds 15
}
