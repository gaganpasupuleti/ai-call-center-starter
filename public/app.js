const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  provider: 'mock',
  loading: false,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatPercent(rate) {
  return `${(Number(rate || 0) * 100).toFixed(1)}%`;
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function showNotice(message, type = 'success') {
  const notice = $('#notice');
  notice.hidden = false;
  notice.textContent = message;
  notice.classList.toggle('error', type === 'error');
  notice.classList.toggle('success', type === 'success');
}

function clearNotice() {
  const notice = $('#notice');
  notice.hidden = true;
  notice.textContent = '';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return body;
}

function setActiveNav(route) {
  $$('.nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === route);
  });
}

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
}

function badge(status) {
  const value = String(status ?? 'unknown');
  let kind = '';
  if (['completed', 'granted', 'answered', 'pending'].includes(value)) kind = 'ok';
  if (['paused', 'scheduled', 'busy', 'no_answer'].includes(value)) kind = 'warn';
  if (['failed', 'cancelled', 'denied', 'revoked', 'rejected'].includes(value)) kind = 'danger';
  return `<span class="badge ${kind}">${escapeHtml(value)}</span>`;
}

function emptyState(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function loadingState() {
  return `<div class="loading">Loading…</div>`;
}

async function renderDashboard() {
  const root = $('#page-root');
  root.innerHTML = loadingState();
  const data = await api('/api/dashboard');
  root.innerHTML = `
    <section class="grid-stats">
      <article class="stat-card"><span>Total leads</span><strong>${data.totalLeads}</strong></article>
      <article class="stat-card"><span>Consented leads</span><strong>${data.consentedLeads}</strong></article>
      <article class="stat-card"><span>Active campaigns</span><strong>${data.activeCampaigns}</strong></article>
      <article class="stat-card"><span>Calls initiated</span><strong>${data.callsInitiated}</strong></article>
      <article class="stat-card"><span>Answered calls</span><strong>${data.answeredCalls}</strong><em>Answer rate ${formatPercent(data.answerRate)}</em></article>
      <article class="stat-card"><span>Interested</span><strong>${data.interestedLeads}</strong><em>Conversion ${formatPercent(data.interestConversionRate)}</em></article>
      <article class="stat-card"><span>Callbacks</span><strong>${data.callbackRequests}</strong></article>
      <article class="stat-card"><span>Not interested</span><strong>${data.notInterested}</strong></article>
      <article class="stat-card"><span>Human-agent requests</span><strong>${data.humanAgentRequests}</strong></article>
      <article class="stat-card"><span>Failed / no-answer</span><strong>${data.failedOrNoAnswer}</strong></article>
    </section>

    <section class="split">
      <article class="card">
        <div class="card-header"><div><h3>Recent calls</h3><p>Latest outbound activity</p></div></div>
        ${renderCallsTable(data.recentCalls, { compact: true })}
      </article>
      <article class="card">
        <div class="card-header"><div><h3>Follow-ups needing attention</h3><p>Pending outbox tasks</p></div></div>
        ${renderFollowUpsTable(data.pendingFollowUps, { compact: true })}
      </article>
    </section>

    <article class="card">
      <div class="card-header"><div><h3>Campaign summary</h3><p>Assigned leads and outcome totals</p></div></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Campaign</th><th>Status</th><th>Leads</th><th>Calls</th>
              <th>Answered</th><th>Interested</th><th>Failed</th>
            </tr>
          </thead>
          <tbody>
            ${
              data.campaignSummaries.length === 0
                ? `<tr><td colspan="7" class="empty">No campaigns yet.</td></tr>`
                : data.campaignSummaries
                    .map(
                      (row) => `<tr>
                        <td>${escapeHtml(row.name)}</td>
                        <td>${badge(row.status)}</td>
                        <td>${row.assigned_leads}</td>
                        <td>${row.calls}</td>
                        <td>${row.answered ?? 0}</td>
                        <td>${row.interested ?? 0}</td>
                        <td>${row.failed ?? 0}</td>
                      </tr>`,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function renderCallsTable(calls, { compact = false, mockControls = false } = {}) {
  if (!calls?.length) return emptyState('No calls yet.');
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Lead</th><th>Campaign</th><th>Status</th><th>Key</th><th>Response</th>
            ${compact ? '' : '<th>Duration</th><th>Started</th>'}
            <th>${mockControls ? 'Simulate' : 'Actions'}</th>
          </tr>
        </thead>
        <tbody>
          ${calls
            .map(
              (call) => `<tr>
                <td><strong>${escapeHtml(call.lead_name)}</strong><br><span class="muted">${escapeHtml(call.phone)}</span></td>
                <td>${escapeHtml(call.campaign_name)}</td>
                <td>${badge(call.status)}</td>
                <td>${escapeHtml(call.selected_digit ?? '—')}</td>
                <td>${escapeHtml(call.interpreted_response ?? '—')}</td>
                ${
                  compact
                    ? ''
                    : `<td>${call.duration_seconds ?? '—'}</td><td>${escapeHtml(formatDate(call.started_at || call.created_at))}</td>`
                }
                <td>
                  <div class="actions">
                    <button type="button" class="secondary small" data-view-call="${call.id}">Details</button>
                    ${
                      mockControls && state.provider === 'mock'
                        ? `
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="ringing">Ringing</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="answered">Answered</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="completed" data-digit="1">Key 1</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="completed" data-digit="2">Key 2</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="completed" data-digit="3">Key 3</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="completed" data-digit="9">Key 9</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="busy">Busy</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="no_answer">No answer</button>
                          <button type="button" class="secondary small" data-sim="${call.id}" data-status="failed">Failed</button>
                        `
                        : ''
                    }
                  </div>
                </td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderFollowUpsTable(items, { compact = false } = {}) {
  if (!items?.length) return emptyState('No follow-ups yet.');
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Type</th><th>Lead</th><th>Campaign</th><th>Status</th><th>Created</th>
            ${compact ? '' : '<th>Actions</th>'}
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (item) => `<tr>
                <td>${escapeHtml(item.type)}</td>
                <td>${escapeHtml(item.lead_name)}</td>
                <td>${escapeHtml(item.campaign_name)}</td>
                <td>${badge(item.status)}</td>
                <td>${escapeHtml(formatDate(item.created_at))}</td>
                ${
                  compact
                    ? ''
                    : `<td class="actions">
                        <button type="button" class="secondary small" data-follow-status="${item.id}" data-status="completed">Complete</button>
                        <button type="button" class="secondary small" data-follow-status="${item.id}" data-status="cancelled">Cancel</button>
                      </td>`
                }
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function renderLeads() {
  const root = $('#page-root');
  root.innerHTML = loadingState();
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const search = params.get('search') || '';
  const consentStatus = params.get('consentStatus') || '';
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  if (consentStatus) query.set('consentStatus', consentStatus);
  const leads = await api(`/api/leads?${query}`);
  root.innerHTML = `
    <section class="split">
      <article class="card">
        <div class="card-header"><div><h3>Lead directory</h3><p>Search, filter and manage contacts</p></div></div>
        <form id="lead-filters" class="toolbar">
          <label>Search<input name="search" value="${escapeHtml(search)}" placeholder="Name, phone, email" /></label>
          <label>Consent
            <select name="consentStatus">
              <option value="">All</option>
              ${['pending', 'granted', 'denied', 'revoked']
                .map(
                  (value) =>
                    `<option value="${value}" ${consentStatus === value ? 'selected' : ''}>${value}</option>`,
                )
                .join('')}
            </select>
          </label>
          <button type="submit" class="secondary">Apply</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th><th>Name</th><th>Phone</th><th>Consent</th><th>DNC</th><th>Source</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${
                leads.items.length === 0
                  ? `<tr><td colspan="7" class="empty">No leads found.</td></tr>`
                  : leads.items
                      .map(
                        (lead) => `<tr>
                          <td><input type="checkbox" class="lead-select" value="${lead.id}" /></td>
                          <td><strong>${escapeHtml(lead.name)}</strong><br><span class="muted">${escapeHtml(lead.email || '—')}</span></td>
                          <td class="mono">${escapeHtml(lead.phone)}</td>
                          <td>${badge(lead.consent_status)}</td>
                          <td>${lead.do_not_call ? badge('dnc') : '—'}</td>
                          <td>${escapeHtml(lead.source || '—')}</td>
                          <td class="actions">
                            <button type="button" class="secondary small" data-edit-lead="${lead.id}">Edit</button>
                            <button type="button" class="secondary small" data-view-lead="${lead.id}">View</button>
                          </td>
                        </tr>`,
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </article>

      <div class="page-root">
        <article class="card">
          <div class="card-header"><div><h3>Add lead</h3><p>Manual entry with consent capture</p></div></div>
          <form id="lead-form">
            <div class="form-grid">
              <label>Full name<input name="name" required /></label>
              <label>Phone<input name="phone" placeholder="+919876543210" required /></label>
              <label>Email<input name="email" type="email" /></label>
              <label>Language<input name="language" placeholder="en" /></label>
              <label>Tags<input name="tags" placeholder="demo, student" /></label>
              <label>Source<input name="source" placeholder="manual" /></label>
              <label>Consent
                <select name="consentStatus">
                  <option value="pending">pending</option>
                  <option value="granted">granted</option>
                  <option value="denied">denied</option>
                  <option value="revoked">revoked</option>
                </select>
              </label>
              <label class="checkbox"><input name="doNotCall" type="checkbox" /> Do-Not-Call</label>
              <label class="full">Notes<textarea name="notes" rows="3"></textarea></label>
            </div>
            <button type="submit">Save lead</button>
          </form>
        </article>

        <article class="card">
          <div class="card-header"><div><h3>Import CSV</h3><p>Does not start calls automatically</p></div></div>
          <form id="csv-form">
            <label class="full">CSV content
              <textarea name="csv" rows="8" placeholder="name,phone,email,consent_status,do_not_call,language,tags,source,notes"></textarea>
            </label>
            <button type="submit">Import leads</button>
          </form>
          <p class="muted">Required columns: name, phone. Use E.164 phone numbers.</p>
        </article>
      </div>
    </section>
  `;

  $('#lead-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (form.get('search')) next.set('search', form.get('search'));
    if (form.get('consentStatus')) next.set('consentStatus', form.get('consentStatus'));
    window.location.hash = `#/leads?${next}`;
  });

  $('#lead-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          phone: form.get('phone'),
          email: form.get('email'),
          language: form.get('language'),
          tags: form.get('tags'),
          source: form.get('source') || 'manual',
          consentStatus: form.get('consentStatus'),
          doNotCall: form.get('doNotCall') === 'on',
          notes: form.get('notes'),
        }),
      });
      showNotice('Lead saved.');
      await renderLeads();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  $('#csv-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api('/api/leads/import', {
        method: 'POST',
        body: JSON.stringify({ csv: form.get('csv') }),
      });
      showNotice(
        `Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed.`,
      );
      if (result.failedRows?.length) {
        openModal(
          'Import row errors',
          `<div class="pre">${escapeHtml(JSON.stringify(result.failedRows, null, 2))}</div>
           ${result.skippedRows?.length ? `<div class="pre">${escapeHtml(JSON.stringify(result.skippedRows, null, 2))}</div>` : ''}`,
        );
      }
      await renderLeads();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });
}

