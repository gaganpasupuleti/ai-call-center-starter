# SmartPing integration checklist

Use this checklist when the sample APIs and sandbox access arrive.

## Documentation needed

- Outbound-call endpoint, HTTP method, base URL, and authentication
- Required caller ID, campaign, flow, audio, or Voicebot identifiers
- Example success and error responses
- Provider call ID field
- Webhook URL registration process
- Webhook authentication or signature verification
- Call status/CDR payload and status definitions
- DTMF/keypad payload and selected-digit field
- Retry behavior, event IDs, and event ordering
- Recording URL and retention behavior, if enabled
- Sandbox restrictions, rate limits, and approved test-number rules

For our own AI agent, obtain separate documentation for bidirectional WebSocket, SIP, or RTP audio. A normal OBD endpoint and DTMF webhook are not enough for real-time AI conversation.

## Fields to map

The rest of the application expects the provider adapter to return this shape when a call starts:

```json
{
  "providerCallId": "provider-unique-id",
  "status": "initiated",
  "raw": {}
}
```

Every provider callback must be normalized to:

```json
{
  "eventId": "provider-event-id",
  "providerCallId": "provider-call-id",
  "status": "completed",
  "selectedDigit": "1",
  "durationSeconds": 32,
  "recordingUrl": null,
  "occurredAt": "2026-07-21T12:00:00.000Z",
  "raw": {}
}
```

Supported internal statuses are:

- `queued`
- `initiated`
- `ringing`
- `answered`
- `completed`
- `busy`
- `no_answer`
- `rejected`
- `failed`

## First live sandbox acceptance test

Use only a number owned by or explicitly approved by the tester.

1. Configure the sandbox credentials and public HTTPS webhook URL.
2. Start one call using `POST /api/calls/test`.
3. Confirm an accepted response and save the provider call ID.
4. Answer the call and press `1`.
5. Confirm the app receives `ringing`, `answered`, and final status events.
6. Confirm the stored selected digit is exactly `1`.
7. Confirm duration and timestamps are populated.
8. Replay the same webhook and confirm it is marked as a duplicate.
9. Repeat with `no answer` and `rejected` scenarios.
10. Only after all checks pass, test a very small campaign.

## Go/no-go criteria

The basic automated IVR product is viable if SmartPing can reliably:

- accept an outbound call through API
- associate our internal call or lead reference
- play configured audio or text-to-speech
- return final call status
- return the exact DTMF selection through a webhook or CDR

Our own conversational AI product additionally requires real-time, two-way media access and human-agent transfer support.
