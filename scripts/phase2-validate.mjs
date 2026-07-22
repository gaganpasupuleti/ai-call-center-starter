import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:8787';
const report = { checks: [], failures: [] };

function ok(name, detail) {
  report.checks.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  report.checks.push({ name, ok: false, detail });
  report.failures.push({ name, detail });
  console.error(`FAIL  ${name} — ${detail}`);
}

async function req(path, options = {}) {
  const response = await fetch(base + path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body, status: response.status };
}

const stamp = Date.now().toString().slice(-8);
const phones = {
  eligible1: `+91977${stamp}01`,
  eligible2: `+91977${stamp}02`,
  eligible3: `+91977${stamp}03`,
  eligible4: `+91977${stamp}04`,
  noConsent: `+91977${stamp}05`,
  dnc: `+91977${stamp}06`,
};

async function createLead(payload) {
  const { status, body } = await req('/api/leads', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (status !== 201) throw new Error(`lead create failed: ${body.error}`);
  return body;
}

async function main() {
  const health = await req('/health');
  if (health.status !== 200 || health.body.provider !== 'mock') {
    fail('active server', JSON.stringify(health.body));
    process.exit(1);
  }
  ok('active server', `provider=${health.body.provider}`);

  const home = await fetch(base + '/');
  const html = await home.text();
  if (home.status === 200 && html.includes('app-shell') && html.includes('Follow-ups')) {
    ok('dashboard shell', 'nav and shell present');
  } else {
    fail('dashboard shell', `status=${home.status}`);
  }

  const leads = {
    e1: await createLead({
      name: 'Eligible One',
      phone: phones.eligible1,
      email: 'e1@example.com',
      consentStatus: 'granted',
      source: 'validation',
    }),
    e2: await createLead({
      name: 'Eligible Two',
      phone: phones.eligible2,
      email: 'e2@example.com',
      consentStatus: 'granted',
      source: 'validation',
    }),
    e3: await createLead({
      name: 'Eligible Three',
      phone: phones.eligible3,
      email: 'e3@example.com',
      consentStatus: 'granted',
      source: 'validation',
    }),
    e4: await createLead({
      name: 'Eligible Four',
      phone: phones.eligible4,
      email: 'e4@example.com',
      consentStatus: 'granted',
      source: 'validation',
    }),
    pending: await createLead({
      name: 'No Consent',
      phone: phones.noConsent,
      email: 'pending@example.com',
      consentStatus: 'pending',
      source: 'validation',
    }),
    dnc: await createLead({
      name: 'DNC Lead',
      phone: phones.dnc,
      email: 'dnc@example.com',
      consentStatus: 'granted',
      doNotCall: true,
      source: 'validation',
    }),
  };
  ok('lead creation', '4 eligible + 1 pending + 1 DNC');

  const sampleCsv = readFileSync('examples/leads-sample.csv', 'utf8');
  const importOnce = await req('/api/leads/import', {
    method: 'POST',
    body: JSON.stringify({
      csv: `name,phone,email,consent_status,do_not_call\nImport Check,+91977${stamp}99,import@example.com,granted,false\n`,
    }),
  });
  if (importOnce.status === 200 && importOnce.body.imported === 1) {
    ok('csv import', `imported=${importOnce.body.imported}`);
  } else {
    fail('csv import', JSON.stringify(importOnce.body));
  }

  const importDup = await req('/api/leads/import', {
    method: 'POST',
    body: JSON.stringify({
      csv: `name,phone,email,consent_status\nImport Check,+91977${stamp}99,import@example.com,granted\n`,
    }),
  });
  if (importDup.body.skipped === 1 && importDup.body.imported === 0) {
    ok('duplicate phone skip', 'skipped=1');
  } else {
    fail('duplicate phone skip', JSON.stringify(importDup.body));
  }

  // Touch sample file path existence for report completeness.
  if (sampleCsv.includes('name,phone')) ok('sample csv present', 'examples/leads-sample.csv');

  const campaign = await req('/api/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      name: `Phase2 Final Validation ${stamp}`,
      description: 'Remaining Phase 2 validation campaign',
      messageText: 'Press 1 interested, 2 callback, 3 not interested, 9 agent.',
      defaultLanguage: 'en',
      leadIds: Object.values(leads).map((lead) => lead.id),
      keypadActions: {
        '1': { label: 'Interested' },
        '2': { label: 'Request a callback' },
        '3': { label: 'Not interested' },
        '9': { label: 'Human-agent transfer requested' },
      },
    }),
  });
  if (campaign.status !== 201) {
    fail('campaign create', campaign.body.error);
    process.exit(1);
  }
  ok('campaign create', campaign.body.id);

  const eligibility = await req(`/api/campaigns/${campaign.body.id}/eligibility`);
  const excludedPhones = eligibility.body.excluded.map((row) => row.phone).sort();
  if (
    eligibility.body.eligibleCount === 4 &&
    eligibility.body.excludedCount === 2 &&
    excludedPhones.includes(phones.noConsent) &&
    excludedPhones.includes(phones.dnc)
  ) {
    ok(
      'eligibility',
      `eligible=${eligibility.body.eligibleCount} excluded=${eligibility.body.excludedCount}`,
    );
  } else {
    fail('eligibility', JSON.stringify(eligibility.body));
  }

  const noConfirm = await req(`/api/campaigns/${campaign.body.id}/start`, {
    method: 'POST',
    body: JSON.stringify({ confirm: false }),
  });
  if (noConfirm.status === 400) ok('start requires confirmation', '400 without confirm');
  else fail('start requires confirmation', String(noConfirm.status));

  const started = await req(`/api/campaigns/${campaign.body.id}/start`, {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
  if (started.status === 202 && started.body.startedCount === 4 && started.body.excludedCount === 2) {
    ok('campaign start', `started=${started.body.startedCount}`);
  } else {
    fail('campaign start', JSON.stringify(started.body));
  }

  const calls = await req(`/api/calls?campaignId=${campaign.body.id}`);
  const byLead = Object.fromEntries(calls.body.items.map((call) => [call.lead_id, call]));
  const call1 = byLead[leads.e1.id];
  const call2 = byLead[leads.e2.id];
  const call3 = byLead[leads.e3.id];
  const call4 = byLead[leads.e4.id];

  await req(`/api/mock/calls/${call1.id}/events`, {
    method: 'POST',
    body: JSON.stringify({ status: 'ringing' }),
  });
  await req(`/api/mock/calls/${call1.id}/events`, {
    method: 'POST',
    body: JSON.stringify({ status: 'answered' }),
  });

  const key1 = await req(`/api/mock/calls/${call1.id}/events`, {
    method: 'POST',
    body: JSON.stringify({
      eventId: `evt-key1-${stamp}`,
      status: 'completed',
      selectedDigit: '1',
      durationSeconds: 31,
    }),
  });
  if (
    key1.body.call.selected_digit === '1' &&
    key1.body.followUp?.type === 'email' &&
    key1.body.followUpCreated === true
  ) {
    ok('DTMF 1', `email follow-up for ${call1.lead_name}`);
  } else {
    fail('DTMF 1', JSON.stringify(key1.body));
  }

  const duplicate = await req(`/api/mock/calls/${call1.id}/events`, {
    method: 'POST',
    body: JSON.stringify({
      eventId: `evt-key1-${stamp}`,
      status: 'completed',
      selectedDigit: '1',
      durationSeconds: 31,
    }),
  });
  if (duplicate.body.duplicate === true) ok('duplicate mock event', 'duplicate=true');
  else fail('duplicate mock event', JSON.stringify(duplicate.body));

  const webhookDup = await req('/webhooks/providers/mock', {
    method: 'POST',
    headers: { 'x-webhook-secret': 'change-this-before-sharing-a-public-webhook' },
    body: JSON.stringify({
      eventId: `evt-key1-${stamp}`,
      providerCallId: call1.provider_call_id,
      status: 'completed',
      selectedDigit: '1',
    }),
  });
  if (webhookDup.body.duplicate === true) {
    ok('duplicate webhook', 'webhook replay ignored');
  } else {
    fail('duplicate webhook', JSON.stringify(webhookDup.body));
  }

  const key2 = await req(`/api/mock/calls/${call2.id}/events`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed', selectedDigit: '2', durationSeconds: 20 }),
  });
  if (key2.body.followUp?.type === 'callback') ok('DTMF 2', 'callback follow-up');
  else fail('DTMF 2', JSON.stringify(key2.body));

  const key3 = await req(`/api/mock/calls/${call3.id}/events`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed', selectedDigit: '3', durationSeconds: 15 }),
  });
  const campaignDetails = await req(`/api/campaigns/${campaign.body.id}`);
  const outcome = campaignDetails.body.leads.find((lead) => lead.id === leads.e3.id)?.outcome;
  if (key3.body.digitAction === 'not_interested' && outcome === 'not_interested') {
    ok('DTMF 3', 'not_interested recorded');
  } else {
    fail('DTMF 3', `action=${key3.body.digitAction} outcome=${outcome}`);
  }

  const key9 = await req(`/api/mock/calls/${call4.id}/events`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed', selectedDigit: '9', durationSeconds: 25 }),
  });
  if (key9.body.followUp?.type === 'human_agent') ok('DTMF 9', 'human_agent follow-up');
  else fail('DTMF 9', JSON.stringify(key9.body));

  const followUps = await req('/api/follow-ups');
  const forCampaign = followUps.body.items.filter((item) => item.campaign_id === campaign.body.id);
  const emailCount = forCampaign.filter((item) => item.type === 'email').length;
  const callbackCount = forCampaign.filter((item) => item.type === 'callback').length;
  const agentCount = forCampaign.filter((item) => item.type === 'human_agent').length;
  if (emailCount === 1 && callbackCount === 1 && agentCount === 1) {
    ok('follow-up uniqueness', `email=${emailCount} callback=${callbackCount} agent=${agentCount}`);
  } else {
    fail('follow-up uniqueness', JSON.stringify({ emailCount, callbackCount, agentCount }));
  }

  const details = await req(`/api/calls/${call1.id}`);
  if (
    details.body.events?.length >= 3 &&
    details.body.followUps?.some((item) => item.type === 'email') &&
    details.body.events.every((event) => event.raw || event.raw_json)
  ) {
    ok('call detail timeline', `events=${details.body.events.length}`);
  } else {
    fail('call detail timeline', 'missing events/raw/follow-ups');
  }

  const metrics = await req('/api/dashboard');
  const summary = metrics.body.campaignSummaries.find((row) => row.id === campaign.body.id);
  const metricsOk =
    metrics.body.answerRate >= 0 &&
    metrics.body.interestConversionRate >= 0 &&
    Number.isFinite(metrics.body.answerRate) &&
    summary &&
    summary.calls === 4 &&
    summary.interested >= 1 &&
    summary.answered >= 1;
  if (metricsOk) {
    ok(
      'dashboard metrics',
      `campaign calls=${summary.calls} answered=${summary.answered} interested=${summary.interested}`,
    );
  } else {
    fail('dashboard metrics', JSON.stringify({ summary, rates: {
      answerRate: metrics.body.answerRate,
      interestConversionRate: metrics.body.interestConversionRate,
    } }));
  }

  const settings = await req('/api/settings');
  const serialized = JSON.stringify(settings.body);
  const secretLeak =
    serialized.includes('change-this-before-sharing-a-public-webhook') ||
    serialized.includes('SMARTPING_API_TOKEN') ||
    Object.hasOwn(settings.body, 'apiToken') ||
    Object.hasOwn(settings.body, 'webhookSecret');
  if (!secretLeak && settings.body.apiTokenConfigured === false) {
    ok('secret exposure', 'settings returns flags only');
  } else {
    fail('secret exposure', serialized);
  }

  const unauthorized = await req('/webhooks/providers/mock', {
    method: 'POST',
    body: JSON.stringify({
      eventId: 'unauth',
      providerCallId: call1.provider_call_id,
      status: 'answered',
    }),
  });
  if (unauthorized.status === 401) ok('webhook auth', '401 without secret');
  else fail('webhook auth', String(unauthorized.status));

  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/phase2-validation.json', JSON.stringify(report, null, 2));
  console.log(`\n${report.failures.length === 0 ? 'VALIDATION_OK' : 'VALIDATION_FAILED'} (${report.checks.filter((c) => c.ok).length}/${report.checks.length})`);
  if (report.failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
