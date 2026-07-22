import { randomUUID } from 'node:crypto';

const allowedStatuses = new Set([
  'queued',
  'initiated',
  'ringing',
  'answered',
  'completed',
  'busy',
  'no_answer',
  'rejected',
  'failed',
]);

export class MockProvider {
  name = 'mock';

  async startOutboundCall({ call, lead, campaign, webhookUrl }) {
    return {
      providerCallId: `mock-${randomUUID()}`,
      status: 'initiated',
      raw: {
        accepted: true,
        internalCallId: call.id,
        destination: lead.phone,
        campaign: campaign.name,
        webhookUrl,
      },
    };
  }

  normalizeWebhook(payload) {
    if (!payload.providerCallId) {
      throw new Error('providerCallId is required');
    }
    if (!allowedStatuses.has(payload.status)) {
      throw new Error(`Unsupported call status: ${payload.status}`);
    }
    return {
      eventId: payload.eventId ?? randomUUID(),
      providerCallId: payload.providerCallId,
      status: payload.status,
      selectedDigit:
        payload.selectedDigit === undefined || payload.selectedDigit === null
          ? null
          : String(payload.selectedDigit),
      durationSeconds:
        payload.durationSeconds === undefined ? null : Number(payload.durationSeconds),
      recordingUrl: payload.recordingUrl ?? null,
      occurredAt: payload.occurredAt ?? new Date().toISOString(),
      raw: payload,
    };
  }
}
