# ===========================================================================
#  Warum ist auf dem Server nicht angekommen, was gepusht wurde?
#
#  Liest nur, aendert nichts. Am Ende steht eine Bewertung mit dem naechsten
#  Schritt.
#
#  Aufruf ueber "Server pruefen.cmd" (Doppelklick) oder von Hand:
#      powershell -ExecutionPolicy Bypass -File deploy\diagnose.ps1
#
#  Ohne Umlaute: PowerShell 5.1 liest eine .ps1 ohne BOM als ANSI und macht
#  aus Umlauten Buchstabensalat.
# ===========================================================================

$ErrorActionPreference = 'Continue'
$DeployDir = 'C:\SmartHome'
$Port = 4173

$befunde = New-Object System.Collections.ArrayList
function Merke($stufe, [string[]]$zeilen) {
  [void]$befunde.Add(@{ Stufe = $stufe; Zeilen = $zeilen })
}

function Titel($text) {
  Write-Host ''
  Write-Host "== $text " -ForegroundColor Cyan -NoNewline
  Write-Host ('=' * [Math]::Max(0, 60 - $text.Length))
}

Write-Host ''
Write-Host '  SmartHome - Server pruefen' -ForegroundColor White
Write-Host '  =========================='
Write-Host "  $(Get-Date -Format 'dd.MM.yyyy HH:mm')  auf  $env:COMPUTERNAME"

# --- 1. Liegt der Code ueberhaupt da, und wie alt ist er? -------------------
Titel 'Deploy-Ordner'

if (-not (Test-Path $DeployDir)) {
  Write-Host "  $DeployDir gibt es nicht." -ForegroundColor Red
  Merke 'fehler' @("Der Ordner $DeployDir fehlt - es wurde noch nie erfolgreich ausgeliefert.")
} else {
  Write-Host "  $DeployDir ist da."

  # Der Zeitstempel der juengsten Codedatei sagt, wann zuletzt kopiert wurde.
  $neueste = Get-ChildItem (Join-Path $DeployDir 'apps') -Recurse -File -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($neueste) {
    $alter = New-TimeSpan -Start $neueste.LastWriteTime -End (Get-Date)
    Write-Host ("  Juengste Codedatei: {0:dd.MM.yyyy HH:mm}  (vor {1:N0} Stunden)" -f $neueste.LastWriteTime, $alter.TotalHours)
    if ($alter.TotalDays -gt 1) {
      Merke 'warnung' @(("Der Code auf dem Server ist {0:N0} Tage alt - seitdem ist kein Deploy durchgelaufen." -f $alter.TotalDays))
    }
  } else {
    Write-Host '  Kein Code unter apps\ gefunden.' -ForegroundColor Red
    Merke 'fehler' @('Unter C:\SmartHome\apps liegt nichts - das Kopieren hat nie stattgefunden.')
  }

  # VERSION.txt schreibt der Workflow bei jedem Deploy.
  $version = Join-Path $DeployDir 'VERSION.txt'
  if (Test-Path $version) {
    Write-Host '  VERSION.txt:'
    Get-Content $version | ForEach-Object { Write-Host "    $_" }
  } else {
    Write-Host '  VERSION.txt fehlt.' -ForegroundColor Yellow
    Merke 'warnung' @('VERSION.txt fehlt - der letzte erfolgreiche Deploy liegt vor deren Einfuehrung.')
  }
}

# --- 2. Der Runner: laeuft er, und unter welchem Konto? --------------------
Titel 'GitHub-Runner'

$runnerDienste = @(Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue)
$runnerKonto = $null

if ($runnerDienste.Count -eq 0) {
  Write-Host '  Kein Runner-Dienst gefunden.' -ForegroundColor Red
  Merke 'fehler' @(
    'Der Runner ist nicht als Dienst eingerichtet. Ohne ihn bleibt der Deploy-Job',
    'auf GitHub bei "Waiting for a runner" stehen und tut nie etwas.'
  )
} else {
  foreach ($d in $runnerDienste) {
    $wmi = Get-CimInstance Win32_Service -Filter "Name='$($d.Name)'" -ErrorAction SilentlyContinue
    $runnerKonto = $wmi.StartName
    $farbe = 'Red'
    if ($d.Status -eq 'Running') { $farbe = 'Green' }
    Write-Host "  $($d.Name)"
    Write-Host "    Status: $($d.Status)" -ForegroundColor $farbe
    Write-Host "    Konto : $runnerKonto"
    Write-Host "    Start : $($wmi.StartMode)"
    if ($d.Status -ne 'Running') {
      Merke 'fehler' @(
        "Der Runner-Dienst laeuft nicht ($($d.Name)).",
        'Solange er steht, bleibt jeder Deploy in der Warteschlange haengen.',
        'Starten mit:  Start-Service ' + $d.Name
      )
    }
    if ($wmi.StartMode -ne 'Auto') {
      Merke 'warnung' @('Der Runner-Dienst startet nicht automatisch mit Windows - nach einem Neustart steht er.')
    }
  }
}

