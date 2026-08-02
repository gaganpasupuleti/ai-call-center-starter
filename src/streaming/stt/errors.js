export class SttClientError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message || code);
    this.name = 'SttClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

export const STT_ERROR_CODES = Object.freeze({
  CONNECT_FAILED: 'stt_connect_failed',
  CONNECT_TIMEOUT: 'stt_connect_timeout',
  PROTOCOL_ERROR: 'stt_protocol_error',
  SERVICE_CLOSED: 'stt_service_closed',
  TRANSCRIPTION_TIMEOUT: 'stt_transcription_timeout',
  MODEL_UNAVAILABLE: 'stt_model_unavailable',
  AUDIO_OVERFLOW: 'stt_audio_overflow',
});
