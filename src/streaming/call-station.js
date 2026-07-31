/**
 * Privacy-safe helpers for Call Station monitoring DTOs.
 */

export function maskPhone(value) {
  if (value === undefined || value === null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `••••${digits.slice(-4)}`;
}

export function sanitizeCallRef(id) {
  if (!id) return null;
  const raw = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!raw) return null;
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

export function normalizeStationStatus(value) {
  const raw = String(value ?? 'unknown').trim().toLowerCase().replace(/[-\s]+/g, '_');
  const map = {
    requested: 'Requested',
    initiated: 'Initiated',
    ringing: 'Ringing',
    answered: 'Answered',
    streaming: 'Streaming',
    completed: 'Completed',
    failed: 'Failed',
    rejected: 'Rejected',
    busy: 'Busy',
    no_answer: 'No answer',
    noanswer: 'No answer',
    missed: 'No answer',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    unknown: 'Unknown',
  };
  return map[raw] || 'Unknown';
}

/**
 * Human-facing pickup outcome for Call Station / Dashboard panels.
 */
export function derivePickupState(row) {
  const status = String(row?.status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  const webhook = String(row?.webhook_status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  const combined = `${status} ${webhook}`;

  if (
    row?.answered_at ||
    ['answered', 'streaming', 'completed'].includes(status) ||
    ((row?.ws_accepted === 1 || row?.ws_accepted === true) &&
      (row?.streaming_at || row?.audio_status === 'playing' || row?.audio_status === 'completed'))
  ) {
    return { code: 'picked_up', label: 'Picked up' };
  }

  if (
    ['no_answer', 'noanswer', 'busy', 'failed', 'rejected', 'missed', 'cancelled', 'canceled'].includes(
      status,
    ) ||
    /no_answer|noanswer|busy|missed|rejected|failed|cancel/.test(combined)
  ) {
    return { code: 'not_picked_up', label: 'Not picked up' };
  }

  if (status === 'ringing' || webhook === 'ringing') {
    return { code: 'ringing', label: 'Ringing' };
  }

  if (['initiated', 'requested'].includes(status)) {
    return { code: 'dialing', label: 'Dialing' };
  }

  return { code: 'unknown', label: 'Unknown' };
}

export function calculateDurationSeconds(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Number(((end - start) / 1000).toFixed(3));
}

export function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!value || typeof value !== 'object') return value;
  const blocked = new Set([
    'authorization',
    'token',
    'apitoken',
    'api_token',
    'x-api-token',
    'secret',
    'password',
    'phone',
    'phone_number',
    'phonenumber',
    'did',
    'did_number',
    'payload',
    'raw',
    'body',
    'headers',
    'ip',
    'srcip',
    'audio',
    'transcript',
  ]);
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (blocked.has(String(key).toLowerCase())) continue;
    out[key] = stripSensitive(nested);
  }
  return out;
}

export function toStationCallDto(row) {
  if (!row) return null;
  const protocolEvents =
    typeof row.protocol_events === 'object' && row.protocol_events
      ? row.protocol_events
      : {};
  const timeline = Array.isArray(row.timeline) ? row.timeline : [];
  const pickup = derivePickupState(row);
  return stripSensitive({
    id: row.public_ref || sanitizeCallRef(row.id),
    internalId: sanitizeCallRef(row.id),
    providerCallId: row.provider_call_id ? sanitizeCallRef(row.provider_call_id) : null,
    streamSid: row.stream_sid ? sanitizeCallRef(row.stream_sid) : null,
    callSid: row.call_sid ? sanitizeCallRef(row.call_sid) : null,
    destinationMasked: row.destination_masked ?? null,
    didMasked: row.did_masked ?? null,
    status: normalizeStationStatus(row.status),
    pickup: pickup.label,
    pickupCode: pickup.code,
    pickedUp: pickup.code === 'picked_up',
    requestedAt: row.requested_at ?? null,
    initiatedAt: row.initiated_at ?? null,
    ringingAt: row.ringing_at ?? null,
    answeredAt: row.answered_at ?? null,
    streamingAt: row.streaming_at ?? null,
    endedAt: row.ended_at ?? null,
    durationSeconds:
      row.duration_seconds ??
      calculateDurationSeconds(row.answered_at || row.streaming_at, row.ended_at),
    websocket: {
      accepted: row.ws_accepted === 1 || row.ws_accepted === true,
      openedAt: row.ws_opened_at ?? null,
      closedAt: row.ws_closed_at ?? null,
      closeCode: row.ws_close_code ?? null,
      result:
        row.ws_accepted === 1 || row.ws_accepted === true
          ? row.ws_closed_at
            ? 'closed'
            : 'open'
          : row.ws_accepted === 0
            ? 'rejected'
            : 'unknown',
    },
    protocolEvents,
    audio: {
      status: row.audio_status ?? 'Unknown',
      queuedAt: row.audio_queued_at ?? null,
      completedAt: row.audio_completed_at ?? null,
      error: row.audio_error ?? null,
    },
    webhook: {
      receivedAt: row.webhook_received_at ?? null,
      duplicate: row.webhook_duplicate === 1 || row.webhook_duplicate === true,
      status: row.webhook_status ?? null,
      result: row.webhook_received_at
        ? row.webhook_duplicate
          ? 'duplicate'
          : 'received'
        : 'missing',
    },
    keypadOption:
      row.metadata?.selectedDigit != null
        ? `Key ${row.metadata.selectedDigit}${
            row.metadata?.keypadLabel
              ? ` · ${String(row.metadata.keypadLabel).slice(0, 48)}`
              : ''
          }`
        : 'Waiting / none',
    keypadSpokenPreview: row.metadata?.keypadSpokenPreview ?? null,
    failureReason: row.failure_category ?? null,
    timeline: timeline.map((item) => ({
      ts: item.ts ?? null,
      event: item.event ?? 'unknown',
      detail: item.detail ?? null,
    })),
  });
}