async function renderCampaigns() {
  const root = $('#page-root');
  root.innerHTML = loadingState();
  const [campaigns, leads] = await Promise.all([
    api('/api/campaigns'),
    api('/api/leads'),
  ]);
  root.innerHTML = `
    <section class="split">
      <article class="card">
        <div class="card-header"><div><h3>Campaigns</h3><p>Draft, review eligibility, then start mock calls</p></div></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th>Leads</th><th>Language</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${
                campaigns.items.length === 0
                  ? `<tr><td colspan="5" class="empty">No campaigns yet.</td></tr>`
                  : campaigns.items
                      .map(
                        (campaign) => `<tr>
                          <td><strong>${escapeHtml(campaign.name)}</strong><br><span class="muted">${escapeHtml(campaign.description || '')}</span></td>
                          <td>${badge(campaign.status)}</td>
                          <td>${campaign.lead_count ?? 0}</td>
                          <td>${escapeHtml(campaign.default_language || '—')}</td>
                          <td class="actions">
                            <button type="button" class="secondary small" data-view-campaign="${campaign.id}">Open</button>
                            <button type="button" class="secondary small" data-eligibility="${campaign.id}">Eligibility</button>
                            <button type="button" class="small" data-start-campaign="${campaign.id}">Start</button>
                          </td>
                        </tr>`,
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </article>

      <article class="card">
        <div class="card-header"><div><h3>Create campaign</h3><p>Assign leads and customize keypad labels</p></div></div>
        <form id="campaign-form">
          <div class="form-grid">
            <label class="full">Campaign name<input name="name" required /></label>
            <label class="full">Description<textarea name="description" rows="2"></textarea></label>
            <label class="full">Call script<textarea name="messageText" rows="4" placeholder="Press 1 if interested…"></textarea></label>
            <label>Audio reference<input name="audioUrl" placeholder="welcome-ivr.wav" /></label>
            <label>Default language<input name="defaultLanguage" value="en" /></label>
            <label>Scheduled at<input name="scheduledAt" type="datetime-local" /></label>
            <label>Retry count<input name="retryCount" type="number" min="0" value="0" /></label>
            <label>Retry delay (sec)<input name="retryDelaySeconds" type="number" min="0" value="0" /></label>
            <label>Key 1 label<input name="label1" value="Interested" /></label>
            <label>Key 2 label<input name="label2" value="Request a callback" /></label>
            <label>Key 3 label<input name="label3" value="Not interested" /></label>
            <label>Key 9 label<input name="label9" value="Human-agent transfer requested" /></label>
          </div>
          <div>
            <p class="muted">Select leads to assign</p>
            <div class="list-check">
              ${
                leads.items.length === 0
                  ? `<span class="muted">Create leads first.</span>`
                  : leads.items
                      .map(
                        (lead) => `<label>
                          <input type="checkbox" name="leadIds" value="${lead.id}" />
                          <span>${escapeHtml(lead.name)} · ${escapeHtml(lead.phone)} · ${escapeHtml(lead.consent_status)}${lead.do_not_call ? ' · DNC' : ''}</span>
                        </label>`,
                      )
                      .join('')
              }
            </div>
          </div>
          <button type="submit">Save campaign</button>
        </form>
      </article>
    </section>
  `;

  $('#campaign-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const leadIds = form.getAll('leadIds');
    try {
      await api('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          description: form.get('description'),
          messageText: form.get('messageText'),
          audioUrl: form.get('audioUrl'),
          defaultLanguage: form.get('defaultLanguage'),
          scheduledAt: form.get('scheduledAt')
            ? new Date(form.get('scheduledAt')).toISOString()
            : null,
          retryCount: Number(form.get('retryCount') || 0),
          retryDelaySeconds: Number(form.get('retryDelaySeconds') || 0),
          leadIds,
          keypadActions: {
            '1': { label: form.get('label1') },
            '2': { label: form.get('label2') },
            '3': { label: form.get('label3') },
            '9': { label: form.get('label9') },
          },
        }),
      });
      showNotice('Campaign created.');
      await renderCampaigns();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });
}

