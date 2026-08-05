/**
 * Operator-only English voice-review sample (WAV).
 * Blocked when any live outbound telephone gate is open.
 */
import { synthesizeOutboundAudio } from '../tts/tts-provider-factory.js';
import { mulawToWavBase64 } from '../tts/mulaw-encode.js';
import {
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
} from '../tts/piper-voices.js';
import { PHASE4F_VOICE_SAMPLES } from './guards.js';

const ALLOWED = new Set(PHASE4F_VOICE_SAMPLES.map((s) => s.text));

export function assertVoiceReviewSurfaceOpen(config) {
  if (
    config.smartPing?.liveCallsEnabled === true ||
    config.smartPing?.singleCallEnabled === true ||
    config.outbound?.dialerLive === true
  ) {
    throw Object.assign(
      new Error('Voice review samples disabled while live-call gates are open'),
      { code: 'voice_review_forbidden', statusCode: 403 },
    );
  }
}

export async function synthesizePhase4fVoiceReviewSample(config, { text, id } = {}) {
  assertVoiceReviewSurfaceOpen(config);

  let spoken = String(text || '').trim();
  if (!spoken && id) {
    const match = PHASE4F_VOICE_SAMPLES.find((s) => s.id === id);
    spoken = match?.text || '';
  }
  if (!spoken || !ALLOWED.has(spoken)) {
    throw Object.assign(
      new Error('Only approved Phase 4F review phrases are allowed'),
      { code: 'voice_review_text_not_allowed', statusCode: 400 },
    );
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
  if (!bytes.length) {
    throw Object.assign(new Error('Empty review sample audio'), {
      code: 'voice_review_empty',
      statusCode: 500,
    });
  }

  const wav = mulawToWavBase64(bytes);
  return {
    ok: true,
    id: id || null,
    provider: synthesized.provider || 'piper-local',
    voice: synthesized.voice || voice,
    speakerId,
    mimeType: wav.mimeType,
    wavBase64: wav.base64,
    byteLength: bytes.length,
    durationSeconds: synthesized.durationSeconds ?? null,
    networkRequestMade: false,
    telephoneCalls: 0,
  };
}
