# ===========================================================================
#  Feste, kostenlose Adresse aus dem Internet - ueber Tailscale Funnel.
#
#  Was das loest: Ein Cloudflare-Schnelltunnel bekommt bei jedem Start eine
#  neue Zufallsadresse. Tailscale vergibt stattdessen einen festen Namen, der
#  an diesen PC gebunden ist und sich nie wieder aendert - ohne eigene Domain
#  und ohne Kosten.
#
#  Wichtig zum Verstaendnis:
#    - Wer zugreift, braucht KEINE App und kein Tailscale-Konto. Die Adresse
#      ist ganz normal im Internet erreichbar, wie jede Webseite.
#    - Es wird KEIN Port im Router geoeffnet. Die Verbindung geht von diesem
#      PC nach aussen, nicht umgekehrt.
#    - Damit ist die App fuer jeden erreichbar, der die Adresse kennt. Was
#      schuetzt, ist einzig die Anmeldung. Deshalb bricht dieses Skript ab,
#      wenn kein Passwort gesetzt ist.
#
#  Braucht Administratorrechte. Aufruf ueber "Feste Adresse einrichten.cmd".
#
#  Ohne Umlaute: PowerShell 5.1 liest eine .ps1 ohne BOM als ANSI.
# ===========================================================================

param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Continue'
$Stamm = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '  Feste Adresse einrichten (Tailscale Funnel)' -ForegroundColor White
Write-Host '  ==========================================='
Write-Host ''

# --- 1. Ohne Passwort geht das nicht --------------------------------------
# Funnel stellt die App oeffentlich ins Internet. Ohne Anmeldung waere die
# Anlage dann fuer jeden offen, der die Adresse kennt oder erraet.
$secrets = Join-Path $Stamm 'secrets.json'
$passwortGesetzt = $false
if (Test-Path $secrets) {
  try {
    $s = Get-Content $secrets -Raw | ConvertFrom-Json
    if (($s.PSObject.Properties.Name -contains 'auth') -and $s.auth.passwordHash) {
      $passwortGesetzt = $true
    }
  } catch { }
}

if (-not $passwortGesetzt) {
  Write-Host '  Es ist noch kein Passwort gesetzt.' -ForegroundColor Red
  Write-Host ''
  Write-Host '  Eine feste oeffentliche Adresse ohne Anmeldung waere eine offene'
  Write-Host '  Tuer zu deiner Anlage. Erst das Passwort setzen:'
  Write-Host ''
  Write-Host "      cd $Stamm"
  Write-Host '      npm run passwort'
  Write-Host ''
  Write-Host '  Danach dieses Skript noch einmal starten.'
  Write-Host ''
  exit 1
}
Write-Host "  Anmeldung ist eingerichtet (Benutzer '$($s.auth.username)')." -ForegroundColor Green

# --- 2. Tailscale finden --------------------------------------------------
function FindeTailscale {
  $imPfad = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($imPfad) { return $imPfad.Source }
  $kandidaten = @(
    "$env:ProgramFiles\Tailscale\tailscale.exe",
    "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe"
  )
  foreach ($k in $kandidaten) { if ($k -and (Test-Path $k)) { return $k } }
  return $null
}

$ts = FindeTailscale
if (-not $ts) {
  Write-Host ''
  Write-Host '  Tailscale ist nicht installiert.' -ForegroundColor Red
  Write-Host ''
  Write-Host '  Installieren mit:'
  Write-Host '      winget install --id tailscale.tailscale'
  Write-Host ''
  Write-Host '  Danach dieses Skript noch einmal starten.'
  Write-Host ''
  exit 1
}
Write-Host "  Tailscale gefunden: $ts" -ForegroundColor Green

# --- 3. Angemeldet? -------------------------------------------------------
$rohStatus = & $ts status --json 2>$null
$angemeldet = $false
$dnsName = $null

