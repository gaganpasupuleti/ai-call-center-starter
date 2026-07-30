import {
  calculateDurationSeconds,
  maskPhone,
  sanitizeCallRef,
  toStationCallDto,
} from './call-station.js';
import { getWelcomeAudioInfo, isFixedWelcomeMode } from './fixed-audio.js';

function nowIso() {
  return new Date().toISOString();
}

function pushTimeline(row, event, detail = null) {
  const timeline = Array.isArray(row.timeline) ? [...row.timeline] : [];
  const last = timeline[timeline.length - 1];
  if (last && last.event === event && last.detail === detail) {
    return timeline;
  }
  timeline.push({ ts: nowIso(), event, detail });
  return timeline;
}

/**
 * Tracks Stage 1 stream test calls for the Call Station UI.
 */
export class CallStationTracker {
  constructor({ repository, config, sessionManager = null }) {
    this.repository = repository;
    this.config = config;
    this.sessionManager = sessionManager;
  }

  setSessionManager(sessionManager) {
    this.sessionManager = sessionManager;
  }

  #findBySession(session) {
    if (!session) return null;
    return (
      this.repository.findStreamTestCall({
        streamSid: session.streamSid,
        callSid: session.callSid,
        appCallId: session.appCallId,
        sessionId: session.id,
      }) ?? null
    );
  }

  onSessionOpened(session) {
    const existing = this.#findBySession(session);
    if (existing) {
      const timeline = pushTimeline(existing, 'websocket_connected');
      return this.repository.updateStreamTestCall(existing.id, {
        status: 'answered',
        wsAccepted: true,
        wsOpenedAt: existing.ws_opened_at || nowIso(),
        answeredAt: existing.answered_at || nowIso(),
        timeline,
      });
    }
    return this.repository.createStreamTestCall({
      publicRef: `TC-${String(session.id).replace(/-/g, '').slice(0, 10)}`,
      sessionId: session.id,
      status: 'answered',
      wsAccepted: true,
      wsOpenedAt: nowIso(),
      answeredAt: nowIso(),
      destinationMasked: null,
      didMasked: maskPhone(this.config.didNumber),
      timeline: [{ ts: nowIso(), event: 'websocket_connected', detail: null }],
    });
  }

  onStreamStarted(session, playback = {}) {
    let row = this.#findBySession(session);
    if (!row) {
      row = this.onSessionOpened(session);
    }
    const protocol = { ...(row.protocol_events || {}) };
    protocol.start = (protocol.start || 0) + 1;
    let timeline = Array.isArray(row.timeline) ? [...row.timeline] : [];
    timeline = pushTimeline({ timeline }, 'start');
    if (playback?.mode === 'fixed-welcome' && !playback.skippedDuplicate) {
      if (playback.error) {
        timeline = pushTimeline({ timeline }, 'fixed_audio_failed', playback.error);
      } else if (playback.enqueuedChunks > 0) {
        timeline = pushTimeline(
          { timeline },
          'fixed_audio_queued',
          `chunks=${playback.enqueuedChunks}`,
        );
      }
    }
    return this.repository.updateStreamTestCall(row.id, {
      streamSid: session.streamSid,
      callSid: session.callSid,
      appCallId: session.appCallId,
      status: 'streaming',
      streamingAt: row.streaming_at || nowIso(),
      protocolEvents: protocol,
      audioStatus: playback?.error
        ? 'failed'
        : playback?.enqueuedChunks > 0
          ? 'queued'
          : row.audio_status,
      audioQueuedAt: playback?.enqueuedChunks > 0 ? nowIso() : row.audio_queued_at,
      audioError: playback?.error || row.audio_error,
      timeline,
    });
  }

  onProtocolEvent(session, eventName) {
    const row = this.#findBySession(session);
    if (!row) return null;
    if (eventName === 'start') return row;
    const protocol = { ...(row.protocol_events || {}) };
    protocol[eventName] = (protocol[eventName] || 0) + 1;
    // Avoid flooding timeline with every media frame.
    let timeline = row.timeline;
    if (eventName !== 'media') {
      timeline = pushTimeline(row, eventName);
    } else if (!row.timeline?.some((item) => item.event === 'inbound_media')) {
      timeline = pushTimeline(row, 'inbound_media', 'first');
    }
    const patch = {
      protocolEvents: protocol,
      timeline,
      status: row.status === 'completed' ? row.status : 'streaming',
    };
    if (eventName === 'connected') {
      patch.status = 'streaming';
      timeline = pushTimeline({ timeline: patch.timeline }, 'connected');
      patch.timeline = timeline;
    }
    return this.repository.updateStreamTestCall(row.id, patch);
  }

  recordTimeline(session, { event, detail }) {
    const row = this.#findBySession(session);
    if (!row) return null;
    return this.repository.updateStreamTestCall(row.id, {
      timeline: pushTimeline(row, event, detail),
    });
  }

  markAudioQueued(session, { chunks, durationSeconds }) {
    const row = this.#findBySession(session);
    if (!row) return null;
    return this.repository.updateStreamTestCall(row.id, {
      audioStatus: 'queued',
      audioQueuedAt: nowIso(),
      metadata: {
        ...(row.metadata || {}),
        welcomeChunks: chunks,
        welcomeDurationSeconds: durationSeconds,
      },
    });
  }

  markAudioCompleted(session) {
    const row = this.#findBySession(session);
    if (!row) return null;
    const timeline = pushTimeline(row, 'fixed_audio_completed');
    return this.repository.updateStreamTestCall(row.id, {
      audioStatus: 'completed',
      audioCompletedAt: nowIso(),
      timeline,
    });
  }

  markAudioFailed(session, code) {
    const row = this.#findBySession(session);
    if (!row) return null;
    return this.repository.updateStreamTestCall(row.id, {
      audioStatus: 'failed',
      audioError: code,
      failureCategory: code,
      timeline: pushTimeline(row, 'fixed_audio_failed', code),
    });
  }

  onSessionClosed(session, reason) {
    const row = this.#findBySession(session);
    if (!row) return null;
    const endedAt = nowIso();
    const answeredAt = row.answered_at || row.streaming_at || row.ws_opened_at;
    const status =
      reason === 'provider_stop' || reason === 'socket_close'
        ? 'completed'
        : reason === 'socket_error'
          ? 'failed'
          : row.status || 'completed';
    let timeline = pushTimeline(row, 'websocket_closed', reason);
    timeline = pushTimeline({ timeline }, 'final_status_stored', status);
    return this.repository.updateStreamTestCall(row.id, {
      status,
      endedAt,
      wsClosedAt: endedAt,
      wsCloseCode: session.wsCloseCode ?? session.ws?.closeCode ?? null,
      durationSeconds: calculateDurationSeconds(answeredAt, endedAt),
      timeline,
    });
  }

  onWebhook({ callRef, status, duplicate, eventKey }) {
    const row =
      this.repository.findStreamTestCall({
        callSid: callRef,
        providerCallId: callRef,
        streamSid: callRef,
      }) || null;

    const target =
      row ||
      this.repository.createStreamTestCall({
        publicRef: `TC-WH-${sanitizeCallRef(eventKey || callRef || Date.now())}`,
        status: status || 'unknown',
        providerCallId: callRef || null,
        callSid: callRef || null,
        webhookReceivedAt: nowIso(),
        webhookDuplicate: Boolean(duplicate),
        webhookStatus: status || null,
        timeline: [
          {
            ts: nowIso(),
            event: duplicate ? 'webhook_duplicate' : 'webhook_received',
            detail: status || null,
          },
        ],
      });

    if (row) {
      return this.repository.updateStreamTestCall(row.id, {
        webhookReceivedAt: nowIso(),
        webhookDuplicate: Boolean(duplicate),
        webhookStatus: status || row.webhook_status,
        status: status ? String(status).toLowerCase() : row.status,
        timeline: pushTimeline(
          row,
          duplicate ? 'webhook_duplicate' : 'webhook_received',
          status || null,
        ),
      });
    }
    return target;
  }

  recordSingleCallRequest({ destinationMasked, dryRun }) {
    return this.repository.createStreamTestCall({
      publicRef: `TC-API-${Date.now().toString(36)}`,
      status: dryRun ? 'requested' : 'initiated',
      requestedAt: nowIso(),
      initiatedAt: dryRun ? null : nowIso(),
      destinationMasked,
      didMasked: maskPhone(this.config.didNumber),
      timeline: [
        {
          ts: nowIso(),
          event: dryRun ? 'api_request_preview' : 'api_request_created',
          detail: null,
        },
      ],
    });
  }

  getSummary() {
    const rows = this.repository.listStreamTestCalls({});
    const activeSessions = this.sessionManager?.list?.()?.length ?? 0;
    const total = rows.length;
    const ringing = rows.filter((r) => r.status === 'ringing').length;
    const answered = rows.filter((r) =>
      ['answered', 'streaming', 'completed'].includes(r.status),
    ).length;
    const completed = rows.filter((r) => r.status === 'completed').length;
    const failed = rows.filter((r) =>
      ['failed', 'rejected'].includes(r.status),
    ).length;
    const durations = rows
      .map((r) => r.duration_seconds)
      .filter((n) => typeof n === 'number' && Number.isFinite(n));
    const avgDuration =
      durations.length === 0
        ? null
        : Number(
            (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(3),
          );
    const webhookTotal = rows.filter((r) => r.webhook_received_at).length;
    const webhookSuccessRate =
      total === 0 ? null : Number((webhookTotal / total).toFixed(4));
    return {
      totalTestCalls: total,
      ringing,
      answered,
      completed,
      failed,
      averageCallDurationSeconds: avgDuration,
      activeWebSocketSessions: activeSessions,
      webhookSuccessRate,
    };
  }

  listCalls(filters = {}) {
    const rows = this.repository.listStreamTestCalls(filters);
    return rows.map((row) => toStationCallDto(row));
  }

  getCall(publicRef) {
    const row = this.repository.getStreamTestCallByPublicRef(publicRef);
    return toStationCallDto(row);
  }

  getHealth(config = this.config) {
    const audio = getWelcomeAudioInfo(config.welcomeAudioPath || undefined);
    return {
      live: true,
      playbackMode: config.playbackMode || 'pipeline',
      fixedWelcome: isFixedWelcomeMode(config),
      dryRun: config.dryRun !== false,
      liveCallsEnabled: config.liveCallsEnabled === true,
      singleCallEnabled: config.singleCallEnabled === true,
      streamUrlConfigured: Boolean(config.streamUrlConfigured || config.streamUrl),
      destinationConfigured: Boolean(process.env.SMARTPING_TEST_PHONE_NUMBER),
      destinationMasked: maskPhone(process.env.SMARTPING_TEST_PHONE_NUMBER || ''),
      didMasked: maskPhone(config.didNumber),
      audio,
      liveCallActionAvailable: false,
      liveCallMessage: 'Live test calls require server-side approval.',
    };
  }
}
