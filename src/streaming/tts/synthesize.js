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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'artifacts',
  'tts-cache',
);

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
    .update(`${voice}\n${text}`)
    .digest('hex')
    .slice(0, 32);
}

export function getTtsHealth({
  voice = process.env.OUTBOUND_TTS_VOICE || 'en-US-JennyNeural',
  cacheDir = DEFAULT_CACHE_DIR,
} = {}) {
  return {
    provider: process.env.OUTBOUND_TTS_PROVIDER || 'edge',
    voice,
    ffmpegAvailable: Boolean(ffmpegPath && existsSync(ffmpegPath)),
    cacheDirConfigured: Boolean(cacheDir),
    ready: Boolean(ffmpegPath && existsSync(ffmpegPath)),
  };
}

/**
 * Synthesize text to raw G.711 μ-law 8 kHz mono via Edge TTS + ffmpeg-static.
 */
export async function synthesizeToMulaw(
  text,
  {
    voice = process.env.OUTBOUND_TTS_VOICE || 'en-US-JennyNeural',
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

  const health = getTtsHealth({ voice, cacheDir });
  if (!health.ready) {
    throw new TtsError(
      'TTS is not ready (ffmpeg-static missing)',
      'tts_not_ready',
      503,
    );
  }

  mkdirSync(cacheDir, { recursive: true });
  const key = cacheKey(trimmed, voice);
  const cachedPath = path.join(cacheDir, `${key}.ulaw`);

  // Cached mulaw: validate non-empty + energy without round-tripping PCM.
  if (existsSync(cachedPath)) {
    const bytes = readFileSync(cachedPath);
    if (bytes.length > 0) {
      let energetic = 0;
      for (const sample of bytes) {
        if (sample !== 0xff && sample !== 0x7f) energetic += 1;
      }
      const energyRatio = energetic / bytes.length;
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
          voice,
          cached: true,
          cacheKey: key,
        };
      }
    }
  }

  const workDir = path.join(cacheDir, 'tmp');
  mkdirSync(workDir, { recursive: true });
  const mp3Path = path.join(workDir, `${key}.mp3`);

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioFilePath } = await tts.toFile(workDir, escapeXml(trimmed));
    // msedge-tts names the file itself; prefer returned path.
    const sourcePath = audioFilePath || mp3Path;
    if (!existsSync(sourcePath)) {
      throw new TtsError('Edge TTS did not produce an audio file', 'tts_edge_empty');
    }

    const pcm = await runFfmpegToPcm(sourcePath);
    const encoded = pcm16leMonoToMulaw(pcm);
    writeFileSync(cachedPath, encoded.bytes);

    try {
      rmSync(sourcePath, { force: true });
    } catch {
      // ignore cleanup
    }

    return {
      ...encoded,
      bytes: Buffer.from(encoded.bytes),
      provider: 'edge',
      voice,
      cached: false,
      cacheKey: key,
    };
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw new TtsError(
      error?.message || 'TTS synthesis failed',
      error?.code || 'tts_synthesis_failed',
      error?.statusCode || 500,
    );
  }
}
