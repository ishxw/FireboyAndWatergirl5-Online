# Public Deployment

## Quick start

### Option 1: Run directly on a VPS

Requirements:
- Node.js 18+
- A public domain name
- An HTTPS reverse proxy such as Nginx or Caddy

Commands:

```bash
npm install
npm start
```

Default service:
- App: `http://127.0.0.1:8005`
- Health check: `http://127.0.0.1:8005/healthz`
- WebSocket: `ws://127.0.0.1:8005/ws`

Recommended environment variables:

```bash
PORT=8005
HOST=0.0.0.0
DATA_DIR=/var/lib/fireboy-online
DB_FILE=/var/lib/fireboy-online/fireboy-online.sqlite
SESSION_TTL_MS=2592000000
RECONNECT_GRACE_MS=60000
```

## Nginx reverse proxy example

Use HTTPS in front of the Node server. WebSocket upgrade is required.

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8005;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8005/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
    }
}
```

## Docker

Build:

```bash
docker build -t fireboy-online .
```

Run:

```bash
docker run -d \
  --name fireboy-online \
  -p 8005:8005 \
  -e PORT=8005 \
  -e HOST=0.0.0.0 \
  -e DATA_DIR=/data \
  -v /your/persistent/path:/data \
  fireboy-online
```

## Persistence

Account data, sessions, and progress are stored in SQLite:

```text
/var/lib/fireboy-online/fireboy-online.sqlite
```

For production, mount a persistent disk or point `DATA_DIR` / `DB_FILE` to durable storage.

## Health check

```bash
curl http://127.0.0.1:8005/healthz
```

Expected response includes:
- `ok`
- `activeRooms`
- `activeClients`
- `accounts`
- `dbFile`

## Important current limitations

This version is deployable, but the multiplayer simulation is still based on:
- one host acting as the authority
- level snapshots broadcast to the other player
- a single Node process with local SQLite persistence

That means:
- it is suitable for small public deployments and friend-room usage
- it is not yet ideal for high-latency competitive internet play
- if you want stronger public reliability, the next step should be:
  - authoritative server-side simulation or deterministic sync
  - Redis / database-backed room state
  - reconnect / resume logic
  - process manager and multi-instance support
