/**
 * Call-level voice conversation lifecycle (Phase 4E).
 * Distinct from dialog state in response/conversation-state.js
 * (waiting_for_demo_interest, etc.).
 */

export const VOICE_LIFECYCLE = Object.freeze({
  CONNECTING: 'connecting',
  GREETING_QUEUED: 'greeting_queued',
  GREETING_PLAYING: 'greeting_playing',
  LISTENING: 'listening',
  SPEECH_DETECTED: 'speech_detected',
  TRANSCRIBING: 'transcribing',
  DECIDING: 'deciding',
  SYNTHESIZING: 'synthesizing',
  RESPONSE_QUEUED: 'response_queued',
  SPEAKING: 'speaking',
  WAITING_FOR_NEXT_TURN: 'waiting_for_next_turn',
  TRANSFERRING: 'transferring',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CLOSED: 'closed',
});

export const COMPLETION_REASONS = Object.freeze({
  COMPLETED: 'completed',
  NOT_INTERESTED: 'not_interested',
  DO_NOT_CALL: 'do_not_call',
  MAX_TURNS: 'max_turns',
  IDLE_TIMEOUT: 'idle_timeout',
  SPEECH_SERVICE_FAILED: 'speech_service_failed',
  CALLER_HANGUP: 'caller_hangup',
  TRANSFER_REQUESTED: 'transfer_requested',
});

const TERMINAL = new Set([
  VOICE_LIFECYCLE.COMPLETED,
  VOICE_LIFECYCLE.FAILED,
  VOICE_LIFECYCLE.CLOSED,
]);

const SPEAKING_STATES = new Set([
  VOICE_LIFECYCLE.GREETING_PLAYING,
  VOICE_LIFECYCLE.RESPONSE_QUEUED,
  VOICE_LIFECYCLE.SPEAKING,
]);

