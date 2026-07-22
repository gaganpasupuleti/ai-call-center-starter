# SmartPing VoiceStreaming — Phase 3A

Phase 3A implements the documented bidirectional WebSocket audio protocol and a local simulator. It does **not** place real telephone calls and does **not** activate `CALL_PROVIDER=smartping`.

## Live audio flow

```text
Customer speech
→ SmartPing WebSocket
→ STT (mock in Phase 3A)
→ AI agent (mock in Phase 3A)
→ TTS (mock in Phase 3A)
→ μ-law 8 kHz conversion
→ 160-byte paced WebSocket media (20 ms)
→ Customer
```

## WebSocket endpoint

Default local path:

`ws://127.0.0.1:8787/ws/voice/smartping`

Configure with `SMARTPING_STREAM_URL`.

### Inbound events (SmartPing → us)

- `connected`
- `start`
- `media`
- `mark`
- `stop`

### Outbound commands (us → SmartPing)

- `media`
- `mark`
- `clear`
- `hangupCall`
- `transfer` (`queue` or `external`)

Audio format: G.711 μ-law, 8000 Hz, mono, base64 payload, 160-byte / 20 ms paced chunks.

## Outbound HTTP request builder

Documented path:

`POST {SMARTPING_BASE_URL}/agm/at/streaming/campaign/voicebot/call-customer`

Headers:

- `Content-Type: application/json`
- `x-api-token: <secret>`

Body:

```json
{
  "phone_number": "+91...",
  "did_number": "<DID>",
  "url": "wss://.../ws/voice/smartping",
  "channel_vars": {
    "custom_parameters": {
      "app_call_id": "..."
    }
  }
}
```

Dry-run preview API:

`POST /api/smartping/outbound/preview`

Never returns the raw API token.

Response parsing for provider call IDs remains intentionally pending an official sample response.

## Local simulator

With the app running:

```bash
npm run simulate:smartping-stream
```

The simulator:

1. Opens a WebSocket to the local stream endpoint
2. Sends `connected` + `start`
3. Sends sample μ-law `media`
4. Receives mock bot `media` + `mark`
5. Exercises `clear`, queue transfer, external transfer, and `hangupCall`
6. Sends `stop`

It never calls SmartPing and never places a phone call.

## Fail-closed configuration

| Variable | Phase 3A default | Purpose |
|---|---|---|
| `SMARTPING_DRY_RUN` | `true` | Preview only, no network call |
| `SMARTPING_LIVE_CALLS_ENABLED` | `false` | Blocks live outbound calling |
| `SMARTPING_STORE_AUDIO` | `false` | Do not persist raw audio payloads |
| `CALL_PROVIDER` | `mock` | Keep Phase 2 mock call-control active |

## Remaining live-test requirements

Before any real sandbox call:

- Sandbox hostname / base URL
- New sandbox API token (never commit it)
- Test DID number
- Approved consented test number
- Official API success and error response samples
- CDR / status webhook documentation
- DTMF documentation for streaming or companion webhooks
- WebSocket authentication requirements, if any
- Rate and concurrency limits
- Confirmation of transfer payload field names in production

## Module boundary

Streaming code lives under `src/streaming/` and is isolated from core `CallService` campaign/IVR logic. Mock STT / agent / TTS implementations are replaceable behind provider-independent interfaces.