# --- 3. Die Autostart-Aufgabe ---------------------------------------------
Titel 'Autostart-Aufgabe "SmartHome"'

$aufgabe = Get-ScheduledTask -TaskName 'SmartHome' -ErrorAction SilentlyContinue
$aufgabenKonto = $null

if (-not $aufgabe) {
  Write-Host '  Die Aufgabe "SmartHome" gibt es nicht.' -ForegroundColor Red
  Merke 'fehler' @(
    'Die Aufgabe "SmartHome" fehlt. Der Deploy prueft sie im ersten Schritt und',
    'bricht dort ab - noch bevor irgendetwas kopiert wird.',
    'Behebung: auf dem Server einmalig "Server-PC einrichten.cmd" als',
    'Administrator ausfuehren (Rechtsklick -> Als Administrator ausfuehren).'
  )
} else {
  $aufgabenKonto = $aufgabe.Principal.UserId
  $info = $aufgabe | Get-ScheduledTaskInfo
  Write-Host "  Zustand      : $($aufgabe.State)"
  Write-Host "  Laeuft als   : $aufgabenKonto"
  Write-Host "  Letzter Lauf : Ergebnis $($info.LastTaskResult), am $($info.LastRunTime)"

  # 267009 = "laeuft gerade", das ist der Normalfall bei einem Dauerlaeufer.
  if ($info.LastTaskResult -ne 0 -and $info.LastTaskResult -ne 267009) {
    Merke 'warnung' @("Die Aufgabe endete zuletzt mit Code $($info.LastTaskResult) - siehe logs\server.log weiter unten.")
  }
}

# --- 4. Der Kernpunkt: darf der Runner die Aufgabe steuern? ---------------
Titel 'Rechte: darf der Runner den Server neu starten?'

if ($runnerKonto -and $aufgabenKonto) {
  $runnerIstSystem = $runnerKonto -match 'LocalSystem|NT AUTHORITY\\SYSTEM'
  $aufgabeIstSystem = $aufgabenKonto -match 'SYSTEM|S-1-5-18'

  Write-Host "  Runner laeuft als : $runnerKonto"
  Write-Host "  Aufgabe laeuft als: $aufgabenKonto"

  if ($aufgabeIstSystem -and -not $runnerIstSystem) {
    Write-Host ''
    Write-Host '  Das passt nicht zusammen.' -ForegroundColor Red
    Merke 'fehler' @(
      'Der Runner laeuft unter einem eingeschraenkten Konto, die Aufgabe unter',
      'SYSTEM. Damit darf der Runner den laufenden Server weder anhalten noch',
      'neu starten. Der Deploy bricht im Schritt "Server anhalten" ab - also',
      'BEVOR er die neuen Dateien kopiert. Genau so sieht es aus, wenn sich auf',
      'dem Server trotz Push nichts aendert.',
      '',
      'Behebung: deploy\runner-auf-system.cmd als Administrator ausfuehren.'
    )
  } else {
    Write-Host '  Sieht passend aus.' -ForegroundColor Green
  }
} else {
  Write-Host '  Nicht pruefbar - Runner oder Aufgabe fehlt (siehe oben).' -ForegroundColor Yellow
}

# --- 5. Laeuft der Server gerade? -----------------------------------------
Titel "Server auf Port $Port"

$horcht = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($horcht.Count -eq 0) {
  Write-Host "  Niemand horcht auf Port $Port." -ForegroundColor Red
  Merke 'fehler' @('Der Server laeuft gerade nicht.')
} else {
  foreach ($v in $horcht) {
    $p = Get-Process -Id $v.OwningProcess -ErrorAction SilentlyContinue
    Write-Host "  Prozess $($v.OwningProcess) ($($p.ProcessName)), gestartet $($p.StartTime)"
  }
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/snapshot" -UseBasicParsing -TimeoutSec 5
    Write-Host "  /api/snapshot antwortet mit $($r.StatusCode)." -ForegroundColor Green
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
      Write-Host '  /api/snapshot antwortet mit 401 - die Anmeldung ist aktiv.' -ForegroundColor Green
    } else {
      Write-Host "  /api/snapshot antwortet nicht: $($_.Exception.Message)" -ForegroundColor Red
      Merke 'warnung' @('Der Port ist belegt, aber die App antwortet nicht richtig.')
    }
  }
}