if ($LASTEXITCODE -eq 0 -and $rohStatus) {
  try {
    $status = ($rohStatus | Out-String) | ConvertFrom-Json
    if ($status.BackendState -eq 'Running') {
      $angemeldet = $true
      $dnsName = $status.Self.DNSName
    }
  } catch { }
}

if (-not $angemeldet) {
  Write-Host ''
  Write-Host '  Dieser PC ist noch nicht bei Tailscale angemeldet.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  Jetzt oeffnet sich der Browser. Dort mit einem Konto anmelden'
  Write-Host '  (Google, Microsoft oder GitHub - ein eigenes Passwort ist nicht'
  Write-Host '  noetig) und den PC bestaetigen.'
  Write-Host ''
  Write-Host '  Druecke Enter, sobald du bereit bist ...'
  [void](Read-Host)

  & $ts up

  Start-Sleep -Seconds 3
  $rohStatus = & $ts status --json 2>$null
  try {
    $status = ($rohStatus | Out-String) | ConvertFrom-Json
    if ($status.BackendState -eq 'Running') {
      $angemeldet = $true
      $dnsName = $status.Self.DNSName
    }
  } catch { }

  if (-not $angemeldet) {
    Write-Host ''
    Write-Host '  Die Anmeldung hat nicht geklappt.' -ForegroundColor Red
    Write-Host '  Noch einmal von Hand versuchen:  tailscale up'
    Write-Host ''
    exit 1
  }
}

# Tailscale haengt an den Namen einen Punkt - der stoert in einer URL.
$dnsName = $dnsName.TrimEnd('.')
Write-Host "  Angemeldet. Name dieses PCs: $dnsName" -ForegroundColor Green

# --- 4. Funnel einschalten ------------------------------------------------
Write-Host ''
Write-Host "  Schalte die Adresse oeffentlich (Port $Port) ..."

# --bg laesst die Weiterleitung im Hintergrund laufen. Sie wird in der
# Tailscale-Konfiguration gespeichert und kommt nach einem Neustart des PCs
# von selbst wieder - eine eigene Autostart-Aufgabe braucht es dafuer nicht.
$ausgabe = & $ts funnel --bg $Port 2>&1
$ausgabe | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  Funnel liess sich nicht einschalten.' -ForegroundColor Red
  Write-Host ''
  Write-Host '  Haeufigster Grund: Funnel muss fuer das Konto einmal freigegeben'
  Write-Host '  werden. In der Meldung oben steht dann ein Link - den im Browser'
  Write-Host '  oeffnen, die Freigabe bestaetigen und dieses Skript noch einmal'
  Write-Host '  starten.'
  Write-Host ''
  exit 1
}

# --- 5. Adresse merken und pruefen ----------------------------------------
$adresse = "https://$dnsName"
$logDir = Join-Path $Stamm 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
Set-Content -Path (Join-Path $logDir 'feste-adresse.txt') -Value $adresse -Encoding ascii

Write-Host ''
Write-Host '  Erreichbar unter:' -ForegroundColor Green
Write-Host "      $adresse" -ForegroundColor White
Write-Host ''
Write-Host '  Diese Adresse bleibt. Sie aendert sich weder beim Neustart des'
Write-Host '  Tunnels noch beim Neustart des PCs - als Lesezeichen geeignet.'
Write-Host ''

Write-Host '  Teste von aussen ...'
try {
  $r = Invoke-WebRequest -Uri $adresse -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction Stop
  Write-Host "  Antwort: $($r.StatusCode) - erreichbar." -ForegroundColor Green
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 302 -or $code -eq 401) {
    Write-Host "  Antwort: $code - die Anmeldeseite kommt. Genau richtig." -ForegroundColor Green
  } else {
    Write-Host "  Noch keine Antwort: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '  Die Erstverbindung braucht manchmal ein bis zwei Minuten.'
    Write-Host '  Einfach die Adresse gleich im Browser aufrufen.'
  }
}

Write-Host ''
Write-Host '  Zum Abschalten:  tailscale funnel --https=443 off'
Write-Host ''
