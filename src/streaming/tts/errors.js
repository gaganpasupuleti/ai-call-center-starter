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