async function renderCalls() {
  const root = $('#page-root');
  root.innerHTML = loadingState();
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const search = params.get('search') || '';
  const status = params.get('status') || '';
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  const calls = await api(`/api/calls?${query}`);
  root.innerHTML = `
    <article class="card">
      <div class="card-header">
        <div><h3>Call history</h3><p>Searchable outcomes and mock simulation controls</p></div>
      </div>
      <form id="call-filters" class="toolbar">
        <label>Search<input name="search" value="${escapeHtml(search)}" placeholder="Lead, phone, campaign" /></label>
        <label>Status
          <select name="status">
            <option value="">All</option>
            ${['queued', 'initiated', 'ringing', 'answered', 'completed', 'busy', 'no_answer', 'failed']
              .map(
                (value) =>
                  `<option value="${value}" ${status === value ? 'selected' : ''}>${value}</option>`,
              )
              .join('')}
          </select>
        </label>
        <button type="submit" class="secondary">Apply</button>
      </form>
      ${renderCallsTable(calls.items, { mockControls: true })}
    </article>
  `;

  $('#call-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (form.get('search')) next.set('search', form.get('search'));
    if (form.get('status')) next.set('status', form.get('status'));
    window.location.hash = `#/calls?${next}`;
  });
}

async function renderFollowUps() {
  const root = $('#page-root');
  root.innerHTML = loadingState();
  const items = await api('/api/follow-ups');
  root.innerHTML = `
    <article class="card">
      <div class="card-header">
        <div><h3>Follow-up outbox</h3><p>Email, callback and human-agent tasks (no external delivery yet)</p></div>
      </div>
      ${renderFollowUpsTable(items.items)}
    </article>
  `;
}

