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

function nowIso() {
  return new Date().toISOString();
}

export class StreamSessionManager {
  constructor({
    repository,
    config,
    pipeline = new VoicePipeline(),
    callStation = null,
  }) {
    this.repository = repository;
    this.config = config;
    this.pipeline = pipeline;
    this.callStation = callStation;
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
            session.metadata.welcomePlayed &&
            !session.metadata.welcomeCompleted &&
            (session.queue?.pendingChunks ?? 0) === 0
          ) {
            session.metadata.welcomeCompleted = true;
            session.metadata.audioCompletedAt = nowIso();
            this.callStation?.markAudioCompleted?.(session);
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

    const playback = this.#maybeEnqueueFixedWelcome(session);
    if (!alreadyStarted) {
      this.callStation?.onStreamStarted?.(session, playback);
    }
    return { ok: true, stream: record, playback, duplicateStart: alreadyStarted };
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

    // Stage 1 fixed playback: do not run mock STT/TTS.
    if (isFixedWelcomeMode(this.config)) {
      return { ok: true, playbackMode: 'fixed-welcome', pipelineSkipped: true };
    }

    const result = await this.pipeline.handleInboundAudio(event.payload, {
      streamSid: session.streamSid,
      callSid: session.callSid,
      customParameters: session.customParameters,
    });

    if (result.audio) {
      this.sendMedia(session, result.audio);
      this.sendMark(session, `tts-${session.stats.mediaOut}`);
    }

    for (const action of result.actions ?? []) {
      if (action.type === 'transfer_queue') {
        this.transferToQueue(session, action.queue || 'default');
      }
    }

    return { ok: true, result };
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
