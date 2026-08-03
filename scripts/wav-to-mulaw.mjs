/**
 * Convert a PCM WAV file to raw G.711 μ-law 8 kHz mono.
 * Usage: node scripts/wav-to-mulaw.mjs <input.wav> <output.ulaw>
 */
import { wavFileToMulaw8k } from './lib/wav-mulaw.mjs';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/wav-to-mulaw.mjs <input.wav> <output.ulaw>');
  process.exit(1);
}

const converted = wavFileToMulaw8k(inputPath, outputPath);
console.log(
  JSON.stringify({
    output: outputPath,
    bytes: converted.mulaw.length,
    sampleRate: converted.sampleRate,
    channels: converted.channels,
    encoding: converted.encoding,
    durationSeconds: converted.durationSeconds,
    nonSilenceRatio: converted.nonSilenceRatio,
  }),
);
