import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { concatMulawWithRepeats } from '../tts/mulaw-encode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'artifacts',
  'outbound-prompts',
);

const memory = new Map();
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

/**
 * In-memory + disk-backed pending outbound prompts keyed by app_call_id.
 */
export class OutboundPromptStore {
  constructor({
    directory = DEFAULT_PROMPT_DIR,
    ttlMs = DEFAULT_TTL_MS,
  } = {}) {
    this.directory = directory;
    this.ttlMs = ttlMs;
    mkdirSync(this.directory, { recursive: true });
  }

  #pathFor(appCallId) {
    const safe = String(appCallId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.directory, `${safe}.ulaw`);
  }

  #metaPathFor(appCallId) {
    const safe = String(appCallId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.directory, `${safe}.json`);
  }

  create({
    phoneMasked,
    messageLength,
    repeatCount,
    mulawBytes,
    durationSeconds,
    voice,
    provider,
  }) {
    const appCallId = `ob-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const audioPath = this.#pathFor(appCallId);
    writeFileSync(audioPath, mulawBytes);
    const record = {
      appCallId,
      phoneMasked: phoneMasked ?? null,
      messageLength: messageLength ?? 0,
      repeatCount: repeatCount ?? 1,
      durationSeconds: durationSeconds ?? null,
      voice: voice ?? null,
      provider: provider ?? null,
      audioPath,
      createdAt: nowIso(),
      expiresAt,
      consumedAt: null,
    };
    writeFileSync(this.#metaPathFor(appCallId), JSON.stringify(record));
    memory.set(appCallId, {
      ...record,
      bytes: Buffer.from(mulawBytes),
    });
    return record;
  }

  get(appCallId) {
    if (!appCallId) return null;
    this.#purgeExpired();
    const mem = memory.get(appCallId);
    if (mem) {
      if (Date.parse(mem.expiresAt) < Date.now()) {
        this.delete(appCallId);
        return null;
      }
      return mem;
    }
    const metaPath = this.#metaPathFor(appCallId);
    const audioPath = this.#pathFor(appCallId);
    if (!existsSync(metaPath) || !existsSync(audioPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (Date.parse(meta.expiresAt) < Date.now()) {
        this.delete(appCallId);
        return null;
      }
      const bytes = readFileSync(audioPath);
      const record = { ...meta, bytes };
      memory.set(appCallId, record);
      return record;
    } catch {
      return null;
    }
  }

  /**
   * Build playback buffer (message × repeat with gaps).
   */
  buildPlaybackBytes(appCallId) {
    const prompt = this.get(appCallId);
    if (!prompt?.bytes?.length) return null;
    return {
      prompt,
      bytes: concatMulawWithRepeats(prompt.bytes, prompt.repeatCount),
    };
  }

  markConsumed(appCallId) {
    const prompt = this.get(appCallId);
    if (!prompt) return null;
    prompt.consumedAt = nowIso();
    memory.set(appCallId, prompt);
    try {
      writeFileSync(this.#metaPathFor(appCallId), JSON.stringify({
        appCallId: prompt.appCallId,
        phoneMasked: prompt.phoneMasked,
        messageLength: prompt.messageLength,
        repeatCount: prompt.repeatCount,
        durationSeconds: prompt.durationSeconds,
        voice: prompt.voice,
        provider: prompt.provider,
        audioPath: prompt.audioPath,
        createdAt: prompt.createdAt,
        expiresAt: prompt.expiresAt,
        consumedAt: prompt.consumedAt,
      }));
    } catch {
      // ignore
    }
    return prompt;
  }

  delete(appCallId) {
    memory.delete(appCallId);
    for (const filePath of [this.#pathFor(appCallId), this.#metaPathFor(appCallId)]) {
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  }

  #purgeExpired() {
    for (const [id, record] of memory.entries()) {
      if (Date.parse(record.expiresAt) < Date.now()) this.delete(id);
    }
  }
}

let singleton = null;
export function getOutboundPromptStore() {
  if (!singleton) singleton = new OutboundPromptStore();
  return singleton;
}