async function renderSettings() {
  const root = $('#page-root');
  root.innerHTML = loadingState();
  const settings = await api('/api/settings');
  root.innerHTML = `
    <article class="card">
      <div class="card-header"><div><h3>Provider settings</h3><p>Non-secret configuration status only</p></div></div>
      <div class="grid-stats">
        <article class="stat-card"><span>Active provider</span><strong>${escapeHtml(settings.activeProvider)}</strong></article>
        <article class="stat-card"><span>Mode</span><strong>${escapeHtml(settings.mode)}</strong></article>
        <article class="stat-card"><span>Base URL configured</span><strong>${settings.baseUrlConfigured ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>Outbound path configured</span><strong>${settings.outboundPathConfigured ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>API token configured</span><strong>${settings.apiTokenConfigured ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>Webhook auth configured</span><strong>${settings.webhookAuthenticationConfigured ? 'Yes' : 'No'}</strong></article>
      </div>
    </article>
    <article class="card">
      <div class="card-header"><div><h3>SmartPing voice streaming</h3><p>Phase 3A protocol foundation (fail-closed)</p></div></div>
      <div class="grid-stats">
        <article class="stat-card"><span>Streaming configured</span><strong>${settings.streamingConfigured ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>DID configured</span><strong>${settings.didConfigured ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>Public stream URL configured</span><strong>${settings.streamUrlConfigured ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>Dry-run enabled</span><strong>${settings.dryRunEnabled ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>Live calls disabled</span><strong>${settings.liveCallsDisabled ? 'Yes' : 'No'}</strong></article>
        <article class="stat-card"><span>AI provider</span><strong>${escapeHtml(settings.aiProvider)}</strong></article>
      </div>
      <p class="notice">${escapeHtml(settings.smartPingActivationMessage)}</p>
      <p class="muted">Stream path hint: <span class="mono">${escapeHtml(settings.streamPathHint || '')}</span></p>
      <p class="muted">Follow-up link placeholder: <span class="mono">${escapeHtml(settings.followUpLinkPlaceholder)}</span></p>
    </article>
  `;
}

