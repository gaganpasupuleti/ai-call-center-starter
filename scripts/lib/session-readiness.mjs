/**
 * Strict session readiness checks for real-audio mode.
 */

const READY_LIFECYCLES = new Set(['listening']);
const NEXT_TURN_LIFECYCLES = new Set(['listening', 'waiting_for_next_turn']);

export function isSessionReadyForAudio(snapshot, { afterFirstTurn = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const life = snapshot.voiceLifecycle;
  const lifecycleOk = afterFirstTurn
    ? NEXT_TURN_LIFECYCLES.has(life)
    : READY_LIFECYCLES.has(life);
  return (
    lifecycleOk &&
    snapshot.sttStarted === true &&
    snapshot.sttStatus === 'ready'
  );
}

export class SessionNotReadyError extends Error {
  constructor(details = {}) {
    super('session_not_ready_for_audio');
    this.name = 'SessionNotReadyError';
    this.code = 'session_not_ready_for_audio';
    this.details = {
      code: 'session_not_ready_for_audio',
      lastLifecycle: details.lastLifecycle ?? null,
      lastSttStatus: details.lastSttStatus ?? null,
      sttStarted: details.sttStarted === true,
    };
  }

  toJSON() {
    return this.details;
  }
}

export async function waitForListening(
  httpBase,
  streamSid,
  {
    timeoutMs = 60_000,
    afterFirstTurn = false,
    pollMs = 400,
    fetchImpl = globalThis.fetch.bind(globalThis),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const res = await fetchImpl(
      `${httpBase}/api/speech/session-turn?streamSid=${encodeURIComponent(streamSid)}`,
    );
    last = await res.json().catch(() => ({}));
    if (res.ok && isSessionReadyForAudio(last, { afterFirstTurn })) {
      return last;
    }
    await sleep(pollMs);
  }
  throw new SessionNotReadyError({
    lastLifecycle: last?.voiceLifecycle ?? null,
    lastSttStatus: last?.sttStatus ?? null,
    sttStarted: last?.sttStarted === true,
  });
}

export function inferFailureStage(gates = {}) {
  const order = [
    ['fixtureValidated', 'fixture'],
    ['sessionStarted', 'session_start'],
    ['listeningReady', 'listening'],
    ['sttReady', 'stt_ready'],
    ['audioSent', 'audio_send'],
    ['audioForwarded', 'audio_forward'],
    ['speechStarted', 'vad_speech_start'],
    ['speechEnded', 'vad_speech_end'],
    ['transcriptReceived', 'transcription'],
    ['intentSelected', 'intent'],
    ['ttsRequested', 'tts_request'],
    ['ttsCompleted', 'tts'],
    ['botAudioReceived', 'bot_audio'],
    ['conversationCompleted', 'completion'],
  ];
  for (const [key, stage] of order) {
    if (gates[key] === false) return stage;
  }
  return null;
}
