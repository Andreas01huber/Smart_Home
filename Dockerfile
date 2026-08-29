# SmartHome — Energie-Dashboard fuer Fronius und Victron
#
# Der Server laeuft direkt aus den TypeScript-Quellen (ueber tsx), genau wie
# ausserhalb von Docker. Es gibt deshalb bewusst keinen Build-Schritt: Was hier
# laeuft, ist derselbe Code, der auch `npm test` und `npm start` durchlaeuft.
#
# Bauen und starten am einfachsten ueber docker-compose.yml im selben Ordner:
#     docker compose up -d
#
# Von Hand:
#     docker build -t smarthome .
#     docker run -d --name smarthome -p 4173:4173 \
#       -e TZ=Europe/Berlin \
#       -v "$PWD/config.json:/app/config.json:ro" \
#       -v "$PWD/secrets.json:/app/secrets.json:ro" \
#       -v "$PWD/data:/app/data" \
#       --restart unless-stopped smarthome

FROM node:22-slim

# Zeitzone ist hier keine Kosmetik, sondern Datenqualitaet: Der Tageswechsel der
# Historie liegt auf der ORTS-Mitternacht (siehe localDate() in history.ts). Ohne
# tzdata faellt Node stillschweigend auf UTC zurueck und der Tag wechselt im
# Sommer zwei Stunden zu frueh - die Tagesbilanz waere dauerhaft falsch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV TZ=Europe/Berlin

WORKDIR /app

# Erst die Manifeste, dann die Installation, dann der Code. So muss npm nur dann
# neu laufen, wenn sich wirklich Abhaengigkeiten aendern - nicht bei jeder
# Code-Aenderung. Die Workspace-Manifeste muessen dafuer einzeln mitkommen.
COPY package.json package-lock.json ./
COPY packages/core/package.json       packages/core/
COPY packages/connectors/package.json packages/connectors/
COPY packages/discovery/package.json  packages/discovery/
COPY apps/server/package.json         apps/server/

# --include=dev ist Absicht und kein Versehen: tsx steht in devDependencies, wird
# hier aber zur LAUFZEIT gebraucht. Ohne das Flag laesst ein spaeter gesetztes
# NODE_ENV=production tsx weg und der Container startet nicht.
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
COPY tools tools

# config.json, secrets.json und data/ kommen bewusst NICHT ins Image, sondern
# beim Start als Volume dazu (siehe docker-compose.yml):
#   - Zugangsdaten haben in einem Image nichts verloren.
#   - IP-Adressen und Tarife lassen sich so ohne Neubau aendern.
#   - Die Historie ueberlebt jedes Update des Containers.
# Der Ordner wird hier nur angelegt und dem unprivilegierten Benutzer
# uebereignet, damit ein leeres Volume die richtigen Rechte erbt.
RUN mkdir -p /app/data && chown -R node:node /app

# Nicht als root laufen. Das Image braucht keine Sonderrechte - der Server liest
# die Anlage nur ueber das Netz und schreibt ausschliesslich nach /app/data.
USER node

EXPOSE 4173

# Prueft denselben Endpunkt, den auch das Dashboard nutzt. Kein curl noetig -
# Node 22 bringt fetch mit, und das ist ohnehin schon im Image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/snapshot').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec-Form ohne npm dazwischen: So kommt das SIGTERM beim Beenden wirklich beim
# Server an, und der schreibt Historie und Ladeprotokoll noch sauber weg
# (process.on('SIGTERM', shutdown) in apps/server/src/index.ts).
CMD ["./node_modules/.bin/tsx", "apps/server/src/index.ts"]