async function showCallDetails(callId) {
  const details = await api(`/api/calls/${callId}`);
  const { call, events, followUps } = details;
  openModal(
    `Call · ${call.lead_name}`,
    `
      <p><strong>Status:</strong> ${badge(call.status)} · <strong>Provider ID:</strong> <span class="mono">${escapeHtml(call.provider_call_id || '—')}</span></p>
      <p><strong>Digit:</strong> ${escapeHtml(call.selected_digit || '—')} · <strong>Response:</strong> ${escapeHtml(call.interpreted_response || '—')}</p>
      <p><strong>Started:</strong> ${escapeHtml(formatDate(call.started_at))} · <strong>Answered:</strong> ${escapeHtml(formatDate(call.answered_at))} · <strong>Completed:</strong> ${escapeHtml(formatDate(call.completed_at))}</p>
      <p><strong>Retry attempt:</strong> ${call.retry_attempt ?? 0} · <strong>Failure:</strong> ${escapeHtml(call.error_message || '—')}</p>
      <h4>Event timeline</h4>
      <div class="timeline">
        ${
          events.length === 0
            ? `<p class="muted">No events yet.</p>`
            : events
                .map(
                  (event) => `<article>
                    <h4>${escapeHtml(event.status || 'event')} ${event.selected_digit ? `· key ${escapeHtml(event.selected_digit)}` : ''}</h4>
                    <p>${escapeHtml(formatDate(event.received_at))}</p>
                    <div class="pre">${escapeHtml(JSON.stringify(event.raw ?? event, null, 2))}</div>
                  </article>`,
                )
                .join('')
        }
      </div>
      <h4>Follow-ups</h4>
      ${
        followUps.length === 0
          ? `<p class="muted">None created for this call.</p>`
          : `<div class="pre">${escapeHtml(JSON.stringify(followUps, null, 2))}</div>`
      }
    `,
  );
}

