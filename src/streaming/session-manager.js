import { randomUUID } from 'node:crypto';
import { STREAM_STATES } from './constants.js';
import { PacedAudioQueue } from './audio-queue.js';
import {
  buildOutboundClear,
  buildOutboundHangup,
  buildOutboundMark,
  buildOutboundMedia,
  buildOutboundTransfer,
} from './protocol.js';
import { VoicePipeline } from './ai/pipeline.js';
import {
  FixedAudioError,
  getWelcomeMulaw,
  isFixedWelcomeMode,
} from './fixed-audio.js';
import { getOutboundPromptStore } from './outbound/prompt-store.js';
import { englishLabelForDigit, formatTransferPhone } from './outbound/phone.js';
import { StreamingSttManager } from './stt/streaming-stt-manager.js';

const MESSAGE_END_HANGUP_MS = 10_000;

function nowIso() {
  return new Date().toISOString();
}

function resolveSttLanguage(session, sttConfig = {}) {
  const fromParams =
    session?.customParameters?.language ||
    session?.customParameters?.stt_language ||
    session?.metadata?.sttLanguage;
  const raw = String(fromParams || sttConfig.defaultLanguage || 'en')
    .trim()
    .toLowerCase();
  if (raw === 'te' || raw === 'telugu') return 'te';
  if (raw === 'auto') return 'auto';
  return 'en';
}

export class StreamSessionManager {
  constructor({
    repository,
    config,
    pipeline = new VoicePipeline(),
    callStation = null,
    promptStore = null,
    sttManager = null,
    appConfig = null,
  }) {
    this.repository = repository;
    this.config = config;
    this.pipeline = pipeline;
    this.callStation = callStation;
    this.promptStore = promptStore || getOutboundPromptStore();
    this.appConfig = appConfig;
    this.voiceSttProvider =
      appConfig?.voiceSttProvider ||
      config?.voiceSttProvider ||
      'mock';
    this.sttConfig = appConfig?.stt || config?.stt || {};
    this.sttManager =
      sttManager ||
      (this.voiceSttProvider === 'faster-whisper-streaming'
        ? new StreamingSttManager({
            url: this.sttConfig.streamUrl,
            token: this.sttConfig.serviceToken || '',
            connectTimeoutMs: this.sttConfig.connectTimeoutMs,
            transcriptTimeoutMs: this.sttConfig.transcriptTimeoutMs,
            maxPendingAudioBytes: this.sttConfig.maxPendingAudioBytes,
          })
        : null);
    this.sessions = new Map();
    this.allSessions = new Set();
  }

  get(streamSid) {
    return this.sessions.get(streamSid) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((session) => this.#publicSession(session));
  }

  attachSocket(ws) {
    const provisionalId = randomUUID();
    const session = {
      id: provisionalId,
      ws,
      streamSid: null,
      callSid: null,
      appCallId: null,
      state: STREAM_STATES.connecting,
      audioFormat: null,
      customParameters: {},
      openedAt: nowIso(),
      closedAt: null,
      seenSequences: new Set(),
      pendingMarks: new Map(),
      stats: {
        mediaIn: 0,
        mediaOut: 0,
        marks: 0,
        invalidMedia: 0,
        duplicateSequences: 0,
      },
      queue: null,
      metadata: {},
    };
    ws.__sessionRef = session;
    this.allSessions.add(session);
    return session;
  }

  async handleNormalizedEvent(session, event) {
    if (event.sequenceNumber) {
      if (session.seenSequences.has(event.sequenceNumber)) {
        session.stats.duplicateSequences += 1;
        this.#persistEvent(session, event, {
          validationResult: 'duplicate_sequence',
        });
        return { ok: false, reason: 'duplicate_sequence' };
      }
      session.seenSequences.add(event.sequenceNumber);
    }

