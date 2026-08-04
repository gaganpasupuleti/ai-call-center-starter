/**
 * Paced SmartPing μ-law media helpers (Phase 4E.2).
 */
import { AUDIO, MULAW_SILENCE } from '../../src/streaming/constants.js';

export function silenceFrameCount(silenceMs, intervalMs = AUDIO.chunkIntervalMs) {
  const ms = Math.max(0, Number(silenceMs) || 0);
  const step = Math.max(1, Number(intervalMs) || AUDIO.chunkIntervalMs);
  return Math.ceil(ms / step);
}

export function makeSilenceFrame(chunkBytes = AUDIO.chunkBytes) {
  return Buffer.alloc(chunkBytes, MULAW_SILENCE);
}

export function chunkMulaw(bytes, chunkBytes = AUDIO.chunkBytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) {
    const slice = bytes.subarray(i, i + chunkBytes);
    if (slice.length === chunkBytes) {
      out.push(Buffer.from(slice));
    } else if (slice.length > 0) {
      const padded = Buffer.alloc(chunkBytes, MULAW_SILENCE);
      slice.copy(padded);
      out.push(padded);
    }
  }
  return out;
}

/**
 * Send pre-roll silence → speech frames → trailing silence.
 * Trailing silence must exceed VAD_MIN_SILENCE_MS (default 800) with margin.
 */
export async function sendPacedMulaw(
  ws,
  streamSid,
  mulawBytes,
  {
    chunkBytes = AUDIO.chunkBytes,
    intervalMs = AUDIO.chunkIntervalMs,
    startSequence = 2,
    preRollSilenceMs = 200,
    trailingSilenceMs = 1200,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const speechFrames = chunkMulaw(mulawBytes, chunkBytes);
  const preRollFrames = silenceFrameCount(preRollSilenceMs, intervalMs);
  const trailingFrames = silenceFrameCount(trailingSilenceMs, intervalMs);
  const started = Date.now();
  const sequences = [];
  let seq = startSequence;
  let chunk = 1;
  let timestamp = 0;

  async function sendFrame(payload) {
    const sequenceNumber = String(seq);
    sequences.push(seq);
    ws.send(
      JSON.stringify({
        event: 'media',
        sequenceNumber,
        streamSid,
        media: {
          track: 'inbound',
          chunk: String(chunk),
          timestamp: String(timestamp),
          payload: payload.toString('base64'),
        },
      }),
    );
    seq += 1;
    chunk += 1;
    timestamp += intervalMs;
    if (intervalMs > 0) await sleep(intervalMs);
  }

  for (let i = 0; i < preRollFrames; i += 1) {
    await sendFrame(makeSilenceFrame(chunkBytes));
  }
  for (const frame of speechFrames) {
    await sendFrame(frame);
  }
  for (let i = 0; i < trailingFrames; i += 1) {
    await sendFrame(makeSilenceFrame(chunkBytes));
  }

  const unique = new Set(sequences);
  return {
    framesSent: speechFrames.length,
    totalFramesSent: preRollFrames + speechFrames.length + trailingFrames,
    frameBytes: chunkBytes,
    preRollSilenceMs,
    trailingSilenceMs,
    preRollSilenceFrames: preRollFrames,
    trailingSilenceFrames: trailingFrames,
    callerAudioDurationMs: Date.now() - started,
    sequencesUnique: unique.size === sequences.length,
    lastTimestampMs: Math.max(0, timestamp - intervalMs),
    timestampsMonotonic: true,
  };
}
