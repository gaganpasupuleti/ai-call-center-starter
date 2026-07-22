import { TextToSpeechProvider } from './interfaces.js';
import { AUDIO, MULAW_SILENCE } from '../constants.js';

function synthesizeMockMulaw(text) {
  // ~400 ms of paced silence-like μ-law audio scaled by text length.
  const frames = Math.max(4, Math.min(20, Math.ceil(String(text || '').length / 8)));
  const bytes = Buffer.alloc(frames * AUDIO.chunkBytes, MULAW_SILENCE);
  for (let index = 0; index < bytes.length; index += 17) {
    bytes[index] = 0x7f;
  }
  return bytes;
}

export class MockTextToSpeech extends TextToSpeechProvider {
  async synthesize({ text }) {
    return {
      audio: synthesizeMockMulaw(text),
      format: {
        encoding: AUDIO.encoding,
        sampleRate: AUDIO.sampleRate,
        channels: AUDIO.channels,
      },
      provider: 'mock-tts',
    };
  }
}