async function showLeadDetails(leadId, edit = false) {
  const lead = await api(`/api/leads/${leadId}`);
  if (!edit) {
    openModal(
      lead.name,
      `<div class="pre">${escapeHtml(JSON.stringify(lead, null, 2))}</div>`,
    );
    return;
  }
  openModal(
    `Edit · ${lead.name}`,
    `
      <form id="edit-lead-form">
        <div class="form-grid">
          <label>Full name<input name="name" value="${escapeHtml(lead.name)}" required /></label>
          <label>Phone<input name="phone" value="${escapeHtml(lead.phone)}" required /></label>
          <label>Email<input name="email" value="${escapeHtml(lead.email || '')}" /></label>
          <label>Language<input name="language" value="${escapeHtml(lead.language || '')}" /></label>
          <label>Tags<input name="tags" value="${escapeHtml((lead.tags || []).join(', '))}" /></label>
          <label>Source<input name="source" value="${escapeHtml(lead.source || '')}" /></label>
          <label>Consent
            <select name="consentStatus">
              ${['pending', 'granted', 'denied', 'revoked']
                .map(
                  (value) =>
                    `<option value="${value}" ${lead.consent_status === value ? 'selected' : ''}>${value}</option>`,
                )
                .join('')}
            </select>
          </label>
          <label class="checkbox"><input name="doNotCall" type="checkbox" ${lead.do_not_call ? 'checked' : ''} /> Do-Not-Call</label>
          <label class="full">Notes<textarea name="notes" rows="3">${escapeHtml(lead.notes || '')}</textarea></label>
        </div>
        <button type="submit">Update lead</button>
      </form>
    `,
  );
  $('#edit-lead-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/leads/${leadId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.get('name'),
          phone: form.get('phone'),
          email: form.get('email'),
          language: form.get('language'),
          tags: form.get('tags'),
          source: form.get('source'),
          consentStatus: form.get('consentStatus'),
          doNotCall: form.get('doNotCall') === 'on',
          notes: form.get('notes'),
        }),
      });
      $('#modal').close();
      showNotice('Lead updated.');
      await renderLeads();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });
}

async function showCampaignDetails(campaignId) {
  const campaign = await api(`/api/campaigns/${campaignId}`);
  openModal(
    campaign.name,
    `
      <p>${badge(campaign.status)} · ${escapeHtml(campaign.mode)} · retries ${campaign.retry_count}</p>
      <p class="muted">${escapeHtml(campaign.description || 'No description')}</p>
      <p><strong>Script</strong></p>
      <div class="pre">${escapeHtml(campaign.message_text || '—')}</div>
      <p><strong>Keypad actions</strong></p>
      <div class="pre">${escapeHtml(JSON.stringify(campaign.keypad_actions, null, 2))}</div>
      <p><strong>Assigned leads</strong></p>
      <div class="pre">${escapeHtml(
        JSON.stringify(
          campaign.leads.map((lead) => ({
            name: lead.name,
            phone: lead.phone,
            consent: lead.consent_status,
            dnc: lead.do_not_call,
            outcome: lead.outcome,
          })),
          null,
          2,
        ),
      )}</div>
    `,
  );
}

async function showEligibility(campaignId) {
  const preview = await api(`/api/campaigns/${campaignId}/eligibility`);
  openModal(
    'Eligibility preview',
    `
      <p><strong>Eligible:</strong> ${preview.eligibleCount} · <strong>Excluded:</strong> ${preview.excludedCount}</p>
      <h4>Eligible leads</h4>
      <div class="pre">${escapeHtml(JSON.stringify(preview.eligible, null, 2))}</div>
      <h4>Excluded leads</h4>
      <div class="pre">${escapeHtml(JSON.stringify(preview.excluded, null, 2))}</div>
    `,
  );
}

