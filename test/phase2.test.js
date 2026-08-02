import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repository } from '../src/database.js';
import { MockProvider } from '../src/providers/mock-provider.js';
import { SmartPingProvider } from '../src/providers/smartping-provider.js';
import { createApp } from '../src/app.js';
import { getConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleCsv = readFileSync(
  path.join(__dirname, '..', 'examples', 'leads-sample.csv'),
  'utf8',
);

async function withServer(run, { providerName = 'mock' } = {}) {
  const repository = new Repository(':memory:');
  const config = getConfig({
    publicBaseUrl: 'http://127.0.0.1',
    webhookSecret: 'test-secret',
    providerName,
    exposureMode: 'full',
    followUpLinkPlaceholder: 'https://example.com/register',
    smartPing: {
      dryRun: true,
      liveCallsEnabled: false,
      streamAuthMode: 'disabled',
      streamSharedSecret: '',
      apiToken: '',
    },
  });
  config.exposureMode = 'full';
  config.smartPing.streamAuthMode = 'disabled';
  config.smartPing.liveCallsEnabled = false;
  config.smartPing.dryRun = true;
  const provider =
    providerName === 'smartping'
      ? new SmartPingProvider(config.smartPing)
      : new MockProvider();
  const server = http.createServer(createApp({ repository, provider, config }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, repository, provider });
  } finally {
    server.close();
    await once(server, 'close');
    repository.close();
  }
}

async function request(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

test('manual lead creation and validation', async () => {
  await withServer(async ({ baseUrl }) => {
    const invalid = await request(baseUrl, '/api/leads', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad', phone: '9876543210', consent: true }),
    });
    assert.equal(invalid.response.status, 400);

    const created = await request(baseUrl, '/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Valid Lead',
        phone: '+919900001111',
        email: 'valid@example.com',
        consentStatus: 'granted',
        language: 'en',
        tags: ['demo'],
        source: 'manual',
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.consent_status, 'granted');
    assert.equal(created.body.language, 'en');
    assert.deepEqual(created.body.tags, ['demo']);
  });
});

test('CSV import with valid and invalid rows plus duplicate phones', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await request(baseUrl, '/api/leads/import', {
      method: 'POST',
      body: JSON.stringify({ csv: sampleCsv }),
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.imported, 5);
    assert.equal(first.body.failed, 0);

    const duplicate = await request(baseUrl, '/api/leads/import', {
      method: 'POST',
      body: JSON.stringify({ csv: sampleCsv }),
    });
    assert.equal(duplicate.body.imported, 0);
    assert.equal(duplicate.body.skipped, 5);

    const mixed = await request(baseUrl, '/api/leads/import', {
      method: 'POST',
      body: JSON.stringify({
        csv: `name,phone,email,consent_status
Good Person,+919900002222,good@example.com,granted
Bad Person,not-a-phone,bad@example.com,granted
`,
      }),
    });
    assert.equal(mixed.body.imported, 1);
    assert.equal(mixed.body.failed, 1);
    assert.match(mixed.body.failedRows[0].reason, /E\.164|phone/i);
  });
});

test('consent and do-not-call enforcement with campaign eligibility', async () => {
  await withServer(async ({ baseUrl }) => {
    await request(baseUrl, '/api/leads/import', {
      method: 'POST',
      body: JSON.stringify({ csv: sampleCsv }),
    });
    const leads = await request(baseUrl, '/api/leads');
    const byPhone = Object.fromEntries(leads.body.items.map((lead) => [lead.phone, lead]));

    const campaign = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Eligibility campaign',
        messageText: 'Press 1 if interested',
        leadIds: leads.body.items.map((lead) => lead.id),
      }),
    });
    assert.equal(campaign.response.status, 201);

    const eligibility = await request(
      baseUrl,
      `/api/campaigns/${campaign.body.id}/eligibility`,
    );
    assert.equal(eligibility.body.eligibleCount, 3);
    assert.equal(eligibility.body.excludedCount, 2);
    const excludedPhones = eligibility.body.excluded.map((row) => row.phone).sort();
    assert.deepEqual(excludedPhones, ['+919811110003', '+919811110004']);

    const blocked = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({
        leadId: byPhone['+919811110003'].id,
        campaignId: campaign.body.id,
      }),
    });
    assert.equal(blocked.response.status, 409);

    const dnc = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({
        leadId: byPhone['+919811110004'].id,
        campaignId: campaign.body.id,
      }),
    });
    assert.equal(dnc.response.status, 409);
  });
});

test('campaign start only calls eligible leads and requires confirmation', async () => {
  await withServer(async ({ baseUrl }) => {
    await request(baseUrl, '/api/leads/import', {
      method: 'POST',
      body: JSON.stringify({ csv: sampleCsv }),
    });
    const leads = await request(baseUrl, '/api/leads');
    const campaign = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Start campaign',
        leadIds: leads.body.items.map((lead) => lead.id),
      }),
    });

    const denied = await request(baseUrl, `/api/campaigns/${campaign.body.id}/start`, {
      method: 'POST',
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(denied.response.status, 400);

    const started = await request(baseUrl, `/api/campaigns/${campaign.body.id}/start`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.startedCount, 3);
    assert.equal(started.body.excludedCount, 2);
  });
});