    switch (event.event) {
      case 'connected':
        session.state = STREAM_STATES.connected;
        session.metadata.protocol = event.protocol;
        session.metadata.version = event.version;
        this.#persistEvent(session, event);
        this.callStation?.onProtocolEvent?.(session, 'connected');
        return { ok: true };
      case 'start':
        return this.#onStart(session, event);
      case 'media':
        return this.#onMedia(session, event);
      case 'mark':
        return this.#onMark(session, event);
      case 'dtmf':
        return this.#onDtmf(session, event);
      case 'stop':
        return this.#onStop(session, event);
      default:
        return { ok: false, reason: 'unknown_event' };
    }
  }

  sendMedia(session, mulawBytes) {
    if (!session?.streamSid || !session.queue) return 0;
    return session.queue.enqueue(mulawBytes);
  }

  sendMark(session, name) {
    if (!session?.streamSid || session.ws?.readyState !== 1) return false;
    const markName = name || `mark-${Date.now()}`;
    session.pendingMarks.set(markName, nowIso());
    this.#send(session, buildOutboundMark(session.streamSid, markName));
    return true;
  }

  clearAudio(session) {
    if (!session?.streamSid) return 0;
    const dropped = session.queue?.clear() ?? 0;
    session.state = STREAM_STATES.clearing;
    this.#send(session, buildOutboundClear(session.streamSid));
    session.state = STREAM_STATES.active;
    return dropped;
  }

  hangupCall(session) {
    if (!session?.streamSid) return false;
    this.#send(session, buildOutboundHangup(session.streamSid));
    return true;
  }

  transferToQueue(session, queueName) {
    if (!session?.streamSid) return false;
    this.#send(
      session,
      buildOutboundTransfer(session.streamSid, {
        type: 'queue',
        queue: queueName,
      }),
    );
    return true;
  }

  transferToExternalNumber(session, phoneNumber) {
    if (!session?.streamSid) return false;
    this.#send(
      session,
      buildOutboundTransfer(session.streamSid, {
        type: 'external',
        phone_number: phoneNumber,
      }),
    );
    return true;
  }

  closeSession(session, reason = 'closed') {
    if (!session || session.state === STREAM_STATES.closed) return;
    if (session.failsafeHangupTimer) {
      clearTimeout(session.failsafeHangupTimer);
      session.failsafeHangupTimer = null;
    }
    const streamSid = session.streamSid;
    if (streamSid && this.sttManager) {
      this.sttManager.stopSession(streamSid).catch(() => {});
    }
    session.queue?.stop();
    session.state = STREAM_STATES.closed;
    session.closedAt = nowIso();
    session.metadata.closeReason = reason;
    if (session.streamSid) {
      this.sessions.delete(session.streamSid);
      this.repository.closeVoiceStream(session.streamSid, {
        closedAt: session.closedAt,
        metadata: session.metadata,
      });
    }
    this.callStation?.onSessionClosed?.(session, reason);
    this.allSessions.delete(session);
    if (session.ws && session.ws.readyState === 1) {
      try {
        session.ws.close();
      } catch {
        // ignore
      }
    }
  }

  closeAll(reason = 'shutdown') {
    if (this.sttManager) {
      this.sttManager.closeAll().catch(() => {});
    }
    for (const session of [...this.allSessions]) {
      this.closeSession(session, reason);
    }
  }

  #onStart(session, event) {
    const alreadyStarted = Boolean(session.streamSid);
    session.streamSid = event.streamSid;
    session.callSid = event.callSid;
    session.audioFormat = event.mediaFormat;
    session.customParameters = event.customParameters ?? {};
    session.appCallId = event.customParameters?.app_call_id ?? null;
    session.state = STREAM_STATES.active;
    this.sessions.set(session.streamSid, session);

    if (!session.queue) {
      session.queue = new PacedAudioQueue({
        sendChunk: (chunk) => {
          if (session.state === STREAM_STATES.closed) return;
          this.#send(session, buildOutboundMedia(session.streamSid, chunk));
          session.stats.mediaOut += 1;
          if (
            (session.metadata.welcomePlayed || session.metadata.customAudioPlayed) &&
            !session.metadata.welcomeCompleted &&
            (session.queue?.pendingChunks ?? 0) === 0
          ) {
            session.metadata.welcomeCompleted = true;
            session.metadata.audioCompletedAt = nowIso();
            this.callStation?.markAudioCompleted?.(session);
            if (session.metadata.customAudioPlayed) {
              this.callStation?.recordTimeline?.(session, {
                event: 'custom_audio_completed',
                detail: null,
              });
            }
            // Failsafe: cut the call 10s after the primary message finishes.
            if (!session.metadata.failsafeHangupScheduled) {
              this.#scheduleFailsafeHangup(session, MESSAGE_END_HANGUP_MS, 'message_ended');
            }
          }
        },
      });
    }

    let record = this.repository.getVoiceStream(session.streamSid);
    if (!record) {
      record = this.repository.createVoiceStream({
        id: session.id,
        streamSid: session.streamSid,
        callSid: session.callSid,
        appCallId: session.appCallId,
        state: session.state,
        audioFormat: session.audioFormat,
        customParameters: session.customParameters,
        openedAt: session.openedAt,
        metadata: session.metadata,
      });
    }
    this.#persistEvent(session, event);
    this.callStation?.onProtocolEvent?.(session, 'start');

    const playback = this.#maybeEnqueueOutboundOrWelcome(session);
    if (!alreadyStarted) {
      this.callStation?.onStreamStarted?.(session, playback);
      this.#maybeStartStreamingStt(session);
    }
    return { ok: true, stream: record, playback, duplicateStart: alreadyStarted };
  }

  #usesStreamingStt() {
    return (
      this.voiceSttProvider === 'faster-whisper-streaming' &&
      this.sttManager != null
    );
  }

  #maybeStartStreamingStt(session) {
    if (!this.#usesStreamingStt()) return;
    if (
      isFixedWelcomeMode(this.config) ||
      session.metadata.playbackMode === 'outbound-tts' ||
      session.metadata.customAudioPlayed
    ) {
      session.metadata.sttStatus = 'skipped_playback_mode';
      return;
    }
    const language = resolveSttLanguage(session, this.sttConfig);
    session.metadata.sttLanguage = language;
    session.metadata.sttStatus = 'connecting';
    session.metadata.speechActive = false;
    session.metadata.transcriptionActive = false;
    const streamSid = session.streamSid;
    this.sttManager
      .startSession({
        streamSid,
        callSid: session.callSid,
        language,
        onTranscript: (event) => {
          this.#onStreamingTranscript(session, event).catch(() => {});
        },
        onEvent: (event) => {
          if (session.state === STREAM_STATES.closed) return;
          if (event?.type === 'speech_started') {
            session.metadata.speechActive = true;
            session.metadata.sttStatus = 'speech';
          } else if (event?.type === 'speech_ended') {
            session.metadata.speechActive = false;
            session.metadata.sttStatus = 'transcribing';
          } else if (event?.type === 'ready') {
            session.metadata.sttStatus = 'ready';
          } else if (event?.type === 'no_speech') {
            session.metadata.speechActive = false;
            session.metadata.sttStatus = 'ready';
          }
        },
        onError: (err) => {
          if (session.state === STREAM_STATES.closed) return;
          session.metadata.lastSttError = err?.code || 'stt_error';
          session.metadata.sttStatus = 'error';
        },
      })
      .then(() => {
        if (session.state === STREAM_STATES.closed) return;
        if (session.metadata.sttStatus === 'connecting') {
          session.metadata.sttStatus = 'ready';
        }
      })
      .catch((err) => {
        if (session.state === STREAM_STATES.closed) return;
        session.metadata.lastSttError = err?.code || 'stt_connect_failed';
        session.metadata.sttStatus = 'error';
      });
  }

  async #onStreamingTranscript(session, event) {
    if (!session || session.state === STREAM_STATES.closed) return;
    if (!event?.text) return;

    // At most one in-flight transcript handler; keep a single pending slot.
    if (session.metadata.transcriptionActive) {
      if (!session.metadata.pendingTranscript) {
        session.metadata.pendingTranscript = event;
      }
      return;
    }

    session.metadata.transcriptionActive = true;
    session.metadata.sttStatus = 'responding';
    session.metadata.lastTranscript = String(event.text).slice(0, 2000);
    session.metadata.lastTranscriptLanguage = event.language || null;
    session.metadata.lastTranscriptAt = nowIso();

    try {
      if (!session.metadata || typeof session.metadata !== 'object') {
        session.metadata = {};
      }
      const result = await this.pipeline.handleTranscript(
        {
          text: event.text,
          isFinal: true,
          language: event.language,
          languageProbability: event.languageProbability,
          provider: event.provider || 'faster-whisper',
          audioDurationMs: event.audioDurationMs,
          inferenceDurationMs: event.inferenceDurationMs,
        },
        {
          streamSid: session.streamSid,
          callSid: session.callSid,
          customParameters: session.customParameters,
          metadata: session.metadata,
        },
      );
      this.#applyPipelineResult(session, result);
    } catch {
      session.metadata.lastSttError = 'stt_response_failed';
    } finally {
      session.metadata.transcriptionActive = false;
      session.metadata.sttStatus = 'ready';
      const pending = session.metadata.pendingTranscript;
      session.metadata.pendingTranscript = null;
      if (pending && session.state !== STREAM_STATES.closed) {
        await this.#onStreamingTranscript(session, pending);
      }
    }
  }

  #applyPipelineResult(session, result) {
    if (!result) return;
    if (result.reply) {
      session.metadata.lastTranscript =
        result.transcript?.text ?? session.metadata.lastTranscript;
      session.metadata.lastIntent =
        result.reply.intent ?? session.metadata.lastIntent;
      if (result.reply.intentConfidence != null) {
        session.metadata.lastIntentConfidence = result.reply.intentConfidence;
      }
      if (result.reply.nextState) {
        session.metadata.conversationState = result.reply.nextState;
      }
      if (result.reply.replyText != null) {
        session.metadata.lastReplyText = result.reply.replyText;
      }
      if (result.reply.language) {
        session.metadata.detectedLanguage = result.reply.language;
      }
    }
    if (result.tts) {
      session.metadata.ttsProvider = result.tts.provider;
      session.metadata.ttsVoice = result.tts.voice;
      session.metadata.ttsLanguage = result.tts.language;
      session.metadata.ttsCached = result.tts.cached === true;
      session.metadata.ttsDurationSeconds = result.tts.durationSeconds;
      session.metadata.ttsSynthesisDurationMs = result.tts.synthesisDurationMs;
      session.metadata.ttsStatus = 'ok';
      session.metadata.lastTtsError = null;
    }
    if (result.ttsError) {
      session.metadata.lastTtsError = result.ttsError.code;
      session.metadata.ttsStatus = 'error';
    }
    if (result.audio) {
      this.sendMedia(session, result.audio);
      this.sendMark(session, `tts-${session.stats.mediaOut}`);
    }
    for (const action of result.actions ?? []) {
      if (action.type === 'transfer_queue') {
        this.transferToQueue(session, action.queue || 'default');
      }
    }
  }

  #maybeEnqueueOutboundOrWelcome(session) {
    if (session.metadata.welcomePlayed === true || session.metadata.customAudioPlayed === true) {
      return {
        mode: session.metadata.playbackMode || 'fixed-welcome',
        enqueuedChunks: 0,
        skippedDuplicate: true,
        byteLength: session.metadata.welcomeBytes ?? session.metadata.customAudioBytes ?? 0,
      };
    }

    const appCallId = session.appCallId || session.customParameters?.app_call_id;
    if (appCallId) {
      const built = this.promptStore?.buildPlaybackBytes?.(appCallId);
      if (built?.bytes?.length) {
        const enqueuedChunks = this.sendMedia(session, built.bytes);
        this.sendMark(session, 'outbound-prompt-complete');
        session.metadata.playbackMode = 'outbound-tts';
        session.metadata.customAudioPlayed = true;
        session.metadata.welcomePlayed = true; // reuse completion/pipeline skip guards
        session.metadata.customAudioBytes = built.bytes.length;
        session.metadata.customRepeatCount = built.prompt.repeatCount;
        session.metadata.welcomeBytes = built.bytes.length;
        session.metadata.welcomeDurationSeconds = Number(
          (built.bytes.length / 8000).toFixed(3),
        );
        session.metadata.audioQueuedAt = nowIso();
        this.promptStore.markConsumed(appCallId);
        if (built.prompt.interactive === true) {
          session.metadata.interactive = true;
          session.metadata.interactiveAppCallId = appCallId;
          session.metadata.keypadCaptured = false;
          session.metadata.agentPhone = built.prompt.agentPhone || null;
          session.metadata.agentPhoneMasked =
            built.prompt.agentPhoneMasked || null;
          this.callStation?.recordTimeline?.(session, {
            event: 'interactive_listening',
            detail: built.prompt.agentPhone
              ? 'awaiting_dtmf;agent_ready'
              : 'awaiting_dtmf',
          });
        }
        this.callStation?.recordTimeline?.(session, {
          event: 'custom_audio_queued',
          detail: `repeat=${built.prompt.repeatCount}`,
        });
        this.callStation?.markAudioQueued?.(session, {
          chunks: enqueuedChunks,
          durationSeconds: session.metadata.welcomeDurationSeconds,
        });
        return {
          mode: 'outbound-tts',
          enqueuedChunks,
          byteLength: built.bytes.length,
          durationSeconds: session.metadata.welcomeDurationSeconds,
          repeatCount: built.prompt.repeatCount,
        };
      }
    }

    return this.#maybeEnqueueFixedWelcome(session);
  }

  #maybeEnqueueFixedWelcome(session) {
    if (!isFixedWelcomeMode(this.config)) {
      return { mode: 'pipeline', enqueuedChunks: 0 };
    }

    if (session.metadata.welcomePlayed === true) {
      return {
        mode: 'fixed-welcome',
        enqueuedChunks: 0,
        skippedDuplicate: true,
        byteLength: session.metadata.welcomeBytes ?? 0,
      };
    }

    try {
      const audioPath = this.config.welcomeAudioPath || undefined;
      const welcome = getWelcomeMulaw(audioPath);
      const enqueuedChunks = this.sendMedia(session, welcome.bytes);
      this.sendMark(session, 'welcome-complete');
      session.metadata.playbackMode = 'fixed-welcome';
      session.metadata.welcomePlayed = true;
      session.metadata.welcomeChunks = enqueuedChunks;
      session.metadata.welcomeBytes = welcome.byteLength;
      session.metadata.welcomeDurationSeconds = welcome.durationSeconds;
      session.metadata.audioQueuedAt = nowIso();
      this.callStation?.markAudioQueued?.(session, {
        chunks: enqueuedChunks,
        durationSeconds: welcome.durationSeconds,
      });
      return {
        mode: 'fixed-welcome',
        enqueuedChunks,
        byteLength: welcome.byteLength,
        durationSeconds: welcome.durationSeconds,
      };
    } catch (error) {
      const code =
        error instanceof FixedAudioError ? error.code : 'welcome_audio_error';
      session.metadata.playbackMode = 'fixed-welcome';
      session.metadata.welcomeError = code;
      session.metadata.welcomePlayed = true;
      this.callStation?.markAudioFailed?.(session, code);
      return {
        mode: 'fixed-welcome',
        enqueuedChunks: 0,
        error: code,
      };
    }
  }

  async #onMedia(session, event) {
    if (!session.streamSid && event.streamSid) {
      // Media before start is invalid for tracking.
    }
    if (event.validation !== 'ok') {
      session.stats.invalidMedia += 1;
      this.#persistEvent(session, event, { validationResult: event.validation });
      return { ok: false, reason: event.validation };
    }

    session.stats.mediaIn += 1;
    this.#persistEvent(session, event, { validationResult: 'ok' });
    this.callStation?.onProtocolEvent?.(session, 'media');

    // Fixed welcome or dialer TTS: do not run mock STT/TTS.
    if (
      isFixedWelcomeMode(this.config) ||
      session.metadata.playbackMode === 'outbound-tts' ||
      session.metadata.customAudioPlayed
    ) {
      return {
        ok: true,
        playbackMode: session.metadata.playbackMode || 'fixed-welcome',
        pipelineSkipped: true,
      };
    }

    // Pass real session.metadata so conversation state stays per-call (not a copy).
    if (!session.metadata || typeof session.metadata !== 'object') {
      session.metadata = {};
    }

    // Streaming Faster-Whisper: forward μ-law and return without mock STT.
    if (this.#usesStreamingStt()) {
      this.sttManager.pushAudio(session.streamSid, event.payload);
      return { ok: true, streamingStt: true };
    }

    const result = await this.pipeline.handleInboundAudio(event.payload, {
      streamSid: session.streamSid,
      callSid: session.callSid,
      customParameters: session.customParameters,
      metadata: session.metadata,
    });

    this.#applyPipelineResult(session, result);

    return { ok: true, result };
  }

  #onDtmf(session, event) {
    const digit = event.digit ? String(event.digit) : null;
    this.#persistEvent(session, event);
    this.callStation?.onProtocolEvent?.(session, 'dtmf', { digit });

    if (!digit) {
      return { ok: false, reason: 'missing_digit' };
    }

    if (session.metadata.keypadCaptured === true) {
      return { ok: true, ignored: true, reason: 'already_captured', digit };
    }

    const appCallId =
      session.metadata.interactiveAppCallId ||
      session.appCallId ||
      session.customParameters?.app_call_id;
    const response = this.promptStore?.getInteractiveResponse?.(appCallId, digit);
    session.metadata.keypadCaptured = true;
    session.metadata.selectedDigit = digit;
    const labelEn = englishLabelForDigit(digit);
    this.callStation?.noteKeypadDigit?.(session, {
      digit,
      label: labelEn,
      spokenPreview: response?.text || null,
    });

    if (!response?.bytes?.length) {
      this.callStation?.recordTimeline?.(session, {
        event: 'dtmf_no_response_audio',
        detail: `digit=${digit};${labelEn}`,
      });
      if (digit === '9' && session.metadata.agentPhone) {
        const sent = this.transferToExternalNumber(
          session,
          session.metadata.agentPhone,
        );
        if (session.failsafeHangupTimer) {
          clearTimeout(session.failsafeHangupTimer);
          session.failsafeHangupTimer = null;
        }
        this.callStation?.recordTimeline?.(session, {
          event: sent ? 'agent_transfer_sent' : 'agent_transfer_failed',
          detail: session.metadata.agentPhoneMasked || 'agent',
        });
        return {
          ok: true,
          digit,
          played: false,
          label: labelEn,
          transferScheduled: true,
        };
      }
      return { ok: true, digit, played: false, label: labelEn };
    }

    this.clearAudio(session);
    const chunks = this.sendMedia(session, response.bytes);
    this.sendMark(session, `keypad-${digit}`);
    this.callStation?.recordTimeline?.(session, {
      event: 'keypad_response_queued',
      detail: `digit=${digit};${labelEn};chunks=${chunks}`,
    });
    const replyMs = Math.max(
      2_000,
      Math.round((response.durationSeconds || 2) * 1000),
    );

    // Key 9 → connect to live agent number after the hold message.
    if (digit === '9' && session.metadata.agentPhone) {
      if (session.failsafeHangupTimer) {
        clearTimeout(session.failsafeHangupTimer);
        session.failsafeHangupTimer = null;
      }
      session.metadata.failsafeHangupScheduled = true;
      this.callStation?.recordTimeline?.(session, {
        event: 'agent_transfer_scheduled',
        detail: session.metadata.agentPhoneMasked || 'agent',
      });
      setTimeout(() => {
        if (session.state === STREAM_STATES.closed) return;
        const sent = this.transferToExternalNumber(
          session,
          session.metadata.agentPhone,
        );
        this.callStation?.recordTimeline?.(session, {
          event: sent ? 'agent_transfer_sent' : 'agent_transfer_failed',
          detail: session.metadata.agentPhoneMasked || 'agent',
        });
      }, replyMs + 400);
      return {
        ok: true,
        digit,
        played: true,
        label: labelEn,
        transferScheduled: true,
        enqueuedChunks: chunks,
        durationSeconds: response.durationSeconds,
      };
    }

    // Keep failsafe: hang up shortly after keypad reply finishes (+10s grace).
    this.#scheduleFailsafeHangup(session, replyMs + MESSAGE_END_HANGUP_MS, 'keypad_reply');
    return {
      ok: true,
      digit,
      played: true,
      label: labelEn,
      enqueuedChunks: chunks,
      durationSeconds: response.durationSeconds,
    };
  }

  #scheduleFailsafeHangup(session, delayMs, reason = 'failsafe') {
    if (!session) return;
    if (session.failsafeHangupTimer) {
      clearTimeout(session.failsafeHangupTimer);
      session.failsafeHangupTimer = null;
    }
    session.metadata.failsafeHangupScheduled = true;
    session.metadata.failsafeHangupReason = reason;
    session.metadata.failsafeHangupAt = new Date(
      Date.now() + Math.max(0, delayMs),
    ).toISOString();
    this.callStation?.recordTimeline?.(session, {
      event: 'failsafe_hangup_scheduled',
      detail: `${reason};${Math.round(delayMs / 1000)}s`,
    });
    session.failsafeHangupTimer = setTimeout(() => {
      session.failsafeHangupTimer = null;
      if (session.state === STREAM_STATES.closed) return;
      this.callStation?.recordTimeline?.(session, {
        event: 'failsafe_hangup',
        detail: reason,
      });
      try {
        this.hangupCall(session);
      } catch {
        // ignore
      }
      // Give provider a moment, then close local session if still open.
      setTimeout(() => {
        if (session.state !== STREAM_STATES.closed) {
          this.closeSession(session, `failsafe_hangup_${reason}`);
        }
      }, 1500);
    }, Math.max(0, delayMs));
  }

  #onMark(session, event) {
    session.stats.marks += 1;
    if (event.name && session.pendingMarks.has(event.name)) {
      session.pendingMarks.delete(event.name);
      session.metadata.lastMarkAck = event.name;
    }
    this.#persistEvent(session, event);
    return { ok: true, acknowledged: Boolean(event.name) };
  }

  #onStop(session, event) {
    session.state = STREAM_STATES.stopping;
    this.#persistEvent(session, event);
    this.callStation?.onProtocolEvent?.(session, 'stop');
    this.closeSession(session, 'provider_stop');
    return { ok: true };
  }

  #send(session, payload) {
    if (!session.ws || session.ws.readyState !== 1) return;
    session.ws.send(JSON.stringify(payload));
  }

  #persistEvent(session, event, extras = {}) {
    if (!session.streamSid && event.event !== 'connected') {
      // Connected happens before streamSid exists; store against provisional id later on start.
    }
    const streamKey = session.streamSid;
    if (!streamKey && event.event !== 'connected') return;
    if (!streamKey) return;

    this.repository.addVoiceStreamEvent({
      streamSid: streamKey,
      eventType: event.event,
      sequenceNumber: event.sequenceNumber,
      payloadSize: event.payloadSize ?? null,
      validationResult: extras.validationResult ?? event.validation ?? 'ok',
      timestampMs: event.timestamp ?? null,
      rawAudioB64:
        this.config.storeAudio && event.payload
          ? Buffer.from(event.payload).toString('base64')
          : null,
      metadata: {
        track: event.track ?? null,
        chunk: event.chunk ?? null,
        name: event.name ?? null,
        callSid: event.callSid ?? session.callSid,
      },
    });
  }

  #publicSession(session) {
    return {
      id: session.id,
      streamSid: session.streamSid,
      callSid: session.callSid,
      appCallId: session.appCallId,
      state: session.state,
      audioFormat: session.audioFormat,
      customParameters: session.customParameters,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      stats: session.stats,
      pendingMarks: [...session.pendingMarks.keys()],
      pendingAudioChunks: session.queue?.pendingChunks ?? 0,
    };
  }
}
