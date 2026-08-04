import WebSocket from 'ws';
import { STT_ERROR_CODES, SttClientError } from './errors.js';
import {
  buildStartMessage,
  buildStopMessage,
  parseServerMessage,
  STT_SERVER_EVENTS,
} from './protocol.js';

/**
 * One STT WebSocket per SmartPing stream.
 *
 * Pending-audio strategy: before the service sends `ready`, buffer up to
 * maxPendingAudioBytes. On overflow, drop the oldest frames and record
 * stt_audio_overflow (do not crash the SmartPing socket).
 */
export class StreamingSttClient {
  constructor({
    url,
    streamSid,
    callSid = null,
    language = 'en',
    token = '',
    connectTimeoutMs = 5000,
    transcriptTimeoutMs = 20000,
    maxPendingAudioBytes = 16000,
    WebSocketImpl = WebSocket,
    onTranscript = null,
    onEvent = null,
    onError = null,
  } = {}) {
    if (!url) throw new SttClientError(STT_ERROR_CODES.CONNECT_FAILED, 'STT URL required');
    if (!streamSid) throw new SttClientError(STT_ERROR_CODES.PROTOCOL_ERROR, 'streamSid required');
    this.url = url;
    this.streamSid = streamSid;
    this.callSid = callSid;
    this.language = language;
    this.token = token || '';
    this.connectTimeoutMs = connectTimeoutMs;
    this.transcriptTimeoutMs = transcriptTimeoutMs;
    this.maxPendingAudioBytes = maxPendingAudioBytes;
    this.WebSocketImpl = WebSocketImpl;
    this.onTranscript = onTranscript;
    this.onEvent = onEvent;
    this.onError = onError;

    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.connectTimer = null;
    this.transcriptTimer = null;
    this._overflowReported = false;
  }

  async connect() {
    if (this.closed) return;
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (code, message) => {
        if (settled) return;
        settled = true;
        this.#clearConnectTimer();
        const err = new SttClientError(code, message);
        this.#emitError(err);
        reject(err);
      };

      try {
        this.ws = new this.WebSocketImpl(this.url, { headers });
      } catch (err) {
        fail(STT_ERROR_CODES.CONNECT_FAILED, err.message || 'connect failed');
        return;
      }

      this.connectTimer = setTimeout(() => {
        try {
          this.ws?.terminate?.();
        } catch {
          // ignore
        }
        fail(STT_ERROR_CODES.CONNECT_TIMEOUT, 'STT connect timeout');
      }, this.connectTimeoutMs);

      this.ws.on('open', () => {
        try {
          this.ws.send(
            JSON.stringify(
              buildStartMessage({
                streamSid: this.streamSid,
                callSid: this.callSid,
                language: this.language,
              }),
            ),
          );
        } catch (err) {
          fail(STT_ERROR_CODES.PROTOCOL_ERROR, err.message || 'start failed');
        }
      });

      this.ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const parsed = parseServerMessage(text);
        if (!parsed.ok) {
          this.#emitError(new SttClientError(parsed.code, parsed.message));
          return;
        }
        const event = parsed.event;
        if (event.type === STT_SERVER_EVENTS.READY) {
          this.ready = true;
          this.#clearConnectTimer();
          this.#flushPending();
          if (!settled) {
            settled = true;
            resolve();
          }
          this.onEvent?.(event);
          return;
        }
        if (event.type === STT_SERVER_EVENTS.TRANSCRIPT) {
          this.#clearTranscriptTimer();
          this.onTranscript?.(event);
          this.onEvent?.(event);
          return;
        }
        if (event.type === STT_SERVER_EVENTS.NO_SPEECH) {
          this.#clearTranscriptTimer();
          this.onEvent?.(event);
          return;
        }
        if (event.type === STT_SERVER_EVENTS.SPEECH_STARTED) {
          this.#armTranscriptTimer();
          this.onEvent?.(event);
          return;
        }
        if (event.type === STT_SERVER_EVENTS.ERROR) {
          this.#clearTranscriptTimer();
          const code =
            event.code === 'model_unavailable'
              ? STT_ERROR_CODES.MODEL_UNAVAILABLE
              : STT_ERROR_CODES.PROTOCOL_ERROR;
          this.#emitError(new SttClientError(code, event.message || event.code));
          this.onEvent?.(event);
          return;
        }
        this.onEvent?.(event);
      });

      this.ws.on('error', (err) => {
        fail(STT_ERROR_CODES.CONNECT_FAILED, err?.message || 'websocket error');
      });

      this.ws.on('close', () => {
        this.ready = false;
        if (!settled && !this.closed) {
          fail(STT_ERROR_CODES.SERVICE_CLOSED, 'STT socket closed before ready');
        } else if (!this.closed) {
          this.#emitError(
            new SttClientError(STT_ERROR_CODES.SERVICE_CLOSED, 'STT socket closed'),
          );
        }
      });
    });
  }

  pushAudio(mulawBytes) {
    if (this.closed || !mulawBytes?.length) return;
    const buf = Buffer.isBuffer(mulawBytes) ? mulawBytes : Buffer.from(mulawBytes);
    if (this.ready && this.ws?.readyState === 1) {
      this.ws.send(buf);
      return;
    }
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    while (this.pendingBytes > this.maxPendingAudioBytes && this.pending.length) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped.length;
      if (!this._overflowReported) {
        this._overflowReported = true;
        this.#emitError(
          new SttClientError(
            STT_ERROR_CODES.AUDIO_OVERFLOW,
            'Pending STT audio exceeded limit; dropped oldest frames',
          ),
        );
      }
    }
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.#clearConnectTimer();
    this.#clearTranscriptTimer();
    try {
      if (this.ws?.readyState === 1) {
        this.ws.send(JSON.stringify(buildStopMessage()));
        this.ws.close();
      } else {
        this.ws?.terminate?.();
      }
    } catch {
      // ignore
    }
    this.ws = null;
    this.pending = [];
    this.pendingBytes = 0;
  }

  #flushPending() {
    if (!this.ready || this.ws?.readyState !== 1) return;
    for (const chunk of this.pending) {
      this.ws.send(chunk);
    }
    this.pending = [];
    this.pendingBytes = 0;
  }

  #armTranscriptTimer() {
    this.#clearTranscriptTimer();
    this.transcriptTimer = setTimeout(() => {
      this.#emitError(
        new SttClientError(
          STT_ERROR_CODES.TRANSCRIPTION_TIMEOUT,
          'Transcript timed out',
        ),
      );
    }, this.transcriptTimeoutMs);
  }

  #clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  #clearTranscriptTimer() {
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
  }

  #emitError(err) {
    try {
      this.onError?.(err);
    } catch {
      // never throw into socket handlers
    }
  }
}
