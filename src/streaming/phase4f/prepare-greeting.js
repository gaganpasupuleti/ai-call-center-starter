/**
 * Prepare Phase 4F greeting audio on the application prompt store.
 * Used by POST /api/speech/prepare-greeting — never places a SmartPing call.
 */
import { AUDIO, MULAW_SILENCE } from '../constants.js';
import { getOutboundPromptStore } from '../outbound/prompt-store.js';
import { synthesizeOutboundAudio } from '../tts/tts-provider-factory.js';
import {
  PHASE4F_GREETING_TEXT,
  PHASE4F_SOURCE,
} from './guards.js';
import {
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
} from '../tts/piper-voices.js';

export function validateGreetingMulaw(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    return { valid: false, reason: 'not_buffer' };
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length) return { valid: false, reason: 'empty' };
  const durationMs = Math.round((buf.length / AUDIO.sampleRate) * 1000);
  if (durationMs < 800) {
    return { valid: false, reason: 'too_short', durationMs };
  }
  if (durationMs > 30_000) {
    return { valid: false, reason: 'too_long', durationMs };
  }
  let silence = 0;
  let energetic = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b === MULAW_SILENCE || b === 0xff || b === 0x7f) silence += 1;
    // μ-law values away from idle encodings
    if (b !== MULAW_SILENCE && b !== 0xff && b !== 0x7f) energetic += 1;
  }
  const silenceRatio = silence / buf.length;
  if (silenceRatio > 0.98 || energetic < 40) {
    return { valid: false, reason: 'silence_only', silenceRatio, durationMs };
  }
  return { valid: true, durationMs, silenceRatio };
}

export async function preparePhase4fGreeting(
  config,
  {
    text = PHASE4F_GREETING_TEXT,
    ttlMs = 60 * 60 * 1000,
    promptStore = null,
  } = {},
) {
  const spoken = String(text || '').trim();
  if (!spoken) {
    throw Object.assign(new Error('Greeting text is required'), {
      code: 'greeting_text_missing',
      statusCode: 400,
    });
  }

  const voice =
    config.piper?.englishVoice ||
    process.env.PIPER_ENGLISH_VOICE ||
    PIPER_DEFAULT_ENGLISH_VOICE;
  const speakerId =
    config.piper?.englishSpeakerId ??
    Number(
      process.env.PIPER_ENGLISH_SPEAKER_ID ?? PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
    );

  const synthesized = await synthesizeOutboundAudio(
    spoken,
    {
      language: 'en',
      voice,
      speakerId,
      requireMatchingScript: false,
    },
    config,
  );

  const bytes = Buffer.from(synthesized.bytes || []);
  const validation = validateGreetingMulaw(bytes);
  if (!validation.valid) {
    throw Object.assign(
      new Error(`Greeting audio validation failed: ${validation.reason}`),
      {
        code: 'greeting_audio_invalid',
        statusCode: 500,
        reason: validation.reason,
      },
    );
  }

  const store = promptStore || getOutboundPromptStore();
  const previousTtl = store.ttlMs;
  store.ttlMs = ttlMs;
  let record;
  try {
    record = store.create({
      phoneMasked: null,
      messageLength: spoken.length,
      repeatCount: 1,
      mulawBytes: bytes,
      durationSeconds:
        synthesized.durationSeconds ?? validation.durationMs / 1000,
      voice: synthesized.voice || voice,
      provider: synthesized.provider || 'piper-local',
      interactive: false,
    });
  } finally {
    store.ttlMs = previousTtl;
  }

  return {
    ok: true,
    appCallId: record.appCallId,
    source: PHASE4F_SOURCE,
    provider: record.provider,
    voice: record.voice,
    speakerId,
    byteLength: bytes.length,
    durationSeconds: record.durationSeconds,
    expiresAt: record.expiresAt,
    repeatCount: 1,
    textLength: spoken.length,
    networkRequestMade: false,
  };
}
