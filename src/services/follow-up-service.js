import { DEFAULT_KEYPAD_ACTIONS } from '../constants.js';

export class FollowUpService {
  constructor({ repository, config }) {
    this.repository = repository;
    this.config = config;
  }

  handleDigitSelection(call, selectedDigit) {
    if (selectedDigit === undefined || selectedDigit === null || selectedDigit === '') {
      return null;
    }

    const campaign = this.repository.getCampaign(call.campaign_id);
    const keypad = campaign?.keypad_actions ?? DEFAULT_KEYPAD_ACTIONS;
    const mapping = keypad[String(selectedDigit)] ?? DEFAULT_KEYPAD_ACTIONS[String(selectedDigit)];
    if (!mapping) return null;

    if (mapping.action === 'not_interested' || mapping.followUpType === null) {
      if (mapping.action === 'not_interested') {
        this.repository.setCampaignLeadOutcome(
          call.campaign_id,
          call.lead_id,
          'not_interested',
        );
      }
      return { action: mapping.action, followUp: null };
    }

    const lead = this.repository.getLead(call.lead_id);
    const followUpType = mapping.followUpType;
    if (!followUpType) {
      return { action: mapping.action, followUp: null };
    }

    const result = this.repository.createFollowUp({
      type: followUpType,
      leadId: call.lead_id,
      campaignId: call.campaign_id,
      callId: call.id,
      recipientEmail: lead?.email ?? null,
      linkPlaceholder:
        followUpType === 'email'
          ? this.config.followUpLinkPlaceholder
          : null,
      notes: mapping.label ?? mapping.action,
      status: 'pending',
    });

    if (mapping.action === 'interested') {
      this.repository.setCampaignLeadOutcome(
        call.campaign_id,
        call.lead_id,
        'interested',
      );
    }

    return {
      action: mapping.action,
      followUp: result.followUp,
      created: result.created,
    };
  }
}
