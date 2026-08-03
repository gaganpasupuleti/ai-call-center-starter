/**
 * Bounded orchestration for deterministic response-engine actions.
 * Dependency-injectable; free of network side effects for messaging providers.
 */
export class ResponseActionExecutor {
  constructor({
    repository = null,
    liveCallsEnabled = false,
    onTransferQueue = null,
    onTransferExternal = null,
    onEnableDtmf = null,
    onRecord = null,
  } = {}) {
    this.repository = repository;
    this.liveCallsEnabled = liveCallsEnabled === true;
    this.onTransferQueue = onTransferQueue;
    this.onTransferExternal = onTransferExternal;
    this.onEnableDtmf = onEnableDtmf;
    this.onRecord = onRecord;
  }

  /**
   * @returns {{ results: object[], transferRequested: boolean, dtmfFallback: boolean, shouldClose: boolean, completionReason: string|null }}
   */
  execute(actions = [], session = {}, context = {}) {
    const results = [];
    let transferRequested = false;
    let dtmfFallback = false;
    let shouldClose = false;
    let completionReason = null;

    for (const action of actions || []) {
      if (!action || typeof action !== 'object') continue;
      const type = String(action.type || '');
      const result = this.#one(type, action, session, context);
      results.push(result);
      if (result.transferRequested) transferRequested = true;
      if (result.dtmfFallback) dtmfFallback = true;
      if (result.shouldClose) {
        shouldClose = true;
        completionReason = result.completionReason || completionReason;
      }
      this.onRecord?.(session, result);
    }

    return {
      results,
      transferRequested,
      dtmfFallback,
      shouldClose,
      completionReason,
    };
  }

  #one(type, action, session, context) {
    const meta = session.metadata || (session.metadata = {});
    const recorded = Array.isArray(meta.recordedActions)
      ? meta.recordedActions
      : (meta.recordedActions = []);

    switch (type) {
      case 'create_follow_up':
      case 'create_demo_request':
      case 'create_callback': {
        const entry = {
          type,
          channel: action.channel || null,
          at: new Date().toISOString(),
          live: false,
        };
        recorded.push(entry);
        this.#persistFollowUp(session, entry, context);
        return { type, ok: true, recorded: true };
      }
      case 'mark_do_not_call': {
        meta.doNotCall = true;
        recorded.push({ type, at: new Date().toISOString() });
        this.#markLeadDnc(session, context);
        return {
          type,
          ok: true,
          recorded: true,
          shouldClose: true,
          completionReason: 'do_not_call',
        };
      }
      case 'collect_callback_time': {
        meta.awaitingCallbackTime = true;
        recorded.push({ type, at: new Date().toISOString() });
        return { type, ok: true, recorded: true };
      }
      case 'enable_dtmf_fallback': {
        meta.dtmfFallbackActive = true;
        this.onEnableDtmf?.(session, action);
        recorded.push({ type, at: new Date().toISOString() });
        return { type, ok: true, dtmfFallback: true };
      }
      case 'transfer_queue': {
        meta.transferRequested = true;
        meta.transferQueue = action.queue || 'default';
        recorded.push({
          type,
          queue: meta.transferQueue,
          at: new Date().toISOString(),
          simulated: !this.liveCallsEnabled,
        });
        if (this.liveCallsEnabled && this.onTransferQueue) {
          this.onTransferQueue(session, action.queue || 'default');
        }
        return {
          type,
          ok: true,
          transferRequested: true,
          simulated: !this.liveCallsEnabled,
          shouldClose: true,
          completionReason: 'transfer_requested',
        };
      }
      default:
        return { type, ok: false, reason: 'unknown_action' };
    }
  }

  #persistFollowUp(session, entry, context) {
    if (!this.repository?.createFollowUp) return;
    try {
      const leadId =
        context.leadId ||
        session.customParameters?.lead_id ||
        session.metadata?.leadId ||
        null;
      if (!leadId) {
        session.metadata.lastFollowUpNote = `${entry.type}_recorded_no_lead`;
        return;
      }
      this.repository.createFollowUp({
        leadId,
        callId: session.appCallId || session.callSid || null,
        type: entry.type,
        channel: entry.channel || 'internal',
        status: 'pending',
        payload: { source: 'voice_conversation', simulated: true },
      });
    } catch {
      session.metadata.lastFollowUpNote = 'follow_up_persist_failed';
    }
  }

  #markLeadDnc(session, context) {
    if (!this.repository?.updateLead) return;
    try {
      const leadId =
        context.leadId ||
        session.customParameters?.lead_id ||
        session.metadata?.leadId ||
        null;
      if (!leadId) return;
      this.repository.updateLead(leadId, { doNotCall: true });
    } catch {
      // ignore — keep metadata flag
    }
  }
}
