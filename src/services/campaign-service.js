import {
  CAMPAIGN_STATUSES,
  DEFAULT_KEYPAD_ACTIONS,
  hasCallConsent,
} from '../constants.js';

function mergeKeypadActions(input) {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_KEYPAD_ACTIONS };
  }
  const merged = { ...DEFAULT_KEYPAD_ACTIONS };
  for (const digit of Object.keys(DEFAULT_KEYPAD_ACTIONS)) {
    if (!input[digit]) continue;
    merged[digit] = {
      ...DEFAULT_KEYPAD_ACTIONS[digit],
      ...input[digit],
      action: DEFAULT_KEYPAD_ACTIONS[digit].action,
      followUpType: DEFAULT_KEYPAD_ACTIONS[digit].followUpType,
      label:
        typeof input[digit].label === 'string' && input[digit].label.trim()
          ? input[digit].label.trim()
          : DEFAULT_KEYPAD_ACTIONS[digit].label,
    };
  }
  return merged;
}

export class CampaignService {
  constructor({ repository, callService }) {
    this.repository = repository;
    this.callService = callService;
  }

  createCampaign(body) {
    const name = String(body.name ?? '').trim();
    if (!name) {
      throw Object.assign(new Error('name is required'), { statusCode: 400 });
    }
    const mode = body.mode ?? 'ivr';
    if (!['ivr', 'ai'].includes(mode)) {
      throw Object.assign(new Error('mode must be ivr or ai'), { statusCode: 400 });
    }
    const status = body.status ?? 'draft';
    if (!CAMPAIGN_STATUSES.includes(status)) {
      throw Object.assign(new Error('status is invalid'), { statusCode: 400 });
    }

    return this.repository.createCampaign({
      name,
      description: body.description?.trim() || null,
      mode,
      messageText: body.messageText?.trim() || body.callScript?.trim() || null,
      audioUrl: body.audioUrl?.trim() || null,
      defaultLanguage: body.defaultLanguage?.trim() || null,
      scheduledAt: body.scheduledAt || null,
      retryCount: body.retryCount ?? 0,
      retryDelaySeconds: body.retryDelaySeconds ?? 0,
      keypadActions: mergeKeypadActions(body.keypadActions),
      status,
      leadIds: Array.isArray(body.leadIds) ? body.leadIds : [],
    });
  }

  updateCampaign(id, body) {
    const existing = this.repository.getCampaign(id);
    if (!existing) {
      throw Object.assign(new Error('Campaign not found'), { statusCode: 404 });
    }
    if (body.status && !CAMPAIGN_STATUSES.includes(body.status)) {
      throw Object.assign(new Error('status is invalid'), { statusCode: 400 });
    }
    if (body.mode && !['ivr', 'ai'].includes(body.mode)) {
      throw Object.assign(new Error('mode must be ivr or ai'), { statusCode: 400 });
    }
    return this.repository.updateCampaign(id, {
      name: body.name?.trim(),
      description: body.description,
      mode: body.mode,
      messageText: body.messageText ?? body.callScript,
      audioUrl: body.audioUrl,
      defaultLanguage: body.defaultLanguage,
      scheduledAt: body.scheduledAt,
      retryCount: body.retryCount,
      retryDelaySeconds: body.retryDelaySeconds,
      keypadActions: body.keypadActions
        ? mergeKeypadActions(body.keypadActions)
        : undefined,
      status: body.status,
      leadIds: body.leadIds,
    });
  }

  assignLeads(id, leadIds) {
    const campaign = this.repository.getCampaign(id);
    if (!campaign) {
      throw Object.assign(new Error('Campaign not found'), { statusCode: 404 });
    }
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      throw Object.assign(new Error('leadIds must be a non-empty array'), {
        statusCode: 400,
      });
    }
    for (const leadId of leadIds) {
      if (!this.repository.getLead(leadId)) {
        throw Object.assign(new Error(`Lead not found: ${leadId}`), {
          statusCode: 404,
        });
      }
    }
    this.repository.assignLeadsToCampaign(id, leadIds);
    return this.repository.getCampaign(id);
  }

  evaluateEligibility(campaignId) {
    const campaign = this.repository.getCampaign(campaignId);
    if (!campaign) {
      throw Object.assign(new Error('Campaign not found'), { statusCode: 404 });
    }

    const eligible = [];
    const excluded = [];

    for (const lead of campaign.leads) {
      const reasons = [];
      if (!hasCallConsent(lead.consent_status)) {
        reasons.push('Consent is not granted');
      }
      if (lead.do_not_call) {
        reasons.push('Lead is on the Do-Not-Call list');
      }
      if (lead.outcome === 'not_interested') {
        reasons.push('Lead marked not interested for this campaign');
      }
      const active = this.repository.findActiveCall(campaignId, lead.id);
      if (active) {
        reasons.push('An active call already exists for this lead');
      }

      if (reasons.length > 0) {
        excluded.push({
          leadId: lead.id,
          name: lead.name,
          phone: lead.phone,
          reasons,
        });
      } else {
        eligible.push({
          leadId: lead.id,
          name: lead.name,
          phone: lead.phone,
        });
      }
    }

    return {
      campaign,
      eligibleCount: eligible.length,
      excludedCount: excluded.length,
      eligible,
      excluded,
    };
  }

  async startCampaign(campaignId, { confirm = false } = {}) {
    if (!confirm) {
      throw Object.assign(
        new Error('Explicit confirmation is required to start campaign calls'),
        { statusCode: 400 },
      );
    }

    const preview = this.evaluateEligibility(campaignId);
    if (preview.eligibleCount === 0) {
      throw Object.assign(new Error('No eligible leads to call'), {
        statusCode: 409,
        details: preview,
      });
    }

    this.repository.setCampaignStatus(campaignId, 'running');
    const started = [];
    const failed = [];

    for (const lead of preview.eligible) {
      try {
        const call = await this.callService.startTestCall({
          leadId: lead.leadId,
          campaignId,
        });
        started.push(call);
      } catch (error) {
        failed.push({
          leadId: lead.leadId,
          phone: lead.phone,
          error: error.message,
          callId: error.callId ?? null,
        });
      }
    }

    const remaining = this.evaluateEligibility(campaignId);
    if (remaining.eligibleCount === 0 && started.length > 0) {
      // Keep running until outcomes complete; do not auto-complete here.
    }

    return {
      campaign: this.repository.getCampaign(campaignId),
      eligibleCount: preview.eligibleCount,
      excludedCount: preview.excludedCount,
      excluded: preview.excluded,
      startedCount: started.length,
      failedCount: failed.length,
      started,
      failed,
    };
  }
}
