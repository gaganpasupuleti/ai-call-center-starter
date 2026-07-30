const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  provider: 'mock',
  loading: false,
  callStation: {
    pollTimer: null,
    connection: 'offline',
    seenLogKeys: new Set(),
    filters: {
      from: '',
      to: '',
      status: '',
      outcome: '',
      websocket: '',
      webhook: '',
      q: '',
    },
    lastItems: [],
  },
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
  $$('.pill-track a').forEach((link) => {
    const active = link.dataset.route === route;
    link.classList.toggle('active', active);
    link.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const select = $('#nav-select');
  if (select && select.value !== route) select.value = route;
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
  const live = data.liveCallStation;
  root.innerHTML = `
    ${
      live
        ? `<section class="grid-stats">
            <article class="stat-card"><span>Live dials (DB)</span><strong>${live.totalTestCalls ?? 0}</strong></article>
            <article class="stat-card"><span>Answered / streaming</span><strong>${live.answered ?? 0}</strong></article>
            <article class="stat-card"><span>Completed</span><strong>${live.completed ?? 0}</strong></article>
            <article class="stat-card"><span>Avg duration</span><strong>${live.averageCallDurationSeconds ?? '—'}s</strong></article>
          </section>`
        : ''
    }
    <section class="grid-stats">
      <article class="stat-card"><span>Total leads</span><strong>${data.totalLeads}</strong></article>
      <article class="stat-card"><span>Consented leads</span><strong>${data.consentedLeads}</strong></article>
      <article class="stat-card"><span>Active campaigns</span><strong>${data.activeCampaigns}</strong></article>
      <article class="stat-card"><span>Campaign calls</span><strong>${data.callsInitiated}</strong></article>
      <article class="stat-card"><span>Answered calls</span><strong>${data.answeredCalls}</strong><em>Answer rate ${formatPercent(data.answerRate)}</em></article>
      <article class="stat-card"><span>Interested</span><strong>${data.interestedLeads}</strong><em>Conversion ${formatPercent(data.interestConversionRate)}</em></article>
      <article class="stat-card"><span>Callbacks</span><strong>${data.callbackRequests}</strong></article>
      <article class="stat-card"><span>Not interested</span><strong>${data.notInterested}</strong></article>
      <article class="stat-card"><span>Human-agent requests</span><strong>${data.humanAgentRequests}</strong></article>
      <article class="stat-card"><span>Failed / no-answer</span><strong>${data.failedOrNoAnswer}</strong></article>
    </section>

    <section class="split">
      <article class="card">
        <div class="card-header"><div><h3>Recent calls</h3><p>Live dialer + stream activity from SQLite</p></div>
          <a class="admin-btn ghost" href="#/call-station">Open Call Station</a>
        </div>
        ${renderRecentLiveCallsTable(data.recentCalls)}
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

function renderRecentLiveCallsTable(calls) {
  if (!calls?.length) return emptyState('No live calls logged yet. Place a call from Outbound.');
  const isStation = calls.some((c) => c.source === 'call-station' || c.stationRef);
  if (!isStation) return renderCallsTable(calls, { compact: true });
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ref</th><th>Destination</th><th>Source</th><th>Status</th><th>Note</th><th>When</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${calls
            .map(
              (call) => `<tr>
                <td class="mono">${escapeHtml(call.stationRef || call.id)}</td>
                <td>${escapeHtml(call.phone || call.lead_name || '—')}</td>
                <td>${escapeHtml(call.campaign_name || '—')}</td>
                <td>${badge(call.status)}</td>
                <td>${escapeHtml(call.interpreted_response || '—')}</td>
                <td>${escapeHtml(formatDate(call.started_at || call.created_at))}</td>
                <td><a class="admin-btn ghost" href="#/call-station">View</a></td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
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
  const [calls, live] = await Promise.all([
    api(`/api/calls?${query}`),
    api('/api/call-station/calls').catch(() => ({ items: [] })),
  ]);
  const liveMapped = (live.items || []).slice(0, 50).map((item) => ({
    id: item.id,
    lead_name: item.destinationMasked || 'Live stream',
    phone: item.destinationMasked || '—',
    campaign_name: String(item.id || '').startsWith('OB-')
      ? 'Outbound dialer'
      : 'Voice stream',
    status: String(item.status || 'unknown').toLowerCase(),
    selected_digit: null,
    interpreted_response:
      item.durationSeconds != null
        ? `${item.durationSeconds}s audio`
        : item.timeline?.[item.timeline.length - 1]?.event || '—',
    duration_seconds: item.durationSeconds,
    started_at: item.requestedAt || item.initiatedAt || item.answeredAt || null,
    created_at: item.requestedAt || item.initiatedAt || item.answeredAt || null,
    stationRef: item.id,
    source: 'call-station',
  }));
  root.innerHTML = `
    <article class="card">
      <div class="card-header">
        <div><h3>Live dial & stream log</h3><p>Real SmartPing activity from SQLite</p></div>
        <a class="admin-btn ghost" href="#/call-station">Call Station</a>
      </div>
      ${renderRecentLiveCallsTable(liveMapped)}
    </article>
    <article class="card">
      <div class="card-header">
        <div><h3>Campaign call history</h3><p>Mock / campaign outcomes</p></div>
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

function stopCallStationPolling() {
  if (state.callStation.pollTimer) {
    clearInterval(state.callStation.pollTimer);
    state.callStation.pollTimer = null;
  }
}

function setCallStationConnection(status) {
  state.callStation.connection = status;
  const pill = $('#station-live-pill');
  if (!pill) return;
  pill.className = `live-pill ${status}`;
  pill.textContent =
    status === 'live'
      ? 'Live'
      : status === 'reconnecting'
        ? 'Reconnecting'
        : 'Offline';
}

function stationDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
    return '—';
  }
  const n = Number(seconds);
  if (n < 60) return `${n.toFixed(1)}s`;
  const mins = Math.floor(n / 60);
  const secs = (n % 60).toFixed(0);
  return `${mins}m ${secs}s`;
}

function stationStatusBadge(status) {
  const value = String(status ?? 'Unknown');
  const lower = value.toLowerCase();
  let kind = '';
  if (['completed', 'answered', 'streaming'].includes(lower)) kind = 'ok';
  if (['ringing', 'initiated', 'requested'].includes(lower)) kind = 'warn';
  if (['failed', 'rejected'].includes(lower)) kind = 'danger';
  return `<span class="badge ${kind}">${escapeHtml(value)}</span>`;
}

function readStationFiltersFromDom() {
  const root = $('#page-root');
  if (!root) return state.callStation.filters;
  const get = (id) => $(`#${id}`, root)?.value ?? '';
  state.callStation.filters = {
    from: get('station-from'),
    to: get('station-to'),
    status: get('station-status'),
    outcome: get('station-outcome'),
    websocket: get('station-websocket'),
    webhook: get('station-webhook'),
    q: get('station-q'),
  };
  return state.callStation.filters;
}

function stationQueryString(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function renderStationSkeleton() {
  return `
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  `;
}

function appendStationActivity(message) {
  const log = $('#station-activity-log');
  if (!log) return;
  const key = `${message}`;
  if (state.callStation.seenLogKeys.has(key)) return;
  state.callStation.seenLogKeys.add(key);
  const item = document.createElement('div');
  item.className = 'muted';
  item.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  log.prepend(item);
  while (log.children.length > 40) log.lastChild.remove();
}

function renderStationCallsTable(items) {
  if (!items || items.length === 0) {
    return `<div class="empty">No monitored test calls yet.</div>`;
  }
  return `
    <div class="table-wrap">
      <table class="station-table">
        <thead>
          <tr>
            <th>Call ref</th>
            <th>Destination</th>
            <th>DID</th>
            <th>Started</th>
            <th>Answered</th>
            <th>Ended</th>
            <th>Duration</th>
            <th>Status</th>
            <th>Audio</th>
            <th>WebSocket</th>
            <th>Webhook</th>
            <th>Keypad</th>
            <th>Failure</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (row) => `<tr class="station-row" data-station-id="${escapeHtml(row.id)}" tabindex="0" role="button">
                <td class="mono">${escapeHtml(row.id)}</td>
                <td>${escapeHtml(row.destinationMasked ?? '—')}</td>
                <td>${escapeHtml(row.didMasked ?? '—')}</td>
                <td>${escapeHtml(formatDate(row.requestedAt || row.initiatedAt || row.streamingAt))}</td>
                <td>${escapeHtml(formatDate(row.answeredAt))}</td>
                <td>${escapeHtml(formatDate(row.endedAt))}</td>
                <td>${escapeHtml(stationDuration(row.durationSeconds))}</td>
                <td>${stationStatusBadge(row.status)}</td>
                <td>${escapeHtml(row.audio?.status ?? 'Unknown')}</td>
                <td>${escapeHtml(row.websocket?.result ?? 'unknown')}</td>
                <td>${escapeHtml(row.webhook?.result ?? 'missing')}</td>
                <td>${escapeHtml(row.keypadOption ?? 'Not supported')}</td>
                <td>${escapeHtml(row.failureReason ?? '—')}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function timelineDelta(prevTs, ts) {
  if (!prevTs || !ts) return '';
  const ms = Date.parse(ts) - Date.parse(prevTs);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return `<span class="station-delta">+${(ms / 1000).toFixed(3)}s</span>`;
}

async function showStationCallDetails(id) {
  const call = await api(`/api/call-station/calls/${encodeURIComponent(id)}`);
  const timeline = Array.isArray(call.timeline) ? call.timeline : [];
  openModal(
    `Call ${call.id}`,
    `
      <div class="station-drawer-meta">
        <div><span>Status</span><br>${stationStatusBadge(call.status)}</div>
        <div><span>Duration</span><br>${escapeHtml(stationDuration(call.durationSeconds))}</div>
        <div><span>Destination</span><br>${escapeHtml(call.destinationMasked ?? '—')}</div>
        <div><span>DID</span><br>${escapeHtml(call.didMasked ?? '—')}</div>
        <div><span>WebSocket</span><br>${escapeHtml(call.websocket?.result ?? 'unknown')} ${call.websocket?.closeCode != null ? `(${escapeHtml(call.websocket.closeCode)})` : ''}</div>
        <div><span>Webhook</span><br>${escapeHtml(call.webhook?.result ?? 'missing')}</div>
        <div><span>Audio</span><br>${escapeHtml(call.audio?.status ?? 'Unknown')}</div>
        <div><span>Keypad</span><br>${escapeHtml(call.keypadOption ?? 'Not supported')}</div>
      </div>
      <h4>Event timeline</h4>
      <div class="timeline">
        ${
          timeline.length === 0
            ? `<p class="muted">No timeline events recorded.</p>`
            : timeline
                .map((item, index) => {
                  const prev = timeline[index - 1];
                  return `<article>
                    <h4>${escapeHtml(item.event)}${timelineDelta(prev?.ts, item.ts)}</h4>
                    <p>${escapeHtml(formatDate(item.ts))}${item.detail ? ` · ${escapeHtml(item.detail)}` : ''}</p>
                  </article>`;
                })
                .join('')
        }
      </div>
    `,
  );
}

async function refreshCallStationData({ quiet = false } = {}) {
  const filters = readStationFiltersFromDom();
  setCallStationConnection('reconnecting');
  try {
    const [summary, health, calls] = await Promise.all([
      api('/api/call-station/summary'),
      api('/api/call-station/health'),
      api(`/api/call-station/calls${stationQueryString(filters)}`),
    ]);
    setCallStationConnection('live');
    state.callStation.lastItems = calls.items ?? [];

    const setStat = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };
    setStat('#stat-total', summary.totalTestCalls ?? 0);
    setStat('#stat-ringing', summary.ringing ?? 0);
    setStat('#stat-answered', summary.answered ?? 0);
    setStat('#stat-completed', summary.completed ?? 0);
    setStat('#stat-failed', summary.failed ?? 0);
    setStat(
      '#stat-avg-duration',
      summary.averageCallDurationSeconds == null
        ? '—'
        : stationDuration(summary.averageCallDurationSeconds),
    );
    setStat('#stat-active-ws', summary.activeWebSocketSessions ?? 0);
    setStat(
      '#stat-webhook-rate',
      summary.webhookSuccessRate == null
        ? '—'
        : formatPercent(summary.webhookSuccessRate),
    );

    const tableHost = $('#station-table-host');
    if (tableHost) tableHost.innerHTML = renderStationCallsTable(calls.items ?? []);

    const gateHost = $('#station-gate-host');
    if (gateHost) {
      gateHost.innerHTML = `
        <div class="gate-item"><span>Destination</span><strong>${escapeHtml(health.destinationMasked || 'Not configured')}</strong></div>
        <div class="gate-item"><span>Playback mode</span><strong>${escapeHtml(health.playbackMode || '—')}</strong></div>
        <div class="gate-item"><span>Dry-run</span><strong>${health.dryRun ? 'On' : 'Off'}</strong></div>
        <div class="gate-item"><span>Live-calls gate</span><strong>${health.liveCallsEnabled ? 'Enabled' : 'Disabled'}</strong></div>
        <div class="gate-item"><span>Single-call gate</span><strong>${health.singleCallEnabled ? 'Enabled' : 'Disabled'}</strong></div>
        <div class="gate-item"><span>Stream URL</span><strong>${health.streamUrlConfigured ? 'Configured' : 'Missing'}</strong></div>
        <div class="gate-item"><span>Audio readiness</span><strong>${health.audio?.ready ? `Ready (${health.audio.durationSeconds}s)` : `Not ready (${health.audio?.error || 'unknown'})`}</strong></div>
      `;
    }

    appendStationActivity(
      `Polled ${calls.items?.length ?? 0} call(s); active WS ${summary.activeWebSocketSessions ?? 0}`,
    );
    return true;
  } catch (error) {
    setCallStationConnection('offline');
    if (!quiet) showNotice(error.message, 'error');
    appendStationActivity(`Poll failed: ${error.message}`);
    const tableHost = $('#station-table-host');
    if (tableHost && !state.callStation.lastItems.length) {
      tableHost.innerHTML = emptyState(error.message);
    }
    return false;
  }
}

function startCallStationPolling() {
  stopCallStationPolling();
  state.callStation.pollTimer = setInterval(() => {
    if (document.hidden) return;
    const route = (window.location.hash || '').replace(/^#\//, '').split('?')[0];
    if (route !== 'call-station') {
      stopCallStationPolling();
      return;
    }
    refreshCallStationData({ quiet: true }).catch(() => {});
  }, 5000);
}

async function renderCallStation() {
  stopCallStationPolling();
  state.callStation.seenLogKeys = new Set();
  const f = state.callStation.filters;
  const root = $('#page-root');
  root.innerHTML = `
    <div class="toolbar" style="justify-content:space-between">
      <div>
        <p class="muted" style="margin:0">Privacy-safe Stage 1 stream monitoring. Polls every 5s while this tab is visible.</p>
      </div>
      <span id="station-live-pill" class="live-pill offline">Offline</span>
    </div>

    <section class="grid-stats station-stats">
      <article class="stat-card"><span>Total test calls</span><strong id="stat-total">—</strong></article>
      <article class="stat-card"><span>Ringing</span><strong id="stat-ringing">—</strong></article>
      <article class="stat-card"><span>Answered</span><strong id="stat-answered">—</strong></article>
      <article class="stat-card"><span>Completed</span><strong id="stat-completed">—</strong></article>
      <article class="stat-card"><span>Failed</span><strong id="stat-failed">—</strong></article>
      <article class="stat-card"><span>Avg duration</span><strong id="stat-avg-duration">—</strong></article>
      <article class="stat-card"><span>Active WebSocket sessions</span><strong id="stat-active-ws">—</strong></article>
      <article class="stat-card"><span>Webhook success rate</span><strong id="stat-webhook-rate">—</strong></article>
    </section>

    <article class="card">
      <div class="card-header"><div><h3>Filters</h3><p>Date range, status, and sanitized call reference</p></div></div>
      <div class="station-filters">
        <label>From<input id="station-from" type="datetime-local" value="${escapeHtml(f.from)}" /></label>
        <label>To<input id="station-to" type="datetime-local" value="${escapeHtml(f.to)}" /></label>
        <label>Status
          <select id="station-status">
            <option value="">Any</option>
            ${['requested','initiated','ringing','answered','streaming','completed','failed','rejected','unknown']
              .map(
                (s) =>
                  `<option value="${s}" ${f.status === s ? 'selected' : ''}>${s}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label>Outcome
          <select id="station-outcome">
            <option value="">Any</option>
            <option value="completed" ${f.outcome === 'completed' ? 'selected' : ''}>Completed</option>
            <option value="failed" ${f.outcome === 'failed' ? 'selected' : ''}>Failed</option>
          </select>
        </label>
        <label>WebSocket
          <select id="station-websocket">
            <option value="">Any</option>
            <option value="accepted" ${f.websocket === 'accepted' ? 'selected' : ''}>Accepted</option>
            <option value="rejected" ${f.websocket === 'rejected' ? 'selected' : ''}>Rejected</option>
          </select>
        </label>
        <label>Webhook
          <select id="station-webhook">
            <option value="">Any</option>
            <option value="received" ${f.webhook === 'received' ? 'selected' : ''}>Received</option>
            <option value="missing" ${f.webhook === 'missing' ? 'selected' : ''}>Missing</option>
          </select>
        </label>
        <label class="full">Search call ref<input id="station-q" type="search" placeholder="TC-…" value="${escapeHtml(f.q)}" /></label>
        <div class="filter-actions">
          <button type="button" id="station-apply-filters">Apply</button>
          <button type="button" class="secondary" id="station-reset-filters">Reset</button>
        </div>
      </div>
    </article>

    <article class="card">
      <div class="card-header"><div><h3>Recent calls</h3><p>Click a row for the chronological event timeline</p></div></div>
      <div id="station-table-host">${renderStationSkeleton()}</div>
    </article>

    <article class="card">
      <div class="card-header"><div><h3>Live activity</h3><p>Deduplicated poll updates</p></div></div>
      <div id="station-activity-log" class="timeline"></div>
    </article>

    <details class="panel-collapse">
      <summary>Controlled Test Call</summary>
      <div class="panel-body">
        <p class="muted">Execution stays disabled until the backend independently confirms every safety gate. The API token is never accepted or displayed here.</p>
        <div id="station-gate-host" class="gate-grid">${renderStationSkeleton()}</div>
        <button type="button" disabled title="Live test calls require server-side approval.">
          Place test call
        </button>
        <p class="muted">Live test calls require server-side approval.</p>
      </div>
    </details>
  `;

  $('#station-apply-filters')?.addEventListener('click', () => {
    refreshCallStationData().catch((error) => showNotice(error.message, 'error'));
  });
  $('#station-reset-filters')?.addEventListener('click', () => {
    state.callStation.filters = {
      from: '',
      to: '',
      status: '',
      outcome: '',
      websocket: '',
      webhook: '',
      q: '',
    };
    renderCallStation().catch((error) => showNotice(error.message, 'error'));
  });

  await refreshCallStationData();
  startCallStationPolling();
}

async function renderOutbound() {
  stopCallStationPolling();
  const root = $('#page-root');
  root.innerHTML = loadingState();
  let health;
  try {
    health = await api('/api/outbound/health');
  } catch (error) {
    root.innerHTML = emptyState(error.message);
    throw error;
  }

  const gatesOpen = health.liveGatesOpen === true;
  const ttsReady = health.tts?.ready === true;
  root.innerHTML = `
    <section class="admin-section outbound-admin">
      <div class="admin-toolbar">
        <div class="admin-toolbar-copy">
          <h3>Outbound Dialer</h3>
          <p>Compose a spoken message and dial one number. Preview is safe; Place call requires confirmation.</p>
        </div>
        <button type="button" class="admin-btn ghost" id="outbound-refresh">Refresh status</button>
      </div>

      <div class="admin-pane">
        <div class="admin-pane-header">Compose call</div>
        <div class="admin-pane-body">
          <div class="admin-status-row">
            <span class="admin-chip ${gatesOpen ? 'ok' : 'warn'}">${gatesOpen ? 'Dialer ready' : 'Dialer locked'}</span>
            <span class="admin-chip ${ttsReady ? 'ok' : 'danger'}">TTS ${ttsReady ? 'ready' : 'not ready'}</span>
            <span class="admin-chip">DID ${escapeHtml(health.didMasked || '—')}</span>
            <span class="admin-chip muted">${escapeHtml(health.liveCallMessage || '')}</span>
          </div>

          ${
            gatesOpen
              ? ''
              : `<div class="admin-alert">
                  Live dialing is disabled until <code>OUTBOUND_DIALER_LIVE=true</code> is set with SmartPing credentials.
                </div>`
          }

          <form class="admin-compose" id="outbound-form">
            <div class="admin-field">
              <label for="outbound-phone">Phone number</label>
              <input
                id="outbound-phone"
                name="phone"
                inputmode="numeric"
                autocomplete="tel"
                placeholder="10-digit mobile (e.g. 98XXXXXXXX)"
                required
              />
            </div>
            <div class="admin-field">
              <label for="outbound-message">Message to speak</label>
              <textarea
                id="outbound-message"
                name="message"
                maxlength="500"
                rows="4"
                placeholder="Hi, hello! How are you doing today?"
                required
              ></textarea>
              <p class="admin-hint"><span id="outbound-count">0</span> / 500</p>
            </div>
            <div class="admin-field">
              <label>Voice</label>
              <div class="voice-toggle" role="radiogroup" aria-label="Indian English voice">
                ${(health.voiceOptions || [
                  { id: 'en-IN-NeerjaNeural', label: 'Neerja', description: 'Female · Indian English' },
                  { id: 'en-IN-PrabhatNeural', label: 'Prabhat', description: 'Male · Indian English' },
                ])
                  .map((option) => {
                    const selected =
                      option.id === (health.defaultVoice || 'en-IN-NeerjaNeural');
                    return `<button
                      type="button"
                      class="voice-option ${selected ? 'active' : ''}"
                      role="radio"
                      aria-checked="${selected ? 'true' : 'false'}"
                      data-voice="${escapeHtml(option.id)}"
                    >
                      <strong>${escapeHtml(option.label)}</strong>
                      <span>${escapeHtml(option.description || '')}</span>
                    </button>`;
                  })
                  .join('')}
              </div>
              <input type="hidden" id="outbound-voice" value="${escapeHtml(health.defaultVoice || 'en-IN-NeerjaNeural')}" />
            </div>
            <div class="admin-field admin-field-inline">
              <label for="outbound-repeat">Repeat message</label>
              <select id="outbound-repeat" name="repeat">
                ${[1, 2, 3, 4, 5]
                  .map((n) => `<option value="${n}" ${n === 1 ? 'selected' : ''}>${n} time${n > 1 ? 's' : ''}</option>`)
                  .join('')}
              </select>
            </div>
            <label class="admin-confirm">
              <input type="checkbox" id="outbound-confirm" ${gatesOpen ? '' : 'disabled'} />
              <span>I confirm placing one live call to this number with this message.</span>
            </label>
            <div class="admin-actions">
              <button type="button" class="admin-btn ghost" id="outbound-preview">Preview</button>
              <button type="button" class="admin-btn primary" id="outbound-call" disabled>
                Place call
              </button>
            </div>
          </form>

          <div id="outbound-result" class="admin-result" hidden></div>
        </div>
      </div>
    </section>
  `;

  const phoneInput = $('#outbound-phone');
  const messageInput = $('#outbound-message');
  const repeatInput = $('#outbound-repeat');
  const voiceInput = $('#outbound-voice');
  const confirmInput = $('#outbound-confirm');
  const callBtn = $('#outbound-call');
  const resultHost = $('#outbound-result');
  const countEl = $('#outbound-count');

  function selectedVoice() {
    return voiceInput.value || health.defaultVoice || 'en-IN-NeerjaNeural';
  }

  $$('.voice-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      voiceInput.value = btn.dataset.voice;
      $$('.voice-option').forEach((other) => {
        const active = other === btn;
        other.classList.toggle('active', active);
        other.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    });
  });

  function syncCallButton() {
    const ready =
      gatesOpen &&
      confirmInput.checked &&
      phoneInput.value.trim().length >= 10 &&
      messageInput.value.trim().length > 0 &&
      ttsReady;
    callBtn.disabled = !ready;
  }

  function syncCount() {
    countEl.textContent = String(messageInput.value.length);
  }

  confirmInput.addEventListener('change', syncCallButton);
  phoneInput.addEventListener('input', syncCallButton);
  messageInput.addEventListener('input', () => {
    syncCount();
    syncCallButton();
  });
  syncCount();
  syncCallButton();

  $('#outbound-refresh').addEventListener('click', () => {
    renderOutbound().catch((error) => showNotice(error.message, 'error'));
  });

  function showResult(title, rows) {
    resultHost.hidden = false;
    resultHost.innerHTML = `
      <strong>${escapeHtml(title)}</strong>
      ${rows.map((row) => `<div>${escapeHtml(row)}</div>`).join('')}
    `;
  }

  $('#outbound-preview').addEventListener('click', async () => {
    try {
      clearNotice();
      const result = await api('/api/outbound/preview', {
        method: 'POST',
        body: JSON.stringify({
          phoneNumber: phoneInput.value.trim(),
          message: messageInput.value,
          repeatCount: Number(repeatInput.value || 1),
          voice: selectedVoice(),
        }),
      });
      showNotice('Preview ready — no network call was made.');
      showResult('Preview', [
        `Destination ${result.phoneMasked || '—'}`,
        `Voice ${result.voice || result.audio?.voice || '—'}`,
        `Message length ${result.messageLength}`,
        `Repeat ${result.repeatCount}`,
        result.audio?.durationSeconds != null
          ? `Audio ~${result.audio.durationSeconds}s (${result.audio.provider || 'tts'})`
          : `Audio unavailable (${result.audio?.error || 'tts not ready'})`,
        `Token configured: ${result.preview?.tokenConfigured ? 'yes' : 'no'}`,
      ]);
    } catch (error) {
      showNotice(error.message, 'error');
    }
  });

  callBtn.addEventListener('click', async () => {
    try {
      clearNotice();
      if (!gatesOpen || !confirmInput.checked) {
        showNotice('Confirm the call and ensure the dialer is unlocked.', 'error');
        return;
      }
      callBtn.disabled = true;
      callBtn.textContent = 'Placing…';
      const result = await api('/api/outbound/call', {
        method: 'POST',
        body: JSON.stringify({
          phoneNumber: phoneInput.value.trim(),
          message: messageInput.value,
          repeatCount: Number(repeatInput.value || 1),
          voice: selectedVoice(),
          confirm: true,
        }),
      });
      showNotice(
        result.networkRequestMade
          ? `Call accepted (HTTP ${result.httpStatus ?? '—'}).`
          : 'Call path returned without a network request.',
        'success',
      );
      showResult('Call result', [
        `Destination ${result.phoneMasked || '—'}`,
        `Voice ${result.audio?.voice || selectedVoice()}`,
        `App call id ${result.appCallId || '—'}`,
        `Call Station ref ${result.stationRef || '—'}`,
        `Network request: ${result.networkRequestMade ? 'yes' : 'no'}`,
        `Provider HTTP: ${result.httpStatus ?? '—'}`,
        `Audio ~${result.audio?.durationSeconds ?? '—'}s`,
      ]);
    } catch (error) {
      showNotice(error.message, 'error');
    } finally {
      callBtn.textContent = 'Place call';
      syncCallButton();
    }
  });
}

const titles = {
  dashboard: ['Overview', 'Dashboard'],
  leads: ['Contacts', 'Leads'],
  campaigns: ['Outbound', 'Campaigns'],
  calls: ['Activity', 'Calls'],
  outbound: ['Compose', 'Outbound'],
  'call-station': ['Monitoring', 'Call Station'],
  'follow-ups': ['Outbox', 'Follow-ups'],
  settings: ['Configuration', 'Settings'],
};

async function renderRoute() {
  clearNotice();
  const hash = window.location.hash || '#/dashboard';
  const route = hash.replace(/^#\//, '').split('?')[0] || 'dashboard';
  const meta = titles[route] || titles.dashboard;
  $('#page-eyebrow').textContent = meta[0];
  $('#page-title').textContent = meta[1];
  setActiveNav(route);

  if (route !== 'call-station') stopCallStationPolling();

  try {
    state.loading = true;
    if (route === 'dashboard') await renderDashboard();
    else if (route === 'leads') await renderLeads();
    else if (route === 'campaigns') await renderCampaigns();
    else if (route === 'calls') await renderCalls();
    else if (route === 'outbound') await renderOutbound();
    else if (route === 'call-station') await renderCallStation();
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
  const target = event.target.closest('button, a, tr.station-row');
  if (!target) return;
  try {
    if (target.dataset.stationId) {
      await showStationCallDetails(target.dataset.stationId);
      return;
    }
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

$('#nav-select')?.addEventListener('change', (event) => {
  const route = event.target.value;
  window.location.hash = `#/${route}`;
});

window.addEventListener('hashchange', () => {
  renderRoute().catch((error) => showNotice(error.message, 'error'));
});

document.addEventListener('visibilitychange', () => {
  const route = (window.location.hash || '').replace(/^#\//, '').split('?')[0];
  if (route !== 'call-station') return;
  if (document.hidden) return;
  refreshCallStationData({ quiet: true }).catch(() => {});
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