/** Allowed transitions (from → Set of to). Closed never returns to active. */
const ALLOWED = {
  [VOICE_LIFECYCLE.CONNECTING]: new Set([
    VOICE_LIFECYCLE.GREETING_QUEUED,
    VOICE_LIFECYCLE.GREETING_PLAYING,
    VOICE_LIFECYCLE.LISTENING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.GREETING_QUEUED]: new Set([
    VOICE_LIFECYCLE.GREETING_PLAYING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.GREETING_PLAYING]: new Set([
    VOICE_LIFECYCLE.LISTENING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.LISTENING]: new Set([
    VOICE_LIFECYCLE.SPEECH_DETECTED,
    VOICE_LIFECYCLE.TRANSCRIBING,
    VOICE_LIFECYCLE.DECIDING,
    VOICE_LIFECYCLE.SPEAKING,
    VOICE_LIFECYCLE.WAITING_FOR_NEXT_TURN,
    VOICE_LIFECYCLE.COMPLETED,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.SPEECH_DETECTED]: new Set([
    VOICE_LIFECYCLE.TRANSCRIBING,
    VOICE_LIFECYCLE.LISTENING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.TRANSCRIBING]: new Set([
    VOICE_LIFECYCLE.DECIDING,
    VOICE_LIFECYCLE.LISTENING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.DECIDING]: new Set([
    VOICE_LIFECYCLE.SYNTHESIZING,
    VOICE_LIFECYCLE.RESPONSE_QUEUED,
    VOICE_LIFECYCLE.SPEAKING,
    VOICE_LIFECYCLE.COMPLETED,
    VOICE_LIFECYCLE.TRANSFERRING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.SYNTHESIZING]: new Set([
    VOICE_LIFECYCLE.RESPONSE_QUEUED,
    VOICE_LIFECYCLE.SPEAKING,
    VOICE_LIFECYCLE.LISTENING,
    VOICE_LIFECYCLE.COMPLETED,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.RESPONSE_QUEUED]: new Set([
    VOICE_LIFECYCLE.SPEAKING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.SPEAKING]: new Set([
    VOICE_LIFECYCLE.WAITING_FOR_NEXT_TURN,
    VOICE_LIFECYCLE.LISTENING,
    VOICE_LIFECYCLE.COMPLETED,
    VOICE_LIFECYCLE.TRANSFERRING,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.WAITING_FOR_NEXT_TURN]: new Set([
    VOICE_LIFECYCLE.LISTENING,
    VOICE_LIFECYCLE.COMPLETED,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.TRANSFERRING]: new Set([
    VOICE_LIFECYCLE.COMPLETED,
    VOICE_LIFECYCLE.CLOSED,
    VOICE_LIFECYCLE.FAILED,
  ]),
  [VOICE_LIFECYCLE.COMPLETED]: new Set([VOICE_LIFECYCLE.CLOSED]),
  [VOICE_LIFECYCLE.FAILED]: new Set([VOICE_LIFECYCLE.CLOSED]),
  [VOICE_LIFECYCLE.CLOSED]: new Set(),
};

function ensureMetadata(session) {
  if (!session || typeof session !== 'object') return { metadata: {} };
  if (!session.metadata || typeof session.metadata !== 'object') {
    session.metadata = {};
  }
  return session;
}

export function getVoiceLifecycle(session) {
  const s = ensureMetadata(session);
  const current = s.metadata.voiceLifecycle;
  if (current && Object.values(VOICE_LIFECYCLE).includes(current)) {
    return current;
  }
  return VOICE_LIFECYCLE.CONNECTING;
}

export function isTerminalLifecycle(state) {
  return TERMINAL.has(state);
}

export function isBotSpeaking(session) {
  return SPEAKING_STATES.has(getVoiceLifecycle(session));
}

export function canAcceptCallerAudio(session, { ignoreWhileSpeaking = true } = {}) {
  const state = getVoiceLifecycle(session);
  if (isTerminalLifecycle(state)) return false;
  if (session?.state === 'closed') return false;
  if (ignoreWhileSpeaking && isBotSpeaking(session)) return false;
  return (
    state === VOICE_LIFECYCLE.LISTENING ||
    state === VOICE_LIFECYCLE.SPEECH_DETECTED ||
    state === VOICE_LIFECYCLE.WAITING_FOR_NEXT_TURN
  );
}

export function canProcessTranscript(session) {
  const state = getVoiceLifecycle(session);
  if (isTerminalLifecycle(state)) return false;
  if (session?.state === 'closed') return false;
  if (session?.metadata?.transcriptionActive) return false;
  return (
    state === VOICE_LIFECYCLE.LISTENING ||
    state === VOICE_LIFECYCLE.SPEECH_DETECTED ||
    state === VOICE_LIFECYCLE.WAITING_FOR_NEXT_TURN ||
    state === VOICE_LIFECYCLE.TRANSCRIBING
  );
}

/**
 * Transition voice lifecycle. Rejects invalid moves; closed never reactivates.
 * @returns {{ ok: boolean, from: string, to: string, rejected?: boolean }}
 */
export function transitionConversation(session, nextState, context = {}) {
  const s = ensureMetadata(session);
  const from = getVoiceLifecycle(s);
  const to = String(nextState || '');

  if (!Object.values(VOICE_LIFECYCLE).includes(to)) {
    return { ok: false, from, to, rejected: true, reason: 'unknown_state' };
  }
  if (from === VOICE_LIFECYCLE.CLOSED && to !== VOICE_LIFECYCLE.CLOSED) {
    return { ok: false, from, to, rejected: true, reason: 'closed_immutable' };
  }
  if (from === to) {
    return { ok: true, from, to, noop: true };
  }
  const allowed = ALLOWED[from] || new Set();
  if (!allowed.has(to)) {
    return { ok: false, from, to, rejected: true, reason: 'invalid_transition' };
  }

  s.metadata.voiceLifecycle = to;
  s.metadata.voiceLifecycleUpdatedAt = new Date().toISOString();
  if (context.reason) {
    s.metadata.voiceLifecycleReason = String(context.reason).slice(0, 120);
  }
  if (context.event) {
    const timeline = Array.isArray(s.metadata.voiceTimeline)
      ? s.metadata.voiceTimeline
      : [];
    timeline.push({
      at: s.metadata.voiceLifecycleUpdatedAt,
      from,
      to,
      event: String(context.event).slice(0, 80),
    });
    // Bound timeline length
    s.metadata.voiceTimeline = timeline.slice(-40);
  }
  return { ok: true, from, to };
}

export function completeConversation(session, reason = COMPLETION_REASONS.COMPLETED) {
  const s = ensureMetadata(session);
  s.metadata.completionReason = reason;
  const current = getVoiceLifecycle(s);
  if (current === VOICE_LIFECYCLE.CLOSED) {
    return { ok: true, from: current, to: current, noop: true };
  }
  if (current !== VOICE_LIFECYCLE.COMPLETED) {
    transitionConversation(s, VOICE_LIFECYCLE.COMPLETED, {
      reason,
      event: 'complete',
    });
  }
  return transitionConversation(s, VOICE_LIFECYCLE.CLOSED, {
    reason,
    event: 'close',
  });
}

export function isVoiceConversationEnabled(config = {}) {
  return config.voiceConversationEnabled === true;
}

export function isSpeechInteractionMode(mode) {
  return mode === 'voice' || mode === 'voice-dtmf';
}

export function voiceConversationActive(config = {}) {
  return (
    isVoiceConversationEnabled(config) &&
    isSpeechInteractionMode(config.voiceInteractionMode)
  );
}
