import {
  buildVoicebotCallRequest,
  executeVoicebotCall,
  executeSingleVoicebotCall,
  toRedactedRequestPreview,
  SmartPingLiveCallsDisabledError,
} from '../streaming/smartping/request-builder.js';

export class IntegrationPendingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrationPendingError';
  }
}

export class SmartPingProvider {
  name = 'smartping';

  constructor(config) {
    this.config = config;
  }

  /**
   * Campaign / bulk outbound remains blocked.
   * Controlled single-call tests use scripts/place-test-call.mjs only.
   */
  async startOutboundCall({ call, lead, campaign, webhookUrl }) {
    const preview = this.buildOutboundPreview({
      phoneNumber: lead.phone,
      customParameters: {
        app_call_id: call.id,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        webhook_url: webhookUrl,
      },
    });

    const result = await executeVoicebotCall(this.config, {
      phoneNumber: lead.phone,
      customParameters: preview.body.channel_vars.custom_parameters,
    });

    if (result.dryRun) {
      throw Object.assign(
        new IntegrationPendingError(
          'SmartPing campaign/bulk live calls are disabled. Use dry-run preview or the single-call CLI after explicit approval.',
        ),
        { statusCode: 403, preview: result.preview },
      );
    }

    throw new IntegrationPendingError(
      'SmartPing campaign/bulk live voicebot calling remains blocked.',
    );
  }

  buildOutboundPreview({ phoneNumber, customParameters = {} }) {
    const request = buildVoicebotCallRequest({
      baseUrl: this.config.baseUrl || 'https://smartping.example',
      outboundPath: this.config.outboundPath,
      apiToken: this.config.apiToken || '',
      phoneNumber,
      didNumber: this.config.didNumber || 'not-configured',
      streamUrl: this.config.streamUrl,
      customParameters,
    });
    return {
      ...request,
      preview: toRedactedRequestPreview(request),
    };
  }

  normalizeWebhook() {
    throw new IntegrationPendingError(
      'SmartPing webhook/CDR mapping is intentionally pending official field documentation.',
    );
  }
}

export { SmartPingLiveCallsDisabledError, executeSingleVoicebotCall };
