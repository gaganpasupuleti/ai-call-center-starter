import {
  VOICE_LIFECYCLE,
  COMPLETION_REASONS,
  transitionConversation,
  canAcceptCallerAudio,
  canProcessTranscript,
  completeConversation,
  voiceConversationActive,
  getVoiceLifecycle,
  isBotSpeaking,
} from './lifecycle.js';
import { ConversationTimers, clearConversationTimers } from './timers.js';
import { listenPrompt } from './prompts.js';
import { globalSpeechMetrics } from './metrics.js';
import { ResponseActionExecutor } from '../actions/response-action-executor.js';
import { PIPER_DEFAULT_VOICE, PIPER_DEFAULT_ENGLISH_VOICE, PIPER_DEFAULT_ENGLISH_SPEAKER_ID } from '../tts/piper-voices.js';
import { KOKORO_DEFAULT_VOICE } from '../tts/kokoro-voices.js';
import { englishUsesPiper } from '../tts/tts-provider-factory.js';
import {
  isPhase4fSession,
  PHASE4F_MAX_TURNS,
} from '../phase4f/guards.js';

/**
 * Orchestrates greeting → listen → turn → speak → listen for voice modes.
 * Injected into StreamSessionManager; disabled when VOICE_CONVERSATION_ENABLED=false.
 */
export class VoiceConversationController {
  constructor({
    appConfig = {},
    pipeline = null,
    sttStarter = null,
    sendMedia = null,
    sendMark = null,
    hangup = null,
    closeSession = null,
    actionExecutor = null,
    callStation = null,
    metrics = globalSpeechMetrics,
  } = {}) {
    this.appConfig = appConfig;
    this.pipeline = pipeline;
    this.sttStarter = sttStarter;
    this.sendMedia = sendMedia;
    this.sendMark = sendMark;
    this.hangup = hangup;
    this.closeSession = closeSession;
    this.callStation = callStation;
    this.metrics = metrics;
    this.actionExecutor =
      actionExecutor ||
      new ResponseActionExecutor({
        liveCallsEnabled: appConfig?.smartPing?.liveCallsEnabled === true,
      });
  }

  active() {
    return voiceConversationActive(this.appConfig);
  }

  interactionMode() {
    return this.appConfig.voiceInteractionMode || 'dtmf';
  }

  ignoreWhileSpeaking() {
    return this.appConfig.voiceIgnoreInputWhileSpeaking !== false;
  }

  onSessionAttached(session) {
    if (!session.metadata) session.metadata = {};
    transitionConversation(session, VOICE_LIFECYCLE.CONNECTING, {
      event: 'attach',
    });
    session.metadata.conversationTurn = 0;
    session.metadata.listenTimeoutCount = 0;
    session.metadata.turnTiming = {};
  }

  onGreetingQueued(session) {
    if (!this.active()) return;
    transitionConversation(session, VOICE_LIFECYCLE.GREETING_QUEUED, {
      event: 'greeting_queued',
    });
    transitionConversation(session, VOICE_LIFECYCLE.GREETING_PLAYING, {
      event: 'greeting_playing',
    });
    this.metrics.inc('activeConversations', 1);
  }

  /**
   * Called when outbound/welcome audio queue drains (and/or mark completes).
   * @returns {boolean} true if voice mode handled it (skip DTMF failsafe)
   */
  onBotAudioDrained(session, { kind = 'greeting' } = {}) {
    if (!this.active()) return false;
    const state = getVoiceLifecycle(session);

    if (
      kind === 'greeting' ||
      state === VOICE_LIFECYCLE.GREETING_PLAYING ||
      state === VOICE_LIFECYCLE.GREETING_QUEUED
    ) {
      if (!session.metadata.welcomeCompleted) {
        session.metadata.welcomeCompleted = true;
        session.metadata.audioCompletedAt = new Date().toISOString();
      }
      this.enterListening(session);
      return true;
    }

    if (
      state === VOICE_LIFECYCLE.SPEAKING ||
      state === VOICE_LIFECYCLE.RESPONSE_QUEUED
    ) {
      this.#afterResponsePlayback(session);
      return true;
    }

    return true;
  }

  shouldSkipLegacyFailsafe(session) {
    return this.active();
  }

  shouldForwardCallerAudio(session) {
    if (!this.active()) return null; // null = use legacy rules
    return canAcceptCallerAudio(session, {
      ignoreWhileSpeaking: this.ignoreWhileSpeaking(),
    });
  }

