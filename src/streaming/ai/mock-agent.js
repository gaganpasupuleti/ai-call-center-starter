import { ConversationAgentProvider } from './interfaces.js';

export class MockConversationAgent extends ConversationAgentProvider {
  async respond({ text }) {
    const normalized = String(text || '').toLowerCase();
    if (normalized.includes('transfer') || normalized.includes('agent')) {
      return {
        replyText: 'I will transfer you to a human agent now.',
        actions: [{ type: 'transfer_queue', queue: 'support' }],
        provider: 'mock-agent',
      };
    }
    return {
      replyText:
        'Thanks for calling. This is the mock voice agent. How can I help you today?',
      actions: [],
      provider: 'mock-agent',
    };
  }
}
