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

const CACHE_VERSION = 'v5';
const ALLOWED_VOICES = new Set(OUTBOUND_VOICE_OPTIONS.map((v) => v.id));
const TELUGU_SCRIPT_RE = /[\u0C00-\u0C7F]/;
const VOICE_META = new Map(OUTBOUND_VOICE_OPTIONS.map((v) => [v.id, v]));

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
      'Unsupported TTS voice — choose Neerja, Prabhat, ప్రియ, or రవి',
      'tts_invalid_voice',
      400,
    );
  }
  return id;
}

/** True when the message includes Telugu Unicode letters. */
export function textHasTeluguScript(text) {
  return TELUGU_SCRIPT_RE.test(String(text ?? ''));
}

/**
 * Latin-heavy copy on a Telugu voice sounds English. Detect that mismatch.
 */
export function teluguVoiceNeedsTeluguScript(voice, text) {
  const locale = localeFromVoice(voice);
  if (locale !== 'te-IN') return false;
  return !textHasTeluguScript(text);
}

/**
 * Bright, energetic delivery for phone playback (not slow/dull).
 * Edge TTS Indian voices do not support mstts:express-as / contour reliably.
 */
function prosodyForVoice(voice, locale) {
  const gender = VOICE_META.get(voice)?.gender || 'female';
  if (locale === 'te-IN') {
    return gender === 'male'
      ? { pitch: '+6Hz', rate: '+8%', volume: '+40%' }
      : { pitch: '+12Hz', rate: '+10%', volume: '+40%' };
  }
  return gender === 'male'
    ? { pitch: '+5Hz', rate: '+10%', volume: '+30%' }
    : { pitch: '+10Hz', rate: '+12%', volume: '+30%' };
}

function buildLivelySsml(text, voice, locale) {
  const body = escapeXml(text);
  const prosody = prosodyForVoice(voice, locale);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">` +
    `<voice name="${voice}">` +
    `<prosody pitch="${prosody.pitch}" rate="${prosody.rate}" volume="${prosody.volume}">` +
    `${body}</prosody></voice></speak>`
  );
}

function runFfmpegToPcm(inputPath, { boostDb = 0, brighten = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !existsSync(ffmpegPath)) {
      reject(new TtsError('ffmpeg binary is unavailable', 'tts_ffmpeg_missing'));
      return;
    }
    const args = ['-y', '-i', inputPath, '-ac', '1', '-ar', '8000'];
    // Presence boost + mild compression so μ-law phone audio feels lively, not muffled.
    const filters = ['highpass=f=100'];
    if (brighten) {
      filters.push('equalizer=f=2200:t=q:w=1.1:g=4');
      filters.push('equalizer=f=4500:t=q:w=1.0:g=2.5');
    }
    if (boostDb > 0) filters.push(`volume=${boostDb}dB`);
    filters.push(
      'acompressor=threshold=-18dB:ratio=2.5:attack=8:release=80:makeup=3dB',
    );
    filters.push('alimiter=limit=0.96:level=false');
    args.push('-af', filters.join(','));
    args.push('-f', 's16le', 'pipe:1');
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', () => {});
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
          new TtsError('ffmpeg conversion failed', 'tts_ffmpeg_failed'),
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
    requireMatchingScript = false,
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

  const scriptMismatch = teluguVoiceNeedsTeluguScript(requestedVoice, trimmed);
  if (requireMatchingScript && scriptMismatch) {
    throw new TtsError(
      'Telugu voices need Telugu script (తెలుగు). English letters will sound English.',
      'tts_telugu_script_required',
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
          scriptMismatch,
          hasTeluguScript: textHasTeluguScript(trimmed),
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
      OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
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

    const ssml = buildLivelySsml(trimmed, requestedVoice, expectedLocale);
    let audioFilePath;
    try {
      ({ audioFilePath } = await tts.rawToFile(workDir, ssml));
    } catch {
      // Fallback to library template with the same lively prosody.
      ({ audioFilePath } = await tts.toFile(
        workDir,
        escapeXml(trimmed),
        prosodyForVoice(requestedVoice, expectedLocale),
      ));
    }
    try {
      tts.close();
    } catch {
      // ignore
    }

    if (!audioFilePath || !existsSync(audioFilePath)) {
      throw new TtsError('Edge TTS did not produce an audio file', 'tts_edge_empty');
    }

    // Delay cleanup slightly so msedge-tts finish handlers can exit cleanly.
    const pcm = await runFfmpegToPcm(audioFilePath, {
      boostDb: expectedLocale === 'te-IN' ? 5 : 3,
      brighten: true,
    });
    const encoded = pcm16leMonoToMulaw(pcm);
    writeFileSync(cachedPath, encoded.bytes);
    writeCacheMeta(metaPath, requestedVoice, key);

    setTimeout(() => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup
      }
    }, 250);

    return {
      ...encoded,
      bytes: Buffer.from(encoded.bytes),
      provider: 'edge',
      voice: requestedVoice,
      requestedVoice,
      locale: expectedLocale,
      scriptMismatch,
      hasTeluguScript: textHasTeluguScript(trimmed),
      cached: false,
      cacheKey: key,
      delivery: 'lively',
    };
  } catch (error) {
    setTimeout(() => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }, 250);
    if (error instanceof TtsError) throw error;
    throw new TtsError(
      error?.message || 'TTS synthesis failed',
      error?.code || 'tts_synthesis_failed',
      error?.statusCode || 500,
    );
  }
}