async function startCampaign(campaignId) {
  const preview = await api(`/api/campaigns/${campaignId}/eligibility`);
  const confirmed = window.confirm(
    `Start mock calls for ${preview.eligibleCount} eligible lead(s)?\n` +
      `${preview.excludedCount} lead(s) will be excluded.\n\n` +
      'This will create call records. No real telephone calls are placed in mock mode.',
  );
  if (!confirmed) return;
  const result = await api(`/api/campaigns/${campaignId}/start`, {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
  showNotice(
    `Campaign start accepted: ${result.startedCount} started, ${result.failedCount} failed, ${result.excludedCount} excluded.`,
  );
  openModal(
    'Campaign start result',
    `<div class="pre">${escapeHtml(
      JSON.stringify(
        {
          startedCount: result.startedCount,
          failedCount: result.failedCount,
          excluded: result.excluded,
          failed: result.failed,
        },
        null,
        2,
      ),
    )}</div>`,
  );
}

async function simulateCall(callId, status, selectedDigit = null) {
  await api(`/api/mock/calls/${callId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      status,
      selectedDigit,
      durationSeconds: status === 'completed' ? 30 : undefined,
    }),
  });
  showNotice(
    `Mock event stored: ${status}${selectedDigit ? `, key ${selectedDigit}` : ''}.`,
  );
  await renderRoute();
}

const titles = {
  dashboard: ['Overview', 'Dashboard'],
  leads: ['Contacts', 'Leads'],
  campaigns: ['Outbound', 'Campaigns'],
  calls: ['Activity', 'Calls'],
  'follow-ups': ['Outbox', 'Follow-ups'],
  settings: ['Configuration', 'Provider Settings'],
};

async function renderRoute() {
  clearNotice();
  const hash = window.location.hash || '#/dashboard';
  const route = hash.replace(/^#\//, '').split('?')[0] || 'dashboard';
  const meta = titles[route] || titles.dashboard;
  $('#page-eyebrow').textContent = meta[0];
  $('#page-title').textContent = meta[1];
  setActiveNav(route);

  try {
    state.loading = true;
    if (route === 'dashboard') await renderDashboard();
    else if (route === 'leads') await renderLeads();
    else if (route === 'campaigns') await renderCampaigns();
    else if (route === 'calls') await renderCalls();
    else if (route === 'follow-ups') await renderFollowUps();
    else if (route === 'settings') await renderSettings();
    else await renderDashboard();
  } catch (error) {
    $('#page-root').innerHTML = emptyState(error.message);
    showNotice(error.message, 'error');
  } finally {
    state.loading = false;
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;
  try {
    if (target.dataset.viewCall) await showCallDetails(target.dataset.viewCall);
    if (target.dataset.viewLead) await showLeadDetails(target.dataset.viewLead, false);
    if (target.dataset.editLead) await showLeadDetails(target.dataset.editLead, true);
    if (target.dataset.viewCampaign) await showCampaignDetails(target.dataset.viewCampaign);
    if (target.dataset.eligibility) await showEligibility(target.dataset.eligibility);
    if (target.dataset.startCampaign) await startCampaign(target.dataset.startCampaign);
    if (target.dataset.sim) {
      await simulateCall(
        target.dataset.sim,
        target.dataset.status,
        target.dataset.digit ?? null,
      );
    }
    if (target.dataset.followStatus) {
      await api(`/api/follow-ups/${target.dataset.followStatus}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: target.dataset.status }),
      });
      showNotice(`Follow-up marked ${target.dataset.status}.`);
      await renderFollowUps();
    }
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

$('#refresh-btn').addEventListener('click', () => {
  renderRoute().catch((error) => showNotice(error.message, 'error'));
});

window.addEventListener('hashchange', () => {
  renderRoute().catch((error) => showNotice(error.message, 'error'));
});

async function boot() {
  try {
    const health = await api('/health');
    state.provider = health.provider;
    $('#provider-pill').textContent = `${health.provider.toUpperCase()} provider`;
  } catch {
    $('#provider-pill').textContent = 'Provider unavailable';
  }
  if (!window.location.hash) window.location.hash = '#/dashboard';
  await renderRoute();
}

boot().catch((error) => showNotice(error.message, 'error'));
