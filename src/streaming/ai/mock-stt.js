import { SpeechToTextProvider } from './interfaces.js';

const SCRIPT = [
  'Hello, I am interested in the program.',
  'Please transfer me to an agent.',
];

export class MockSpeechToText extends SpeechToTextProvider {
  constructor() {
    super();
    this.bytesSeen = 0;
    this.turn = 0;
  }

  async transcribe({ audio }) {
    this.bytesSeen += audio?.length ?? 0;
    // Emit a final transcript once enough inbound audio has been observed.
    if (this.bytesSeen < 320) {
      return { text: '', isFinal: false, provider: 'mock-stt' };
    }
    this.bytesSeen = 0;
    const text = SCRIPT[this.turn % SCRIPT.length];
    this.turn += 1;
    return {
      text,
      isFinal: true,
      provider: 'mock-stt',
    };
  }
}
