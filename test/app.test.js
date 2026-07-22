import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Repository } from '../src/database.js';
import { MockProvider } from '../src/providers/mock-provider.js';
import { createApp } from '../src/app.js';

async function withServer(run) {
  const repository = new Repository(':memory:');
  const provider = new MockProvider();
  const config = {
    publicBaseUrl: 'http://127.0.0.1',
    webhookSecret: 'test-secret',
    exposureMode: 'full',
    smartPing: {
      dryRun: true,
      liveCallsEnabled: false,
      streamAuthMode: 'disabled',
    },
  };
  const server = http.createServer(createApp({ repository, provider, config }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, repository });
  } finally {
    server.close();
    await once(server, 'close');
    repository.close();
  }
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function createLeadAndCampaign(baseUrl, consent = true) {
  const leadResult = await request(baseUrl, '/api/leads', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Approved Tester',
      phone: '+919876543210',
      email: 'tester@example.com',
      consent,
    }),
  });
  const campaignResult = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      name: 'CodeQuest demo',
      mode: 'ivr',
      messageText: 'Press 1 if interested.',
    }),
  });
  return { lead: leadResult.body, campaign: campaignResult.body };
}

test('completes a mock call and stores the DTMF selection', async () => {
  await withServer(async ({ baseUrl }) => {
    const health = await request(baseUrl, '/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.provider, 'mock');

    const { lead, campaign } = await createLeadAndCampaign(baseUrl);
    const started = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({ leadId: lead.id, campaignId: campaign.id }),
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.status, 'initiated');
    assert.match(started.body.provider_call_id, /^mock-/);

    const completed = await request(
      baseUrl,
      `/api/mock/calls/${started.body.id}/events`,
      {
        method: 'POST',
        body: JSON.stringify({
          status: 'completed',
          selectedDigit: '1',
          durationSeconds: 31,
        }),
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.call.status, 'completed');
    assert.equal(completed.body.call.selected_digit, '1');
    assert.equal(completed.body.call.duration_seconds, 31);

    const history = await request(baseUrl, `/api/calls/${started.body.id}/events`);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].selected_digit, '1');
  });
});

test('does not start a call when consent is missing', async () => {
  await withServer(async ({ baseUrl }) => {
    const { lead, campaign } = await createLeadAndCampaign(baseUrl, false);
    const result = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({ leadId: lead.id, campaignId: campaign.id }),
    });
    assert.equal(result.response.status, 409);
    assert.match(result.body.error, /consent/i);
  });
});

test('authenticates webhooks and ignores duplicate provider events', async () => {
  await withServer(async ({ baseUrl }) => {
    const { lead, campaign } = await createLeadAndCampaign(baseUrl);
    const started = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({ leadId: lead.id, campaignId: campaign.id }),
    });
    const event = {
      eventId: 'provider-event-001',
      providerCallId: started.body.provider_call_id,
      status: 'answered',
    };

    const unauthorized = await request(baseUrl, '/webhooks/providers/mock', {
      method: 'POST',
      body: JSON.stringify(event),
    });
    assert.equal(unauthorized.response.status, 401);

    const first = await request(baseUrl, '/webhooks/providers/mock', {
      method: 'POST',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify(event),
    });
    assert.equal(first.body.duplicate, false);

    const duplicate = await request(baseUrl, '/webhooks/providers/mock', {
      method: 'POST',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify(event),
    });
    assert.equal(duplicate.body.duplicate, true);

    const history = await request(baseUrl, `/api/calls/${started.body.id}/events`);
    assert.equal(history.body.items.length, 1);
  });
});