  shouldDeferSttUntilListening() {
    return this.active();
  }

  enterListening(session) {
    if (!this.active()) return;
    if (session.state === 'closed') return;

    clearListenOnly(session);
    const state = getVoiceLifecycle(session);
    if (
      state === VOICE_LIFECYCLE.SPEAKING ||
      state === VOICE_LIFECYCLE.RESPONSE_QUEUED
    ) {
      transitionConversation(session, VOICE_LIFECYCLE.WAITING_FOR_NEXT_TURN, {
        event: 'wait_next',
      });
    }
    const moved = transitionConversation(session, VOICE_LIFECYCLE.LISTENING, {
      event: 'listening',
    });
    if (!moved.ok && !moved.noop) {
      // Best-effort: allow listening from deciding/synthesizing after failed audio
      session.metadata.voiceLifecycle = VOICE_LIFECYCLE.LISTENING;
    }

    session.metadata.turnTiming = {
      ...session.metadata.turnTiming,
      listeningStartedAt: new Date().toISOString(),
    };
    session.metadata.listeningEnteredAt = session.metadata.turnTiming.listeningStartedAt;

    this.sttStarter?.(session);
    this.callStation?.recordTimeline?.(session, {
      event: 'voice_listening',
      detail: this.interactionMode(),
    });

    const listenMs = Number(this.appConfig.voiceListenTimeoutMs || 12_000);
    const idleMs = Number(this.appConfig.voiceIdleHangupMs || 30_000);
    const timers = new ConversationTimers(session);
    timers.set('listen', () => this.#onListenTimeout(session), listenMs);
    timers.set('idle', () => this.#onIdleTimeout(session), idleMs);
  }

  onSpeechStarted(session) {
    if (!this.active()) return;
    const timing = session.metadata.turnTiming || {};
    timing.vadSpeechStartedAt = new Date().toISOString();
    session.metadata.turnTiming = timing;
    transitionConversation(session, VOICE_LIFECYCLE.SPEECH_DETECTED, {
      event: 'speech_started',
    });
    new ConversationTimers(session).clear('listen');
  }

  onSpeechEnded(session) {
    if (!this.active()) return;
    const timing = session.metadata.turnTiming || {};
    timing.vadSpeechEndedAt = new Date().toISOString();
    session.metadata.turnTiming = timing;
    transitionConversation(session, VOICE_LIFECYCLE.TRANSCRIBING, {
      event: 'speech_ended',
    });
  }

  canAcceptTranscript(session) {
    if (!this.active()) return true;
    return canProcessTranscript(session);
  }

  rejectExtraTranscript(session) {
    session.metadata.pendingTranscriptRejected =
      (session.metadata.pendingTranscriptRejected || 0) + 1;
    this.callStation?.recordTimeline?.(session, {
      event: 'transcript_rejected',
      detail: 'pending_limit',
    });
  }

  async processTurn(session, pipelineResult, { hangupAfterClose = true } = {}) {
    if (!this.active()) return pipelineResult;

    const timing = session.metadata.turnTiming || {};
    timing.transcriptReceivedAt = timing.transcriptReceivedAt || new Date().toISOString();
    timing.decisionCompletedAt = new Date().toISOString();
    session.metadata.turnTiming = timing;

    transitionConversation(session, VOICE_LIFECYCLE.DECIDING, {
      event: 'deciding',
    });

    const turn = Number(session.metadata.conversationTurn || 0) + 1;
    session.metadata.conversationTurn = turn;

    const phase4f = isPhase4fSession(session);
    const maxTurns = phase4f
      ? PHASE4F_MAX_TURNS
      : Number(this.appConfig.voiceMaxTurns || 6);
    const intent = pipelineResult?.reply?.intent;
    const dialogState = pipelineResult?.reply?.nextState;

    const actionOutcome = this.actionExecutor.execute(
      pipelineResult?.actions || [],
      session,
      {},
    );

    if (pipelineResult?.ttsError) {
      this.#noteTtsFailure(pipelineResult.ttsError);
    }

    if (pipelineResult?.tts) {
      timing.ttsCompletedAt = new Date().toISOString();
      timing.ttsDurationMs = pipelineResult.tts.synthesisDurationMs ?? null;
      if (timing.ttsDurationMs != null) {
        this.metrics.recordLatency('ttsMs', timing.ttsDurationMs);
      }
    }

    if (timing.vadSpeechEndedAt && timing.transcriptReceivedAt) {
      const sttMs =
        Date.parse(timing.transcriptReceivedAt) -
        Date.parse(timing.vadSpeechEndedAt);
      if (Number.isFinite(sttMs)) {
        timing.speechEndToTranscriptMs = sttMs;
        this.metrics.recordLatency('sttMs', sttMs);
      }
    }

    let forceCloseReason = null;
    if (actionOutcome.shouldClose) {
      forceCloseReason = actionOutcome.completionReason;
    }
    if (intent === 'NOT_INTERESTED') {
      forceCloseReason = COMPLETION_REASONS.NOT_INTERESTED;
    }
    if (intent === 'DO_NOT_CALL') {
      forceCloseReason = COMPLETION_REASONS.DO_NOT_CALL;
    }
    if (dialogState === 'completed' && !forceCloseReason) {
      forceCloseReason = COMPLETION_REASONS.COMPLETED;
    }
    if (turn >= maxTurns) {
      forceCloseReason = COMPLETION_REASONS.MAX_TURNS;
    }

    session.metadata.listenTimeoutCount = 0;
    session.metadata.pendingCloseReason = forceCloseReason;
    session.metadata.dtmfFallbackActive =
      actionOutcome.dtmfFallback || session.metadata.dtmfFallbackActive;

    if (actionOutcome.transferRequested) {
      transitionConversation(session, VOICE_LIFECYCLE.TRANSFERRING, {
        event: 'transfer_requested',
      });
    }

    if (pipelineResult?.audio) {
      transitionConversation(session, VOICE_LIFECYCLE.SYNTHESIZING, {
        event: 'synthesizing',
      });
      transitionConversation(session, VOICE_LIFECYCLE.RESPONSE_QUEUED, {
        event: 'response_queued',
      });
      transitionConversation(session, VOICE_LIFECYCLE.SPEAKING, {
        event: 'speaking',
      });
      timing.playbackStartedAt = new Date().toISOString();
      session.metadata.botPlaybackKind = 'response';
      session.metadata.welcomeCompleted = false; // reuse drain detection
    } else if (forceCloseReason) {
      await this.finish(session, forceCloseReason, { hangupAfterClose });
    } else {
      this.enterListening(session);
    }

    session.metadata.turnTiming = timing;
    return { ...pipelineResult, actionOutcome, forceCloseReason };
  }

  async #afterResponsePlayback(session) {
    const timing = session.metadata.turnTiming || {};
    timing.playbackCompletedAt = new Date().toISOString();
    if (timing.vadSpeechEndedAt) {
      const e2e =
        Date.parse(timing.playbackCompletedAt) -
        Date.parse(timing.vadSpeechEndedAt);
      if (Number.isFinite(e2e)) {
        timing.speechEndToFirstBotAudioMs = e2e;
        timing.turnTotalMs = e2e;
        this.metrics.recordLatency('turnMs', e2e);
      }
    }
    session.metadata.turnTiming = timing;
    session.metadata.botPlaybackKind = null;

    const pending = session.metadata.pendingCloseReason;
    if (pending) {
      if (pending === COMPLETION_REASONS.MAX_TURNS) {
        await this.#speakAndClose(
          session,
          listenPrompt(session.metadata.detectedLanguage || 'en', 'closingMaxTurns'),
          pending,
        );
        return;
      }
      await this.finish(session, pending);
      return;
    }

    if (session.metadata.dtmfFallbackActive && this.interactionMode() === 'voice-dtmf') {
      // Stay open for keypad; cancel listen loop.
      clearConversationTimers(session);
      transitionConversation(session, VOICE_LIFECYCLE.LISTENING, {
        event: 'dtmf_fallback',
      });
      return;
    }

    this.enterListening(session);
  }

