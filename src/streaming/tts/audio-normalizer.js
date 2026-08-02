import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { AUDIO } from '../constants.js';
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';

/**
 * Convert Kokoro PCM16LE 24 kHz mono → G.711 μ-law 8 kHz mono via ffmpeg-static.
 * Uses spawn + pipes only (no shell, no temp files).
 */
export async function pcm24kToMulaw8k(
  pcmBuffer,
  {
    inputSampleRate = 24000,
    timeoutMs = 15000,
    maxMulawBytes = 160000,
    ffmpegBinary = ffmpegPath,
  } = {},
) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.EMPTY_RESPONSE,
      'PCM buffer is empty',
      { statusCode: 502 },
    );
  }
  if (!ffmpegBinary || !existsSync(ffmpegBinary)) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.CONVERSION_FAILED,
      'ffmpeg binary is unavailable',
      { statusCode: 500 },
    );
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    String(inputSampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-ar',
    '8000',
    '-ac',
    '1',
    '-f',
    'mulaw',
    'pipe:1',
  ];

  const mulaw = await runFfmpegPipe(ffmpegBinary, args, pcmBuffer, {
    timeoutMs,
    maxStdoutBytes: maxMulawBytes,
  });

  if (!mulaw.length) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.CONVERSION_FAILED,
      'Conversion produced empty μ-law audio',
      { statusCode: 502 },
    );
  }
  if (mulaw.length > maxMulawBytes) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.RESPONSE_TOO_LARGE,
      'Converted μ-law audio exceeds size limit',
      { statusCode: 502 },
    );
  }

  const durationSeconds = Number((mulaw.length / AUDIO.sampleRate).toFixed(3));
  return {
    audio: mulaw,
    format: {
      encoding: 'mulaw',
      sampleRate: AUDIO.sampleRate,
      channels: 1,
    },
    durationSeconds,
    byteLength: mulaw.length,
  };
}

function runFfmpegPipe(binary, args, stdinBuffer, { timeoutMs, maxStdoutBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const chunks = [];
    let total = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(
        new TtsProviderError(
          TTS_ERROR_CODES.CONVERSION_TIMEOUT,
          'Audio conversion timed out',
          { retryable: true },
        ),
      );
    }, timeoutMs);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxStdoutBytes) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish(
          new TtsProviderError(
            TTS_ERROR_CODES.RESPONSE_TOO_LARGE,
            'Converted audio exceeded buffer limit',
          ),
        );
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64_000) {
        // drop further stderr — do not log audio
      }
    });

    child.on('error', (error) => {
      finish(
        new TtsProviderError(
          TTS_ERROR_CODES.CONVERSION_FAILED,
          `ffmpeg failed to start: ${error.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new TtsProviderError(
            TTS_ERROR_CODES.CONVERSION_FAILED,
            'ffmpeg conversion failed',
          ),
        );
        return;
      }
      finish(null, Buffer.concat(chunks, total));
    });

    child.stdin.on('error', () => {
      // EPIPE after kill — ignore
    });
    child.stdin.end(stdinBuffer);
  });
}

/** Build synthetic PCM16LE mono for tests (approx durationSeconds at sampleRate). */
export function synthPcmTone({
  durationSeconds = 1,
  sampleRate = 24000,
  frequencyHz = 440,
  amplitude = 0.2,
} = {}) {
  const samples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const sample = Math.round(
      Math.sin(2 * Math.PI * frequencyHz * t) * amplitude * 32767,
    );
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}
