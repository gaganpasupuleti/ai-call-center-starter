/**
 * Provider-independent streaming AI interfaces.
 * Phase 3A ships mock implementations only.
 */

export class SpeechToTextProvider {
  /**
   * @param {object} input
   * @param {Buffer} input.audio
   * @param {object} [input.metadata]
   * @returns {Promise<{ text: string, isFinal: boolean, provider: string }>}
   */
  async transcribe() {
    throw new Error('SpeechToTextProvider.transcribe is not implemented');
  }
}

export class ConversationAgentProvider {
  /**
   * @param {object} input
   * @param {string} input.text
   * @param {object} [input.session]
   * @returns {Promise<{ replyText: string, actions?: object[], provider: string }>}
   */
  async respond() {
    throw new Error('ConversationAgentProvider.respond is not implemented');
  }
}

export class TextToSpeechProvider {
  /**
   * @param {object} input
   * @param {string} input.text
   * @returns {Promise<{ audio: Buffer, format: object, provider: string }>}
   */
  async synthesize() {
    throw new Error('TextToSpeechProvider.synthesize is not implemented');
  }
}
