export const STREAM_PATH = '/ws/voice/smartping';

export const INBOUND_EVENTS = new Set([
  'connected',
  'start',
  'media',
  'mark',
  'stop',
]);

export const OUTBOUND_EVENTS = {
  media: 'media',
  mark: 'mark',
  clear: 'clear',
  hangupCall: 'hangupCall',
  transfer: 'transfer',
};

export const AUDIO = {
  encoding: 'audio/x-mulaw',
  sampleRate: 8000,
  channels: 1,
  chunkBytes: 160,
  chunkIntervalMs: 20,
};

export const STREAM_STATES = {
  connecting: 'connecting',
  connected: 'connected',
  active: 'active',
  clearing: 'clearing',
  stopping: 'stopping',
  closed: 'closed',
  error: 'error',
};

export const DEFAULT_VOICEBOT_PATH =
  '/agm/at/streaming/campaign/voicebot/call-customer';

/** μ-law silence byte */
export const MULAW_SILENCE = 0xff;
