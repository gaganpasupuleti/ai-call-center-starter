import {
  buildVoicebotCallRequest,
  executeVoicebotCall,
  toRedactedRequestPreview,
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
   * Live outbound calling remains disabled in Phase 3A.
   * Use buildOutboundPreview() / dry-run execution instead.
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
          'SmartPing live calls are disabled. Dry-run preview available via /api/smartping/outbound/preview.',
        ),
        { statusCode: 403, preview: result.preview },
      );
    }

    throw new IntegrationPendingError(
      'SmartPing live voicebot calling is not enabled in Phase 3A.',
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