# --- 6. Anmeldung eingerichtet? -------------------------------------------
Titel 'Anmeldung'

$secrets = Join-Path $DeployDir 'secrets.json'
if (-not (Test-Path $secrets)) {
  Write-Host '  secrets.json fehlt.' -ForegroundColor Yellow
  Merke 'warnung' @('secrets.json fehlt - weder Wallbox-Daten noch Passwort sind gesetzt.')
} else {
  try {
    $s = Get-Content $secrets -Raw | ConvertFrom-Json
    $hatAuth = $s.PSObject.Properties.Name -contains 'auth'
    $tuya = 'fehlt'
    if ($s.PSObject.Properties.Name -contains 'tuya') { $tuya = 'gesetzt' }
    Write-Host "  Wallbox (tuya): $tuya"
    # Konten lesen. Zwei Formen sind moeglich: die heutige mit auth.benutzer
    # (mehrere Konten mit Rollen) und die fruehere mit einem einzelnen Konto
    # direkt unter auth. Der Server wandelt die alte beim Start um - dieses
    # Skript liest aber nur, also muss es beide kennen.
    $konten = @()
    if ($hatAuth) {
      $a = $s.auth
      if ($a.PSObject.Properties.Name -contains 'benutzer') {
        foreach ($b in $a.benutzer) {
          if ($b.passwordHash) {
            if ($b.rolle -eq 'admin') { $konten += "$($b.username) (Administrator)" }
            else { $konten += "$($b.username)" }
          }
        }
      } elseif ($a.passwordHash) {
        $konten += "$($a.username) (Administrator, altes Format)"
      }
    }

    if ($konten.Count -gt 0) {
      Write-Host "  Konten        : $($konten -join ', ')" -ForegroundColor Green
    } else {
      Write-Host '  Passwort      : NICHT gesetzt' -ForegroundColor Red
      Merke 'warnung' @(
        'Es ist kein Passwort gesetzt. Solange der Tunnel laeuft, ist das',
        'Dashboard oeffentlich erreichbar.',
        'Setzen in C:\SmartHome mit:  npm run passwort'
      )
    }
  } catch {
    Write-Host '  secrets.json ist kein gueltiges JSON.' -ForegroundColor Red
    Merke 'fehler' @('secrets.json ist beschaedigt - der Server startet damit nicht.')
  }
}

# --- 7. Zugriff von aussen -------------------------------------------------
Titel 'Zugriff von aussen'

# Die feste Adresse zuerst: Wenn sie eingerichtet ist, ist der Cloudflare-
# Schnelltunnel darunter nur noch eine Altlast und muss nicht laufen.
$festeDatei = Join-Path $DeployDir 'logs\feste-adresse.txt'
$hatFeste = $false
if (Test-Path $festeDatei) {
  $feste = (Get-Content $festeDatei -Raw).Trim()
  if ($feste) {
    $hatFeste = $true
    Write-Host '  Feste Adresse (Tailscale):'
    Write-Host "      $feste" -ForegroundColor White
    $tsLaeuft = @(Get-Process -Name 'tailscaled', 'tailscale-ipn' -ErrorAction SilentlyContinue)
    if ($tsLaeuft.Count -gt 0) {
      Write-Host '  Tailscale laeuft.' -ForegroundColor Green
    } else {
      Write-Host '  Tailscale laeuft nicht.' -ForegroundColor Red
      Merke 'fehler' @(
        'Die feste Adresse ist eingerichtet, aber Tailscale laeuft nicht -',
        'von aussen ist nichts erreichbar. Der Dienst startet normalerweise mit',
        'Windows; pruefen mit:  Get-Service Tailscale'
      )
    }
  }
}

if (-not $hatFeste) {
  Write-Host '  Keine feste Adresse eingerichtet.' -ForegroundColor Yellow
  Merke 'warnung' @(
    'Es ist keine feste Adresse eingerichtet. Eine trycloudflare.com-Adresse',
    'wechselt bei jedem Neustart des Tunnels und ist danach endgueltig weg.',
    'Feste, kostenlose Adresse: "Feste Adresse einrichten.cmd" als Administrator.'
  )
}