  async #onListenTimeout(session) {
    if (!this.active() || session.state === 'closed') return;
    if (isBotSpeaking(session)) return;

    const count = Number(session.metadata.listenTimeoutCount || 0) + 1;
    session.metadata.listenTimeoutCount = count;
    const language = session.metadata.detectedLanguage || 'en';

    if (count === 1) {
      await this.#speakPrompt(
        session,
        listenPrompt(language, 'stillThere'),
        language,
      );
      return;
    }

    if (this.interactionMode() === 'voice-dtmf') {
      session.metadata.dtmfFallbackActive = true;
      await this.#speakPrompt(
        session,
        listenPrompt(language, 'dtmfFallback'),
        language,
      );
      this.actionExecutor.execute([{ type: 'enable_dtmf_fallback' }], session);
      return;
    }

    await this.#speakAndClose(
      session,
      listenPrompt(language, 'closingPolite'),
      COMPLETION_REASONS.IDLE_TIMEOUT,
    );
  }

  async #onIdleTimeout(session) {
    if (!this.active() || session.state === 'closed') return;
    await this.#speakAndClose(
      session,
      listenPrompt(session.metadata.detectedLanguage || 'en', 'closingIdle'),
      COMPLETION_REASONS.IDLE_TIMEOUT,
    );
  }

  async #speakPrompt(session, text, language = 'en') {
    if (!this.pipeline?.tts && !this.pipeline?.handleTranscript) {
      this.enterListening(session);
      return;
    }
    transitionConversation(session, VOICE_LIFECYCLE.SYNTHESIZING, {
      event: 'system_prompt',
    });
    try {
      const mode = this.appConfig?.voiceTtsProvider || 'mock';
      const usePiperEn = englishUsesPiper(mode);
      const voice =
        language === 'te'
          ? this.appConfig.piper?.teluguVoice ||
            this.appConfig.piper?.defaultVoice ||
            PIPER_DEFAULT_VOICE
          : usePiperEn
            ? this.appConfig.piper?.englishVoice || PIPER_DEFAULT_ENGLISH_VOICE
            : this.appConfig.kokoro?.defaultVoice || KOKORO_DEFAULT_VOICE;
      const speakerId =
        language === 'en' && usePiperEn
          ? this.appConfig.piper?.englishSpeakerId ??
            PIPER_DEFAULT_ENGLISH_SPEAKER_ID
          : undefined;
      const speech = await this.pipeline.tts.synthesize({
        text,
        language: language === 'te' ? 'te' : 'en',
        voice,
        speakerId,
        metadata: {
          streamSid: session.streamSid,
          sessionClosed: session.state === 'closed',
        },
      });
      if (session.state === 'closed') return;
      transitionConversation(session, VOICE_LIFECYCLE.SPEAKING, {
        event: 'system_speaking',
      });
      session.metadata.botPlaybackKind = 'system';
      session.metadata.welcomeCompleted = false;
      this.sendMedia?.(session, speech.audio);
      this.sendMark?.(session, `voice-prompt-${Date.now()}`);
    } catch {
      this.enterListening(session);
    }
  }

  async #speakAndClose(session, text, reason) {
    session.metadata.pendingCloseReason = reason;
    await this.#speakPrompt(
      session,
      text,
      session.metadata.detectedLanguage || 'en',
    );
    // If TTS failed and we re-entered listening, force finish.
    if (getVoiceLifecycle(session) === VOICE_LIFECYCLE.LISTENING) {
      await this.finish(session, reason);
    }
  }

  async finish(session, reason, { hangupAfterClose = true } = {}) {
    clearConversationTimers(session);
    completeConversation(session, reason);
    this.metrics.recordCompletion(reason);
    this.metrics.inc('activeConversations', -1);
    this.callStation?.recordTimeline?.(session, {
      event: 'voice_completed',
      detail: reason,
    });
    if (hangupAfterClose) {
      try {
        this.hangup?.(session);
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (session.state !== 'closed') {
          this.closeSession?.(session, `voice_${reason}`);
        }
      }, 1500);
    }
  }

  onSessionClose(session, reason = 'closed') {
    clearConversationTimers(session);
    const state = getVoiceLifecycle(session);
    if (state !== VOICE_LIFECYCLE.CLOSED && state !== VOICE_LIFECYCLE.COMPLETED) {
      if (reason === 'provider_stop' || reason === 'caller_hangup') {
        completeConversation(session, COMPLETION_REASONS.CALLER_HANGUP);
        this.metrics.recordCompletion(COMPLETION_REASONS.CALLER_HANGUP);
      } else {
        transitionConversation(session, VOICE_LIFECYCLE.CLOSED, {
          event: 'close',
          reason,
        });
      }
    }
  }

  #noteTtsFailure(err) {
    const code = err?.code || '';
    if (String(code).includes('piper')) this.metrics.inc('piperFailures');
    else if (String(code).includes('kokoro') || code.startsWith('tts_')) {
      this.metrics.inc('kokoroFailures');
    }
    if (code === 'tts_queue_full') this.metrics.inc('ttsQueueFull');
  }
}

function clearListenOnly(session) {
  const timers = new ConversationTimers(session);
  timers.clear('listen');
}
