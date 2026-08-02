import { MockSpeechToText } from './mock-stt.js';
import { MockConversationAgent } from './mock-agent.js';
import { MockTextToSpeech } from './mock-tts.js';
import { AdmissionsResponseEngine } from '../response/response-engine.js';
import { createTextToSpeechProvider } from '../tts/tts-provider-factory.js';
import { KOKORO_DEFAULT_VOICE } from '../tts/kokoro-voices.js';
import { TtsProviderError } from '../tts/errors.js';

/**
 * Resolve conversation agent from VOICE_RESPONSE_ENGINE.
 * Supported: deterministic (default), mock.
 */
export function createConversationAgent(engineName) {
  const mode = String(engineName ?? process.env.VOICE_RESPONSE_ENGINE ?? 'deterministic')
    .trim()
    .toLowerCase();
  if (mode === 'mock') {
    return new MockConversationAgent();
  }
  return new AdmissionsResponseEngine();
}

/**
 * Provider-independent orchestration:
 * customer audio → STT → agent → TTS → paced μ-law media
 */
export class VoicePipeline {
  constructor({
    stt = new MockSpeechToText(),
    agent = createConversationAgent(),
    tts = null,
    ttsConfig = null,
    defaultVoice = null,
  } = {}) {
    this.stt = stt;
    this.agent = agent;
    this.tts =
      tts ||
      (ttsConfig
        ? createTextToSpeechProvider(ttsConfig)
        : new MockTextToSpeech());
    this.defaultVoice = defaultVoice;
    this.providerName =
      agent instanceof MockConversationAgent
        ? 'mock'
        : agent instanceof AdmissionsResponseEngine
          ? 'deterministic'
          : 'custom';
  }

  async handleInboundAudio(audio, session = {}) {
    const transcript = await this.stt.transcribe({ audio, metadata: session });
    return this.handleTranscript(transcript, session);
  }

  /**
   * Finalize a transcript through the response engine + TTS.
   * Used by mock STT and by streaming Faster-Whisper callbacks.
   */
  async handleTranscript(transcript, session = {}) {
    const normalized = normalizeTranscript(transcript);
    if (!normalized.isFinal || !normalized.text) {
      return { transcript: normalized, reply: null, audio: null, actions: [] };
    }
    const reply = await this.agent.respond({ text: normalized.text, session });
    const language = reply.language || normalized.language || 'en';
    const voice =
      session?.metadata?.ttsVoice ||
      this.defaultVoice ||
      (language === 'en' ? KOKORO_DEFAULT_VOICE : undefined);

    let speech = null;
    let ttsError = null;
    try {
      speech = await this.tts.synthesize({
        text: reply.replyText,
        language,
        voice,
        metadata: {
          streamSid: session?.streamSid || null,
          callSid: session?.callSid || null,
          sessionClosed: session?.state === 'closed',
        },
      });
    } catch (err) {
      ttsError = {
        code:
          err instanceof TtsProviderError
            ? err.code
            : err?.code || 'tts_error',
        message: 'TTS synthesis failed',
        retryable: err?.retryable === true,
      };
    }

    return {
      transcript: normalized,
      reply,
      audio: speech?.audio ?? null,
      format: speech?.format ?? null,
      actions: reply.actions ?? [],
      tts: speech
        ? {
            provider: speech.provider,
            voice: speech.voice,
            language: speech.language,
            cached: speech.cached === true,
            durationSeconds: speech.durationSeconds,
            synthesisDurationMs: speech.synthesisDurationMs,
          }
        : null,
      ttsError,
    };
  }
}

function normalizeTranscript(transcript) {
  if (transcript == null) {
    return { text: '', isFinal: false, provider: 'unknown' };
  }
  if (typeof transcript === 'string') {
    const text = transcript.trim().slice(0, 2000);
    return { text, isFinal: Boolean(text), provider: 'external' };
  }
  const text = String(transcript.text || '').trim().slice(0, 2000);
  return {
    text,
    isFinal: transcript.isFinal !== false && Boolean(text),
    language: transcript.language ?? null,
    languageProbability: transcript.languageProbability ?? null,
    provider: transcript.provider || 'external',
    audioDurationMs: transcript.audioDurationMs ?? null,
    inferenceDurationMs: transcript.inferenceDurationMs ?? null,
  };
}