$tunnelAufgabe = Get-ScheduledTask -TaskName 'SmartHomeTunnel' -ErrorAction SilentlyContinue
$cfLaeuft = @(Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)

if ($hatFeste -and $cfLaeuft.Count -eq 0 -and -not $tunnelAufgabe) {
  # Feste Adresse da, kein Cloudflare im Spiel - alles gut, nichts weiter melden.
  Write-Host '  Cloudflare-Tunnel: nicht in Benutzung (wird nicht mehr gebraucht).'
} else {
  if ($cfLaeuft.Count -gt 0) {
    Write-Host "  cloudflared laeuft (Prozess $($cfLaeuft[0].Id), gestartet $($cfLaeuft[0].StartTime))." -ForegroundColor Green
    if ($hatFeste) {
      Merke 'warnung' @(
        'Es laufen beide Wege gleichzeitig: die feste Adresse und der alte',
        'Cloudflare-Schnelltunnel. Der Tunnel wird nicht mehr gebraucht und kann',
        'weg:  Unregister-ScheduledTask SmartHomeTunnel -Confirm:$false'
      )
    }
  } elseif (-not $hatFeste) {
    Write-Host '  cloudflared laeuft nicht.' -ForegroundColor Red
    Merke 'fehler' @(
      'Von aussen ist nichts erreichbar: weder eine feste Adresse noch ein',
      'laufender Cloudflare-Tunnel.',
      'Empfohlen: "Feste Adresse einrichten.cmd" als Administrator - die Adresse',
      'bleibt dann dauerhaft dieselbe.'
    )
  }

  $urlDatei = Join-Path $DeployDir 'logs\tunnel-url.txt'
  if (Test-Path $urlDatei) {
    $adresse = (Get-Content $urlDatei -Raw).Trim()
    $stand = (Get-Item $urlDatei).LastWriteTime
    Write-Host '  Cloudflare-Adresse (wechselt bei jedem Neustart):'
    Write-Host "      $adresse" -ForegroundColor White
    Write-Host ("  Eingetragen am {0:dd.MM.yyyy HH:mm}" -f $stand)
  } elseif ($cfLaeuft.Count -gt 0 -and -not $tunnelAufgabe) {
    Write-Host '  Keine Adresse hinterlegt (logs\tunnel-url.txt fehlt).' -ForegroundColor Yellow
    Merke 'warnung' @(
      'cloudflared laeuft, wurde aber von Hand gestartet - die Adresse steht nur',
      'in dem Fenster, in dem es gestartet wurde. Wird das Fenster geschlossen',
      'oder der PC neu gestartet, ist der Zugriff von aussen weg.'
    )
  }

  if ($tunnelAufgabe) {
    Write-Host "  Autostart-Aufgabe SmartHomeTunnel: $($tunnelAufgabe.State)"
  }
}

# --- 8. Log ---------------------------------------------------------------
Titel 'Letzte Zeilen aus logs\server.log'

$log = Join-Path $DeployDir 'logs\server.log'
if (Test-Path $log) {
  Get-Content $log -Tail 25 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} else {
  Write-Host '  Keine Logdatei - der Server ist ueber diesen Weg nie gestartet.' -ForegroundColor Yellow
}

# --- Bewertung ------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 66)
Write-Host '  Ergebnis' -ForegroundColor White
Write-Host ('=' * 66)

$fehler = @($befunde | Where-Object { $_.Stufe -eq 'fehler' })
$warnungen = @($befunde | Where-Object { $_.Stufe -eq 'warnung' })

if ($fehler.Count -eq 0 -and $warnungen.Count -eq 0) {
  Write-Host ''
  Write-Host '  Auf dem Server ist alles in Ordnung. Wenn trotzdem nichts ankommt,' -ForegroundColor Green
  Write-Host '  auf GitHub unter Actions den letzten Lauf oeffnen und nachsehen,' -ForegroundColor Green
  Write-Host '  woran er gescheitert ist.' -ForegroundColor Green
} else {
  foreach ($b in $fehler) {
    Write-Host ''
    Write-Host '  [ PROBLEM ]' -ForegroundColor Red
    foreach ($z in $b.Zeilen) { Write-Host "  $z" }
  }
  foreach ($b in $warnungen) {
    Write-Host ''
    Write-Host '  [ Hinweis ]' -ForegroundColor Yellow
    foreach ($z in $b.Zeilen) { Write-Host "  $z" }
  }
}

Write-Host ''
Write-Host '  Diesen Text bei Bedarf komplett markieren und kopieren.'
Write-Host ''
