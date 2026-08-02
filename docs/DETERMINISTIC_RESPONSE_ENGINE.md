# Deterministic Response Engine (Phase 4A)

Phase 4A adds a **rule-based, multilingual conversation engine** for admissions-style outbound calls.

## Why no LLM

- Predictable replies for regulated outbound campaigns
- No per-call API cost or latency to a model host
- No dependency on OpenAI, Deepgram, or other paid decision APIs
- Easy to audit: intents and phrases live in editable config files
- Safe to run offline in tests and local simulation

This phase does **not** implement Faster-Whisper STT or production TTS. Mock STT and mock TTS remain for tests and the SmartPing stream simulator.

## Pipeline architecture

```text
Customer audio
→ speech-to-text (mock in Phase 4A)
→ AdmissionsResponseEngine (deterministic)
→ text-to-speech (mock in Phase 4A)
→ SmartPing μ-law media (when playbackMode=pipeline)
```

Outbound dialer flows that use Edge TTS + DTMF continue unchanged. Fixed-welcome and outbound-TTS playback modes still skip the STT → engine → TTS pipeline.

Constructor injection is unchanged:

```javascript
new VoicePipeline({ stt, agent, tts });
```

Default `agent` is `AdmissionsResponseEngine`. Set `VOICE_RESPONSE_ENGINE=mock` to use `MockConversationAgent` for debugging.

## Supported intents

`GREETING`, `INTERESTED`, `SEND_DETAILS`, `BOOK_DEMO`, `CALLBACK`, `CALLBACK_TIME`, `ASK_PRICE`, `ASK_COURSE`, `ASK_DURATION`, `ASK_LOCATION`, `ASK_ONLINE_OFFLINE`, `NOT_INTERESTED`, `DO_NOT_CALL`, `HUMAN_AGENT`, `YES`, `NO`, `REPEAT`, `UNKNOWN`

## Conversation states

Stored **per call** on `session.metadata` (never in a process-wide singleton):

- `waiting_for_initial_response` (initial)
- `waiting_for_demo_interest`
- `waiting_for_demo_date`
- `waiting_for_callback_time`
- `waiting_for_details_confirmation`
- `waiting_for_human_transfer`
- `completed`

Helpers: `getConversationState`, `setConversationState`, `incrementUnknownCount`, `resetUnknownCount`.

## Phrase configuration

| File | Role |
|------|------|
| `src/streaming/response/intents.en.js` | English phrases / keywords |
| `src/streaming/response/intents.te.js` | Telugu + transliterated phrases |
| `src/streaming/response/responses.en.js` | English reply templates |
| `src/streaming/response/responses.te.js` | Telugu reply templates |

Matching uses normalized exact phrases, required keyword groups, optional keywords, token-overlap scoring, conversation state, and negation protection. No NLP libraries.

## Unknown handling

1. First `UNKNOWN` — ask to repeat  
2. Second `UNKNOWN` — list supported choices  
3. Third `UNKNOWN` — DTMF fallback prompt + `{ type: 'enable_dtmf_fallback' }`  

Any successfully recognized intent resets the unknown counter.

## Safety: `DO_NOT_CALL`

`DO_NOT_CALL` has the highest matching priority. Negative phrases such as “I am not interested” must not classify as `INTERESTED`. The engine returns `{ type: 'mark_do_not_call' }` for orchestration; it does not mutate the database itself.

## How to add a new intent

1. Add the intent name to `INTENT_PRIORITY_EN` / `INTENT_PRIORITY_TE` (order matters).
2. Add phrase + keyword config in `intents.en.js` and, if needed, `intents.te.js`.
3. Add reply templates in `responses.en.js` / `responses.te.js`.
4. Handle the intent in `AdmissionsResponseEngine.#plan` (reply, actions, next state).
5. Add a deterministic unit test.

## How to add new phrases

Edit the `phrases` / `requiredKeywords` arrays for an existing intent. Prefer readable lists over clever regex. Re-run `npm test`.

## Future STT / TTS boundaries

| Stage | Owns |
|-------|------|
| Phase 4A (this) | Intent + state + reply text + actions |
| Phase 4B (next) | Silero VAD → utterance buffering → Faster-Whisper STT service |
| Later | Local / Edge TTS for engine replies on live media |

The response engine must keep accepting `{ text, session }` and returning at least `{ replyText, actions, provider }` so STT/TTS can be swapped without redesigning decisions.

## Environment

```env
VOICE_RESPONSE_ENGINE=deterministic
```

Supported values: `deterministic` (default), `mock`. Unknown values fall back to `deterministic`.

Live-call flags (`SMARTPING_LIVE_CALLS_ENABLED`, etc.) stay fail-closed by default.

## Limitations of rule-based matching

- Incomplete coverage of Telugu dialects and ASR error patterns
- Weak handling of long, multi-intent utterances
- Simple entity extraction (not a full date/time parser)
- State machine is admissions-oriented and intentionally small
- Transliteration support is practical, not linguistically complete

Expand configuration and tests as real transcripts arrive; do not jump to an LLM for Phase 4A/4B foundations.
