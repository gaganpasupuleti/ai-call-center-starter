/**
 * Local/remote SmartPing voice-stream simulator.
 * Connects to the app WebSocket endpoint. Does not call SmartPing or place phone calls.
 *
 * Usage:
 *   npm run simulate:smartping-stream
 *   npm run simulate:smartping-stream -- --url wss://example/ws/voice/smartping
 *   npm run simulate:smartping-stream -- --url wss://example/ws/voice/smartping --token <secret> --ws-auth
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AUDIO, MULAW_SILENCE, STREAM_PATH } from '../src/streaming/constants.js';
import { parseArgs } from './parse-simulator-args.js';

function httpBaseFromWsUrl(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

const cli = parseArgs(process.argv.slice(2));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const streamPath = process.env.SMARTPING_STREAM_PATH || STREAM_PATH;
const wsUrl =
  cli.url ||
  process.env.SMARTPING_STREAM_URL ||
  `ws://${host}:${port}${streamPath}`;
const tokenFromFile = cli.tokenFile
  ? readFileSync(cli.tokenFile, 'utf8').trim()
  : null;
const token =
  cli.token || tokenFromFile || process.env.SMARTPING_STREAM_SHARED_SECRET || null;
// When --url is provided, derive HTTP base from that URL so local PUBLIC_BASE_URL
// cannot accidentally send stream commands to the wrong host.
const httpBase = cli.url
  ? httpBaseFromWsUrl(wsUrl)
  : process.env.PUBLIC_BASE_URL || httpBaseFromWsUrl(wsUrl);

const streamSid = `MZ${randomUUID().replaceAll('-', '').slice(0, 32)}`;
const callSid = `CA${randomUUID().replaceAll('-', '').slice(0, 32)}`;

const seen = {
  connected: 0,
  start: 0,
  media: 0,
  mark: 0,
  clear: 0,
  hangupCall: 0,
  transferQueue: 0,
  transferExternal: 0,
  errors: [],
};

function mulawChunk(fill = MULAW_SILENCE) {
  return Buffer.alloc(AUDIO.chunkBytes, fill).toString('base64');
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
  if (payload.event === 'connected') seen.connected += 1;
  if (payload.event === 'start') seen.start += 1;
}

async function command(streamId, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${httpBase}/api/streams/${streamId}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `command failed ${response.status}`);
  return json;
}

function waitFor(predicate, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout waiting for ${label}`));
      }
    }, 50);
  });
}

async function main() {
  console.log(`Connecting simulator to ${wsUrl}`);
  console.log('NOTE: This simulator never calls SmartPing or places a telephone call.');
  if (token && cli.wsAuth) {
    console.log('Using Authorization bearer token for WebSocket upgrade (required mode).');
  } else if (token) {
    console.log('Token reserved for stream command API only (provider-compatible WSS).');
  }

  const headers = {};
  if (token && cli.wsAuth) headers.Authorization = `Bearer ${token}`;

  const ws = new WebSocket(wsUrl, { headers });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, response) => {
      reject(new Error(`WebSocket rejected with HTTP ${response.statusCode}`));
    });
  });

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      seen.errors.push('invalid_json_from_server');
      return;
    }
    if (message.event === 'media') seen.media += 1;
    if (message.event === 'mark') {
      seen.mark += 1;
      send(ws, {
        event: 'mark',
        sequenceNumber: String(1000 + seen.mark),
        streamSid,
        mark: { name: message.mark?.name },
      });
    }
    if (message.event === 'clear') seen.clear += 1;
    if (message.event === 'hangupCall') seen.hangupCall += 1;
    if (message.event === 'transfer') {
      if (message.transfer?.type === 'queue') seen.transferQueue += 1;
      if (message.transfer?.type === 'external') seen.transferExternal += 1;
    }
    if (message.event === 'error') {
      seen.errors.push(message.error?.code || 'error');
    }
  });

  send(ws, { event: 'connected', protocol: 'Call', version: '1.0.0' });
  send(ws, {
    event: 'start',
    sequenceNumber: '1',
    start: {
      streamSid,
      callSid,
      tracks: ['inbound'],
      mediaFormat: {
        encoding: AUDIO.encoding,
        sampleRate: AUDIO.sampleRate,
        channels: AUDIO.channels,
      },
      customParameters: {
        app_call_id: 'simulator-call',
        source: 'local-simulator',
      },
    },
  });

  for (let index = 0; index < 6; index += 1) {
    send(ws, {
      event: 'media',
      sequenceNumber: String(2 + index),
      streamSid,
      media: {
        track: 'inbound',
        chunk: String(index + 1),
        timestamp: String(index * 20),
        payload: mulawChunk(index % 2 === 0 ? 0xff : 0x7f),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  await waitFor(() => seen.media > 0, 'outbound media');
  await waitFor(() => seen.mark > 0, 'mark');

  await command(streamSid, { command: 'clear' });
  await waitFor(() => seen.clear > 0, 'clear');

  await command(streamSid, { command: 'transfer_queue', queue: 'support' });
  await waitFor(() => seen.transferQueue > 0, 'queue transfer');

  await command(streamSid, {
    command: 'transfer_external',
    phoneNumber: '+919999999999',
  });
  await waitFor(() => seen.transferExternal > 0, 'external transfer');

  await command(streamSid, { command: 'hangup' });
  await waitFor(() => seen.hangupCall > 0, 'hangup');

  send(ws, {
    event: 'stop',
    sequenceNumber: '99',
    streamSid,
    stop: { callSid },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  ws.close();

  const summary = {
    streamSid,
    callSid,
    url: wsUrl,
    authUsed: Boolean(token && cli.wsAuth),
    commandAuthUsed: Boolean(token),
    received: seen,
    networkExternalCalls: 0,
    telephoneCalls: 0,
    ok:
      seen.connected > 0 &&
      seen.start > 0 &&
      seen.media > 0 &&
      seen.mark > 0 &&
      seen.clear > 0 &&
      seen.hangupCall > 0 &&
      seen.transferQueue > 0 &&
      seen.transferExternal > 0 &&
      seen.errors.length === 0,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
  console.log('SIMULATOR_OK');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
