export const CONVERSATION_STATES = Object.freeze({
  waiting_for_initial_response: 'waiting_for_initial_response',
  waiting_for_demo_interest: 'waiting_for_demo_interest',
  waiting_for_demo_date: 'waiting_for_demo_date',
  waiting_for_callback_time: 'waiting_for_callback_time',
  waiting_for_details_confirmation: 'waiting_for_details_confirmation',
  waiting_for_human_transfer: 'waiting_for_human_transfer',
  completed: 'completed',
});

export const INITIAL_CONVERSATION_STATE =
  CONVERSATION_STATES.waiting_for_initial_response;

function ensureMetadata(session) {
  if (!session || typeof session !== 'object') {
    return { metadata: {} };
  }
  if (!session.metadata || typeof session.metadata !== 'object') {
    session.metadata = {};
  }
  return session;
}

export function getConversationState(session) {
  const s = ensureMetadata(session);
  const current = s.metadata.conversationState;
  if (current && Object.values(CONVERSATION_STATES).includes(current)) {
    return current;
  }
  s.metadata.conversationState = INITIAL_CONVERSATION_STATE;
  return INITIAL_CONVERSATION_STATE;
}

export function setConversationState(session, nextState) {
  const s = ensureMetadata(session);
  const next =
    nextState && Object.values(CONVERSATION_STATES).includes(nextState)
      ? nextState
      : INITIAL_CONVERSATION_STATE;
  s.metadata.conversationState = next;
  return next;
}

export function getUnknownCount(session) {
  const s = ensureMetadata(session);
  const n = Number(s.metadata.unknownCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function incrementUnknownCount(session) {
  const s = ensureMetadata(session);
  const next = getUnknownCount(s) + 1;
  s.metadata.unknownCount = next;
  return next;
}

export function resetUnknownCount(session) {
  const s = ensureMetadata(session);
  s.metadata.unknownCount = 0;
  return 0;
}

export function recordEngineDecision(session, decision = {}) {
  const s = ensureMetadata(session);
  if (decision.transcript != null) {
    s.metadata.lastTranscript = String(decision.transcript);
  }
  if (decision.intent != null) {
    s.metadata.lastIntent = String(decision.intent);
  }
  if (decision.intentConfidence != null) {
    s.metadata.lastIntentConfidence = Number(decision.intentConfidence);
  }
  if (decision.nextState != null) {
    setConversationState(s, decision.nextState);
  }
  if (decision.replyText != null) {
    s.metadata.lastReplyText = String(decision.replyText);
  }
  if (decision.language != null) {
    s.metadata.detectedLanguage = String(decision.language);
  }
  if (typeof decision.unknownCount === 'number') {
    s.metadata.unknownCount = decision.unknownCount;
  }
  return s.metadata;
}
