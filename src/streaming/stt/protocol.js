export const STT_CLIENT_EVENTS = Object.freeze({
  START: 'start',
  STOP: 'stop',
  PING: 'ping',
});

export const STT_SERVER_EVENTS = Object.freeze({
  READY: 'ready',
  SPEECH_STARTED: 'speech_started',
  SPEECH_ENDED: 'speech_ended',
  TRANSCRIPT: 'transcript',
  NO_SPEECH: 'no_speech',
  ERROR: 'error',
  PONG: 'pong',
});

export function buildStartMessage({
  streamSid,
  callSid = null,
  language = 'en',
  encoding = 'mulaw',
  sampleRate = 8000,
  channels = 1,
} = {}) {
  return {
    type: STT_CLIENT_EVENTS.START,
    streamSid,
    callSid,
    language,
    encoding,
    sampleRate,
    channels,
  };
}

export function buildStopMessage() {
  return { type: STT_CLIENT_EVENTS.STOP };
}

/**
 * Parse and validate a JSON message from the STT service.
 * Returns null for ignorable/unknown shapes (caller may log protocol error).
 */
export function parseServerMessage(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, code: 'stt_protocol_error', message: 'Malformed JSON' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'stt_protocol_error', message: 'Invalid message' };
  }
  const type = data.type;
  if (type === STT_SERVER_EVENTS.TRANSCRIPT) {
    if (data.isFinal !== true || typeof data.text !== 'string') {
      return {
        ok: false,
        code: 'stt_protocol_error',
        message: 'Malformed transcript',
      };
    }
    const text = data.text.trim();
    if (!text) {
      return {
        ok: true,
        event: {
          type: STT_SERVER_EVENTS.NO_SPEECH,
          streamSid: data.streamSid,
          reason: 'empty_transcript',
        },
      };
    }
    return {
      ok: true,
      event: {
        type: STT_SERVER_EVENTS.TRANSCRIPT,
        streamSid: data.streamSid,
        text: text.slice(0, 2000),
        language: data.language || null,
        languageProbability:
          data.languageProbability == null ? null : Number(data.languageProbability),
        isFinal: true,
        audioDurationMs: data.audioDurationMs ?? null,
        inferenceDurationMs: data.inferenceDurationMs ?? null,
        provider: data.provider || 'faster-whisper',
      },
    };
  }
  return { ok: true, event: data };
}
