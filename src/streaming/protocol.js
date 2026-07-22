import { INBOUND_EVENTS } from './constants.js';

export class ProtocolError extends Error {
  constructor(message, code = 'protocol_error') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function parseInboundMessage(raw) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new ProtocolError('Invalid JSON', 'invalid_json');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('Invalid JSON', 'invalid_json');
  }
  const event = payload.event;
  if (typeof event !== 'string' || !INBOUND_EVENTS.has(event)) {
    throw new ProtocolError(`Unknown event: ${event ?? 'missing'}`, 'unknown_event');
  }
  return normalizeInboundEvent(payload);
}

export function normalizeInboundEvent(payload) {
  const event = payload.event;
  const sequenceNumber =
    payload.sequenceNumber === undefined || payload.sequenceNumber === null
      ? null
      : String(payload.sequenceNumber);

  if (event === 'connected') {
    return {
      event,
      sequenceNumber,
      protocol: payload.protocol ?? null,
      version: payload.version ?? null,
      raw: payload,
    };
  }

  if (event === 'start') {
    const start = payload.start ?? {};
    const streamSid = start.streamSid ?? payload.streamSid;
    const callSid = start.callSid ?? payload.callSid;
    if (!streamSid) {
      throw new ProtocolError('Missing streamSid', 'missing_stream_sid');
    }
    return {
      event,
      sequenceNumber,
      streamSid: String(streamSid),
      callSid: callSid ? String(callSid) : null,
      mediaFormat: start.mediaFormat ?? null,
      customParameters: start.customParameters ?? {},
      tracks: start.tracks ?? [],
      raw: payload,
    };
  }

  if (event === 'media') {
    const media = payload.media ?? {};
    const streamSid = payload.streamSid ?? media.streamSid;
    if (!streamSid) {
      throw new ProtocolError('Missing streamSid', 'missing_stream_sid');
    }
    const payloadB64 = media.payload;
    let decoded = null;
    let validation = 'ok';
    if (typeof payloadB64 !== 'string' || payloadB64.length === 0) {
      validation = 'invalid_base64';
    } else {
      try {
        decoded = Buffer.from(payloadB64, 'base64');
        if (decoded.length === 0 && payloadB64.length > 0) {
          validation = 'invalid_base64';
          decoded = null;
        } else {
          // Reject strings that are not valid base64 alphabet.
          const normalized = payloadB64.replace(/\s+/g, '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
            validation = 'invalid_base64';
            decoded = null;
          }
        }
      } catch {
        validation = 'invalid_base64';
        decoded = null;
      }
    }
    return {
      event,
      sequenceNumber,
      streamSid: String(streamSid),
      track: media.track ?? null,
      chunk: media.chunk ?? null,
      timestamp: media.timestamp ?? null,
      payloadSize: decoded?.length ?? 0,
      payload: decoded,
      validation,
      raw: payload,
    };
  }

  if (event === 'mark') {
    const mark = payload.mark ?? {};
    const streamSid = payload.streamSid ?? mark.streamSid;
    if (!streamSid) {
      throw new ProtocolError('Missing streamSid', 'missing_stream_sid');
    }
    return {
      event,
      sequenceNumber,
      streamSid: String(streamSid),
      name: mark.name ?? null,
      raw: payload,
    };
  }

  if (event === 'stop') {
    const stop = payload.stop ?? {};
    const streamSid = payload.streamSid ?? stop.streamSid;
    const callSid = stop.callSid ?? payload.callSid ?? null;
    return {
      event,
      sequenceNumber,
      streamSid: streamSid ? String(streamSid) : null,
      callSid: callSid ? String(callSid) : null,
      raw: payload,
    };
  }

  throw new ProtocolError(`Unknown event: ${event}`, 'unknown_event');
}

export function buildOutboundMedia(streamSid, mulawChunk) {
  return {
    event: 'media',
    streamSid,
    media: {
      payload: Buffer.from(mulawChunk).toString('base64'),
    },
  };
}

export function buildOutboundMark(streamSid, name) {
  return {
    event: 'mark',
    streamSid,
    mark: { name },
  };
}

export function buildOutboundClear(streamSid) {
  return {
    event: 'clear',
    streamSid,
  };
}

export function buildOutboundHangup(streamSid) {
  return {
    event: 'hangupCall',
    streamSid,
  };
}

export function buildOutboundTransfer(streamSid, transfer) {
  return {
    event: 'transfer',
    streamSid,
    transfer,
  };
}
