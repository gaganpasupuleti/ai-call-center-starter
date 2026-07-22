import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getPublicSettings } from './config.js';
import { FOLLOW_UP_STATUSES } from './constants.js';
import { readJson, sendJson, servePublicFile } from './http.js';
import { CallService } from './services/call-service.js';
import { CampaignService } from './services/campaign-service.js';
import { LeadService } from './services/lead-service.js';
import {
  executeVoicebotCall,
  toRedactedRequestPreview,
  buildVoicebotCallRequest,
} from './streaming/smartping/request-builder.js';
import { safeErrorMessage } from './streaming/redaction.js';
import { authorizeStreamUpgrade } from './streaming/stream-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(__dirname, '..', 'public');

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual ?? '');
  const expectedBuffer = Buffer.from(expected ?? '');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`${name} is required`), { statusCode: 400 });
  }
  return value.trim();
}

export function createApp({ repository, provider, config, sessionManager = null }) {
  const callService = new CallService({ repository, provider, config });
  const leadService = new LeadService({ repository });
  const campaignService = new CampaignService({ repository, callService });
  const secrets = [
    config.smartPing?.apiToken,
    config.smartPing?.streamSharedSecret,
    config.webhookSecret,
  ].filter(Boolean);

  return async function app(request, response) {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader(
      'access-control-allow-headers',
      'content-type, x-webhook-secret, authorization',
    );
    response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (request.method === 'GET' && pathname === '/healthz') {
        return sendJson(response, 200, {
          status: 'ok',
          service: 'smartping-voice-stream',
          liveCallsEnabled: false,
        });
      }

      const streamCommandMatchEarly = pathname.match(
        /^\/api\/streams\/([^/]+)\/commands$/,
      );
      const isAuthenticatedStreamCommand =
        request.method === 'POST' &&
        streamCommandMatchEarly &&
        config.exposureMode === 'stream-only' &&
        config.smartPing?.streamAuthMode === 'required' &&
        authorizeStreamUpgrade(request, config.smartPing).ok;

      if (config.exposureMode === 'stream-only' && !isAuthenticatedStreamCommand) {
        return sendJson(response, 404, { error: 'Not found' });
      }

      if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return servePublicFile(response, publicDirectory, 'index.html');
      }
      if (request.method === 'GET' && pathname === '/styles.css') {
        return servePublicFile(response, publicDirectory, 'styles.css');
      }
      if (request.method === 'GET' && pathname === '/app.js') {
        return servePublicFile(response, publicDirectory, 'app.js');
      }

      if (request.method === 'GET' && pathname === '/health') {
        return sendJson(response, 200, {
          ok: true,
          provider: provider.name,
          timestamp: new Date().toISOString(),
        });
      }

      if (request.method === 'GET' && pathname === '/api/summary') {
        return sendJson(response, 200, repository.getSummary());
      }

      if (request.method === 'GET' && pathname === '/api/dashboard') {
        return sendJson(response, 200, repository.getDashboardMetrics());
      }

      if (request.method === 'GET' && pathname === '/api/settings') {
        return sendJson(response, 200, getPublicSettings(config, provider.name));
      }

      if (request.method === 'GET' && pathname === '/api/streams') {
        const active = sessionManager?.list() ?? [];
        const stored = repository.listVoiceStreams();
        return sendJson(response, 200, { active, items: stored });
      }

      const streamCommandMatch = pathname.match(/^\/api\/streams\/([^/]+)\/commands$/);
      if (request.method === 'POST' && streamCommandMatch) {
        if (!sessionManager) {
          return sendJson(response, 503, { error: 'Streaming is unavailable' });
        }
        const session = sessionManager.get(streamCommandMatch[1]);
        if (!session) {
          return sendJson(response, 404, { error: 'Active stream not found' });
        }
        const body = await readJson(request);
        const command = requiredString(body.command, 'command');
        let result = null;
        switch (command) {
          case 'clear':
            result = { dropped: sessionManager.clearAudio(session) };
            break;
          case 'hangup':
            result = { sent: sessionManager.hangupCall(session) };
            break;
          case 'mark':
            result = {
              sent: sessionManager.sendMark(session, body.name || 'local-mark'),
            };
            break;
          case 'transfer_queue':
            result = {
              sent: sessionManager.transferToQueue(
                session,
                requiredString(body.queue || 'support', 'queue'),
              ),
            };
            break;
          case 'transfer_external':
            result = {
              sent: sessionManager.transferToExternalNumber(
                session,
                requiredString(body.phoneNumber ?? body.phone_number, 'phoneNumber'),
              ),
            };
            break;
          default:
            throw Object.assign(new Error('Unsupported stream command'), {
              statusCode: 400,
            });
        }
        return sendJson(response, 200, { ok: true, command, result });
      }

      const streamMatch = pathname.match(/^\/api\/streams\/([^/]+)$/);
      if (request.method === 'GET' && streamMatch) {
        const stream = repository.getVoiceStream(streamMatch[1]);
        if (!stream) return sendJson(response, 404, { error: 'Stream not found' });
        return sendJson(response, 200, {
          stream,
          events: repository.listVoiceStreamEvents(stream.stream_sid),
          active: sessionManager?.get(stream.stream_sid)
            ? sessionManager.list().find((item) => item.streamSid === stream.stream_sid)
            : null,
        });
      }

      if (request.method === 'POST' && pathname === '/api/smartping/outbound/preview') {
        const body = await readJson(request);
        const built = buildVoicebotCallRequest({
          baseUrl: config.smartPing.baseUrl || 'https://smartping.example',
          outboundPath: config.smartPing.outboundPath,
          apiToken: config.smartPing.apiToken || 'not-configured',
          phoneNumber: requiredString(body.phoneNumber ?? body.phone_number, 'phoneNumber'),
          didNumber:
            body.didNumber ??
            body.did_number ??
            config.smartPing.didNumber ??
            'not-configured',
          streamUrl:
            body.streamUrl ?? body.url ?? config.smartPing.streamUrl,
          customParameters:
            body.customParameters ?? body.channel_vars?.custom_parameters ?? {},
        });
        const executed = await executeVoicebotCall(
          { ...config.smartPing, dryRun: true, liveCallsEnabled: false },
          {
            phoneNumber: built.body.phone_number,
            didNumber: built.body.did_number,
            streamUrl: built.body.url,
            customParameters: built.body.channel_vars.custom_parameters,
            fetchImpl: async () => {
              throw new Error('Network fetch must not run during dry-run preview');
            },
          },
        );
        return sendJson(response, 200, {
          ...executed,
          preview: executed.preview ?? toRedactedRequestPreview(built),
        });
      }

      if (request.method === 'GET' && pathname === '/api/leads') {
        return sendJson(
          response,
          200,
          {
            items: repository.listLeads({
              search: url.searchParams.get('search') ?? '',
              consentStatus: url.searchParams.get('consentStatus') ?? '',
              doNotCall: url.searchParams.get('doNotCall') ?? '',
              tag: url.searchParams.get('tag') ?? '',
            }),
          },
        );
      }

      if (request.method === 'POST' && pathname === '/api/leads/import') {
        const body = await readJson(request);
        const csv = body.csv ?? body.content ?? '';
        return sendJson(response, 200, leadService.importCsv(csv));
      }

      if (request.method === 'POST' && pathname === '/api/leads') {
        const body = await readJson(request);
        const lead = leadService.createLead(body);
        return sendJson(response, 201, lead);
      }

      const leadMatch = pathname.match(/^\/api\/leads\/([^/]+)$/);
      if (leadMatch) {
        const leadId = leadMatch[1];
        if (request.method === 'GET') {
          const lead = repository.getLead(leadId);
          if (!lead) return sendJson(response, 404, { error: 'Lead not found' });
          return sendJson(response, 200, lead);
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          const lead = leadService.updateLead(leadId, body);
          return sendJson(response, 200, lead);
        }
      }

      if (request.method === 'GET' && pathname === '/api/campaigns') {
        return sendJson(response, 200, { items: repository.listCampaigns() });
      }

      if (request.method === 'POST' && pathname === '/api/campaigns') {
        const body = await readJson(request);
        const campaign = campaignService.createCampaign(body);
        return sendJson(response, 201, campaign);
      }

      const campaignMatch = pathname.match(/^\/api\/campaigns\/([^/]+)$/);
      if (campaignMatch) {
        const campaignId = campaignMatch[1];
        if (request.method === 'GET') {
          const campaign = repository.getCampaign(campaignId);
          if (!campaign) {
            return sendJson(response, 404, { error: 'Campaign not found' });
          }
          return sendJson(response, 200, campaign);
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          const campaign = campaignService.updateCampaign(campaignId, body);
          return sendJson(response, 200, campaign);
        }
      }

      const campaignAssignMatch = pathname.match(
        /^\/api\/campaigns\/([^/]+)\/leads$/,
      );
      if (request.method === 'POST' && campaignAssignMatch) {
        const body = await readJson(request);
        const campaign = campaignService.assignLeads(
          campaignAssignMatch[1],
          body.leadIds,
        );
        return sendJson(response, 200, campaign);
      }

      const campaignEligibilityMatch = pathname.match(
        /^\/api\/campaigns\/([^/]+)\/eligibility$/,
      );
      if (request.method === 'GET' && campaignEligibilityMatch) {
        return sendJson(
          response,
          200,
          campaignService.evaluateEligibility(campaignEligibilityMatch[1]),
        );
      }

      const campaignStartMatch = pathname.match(
        /^\/api\/campaigns\/([^/]+)\/start$/,
      );
      if (request.method === 'POST' && campaignStartMatch) {
        const body = await readJson(request);
        const result = await campaignService.startCampaign(campaignStartMatch[1], {
          confirm: body.confirm === true,
        });
        return sendJson(response, 202, result);
      }

      if (request.method === 'GET' && pathname === '/api/calls') {
        return sendJson(response, 200, {
          items: repository.listCalls({
            search: url.searchParams.get('search') ?? '',
            status: url.searchParams.get('status') ?? '',
            campaignId: url.searchParams.get('campaignId') ?? '',
            digit: url.searchParams.get('digit') ?? '',
          }),
        });
      }

      if (request.method === 'POST' && pathname === '/api/calls/test') {
        const body = await readJson(request);
        const call = await callService.startTestCall({
          leadId: requiredString(body.leadId, 'leadId'),
          campaignId: requiredString(body.campaignId, 'campaignId'),
        });
        return sendJson(response, 202, call);
      }

      const callDetailMatch = pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (request.method === 'GET' && callDetailMatch) {
        const call = repository.getCall(callDetailMatch[1]);
        if (!call) return sendJson(response, 404, { error: 'Call not found' });
        const events = repository.listCallEvents(call.id);
        const followUps = repository
          .listFollowUps()
          .filter((item) => item.call_id === call.id);
        return sendJson(response, 200, { call, events, followUps });
      }

      const eventHistoryMatch = pathname.match(/^\/api\/calls\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventHistoryMatch) {
        const call = repository.getCall(eventHistoryMatch[1]);
        if (!call) {
          return sendJson(response, 404, { error: 'Call not found' });
        }
        return sendJson(response, 200, {
          call,
          items: repository.listCallEvents(call.id),
        });
      }

      if (request.method === 'GET' && pathname === '/api/follow-ups') {
        return sendJson(response, 200, {
          items: repository.listFollowUps({
            status: url.searchParams.get('status') ?? '',
            type: url.searchParams.get('type') ?? '',
          }),
        });
      }

      const followUpMatch = pathname.match(/^\/api\/follow-ups\/([^/]+)$/);
      if (request.method === 'PATCH' && followUpMatch) {
        const body = await readJson(request);
        const status = requiredString(body.status, 'status');
        if (!FOLLOW_UP_STATUSES.includes(status)) {
          throw Object.assign(new Error('status is invalid'), { statusCode: 400 });
        }
        const followUp = repository.updateFollowUpStatus(followUpMatch[1], status);
        if (!followUp) {
          return sendJson(response, 404, { error: 'Follow-up not found' });
        }
        return sendJson(response, 200, followUp);
      }

      const mockEventMatch = pathname.match(/^\/api\/mock\/calls\/([^/]+)\/events$/);
      if (request.method === 'POST' && mockEventMatch) {
        if (provider.name !== 'mock') {
          return sendJson(response, 404, { error: 'Mock simulation is disabled' });
        }
        const call = repository.getCall(mockEventMatch[1]);
        if (!call) return sendJson(response, 404, { error: 'Call not found' });
        const body = await readJson(request);
        const event = provider.normalizeWebhook({
          eventId: body.eventId ?? randomUUID(),
          providerCallId: call.provider_call_id,
          status: requiredString(body.status, 'status'),
          selectedDigit: body.selectedDigit,
          durationSeconds: body.durationSeconds,
          recordingUrl: body.recordingUrl,
        });
        return sendJson(response, 200, callService.processProviderEvent(event));
      }

      const webhookMatch = pathname.match(/^\/webhooks\/providers\/([^/]+)$/);
      if (request.method === 'POST' && webhookMatch) {
        if (webhookMatch[1] !== provider.name) {
          return sendJson(response, 404, { error: 'Provider is not active' });
        }
        if (!secretsMatch(request.headers['x-webhook-secret'], config.webhookSecret)) {
          return sendJson(response, 401, { error: 'Invalid webhook secret' });
        }
        const body = await readJson(request);
        const event = provider.normalizeWebhook(body, request.headers);
        return sendJson(response, 200, callService.processProviderEvent(event));
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const statusCode = error.statusCode ?? 500;
      return sendJson(response, statusCode, {
        error: safeErrorMessage(error, secrets),
        ...(error.callId ? { callId: error.callId } : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}
