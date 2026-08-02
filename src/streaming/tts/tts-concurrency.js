import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';

/**
 * Limits concurrent upstream TTS work with a bounded pending queue.
 */
export class TtsConcurrencyLimiter {
  constructor({ maxConcurrent = 2, maxPending = 10 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 2);
    this.maxPending = Math.max(0, Number(maxPending) || 10);
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxPending) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.QUEUE_FULL,
          'TTS synthesis queue is full',
          { statusCode: 503, retryable: true },
        );
      }
      await new Promise((resolve, reject) => {
        this.queue.push({ resolve, reject });
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next.resolve();
    }
  }

  getStats() {
    return {
      active: this.active,
      pending: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxPending: this.maxPending,
    };
  }
}
