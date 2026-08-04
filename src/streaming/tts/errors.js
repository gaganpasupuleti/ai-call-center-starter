export const TTS_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'tts_not_configured',
  LANGUAGE_NOT_CONFIGURED: 'tts_language_not_configured',
  CONNECT_FAILED: 'tts_connect_failed',
  CONNECT_TIMEOUT: 'tts_connect_timeout',
  REQUEST_TIMEOUT: 'tts_request_timeout',
  HTTP_ERROR: 'tts_http_error',
  INVALID_RESPONSE: 'tts_invalid_response',
  EMPTY_RESPONSE: 'tts_empty_response',
  RESPONSE_TOO_LARGE: 'tts_response_too_large',
  CONVERSION_FAILED: 'tts_conversion_failed',
  CONVERSION_TIMEOUT: 'tts_conversion_timeout',
  QUEUE_FULL: 'tts_queue_full',
  SESSION_CLOSED: 'tts_session_closed',
  TEXT_TOO_LONG: 'tts_text_too_long',
  VOICE_NOT_ALLOWED: 'tts_voice_not_allowed',
  LANGUAGE_VOICE_MISMATCH: 'tts_language_voice_mismatch',
  // Piper-specific (also used as primary codes from PiperTextToSpeech)
  PIPER_NOT_CONFIGURED: 'piper_not_configured',
  PIPER_CONNECT_FAILED: 'piper_connect_failed',
  PIPER_CONNECT_TIMEOUT: 'piper_connect_timeout',
  PIPER_REQUEST_TIMEOUT: 'piper_request_timeout',
  PIPER_HTTP_ERROR: 'piper_http_error',
  PIPER_INVALID_RESPONSE: 'piper_invalid_response',
  PIPER_EMPTY_RESPONSE: 'piper_empty_response',
  PIPER_RESPONSE_TOO_LARGE: 'piper_response_too_large',
  PIPER_VOICE_NOT_ALLOWED: 'piper_voice_not_allowed',
  PIPER_SPEAKER_NOT_ALLOWED: 'piper_speaker_not_allowed',
  PIPER_MODEL_UNAVAILABLE: 'piper_model_unavailable',
  PIPER_CONVERSION_FAILED: 'piper_conversion_failed',
  PIPER_CONVERSION_TIMEOUT: 'piper_conversion_timeout',
});

export class TtsProviderError extends Error {
  constructor(code, message, { retryable = false, statusCode = 500 } = {}) {
    super(message || code);
    this.name = 'TtsProviderError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}
