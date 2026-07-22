# Railway deployment — Phase 3B public WebSocket stream

This guide deploys a **stream-only** SmartPing WebSocket test service.

- No real telephone calls
- No SmartPing outbound API calls
- No `CALL_PROVIDER=smartping`
- Dashboard and management APIs are blocked publicly
- Temporary WebSocket bearer auth is for our Railway simulator only until SmartPing documents WebSocket authentication
- Do **not** create or advertise a “Token URL”

## 1. GitHub deployment steps

1. Create or use a GitHub repository owned by you.
2. Push this project (excluding `.env`, databases, logs, artifacts).
3. In Railway, choose **Deploy from GitHub** and select that repository.

If Git is not initialized locally, initialize it, add the GitHub remote you own, then push.

## 2. Railway service creation

1. Open [Railway](https://railway.com).
2. Create a new project.
3. Add a service from the GitHub repo (or deploy from the local directory with Railway CLI).
4. Set the start command to `npm start` (also configured in `railway.toml`).

## 3. Public-domain generation

1. Open the service → **Settings** → **Networking**.
2. Generate a public domain.
3. Note the HTTPS host, for example `https://<generated-domain>`.
4. The WebSocket URL will be:

```text
wss://<generated-domain>/ws/voice/smartping
```

## 4. Volume creation and `/data` mount

1. Create a Railway Volume.
2. Mount it at `/data`.
3. Set `DATABASE_PATH=/data/ai-call-center.sqlite`.

Raw audio remains disabled by default (`SMARTPING_STORE_AUDIO=false`).

## 5. Exact environment variables

Set these values in Railway (generate a new stream secret; do not reuse any PDF API token):

```text
NODE_ENV=production
HOST=0.0.0.0
APP_EXPOSURE_MODE=stream-only
DATABASE_PATH=/data/ai-call-center.sqlite
CALL_PROVIDER=mock
SMARTPING_DRY_RUN=true
SMARTPING_LIVE_CALLS_ENABLED=false
SMARTPING_STORE_AUDIO=false
SMARTPING_STREAM_AUTH_MODE=required
SMARTPING_STREAM_SHARED_SECRET=<new Railway-only secret>
WEBHOOK_SECRET=<new random secret>
```

Keep unset initially:

```text
SMARTPING_API_TOKEN
SMARTPING_DID_NUMBER
SMARTPING_BASE_URL
SMARTPING_STREAM_URL
```

Do **not** manually set `PORT`. Railway injects it.

After the public WSS simulator passes, you may set:

```text
SMARTPING_STREAM_URL=wss://<generated-domain>/ws/voice/smartping
```

## 6. HTTP health check

Railway health check path:

```text
/healthz
```

Expected body:

```json
{
  "status": "ok",
  "service": "smartping-voice-stream",
  "liveCallsEnabled": false
}
```

## 7. Public WSS simulator command

```bash
npm run simulate:smartping-stream -- \
  --url wss://<generated-domain>/ws/voice/smartping \
  --token-file .railway-stream-secret.local
```

Or:

```bash
npm run simulate:smartping-stream -- \
  --url wss://<generated-domain>/ws/voice/smartping \
  --token <Railway stream test secret>
```

Prefer `--token-file` so the secret is not pasted into shell history.

The simulator sends:

```text
Authorization: Bearer <Railway stream test secret>
```

This bearer auth is temporary test protection only. It is not a SmartPing-documented WebSocket authentication contract and must not be called a “Token URL.”

## 8. Log and secret checks

Inspect Railway logs and confirm:

- No API tokens
- No stream shared secret
- No raw audio payloads
- No phone-number dumps from dashboard data
- No outbound SmartPing HTTP requests
- No external AI provider calls

## 9. Rollback steps

1. In Railway, open **Deployments**.
2. Redeploy the previous successful deployment.
3. Or set `APP_EXPOSURE_MODE=stream-only` and disable public networking if needed.
4. Rotate `SMARTPING_STREAM_SHARED_SECRET` and `WEBHOOK_SECRET` if exposure is suspected.

## 10. Railway WebSocket connection limit

Railway currently documents a **15-minute** WebSocket connection duration limit on the public edge. Long-lived voice sessions may be disconnected at that limit. Plan reconnect/test windows accordingly.

## 11. Dashboard disabled in stream-only mode

With `APP_EXPOSURE_MODE=stream-only`:

- `/healthz` is allowed
- `/ws/voice/smartping` is allowed (with required bearer auth)
- Authenticated local stream command endpoint is allowed only for simulator controls
- Dashboard, static UI, and other `/api/*` management routes return 404

## 12. Real calls remain disabled

These remain mandatory for Phase 3B:

- `CALL_PROVIDER=mock`
- `SMARTPING_DRY_RUN=true`
- `SMARTPING_LIVE_CALLS_ENABLED=false`

No SmartPing outbound call API is invoked by this deployment.
