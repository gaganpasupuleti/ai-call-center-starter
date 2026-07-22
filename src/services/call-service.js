import { hasCallConsent } from '../constants.js';
import { FollowUpService } from './follow-up-service.js';

export class CallService {
  constructor({ repository, provider, config }) {
    this.repository = repository;
    this.provider = provider;
    this.config = config;
    this.followUpService = new FollowUpService({ repository, config });
  }

  async startTestCall({ leadId, campaignId }) {
    const lead = this.repository.getLead(leadId);
    if (!lead) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });

    const campaign = this.repository.getCampaign(campaignId);
    if (!campaign) {
      throw Object.assign(new Error('Campaign not found'), { statusCode: 404 });
    }

    if (!hasCallConsent(lead.consent_status)) {
      throw Object.assign(new Error('Lead does not have recorded call consent'), {
        statusCode: 409,
      });
    }
    if (lead.do_not_call) {
      throw Object.assign(new Error('Lead is on the do-not-call list'), {
        statusCode: 409,
      });
    }

    const active = this.repository.findActiveCall(campaignId, leadId);
    if (active) {
      throw Object.assign(
        new Error('An active call already exists for this campaign and lead'),
        { statusCode: 409, callId: active.id },
      );
    }

    const call = this.repository.createCall({
      leadId,
      campaignId,
      provider: this.provider.name,
    });
    const webhookUrl = `${this.config.publicBaseUrl}/webhooks/providers/${this.provider.name}`;

    try {
      const result = await this.provider.startOutboundCall({
        call,
        lead,
        campaign,
        webhookUrl,
      });
      return this.repository.markCallStarted(call.id, result);
    } catch (error) {
      this.repository.markCallFailed(call.id, error.message);
      throw Object.assign(error, { statusCode: error.statusCode ?? 502, callId: call.id });
    }
  }

  processProviderEvent(event) {
    const call = this.repository.getCallByProviderId(event.providerCallId);
    if (!call) {
      throw Object.assign(new Error('No call matches the provider call ID'), {
        statusCode: 404,
      });
    }

    const result = this.repository.applyCallEvent(call.id, event);
    if (result.duplicate) {
      return result;
    }

    let followUpResult = null;
    if (
      event.selectedDigit !== undefined &&
      event.selectedDigit !== null &&
      event.selectedDigit !== ''
    ) {
      followUpResult = this.followUpService.handleDigitSelection(
        result.call,
        event.selectedDigit,
      );
    }

    return {
      ...result,
      followUp: followUpResult?.followUp ?? null,
      followUpCreated: followUpResult?.created ?? false,
      digitAction: followUpResult?.action ?? null,
    };
  }
}
