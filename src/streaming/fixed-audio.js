import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULAW_SILENCE } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WELCOME_AUDIO_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'assets',
  'audio',
  'welcome.ulaw',
);

export class FixedAudioError extends Error {
  constructor(message, code = 'fixed_audio_error') {
    super(message);
    this.name = 'FixedAudioError';
    this.code = code;
    this.statusCode = 500;
  }
}

function assertNotSilenceOnly(bytes) {
  let silence = 0;
  let energetic = 0;
  for (const sample of bytes) {
    if (sample === MULAW_SILENCE || sample === 0xff || sample === 0x7f) {
      silence += 1;
    }
    // μ-law values away from idle silence encodings
    if (sample !== MULAW_SILENCE && sample !== 0xff) {
      energetic += 1;
    }
  }
  const energyRatio = energetic / bytes.length;
  if (energyRatio < 0.02) {
    throw new FixedAudioError(
      'Welcome audio appears silence-only',
      'welcome_audio_silence',
    );
  }
  return {
    silenceRatio: Number((silence / bytes.length).toFixed(4)),
    energyRatio: Number(energyRatio.toFixed(4)),
  };
}

/**
 * Load raw G.711 μ-law 8 kHz mono bytes from disk.
 * Does not parse WAV headers — file must already be raw μ-law.
 */
export function loadMulawFile(filePath = DEFAULT_WELCOME_AUDIO_PATH) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new FixedAudioError(
      'Welcome audio file is missing',
      'welcome_audio_missing',
    );
  }
  const stat = statSync(resolved);
  if (!stat.size) {
    throw new FixedAudioError(
      'Welcome audio file is empty',
      'welcome_audio_empty',
    );
  }
  const bytes = readFileSync(resolved);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new FixedAudioError(
      'Welcome audio file is empty',
      'welcome_audio_empty',
    );
  }
  const quality = assertNotSilenceOnly(bytes);
  return {
    bytes: Buffer.from(bytes),
    byteLength: bytes.length,
    durationSeconds: Number((bytes.length / 8000).toFixed(3)),
    sampleRate: 8000,
    channels: 1,
    encoding: 'audio/x-mulaw',
    ...quality,
  };
}

let welcomeCache = null;
let welcomeCachePath = null;

export function getWelcomeMulaw(filePath = DEFAULT_WELCOME_AUDIO_PATH) {
  const resolved = path.resolve(filePath);
  if (welcomeCache && welcomeCachePath === resolved) {
    return {
      ...welcomeCache,
      bytes: Buffer.from(welcomeCache.bytes),
    };
  }
  const loaded = loadMulawFile(resolved);
  welcomeCache = loaded;
  welcomeCachePath = resolved;
  return {
    ...loaded,
    bytes: Buffer.from(loaded.bytes),
  };
}

export function getWelcomeAudioInfo(filePath = DEFAULT_WELCOME_AUDIO_PATH) {
  try {
    const info = getWelcomeMulaw(filePath);
    return {
      ready: true,
      byteLength: info.byteLength,
      durationSeconds: info.durationSeconds,
      sampleRate: info.sampleRate,
      channels: info.channels,
      encoding: info.encoding,
      energyRatio: info.energyRatio,
      error: null,
    };
  } catch (error) {
    return {
      ready: false,
      byteLength: 0,
      durationSeconds: 0,
      sampleRate: 8000,
      channels: 1,
      encoding: 'audio/x-mulaw',
      energyRatio: 0,
      error: error?.code || 'welcome_audio_error',
    };
  }
}

export function clearWelcomeMulawCache() {
  welcomeCache = null;
  welcomeCachePath = null;
}

export function isFixedWelcomeMode(config = {}) {
  return String(config.playbackMode ?? '').trim().toLowerCase() === 'fixed-welcome';
}
