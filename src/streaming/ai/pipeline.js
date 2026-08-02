import { MockSpeechToText } from './mock-stt.js';
import { MockConversationAgent } from './mock-agent.js';
import { MockTextToSpeech } from './mock-tts.js';
import { AdmissionsResponseEngine } from '../response/response-engine.js';

/**
 * Resolve conversation agent from VOICE_RESPONSE_ENGINE.
 * Supported: deterministic (default), mock.
 */
export function createConversationAgent(engineName) {
  const mode = String(engineName ?? process.env.VOICE_RESPONSE_ENGINE ?? 'deterministic')
    .trim()
    .toLowerCase();
  if (mode === 'mock') {
    return new MockConversationAgent();
  }
  // Unknown values fall back to deterministic (safe default).
  return new AdmissionsResponseEngine();
}

/**
 * Provider-independent orchestration:
 * customer audio → STT → agent → TTS → paced μ-law media
 */
export class VoicePipeline {
  constructor({
    stt = new MockSpeechToText(),
    agent = createConversationAgent(),
    tts = new MockTextToSpeech(),
  } = {}) {
    this.stt = stt;
    this.agent = agent;
    this.tts = tts;
    this.providerName =
      agent instanceof MockConversationAgent
        ? 'mock'
        : agent instanceof AdmissionsResponseEngine
          ? 'deterministic'
          : 'custom';
  }

  async handleInboundAudio(audio, session = {}) {
    const transcript = await this.stt.transcribe({ audio, metadata: session });
    if (!transcript.isFinal || !transcript.text) {
      return { transcript, reply: null, audio: null, actions: [] };
    }
    const reply = await this.agent.respond({ text: transcript.text, session });
    const speech = await this.tts.synthesize({ text: reply.replyText });
    return {
      transcript,
      reply,
      audio: speech.audio,
      format: speech.format,
      actions: reply.actions ?? [],
    };
  }
}
