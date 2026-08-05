# Phase 4F — Controlled consented SmartPing sandbox call

## Status

| Gate | Status |
|------|--------|
| Phase 4F-A (no-call preflight, safeguards, greeting, human voice review prep) | In progress on branch `phase-4f-controlled-smartping-call` |
| Phase 4F-B (exactly one manually approved network call) | **Blocked** until operator prints approval and runs `--confirm` |

Cursor / automation must never run the live `--confirm` command.

## Phase 4E.3 acceptance (starting point)

```text
Branch: phase-4e3-cpu-safe-english-tts
Commit: 765aead9b3a3bfc54b7e94c684e8cab1fba7d66c
```

Runtime path accepted on `speech-e2e`:

```text
SmartPing call → public staging WSS → Silero VAD → Faster-Whisper
  → deterministic response engine → Piper English → G.711 μ-law 8 kHz → caller
```

English TTS: `en_US-libritts_r-medium`, speaker ID `0`, provider mode `local-cpu`.

## Why English-only initially

Phase 4F is a **consented sandbox telephone call**. English was accepted end-to-end in 4E.3 under CPU-safe Piper. Telugu telephone testing requires a **later, separately approved** call after English Phase 4F-B succeeds.

## Consent requirements

- Destination must be one consenting tester (not a lead, student without consent, customer, or campaign import).
- Process-local flags required:

```env
PHASE4F_OPERATOR_APPROVED=true
PHASE4F_DESTINATION_CONSENTED=true
PHASE4F_EXPECTED_ENVIRONMENT=speech-e2e
PHASE4F_LANGUAGE=en
PHASE4F_MAX_NETWORK_REQUESTS=1
PHASE4F_APPROVAL_ID=<operator-created-non-secret-id>
```

Never set SmartPing live outbound flags on the Railway application.

## Human voice QA requirement

Generate local samples (temporary WAVs, not committed):

```bash
npm run phase4f:voice-samples
```

Listen to greeting, send-details, callback, and closing lines. Confirm:

* Speech is understandable
* Volume is acceptable
* No severe clipping
* Pronunciation is acceptable
* Voice does not sound broken
* Greeting clearly states that this is an automated test

Then set:

```env
PHASE4F_ENGLISH_VOICE_REVIEWED=true
```

Do not claim speaker 0 passed human QA unless this review occurred.

## Railway application safeguards (must remain)

```env
SMARTPING_DRY_RUN=true
SMARTPING_LIVE_CALLS_ENABLED=false
SMARTPING_SINGLE_CALL_ENABLED=false
OUTBOUND_DIALER_LIVE=false
CALL_PROVIDER=mock
VOICE_CONVERSATION_ENABLED=true
VOICE_INTERACTION_MODE=voice-dtmf
VOICE_RESPONSE_ENGINE=deterministic
VOICE_STT_PROVIDER=faster-whisper-streaming
VOICE_TTS_PROVIDER=local-cpu
OUTBOUND_TTS_PROVIDER=inherit
```

The app accepts the incoming SmartPing media stream only. Outbound initiation is **local CLI only**.

## No-call preflight

```bash
npm run phase4f:preflight
```

Verifies branch, environment, application, WSS/health/readiness, STT/Piper, voice settings, consent, voice review, prepared greeting, and that the app reports live outbound closed. **Does not** call SmartPing outbound.

Success ends with:

```text
PHASE4F_PREFLIGHT_OK
```

## Prepared greeting

Approved text:

```text
Hello. This is a consented Code Quest automated voice test.
You can say send details, call me back, not interested, or do not call.
You can also press a keypad option.
```

Prepared via `POST /api/speech/prepare-greeting` on the staging app (Piper EN → μ-law → prompt store) under a unique `app_call_id`. If preparation fails, the live call request is refused.

## Dry-run preview

```bash
npm run call:smartping-single -- --dry-run-preview
```

Expect `dryRun=true`, `networkRequestMade=false`, redacted destination/DID/token. Part of Phase 4F-A only.

## Manual approval boundary

After Phase 4F-A:

```text
PHASE4F_READY_FOR_MANUAL_APPROVAL
```

Exact one-call command (**operator only**):

```bash
npm run call:smartping-single -- \
  --confirm \
  --approval-id <APPROVAL_ID> \
  --language en
```

Requires process-local live SmartPing flags in `.env.phase4f` (gitignored). Never commit that file. Never print destination, DID, or token.

## Operator procedure (Phase 4F-B)

1. Confirm the test recipient is available.
2. Confirm they consent to an automated test call.
3. Confirm speech services are ready (`/api/speech/readiness`).
4. Confirm no other test call is active.
5. Confirm Railway app live outbound flags remain false.
6. Confirm local CLI flags are process-local (`.env.phase4f`).
7. Run preflight again.
8. Run dry-run preview again.
9. Run the exact `--confirm` command **once**.

No second attempt without a new approval ID and review.

## Test-call conversation (recommended)

```text
Bot: Opening consented-test greeting
Tester: “Send me the course details.”
Bot: Deterministic SEND_DETAILS response
Tester: “I am not interested.”
Bot: Polite closing response
Call: Ends safely
```

Limits: **2 caller turns**, **90 seconds** max (`phase4f_max_duration`). No SMS/WhatsApp send. Transfer remains simulated while Railway live flags are false.

## Emergency hangup / terminal phrases

Immediate terminal phrases: `stop`, `end the call`, `hang up`, `do not call`, `do not call me again`, `not interested`.

These play a short closing response, stop further listening, end the call, and record completion. `DO_NOT_CALL` is terminal. Do not auto-redial.

## Monitoring checklist (safe events only)

```text
outbound_request_submitted, stream_connected, stream_started,
greeting_queued, greeting_completed, listening,
speech_started, speech_ended, transcript_received,
intent_selected, tts_started, tts_completed, response_played,
conversation_completed, stream_stopped
```

Record `phase4fRunId`, timestamps, language, intent, provider, voice, latency, completion reason, HTTP status. Do **not** record raw audio, full destination/DID/token, SmartPing response body, or private service URLs.

## Live acceptance criteria

Pass only when: one outbound request, one destination, stream connected, greeting audible, Silero + Faster-Whisper path worked, expected intent, Piper EN `en_US-libritts_r-medium`, valid μ-law response audible, call ended ≤90s, no SMS/WhatsApp, no real transfer, no second call, no raw audio stored.

## No-retry policy

At most one HTTP request. Never retry on timeout, 4xx, 5xx, or parse failure. A failed request requires a new operator review and a new approval ID.

## Post-call lockdown

Unset local live-call variables. Confirm campaign executor blocked. Confirm Railway live flags still false. Run:

```bash
npm run verify:non-live
```

## Rollback

1. Do not re-run `--confirm`.
2. Keep Railway live outbound flags false.
3. Revert or redeploy prior known-good `speech-e2e` revision if stream behaviour regresses.
4. Leave `VOICE_TTS_PROVIDER=local-cpu` unless rolling back TTS separately.

## Results

| Item | Result |
|------|--------|
| Network requests made (4F-A) | 0 |
| Telephone calls placed (4F-A) | 0 |
| Human voice review | Operator checklist required |
| Phase 4F-B | Awaiting `PHASE4F_READY_FOR_MANUAL_APPROVAL` + operator `--confirm` |

## Production-readiness findings

- Self-hosted English path is ready for **one** consented sandbox call after human voice QA and manual approval.
- Railway app must remain fail-closed for outbound initiation.
- Campaign/bulk dialer must stay blocked.
- One call does **not** establish production-scale performance or Telugu telephone readiness.
