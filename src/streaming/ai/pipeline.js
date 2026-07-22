import { MockSpeechToText } from './mock-stt.js';
import { MockConversationAgent } from './mock-agent.js';
import { MockTextToSpeech } from './mock-tts.js';

/**
 * Provider-independent orchestration:
 * customer audio → STT → agent → TTS → paced μ-law media
 */
export class VoicePipeline {
  constructor({
    stt = new MockSpeechToText(),
    agent = new MockConversationAgent(),
    tts = new MockTextToSpeech(),
  } = {}) {
    this.stt = stt;
    this.agent = agent;
    this.tts = tts;
    this.providerName = 'mock';
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
