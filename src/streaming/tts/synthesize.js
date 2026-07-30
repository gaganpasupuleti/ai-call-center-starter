import { createHash } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import ffmpegPath from 'ffmpeg-static';
import { pcm16leMonoToMulaw } from './mulaw-encode.js';
import { OUTBOUND_VOICE_OPTIONS } from '../outbound/phone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'artifacts',
  'tts-cache',
);

const CACHE_VERSION = 'v2';
const ALLOWED_VOICES = new Set(OUTBOUND_VOICE_OPTIONS.map((v) => v.id));

export class TtsError extends Error {
  constructor(message, code = 'tts_error', statusCode = 500) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function localeFromVoice(voice) {
  const match = /\w{2}-\w{2}/.exec(String(voice || ''));
  return match ? match[0] : null;
}

function assertAllowedVoice(voice) {
  const id = String(voice ?? '').trim();
  if (!ALLOWED_VOICES.has(id)) {
    throw new TtsError(
      'Unsupported TTS voice — choose Neerja, Prabhat, Shruti, or Mohan',
      'tts_invalid_voice',
      400,
    );
  }
  return id;
}

function runFfmpegToPcm(inputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !existsSync(ffmpegPath)) {
      reject(new TtsError('ffmpeg binary is unavailable', 'tts_ffmpeg_missing'));
      return;
    }
    const args = [
      '-y',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      's16le',
      'pipe:1',
    ];
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => {
      reject(
        new TtsError(
          `ffmpeg failed to start: ${error.message}`,
          'tts_ffmpeg_spawn',
        ),
      );
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new TtsError(
            'ffmpeg conversion failed',
            'tts_ffmpeg_failed',
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function cacheKey(text, voice) {
  return createHash('sha256')
    .update(`${CACHE_VERSION}\n${voice}\n${text}`)
    .digest('hex')
    .slice(0, 32);
}

function readCacheMeta(metaPath, expectedVoice) {
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta?.voice !== expectedVoice || meta?.version !== CACHE_VERSION) {
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

function writeCacheMeta(metaPath, voice, key) {
  writeFileSync(
    metaPath,
    JSON.stringify({
      version: CACHE_VERSION,
      voice,
      cacheKey: key,
      createdAt: new Date().toISOString(),
    }),
  );
}

function mulawEnergyRatio(bytes) {
  let energetic = 0;
  for (const sample of bytes) {
    if (sample !== 0xff && sample !== 0x7f) energetic += 1;
  }
  return energetic / bytes.length;
}

export function getTtsHealth({
  voice = process.env.OUTBOUND_TTS_VOICE || 'en-IN-NeerjaNeural',
  cacheDir = DEFAULT_CACHE_DIR,
} = {}) {
  const resolved = ALLOWED_VOICES.has(String(voice || '').trim())
    ? String(voice).trim()
    : 'en-IN-NeerjaNeural';
  return {
    provider: process.env.OUTBOUND_TTS_PROVIDER || 'edge',
    voice: resolved,
    allowedVoices: [...ALLOWED_VOICES],
    ffmpegAvailable: Boolean(ffmpegPath && existsSync(ffmpegPath)),
    cacheDirConfigured: Boolean(cacheDir),
    ready: Boolean(ffmpegPath && existsSync(ffmpegPath)),
  };
}

/**
 * Synthesize text to raw G.711 μ-law 8 kHz mono via Edge TTS + ffmpeg-static.
 * Enforces the outbound voice allowlist and binds cache entries to that voice.
 */
export async function synthesizeToMulaw(
  text,
  {
    voice = process.env.OUTBOUND_TTS_VOICE || 'en-IN-NeerjaNeural',
    cacheDir = DEFAULT_CACHE_DIR,
  } = {},
) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    throw new TtsError('Message text is required', 'tts_text_required', 400);
  }
  if (trimmed.length > 500) {
    throw new TtsError(
      'Message text must be 500 characters or fewer',
      'tts_text_too_long',
      400,
    );
  }

  const requestedVoice = assertAllowedVoice(voice);
  const expectedLocale = localeFromVoice(requestedVoice);
  if (!expectedLocale) {
    throw new TtsError(
      'Could not derive locale from voice id',
      'tts_invalid_voice',
      400,
    );
  }

  const health = getTtsHealth({ voice: requestedVoice, cacheDir });
  if (!health.ready) {
    throw new TtsError(
      'TTS is not ready (ffmpeg-static missing)',
      'tts_not_ready',
      503,
    );
  }

  mkdirSync(cacheDir, { recursive: true });
  const key = cacheKey(trimmed, requestedVoice);
  const cachedPath = path.join(cacheDir, `${key}.ulaw`);
  const metaPath = path.join(cacheDir, `${key}.json`);

  // Cached mulaw: require matching voice meta + energy floor.
  if (existsSync(cachedPath) && readCacheMeta(metaPath, requestedVoice)) {
    const bytes = readFileSync(cachedPath);
    if (bytes.length > 0) {
      const energyRatio = mulawEnergyRatio(bytes);
      if (energyRatio >= 0.02) {
        return {
          bytes: Buffer.from(bytes),
          byteLength: bytes.length,
          durationSeconds: Number((bytes.length / 8000).toFixed(3)),
          sampleRate: 8000,
          channels: 1,
          encoding: 'audio/x-mulaw',
          energyRatio: Number(energyRatio.toFixed(4)),
          provider: 'edge',
          voice: requestedVoice,
          requestedVoice,
          locale: expectedLocale,
          cached: true,
          cacheKey: key,
        };
      }
    }
  }

  const workDir = path.join(cacheDir, 'tmp', key);
  mkdirSync(workDir, { recursive: true });

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      requestedVoice,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      { voiceLocale: expectedLocale },
    );

    const boundVoice = tts._voice;
    const boundLocale = tts._metadataOptions?.voiceLocale;
    if (boundVoice !== requestedVoice || boundLocale !== expectedLocale) {
      throw new TtsError(
        `Edge TTS voice mismatch (got ${boundVoice}/${boundLocale})`,
        'tts_voice_mismatch',
        500,
      );
    }

    const { audioFilePath } = await tts.toFile(workDir, escapeXml(trimmed));
    try {
      tts.close();
    } catch {
      // ignore
    }

    if (!audioFilePath || !existsSync(audioFilePath)) {
      throw new TtsError('Edge TTS did not produce an audio file', 'tts_edge_empty');
    }

    const pcm = await runFfmpegToPcm(audioFilePath);
    const encoded = pcm16leMonoToMulaw(pcm);
    writeFileSync(cachedPath, encoded.bytes);
    writeCacheMeta(metaPath, requestedVoice, key);

    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }

    return {
      ...encoded,
      bytes: Buffer.from(encoded.bytes),
      provider: 'edge',
      voice: requestedVoice,
      requestedVoice,
      locale: expectedLocale,
      cached: false,
      cacheKey: key,
    };
  } catch (error) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (error instanceof TtsError) throw error;
    throw new TtsError(
      error?.message || 'TTS synthesis failed',
      error?.code || 'tts_synthesis_failed',
      error?.statusCode || 500,
    );
  }
}
