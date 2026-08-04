import { createHash } from 'node:crypto';

/**
 * Bounded in-memory LRU TTS cache for bot-generated audio only.
 */
export class BoundedTtsCache {
  constructor({
    enabled = true,
    maxEntries = 100,
    maxBytes = 52_428_800,
    ttlMs = 3_600_000,
  } = {}) {
    this.enabled = enabled !== false;
    this.maxEntries = Math.max(1, Number(maxEntries) || 100);
    this.maxBytes = Math.max(1, Number(maxBytes) || 52_428_800);
    this.ttlMs = Math.max(1, Number(ttlMs) || 3_600_000);
    this.map = new Map();
    this.totalBytes = 0;
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  static buildKey({
    provider,
    language,
    voice,
    speed,
    text,
    speakerId = null,
    formatVersion = 'mulaw-8k-v1',
  }) {
    const normalized = String(text || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    const material = [
      provider,
      language,
      voice,
      speakerId == null ? '' : String(speakerId),
      String(Number(speed).toFixed(3)),
      formatVersion,
      normalized,
    ].join('\n');
    return createHash('sha256').update(material).digest('hex');
  }

  get(key) {
    if (!this.enabled) return null;
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.#delete(key);
      this.stats.misses += 1;
      this.stats.evictions += 1;
      return null;
    }
    // LRU refresh
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits += 1;
    return Buffer.from(entry.audio);
  }

  set(key, audio) {
    if (!this.enabled) return false;
    if (!Buffer.isBuffer(audio) || audio.length === 0) return false;
    if (audio.length > this.maxBytes) return false;

    if (this.map.has(key)) this.#delete(key);

    while (
      this.map.size >= this.maxEntries ||
      this.totalBytes + audio.length > this.maxBytes
    ) {
      const oldest = this.map.keys().next().value;
      if (oldest == null) break;
      this.#delete(oldest);
      this.stats.evictions += 1;
    }

    const copy = Buffer.from(audio);
    this.map.set(key, {
      audio: copy,
      expiresAt: Date.now() + this.ttlMs,
      bytes: copy.length,
    });
    this.totalBytes += copy.length;
    return true;
  }

  clear() {
    this.map.clear();
    this.totalBytes = 0;
  }

  size() {
    return this.map.size;
  }

  #delete(key) {
    const entry = this.map.get(key);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.map.delete(key);
  }
}
