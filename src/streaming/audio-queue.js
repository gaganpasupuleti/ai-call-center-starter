import { AUDIO, MULAW_SILENCE } from './constants.js';

export function chunkMulawBytes(bytes, chunkSize = AUDIO.chunkBytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (source.length === 0) return [];
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    const slice = source.subarray(offset, offset + chunkSize);
    if (slice.length === chunkSize) {
      chunks.push(Buffer.from(slice));
      continue;
    }
    const padded = Buffer.alloc(chunkSize, MULAW_SILENCE);
    slice.copy(padded);
    chunks.push(padded);
  }
  return chunks;
}

export class PacedAudioQueue {
  constructor({
    sendChunk,
    chunkSize = AUDIO.chunkBytes,
    intervalMs = AUDIO.chunkIntervalMs,
    now = () => Date.now(),
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = (id) => clearInterval(id),
  }) {
    this.sendChunk = sendChunk;
    this.chunkSize = chunkSize;
    this.intervalMs = intervalMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.queue = [];
    this.timer = null;
    this.closed = false;
    this.sentCount = 0;
  }

  enqueue(bytes) {
    if (this.closed) return 0;
    const chunks = chunkMulawBytes(bytes, this.chunkSize);
    this.queue.push(...chunks);
    this.#ensureTimer();
    return chunks.length;
  }

  clear() {
    const dropped = this.queue.length;
    this.queue = [];
    return dropped;
  }

  stop() {
    this.closed = true;
    this.clear();
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  get pendingChunks() {
    return this.queue.length;
  }

  #ensureTimer() {
    if (this.timer || this.closed) return;
    this.timer = this.setTimer(() => {
      if (this.closed) {
        this.stop();
        return;
      }
      const chunk = this.queue.shift();
      if (!chunk) return;
      this.sendChunk(chunk);
      this.sentCount += 1;
    }, this.intervalMs);
  }
}