test('DTMF actions create follow-ups once and record not interested', async () => {
  await withServer(async ({ baseUrl }) => {
    const lead = await request(baseUrl, '/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'DTMF Lead',
        phone: '+919900003333',
        email: 'dtmf@example.com',
        consent: true,
      }),
    });
    const campaign = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: 'DTMF campaign',
        leadIds: [lead.body.id],
      }),
    });
    const call = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({
        leadId: lead.body.id,
        campaignId: campaign.body.id,
      }),
    });
    assert.equal(call.response.status, 202);

    const key1 = await request(baseUrl, `/api/mock/calls/${call.body.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        eventId: 'evt-key1',
        status: 'completed',
        selectedDigit: '1',
        durationSeconds: 22,
      }),
    });
    assert.equal(key1.body.followUpCreated, true);
    assert.equal(key1.body.followUp.type, 'email');
    assert.equal(key1.body.followUp.recipient_email, 'dtmf@example.com');

    const duplicate = await request(baseUrl, `/api/mock/calls/${call.body.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        eventId: 'evt-key1',
        status: 'completed',
        selectedDigit: '1',
      }),
    });
    assert.equal(duplicate.body.duplicate, true);

    const followUps = await request(baseUrl, '/api/follow-ups');
    assert.equal(followUps.body.items.filter((item) => item.type === 'email').length, 1);

    const lead2 = await request(baseUrl, '/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Callback Lead',
        phone: '+919900003334',
        email: 'cb@example.com',
        consent: true,
      }),
    });
    const call2 = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({
        leadId: lead2.body.id,
        campaignId: campaign.body.id,
      }),
    });
    const key2 = await request(baseUrl, `/api/mock/calls/${call2.body.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed', selectedDigit: '2' }),
    });
    assert.equal(key2.body.followUp.type, 'callback');

    const lead3 = await request(baseUrl, '/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Not Interested Lead',
        phone: '+919900003335',
        consent: true,
      }),
    });
    const call3 = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({
        leadId: lead3.body.id,
        campaignId: campaign.body.id,
      }),
    });
    await request(baseUrl, `/api/mock/calls/${call3.body.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed', selectedDigit: '3' }),
    });
    const campaignDetails = await request(baseUrl, `/api/campaigns/${campaign.body.id}`);
    const outcomeLead = campaignDetails.body.leads.find((item) => item.id === lead3.body.id);
    assert.equal(outcomeLead.outcome, 'not_interested');

    const lead9 = await request(baseUrl, '/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Agent Lead',
        phone: '+919900003336',
        consent: true,
      }),
    });
    const call9 = await request(baseUrl, '/api/calls/test', {
      method: 'POST',
      body: JSON.stringify({
        leadId: lead9.body.id,
        campaignId: campaign.body.id,
      }),
    });
    const key9 = await request(baseUrl, `/api/mock/calls/${call9.body.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed', selectedDigit: '9' }),
    });
    assert.equal(key9.body.followUp.type, 'human_agent');
  });
});

test('dashboard metrics calculate correctly with empty-safe rates', async () => {
  await withServer(async ({ baseUrl }) => {
    const empty = await request(baseUrl, '/api/dashboard');
    assert.equal(empty.body.callsInitiated, 0);
    assert.equal(empty.body.answerRate, 0);
    assert.equal(empty.body.interestConversionRate, 0);

    await request(baseUrl, '/api/leads/import', {
      method: 'POST',
      body: JSON.stringify({ csv: sampleCsv }),
    });
    const leads = await request(baseUrl, '/api/leads');
    const eligible = leads.body.items.filter(
      (lead) => lead.consent_status === 'granted' && !lead.do_not_call,
    );
    const campaign = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Metrics campaign',
        leadIds: eligible.map((lead) => lead.id),
      }),
    });
    await request(baseUrl, `/api/campaigns/${campaign.body.id}/start`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    const calls = await request(baseUrl, '/api/calls');
    const campaignItems = calls.body.campaignCalls || calls.body.items;
    await request(baseUrl, `/api/mock/calls/${campaignItems[0].id}/events`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed', selectedDigit: '1', durationSeconds: 20 }),
    });
    await request(baseUrl, `/api/mock/calls/${campaignItems[1].id}/events`, {
      method: 'POST',
      body: JSON.stringify({ status: 'no_answer' }),
    });

    const metrics = await request(baseUrl, '/api/dashboard');
    assert.equal(metrics.body.totalLeads, 5);
    assert.equal(metrics.body.consentedLeads, 4);
    assert.equal(metrics.body.callsInitiated, 3);
    assert.equal(metrics.body.interestedLeads, 1);
    assert.equal(metrics.body.failedOrNoAnswer, 1);
    assert.ok(metrics.body.answerRate > 0);
  });
});

test('mock simulation routes are unavailable for non-mock providers', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const result = await request(baseUrl, '/api/mock/calls/does-not-exist/events', {
        method: 'POST',
        body: JSON.stringify({ status: 'completed' }),
      });
      assert.equal(result.response.status, 404);
      assert.match(result.body.error, /disabled/i);
    },
    { providerName: 'smartping' },
  );
});

test('settings API never returns secret values', async () => {
  await withServer(async ({ baseUrl }) => {
    const settings = await request(baseUrl, '/api/settings');
    assert.equal(settings.response.status, 200);
    assert.equal(settings.body.activeProvider, 'mock');
    assert.equal(settings.body.apiTokenConfigured, false);
    assert.equal(settings.body.webhookAuthenticationConfigured, true);
    const serialized = JSON.stringify(settings.body);
    assert.equal(serialized.includes('test-secret'), false);
    assert.equal(serialized.includes('SMARTPING_API_TOKEN'), false);
    assert.equal(typeof settings.body.apiToken, 'undefined');
    assert.equal(typeof settings.body.webhookSecret, 'undefined');
  });
});
