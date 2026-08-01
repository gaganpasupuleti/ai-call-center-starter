import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ACTIVE_CALL_STATUSES,
  DEFAULT_KEYPAD_ACTIONS,
  interpretDigit,
} from './constants.js';

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapEvent(row) {
  if (!row) return null;
  return { ...row, raw: parseJson(row.raw_json) };
}

function mapLead(row) {
  if (!row) return null;
  return {
    ...row,
    do_not_call: Boolean(row.do_not_call),
    tags: parseJson(row.tags_json, []),
  };
}

function mapCampaign(row) {
  if (!row) return null;
  return {
    ...row,
    keypad_actions: parseJson(row.keypad_actions_json, DEFAULT_KEYPAD_ACTIONS),
  };
}

function mapFollowUp(row) {
  if (!row) return null;
  return { ...row };
}

function mapCall(row) {
  if (!row) return null;
  const keypad = parseJson(row.keypad_actions_json, DEFAULT_KEYPAD_ACTIONS);
  return {
    ...row,
    interpreted_response:
      row.interpreted_response ?? interpretDigit(row.selected_digit, keypad),
  };
}

export class Repository {
  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.migrateLeadsTable();
    this.migrateCampaignsTable();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_leads (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        outcome TEXT,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (campaign_id, lead_id)
      );

      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES leads(id),
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        provider TEXT NOT NULL,
        provider_call_id TEXT UNIQUE,
        status TEXT NOT NULL,
        selected_digit TEXT,
        interpreted_response TEXT,
        duration_seconds INTEGER,
        recording_url TEXT,
        error_message TEXT,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        answered_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS call_events (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES calls(id),
        provider_event_id TEXT NOT NULL,
        status TEXT,
        selected_digit TEXT,
        duration_seconds INTEGER,
        recording_url TEXT,
        occurred_at TEXT,
        received_at TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE(call_id, provider_event_id)
      );

      CREATE TABLE IF NOT EXISTS follow_ups (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        lead_id TEXT NOT NULL REFERENCES leads(id),
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        call_id TEXT NOT NULL REFERENCES calls(id),
        status TEXT NOT NULL,
        recipient_email TEXT,
        link_placeholder TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(call_id, type)
      );

      CREATE TABLE IF NOT EXISTS voice_streams (
        id TEXT PRIMARY KEY,
        stream_sid TEXT NOT NULL UNIQUE,
        call_sid TEXT,
        app_call_id TEXT,
        state TEXT NOT NULL,
        audio_format_json TEXT,
        custom_parameters_json TEXT,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS voice_stream_events (
        id TEXT PRIMARY KEY,
        stream_sid TEXT NOT NULL,
        event_type TEXT NOT NULL,
        sequence_number TEXT,
        payload_size INTEGER,
        validation_result TEXT,
        timestamp_ms TEXT,
        raw_audio_b64 TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smartping_call_status_events (
        id TEXT PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        call_ref TEXT,
        status TEXT,
        phone_hash TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stream_test_calls (
        id TEXT PRIMARY KEY,
        public_ref TEXT NOT NULL UNIQUE,
        session_id TEXT,
        provider_call_id TEXT,
        stream_sid TEXT,
        call_sid TEXT,
        app_call_id TEXT,
        destination_masked TEXT,
        did_masked TEXT,
        status TEXT NOT NULL,
        requested_at TEXT,
        initiated_at TEXT,
        ringing_at TEXT,
        answered_at TEXT,
        streaming_at TEXT,
        ended_at TEXT,
        duration_seconds REAL,
        ws_accepted INTEGER,
        ws_opened_at TEXT,
        ws_closed_at TEXT,
        ws_close_code INTEGER,
        protocol_events_json TEXT,
        audio_status TEXT,
        audio_queued_at TEXT,
        audio_completed_at TEXT,
        audio_error TEXT,
        webhook_received_at TEXT,
        webhook_duplicate INTEGER,
        webhook_status TEXT,
        failure_category TEXT,
        timeline_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dialed_calls (
        id TEXT PRIMARY KEY,
        public_ref TEXT NOT NULL UNIQUE,
        app_call_id TEXT,
        provider_call_id TEXT,
        destination_masked TEXT,
        did_masked TEXT,
        status TEXT NOT NULL,
        selected_digit TEXT,
        interpreted_response TEXT,
        duration_seconds REAL,
        voice TEXT,
        source TEXT NOT NULL DEFAULT 'outbound-dialer',
        answered_at TEXT,
        completed_at TEXT,
        started_at TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureColumn('calls', 'interpreted_response', 'TEXT');
    this.ensureColumn('calls', 'retry_attempt', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('calls', 'started_at', 'TEXT');
    this.ensureColumn('calls', 'answered_at', 'TEXT');
    this.ensureColumn('calls', 'completed_at', 'TEXT');

    this.db
      .prepare(
        `UPDATE campaigns
         SET keypad_actions_json = ?
         WHERE keypad_actions_json IS NULL OR keypad_actions_json = ''`,
      )
      .run(JSON.stringify(DEFAULT_KEYPAD_ACTIONS));

    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('version', '4')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
  }

  tableExists(name) {
    return Boolean(
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name),
    );
  }

  migrateLeadsTable() {
    if (!this.tableExists('leads')) {
      this.db.exec(`
        CREATE TABLE leads (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT NOT NULL UNIQUE,
          email TEXT,
          language TEXT,
          tags_json TEXT,
          source TEXT,
          consent_status TEXT NOT NULL,
          consent_timestamp TEXT,
          do_not_call INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      return;
    }

    const columns = this.db.prepare('PRAGMA table_info(leads)').all();
    const names = new Set(columns.map((column) => column.name));
    const needsRebuild =
      !names.has('updated_at') ||
      !names.has('language') ||
      !names.has('tags_json');

    if (!needsRebuild) {
      this.db
        .prepare(
          `UPDATE leads
           SET consent_status = 'pending',
               updated_at = COALESCE(updated_at, created_at, ?)
           WHERE consent_status = 'missing'`,
        )
        .run(now());
      return;
    }

    this.db.exec(`
      CREATE TABLE leads_v2 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        email TEXT,
        language TEXT,
        tags_json TEXT,
        source TEXT,
        consent_status TEXT NOT NULL,
        consent_timestamp TEXT,
        do_not_call INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const rows = this.db.prepare('SELECT * FROM leads').all();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO leads_v2 (
        id, name, phone, email, language, tags_json, source,
        consent_status, consent_timestamp, do_not_call, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const consent =
        row.consent_status === 'missing' ? 'pending' : row.consent_status;
      insert.run(
        row.id,
        row.name,
        row.phone,
        row.email ?? null,
        row.language ?? null,
        row.tags_json ?? '[]',
        row.source ?? null,
        consent,
        row.consent_timestamp ??
          (consent === 'granted' ? row.created_at : null),
        row.do_not_call ?? 0,
        row.notes ?? null,
        row.created_at,
        row.updated_at ?? row.created_at,
      );
    }

    this.db.exec('PRAGMA foreign_keys = OFF;');
    this.db.exec('DROP TABLE leads;');
    this.db.exec('ALTER TABLE leads_v2 RENAME TO leads;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  migrateCampaignsTable() {
    if (!this.tableExists('campaigns')) {
      this.db.exec(`
        CREATE TABLE campaigns (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          mode TEXT NOT NULL CHECK (mode IN ('ivr', 'ai')),
          message_text TEXT,
          audio_url TEXT,
          default_language TEXT,
          scheduled_at TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          retry_delay_seconds INTEGER NOT NULL DEFAULT 0,
          keypad_actions_json TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      return;
    }

    this.ensureColumn('campaigns', 'description', 'TEXT');
    this.ensureColumn('campaigns', 'default_language', 'TEXT');
    this.ensureColumn('campaigns', 'scheduled_at', 'TEXT');
    this.ensureColumn('campaigns', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(
      'campaigns',
      'retry_delay_seconds',
      'INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureColumn('campaigns', 'keypad_actions_json', 'TEXT');
    this.ensureColumn('campaigns', 'updated_at', 'TEXT');
    this.db
      .prepare(
        `UPDATE campaigns SET updated_at = created_at WHERE updated_at IS NULL`,
      )
      .run();
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() {
    this.db.close();
  }

  createLead(input) {
    const timestamp = now();
    const consentStatus = input.consentStatus ?? 'pending';
    const lead = {
      id: randomUUID(),
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      language: input.language ?? null,
      tags_json: JSON.stringify(input.tags ?? []),
      source: input.source ?? null,
      consent_status: consentStatus,
      consent_timestamp:
        input.consentTimestamp ??
        (consentStatus === 'granted' ? timestamp : null),
      do_not_call: input.doNotCall ? 1 : 0,
      notes: input.notes ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    try {
      this.db
        .prepare(`
          INSERT INTO leads (
            id, name, phone, email, language, tags_json, source,
            consent_status, consent_timestamp, do_not_call, notes,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          lead.id,
          lead.name,
          lead.phone,
          lead.email,
          lead.language,
          lead.tags_json,
          lead.source,
          lead.consent_status,
          lead.consent_timestamp,
          lead.do_not_call,
          lead.notes,
          lead.created_at,
          lead.updated_at,
        );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw Object.assign(new Error('A lead with this phone number already exists'), {
          statusCode: 409,
        });
      }
      throw error;
    }
    return this.getLead(lead.id);
  }

  updateLead(id, input) {
    const existing = this.getLead(id);
    if (!existing) return null;
    const timestamp = now();
    const consentStatus = input.consentStatus ?? existing.consent_status;
    let consentTimestamp = existing.consent_timestamp;
    if (input.consentTimestamp !== undefined) {
      consentTimestamp = input.consentTimestamp;
    } else if (consentStatus !== existing.consent_status && consentStatus === 'granted') {
      consentTimestamp = timestamp;
    }
    const next = {
      name: input.name ?? existing.name,
      phone: input.phone ?? existing.phone,
      email: input.email !== undefined ? input.email : existing.email,
      language: input.language !== undefined ? input.language : existing.language,
      tags_json: JSON.stringify(input.tags ?? existing.tags ?? []),
      source: input.source !== undefined ? input.source : existing.source,
      consent_status: consentStatus,
      consent_timestamp: consentTimestamp,
      do_not_call:
        input.doNotCall !== undefined
          ? input.doNotCall
            ? 1
            : 0
          : existing.do_not_call
            ? 1
            : 0,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      updated_at: timestamp,
    };
    try {
      this.db
        .prepare(`
          UPDATE leads SET
            name = ?, phone = ?, email = ?, language = ?, tags_json = ?, source = ?,
            consent_status = ?, consent_timestamp = ?, do_not_call = ?, notes = ?,
            updated_at = ?
          WHERE id = ?
        `)
        .run(
          next.name,
          next.phone,
          next.email,
          next.language,
          next.tags_json,
          next.source,
          next.consent_status,
          next.consent_timestamp,
          next.do_not_call,
          next.notes,
          next.updated_at,
          id,
        );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw Object.assign(new Error('A lead with this phone number already exists'), {
          statusCode: 409,
        });
      }
      throw error;
    }
    return this.getLead(id);
  }

  getLead(id) {
    return mapLead(this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id));
  }

  getLeadByPhone(phone) {
    return mapLead(this.db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone));
  }

  listLeads({ search = '', consentStatus = '', doNotCall = '', tag = '' } = {}) {
    const clauses = [];
    const params = [];
    if (search) {
      clauses.push(
        `(name LIKE ? OR phone LIKE ? OR email LIKE ? OR IFNULL(source, '') LIKE ? OR IFNULL(notes, '') LIKE ?)`,
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (consentStatus) {
      clauses.push('consent_status = ?');
      params.push(consentStatus === 'missing' ? 'pending' : consentStatus);
    }
    if (doNotCall === 'true' || doNotCall === true) {
      clauses.push('do_not_call = 1');
    } else if (doNotCall === 'false' || doNotCall === false) {
      clauses.push('do_not_call = 0');
    }
    if (tag) {
      clauses.push(`tags_json LIKE ?`);
      params.push(`%${tag}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM leads ${where} ORDER BY created_at DESC`)
      .all(...params)
      .map(mapLead);
  }

  createCampaign(input) {
    const timestamp = now();
    const campaign = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      mode: input.mode ?? 'ivr',
      message_text: input.messageText ?? null,
      audio_url: input.audioUrl ?? null,
      default_language: input.defaultLanguage ?? null,
      scheduled_at: input.scheduledAt ?? null,
      retry_count: Number(input.retryCount ?? 0),
      retry_delay_seconds: Number(input.retryDelaySeconds ?? 0),
      keypad_actions_json: JSON.stringify(
        input.keypadActions ?? DEFAULT_KEYPAD_ACTIONS,
      ),
      status: input.status ?? 'draft',
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.db
      .prepare(`
        INSERT INTO campaigns (
          id, name, description, mode, message_text, audio_url, default_language,
          scheduled_at, retry_count, retry_delay_seconds, keypad_actions_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        campaign.id,
        campaign.name,
        campaign.description,
        campaign.mode,
        campaign.message_text,
        campaign.audio_url,
        campaign.default_language,
        campaign.scheduled_at,
        campaign.retry_count,
        campaign.retry_delay_seconds,
        campaign.keypad_actions_json,
        campaign.status,
        campaign.created_at,
        campaign.updated_at,
      );
    if (Array.isArray(input.leadIds) && input.leadIds.length > 0) {
      this.assignLeadsToCampaign(campaign.id, input.leadIds);
    }
    return this.getCampaign(campaign.id);
  }

  updateCampaign(id, input) {
    const existing = this.getCampaign(id);
    if (!existing) return null;
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE campaigns SET
          name = ?, description = ?, mode = ?, message_text = ?, audio_url = ?,
          default_language = ?, scheduled_at = ?, retry_count = ?,
          retry_delay_seconds = ?, keypad_actions_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.name ?? existing.name,
        input.description !== undefined ? input.description : existing.description,
        input.mode ?? existing.mode,
        input.messageText !== undefined ? input.messageText : existing.message_text,
        input.audioUrl !== undefined ? input.audioUrl : existing.audio_url,
        input.defaultLanguage !== undefined
          ? input.defaultLanguage
          : existing.default_language,
        input.scheduledAt !== undefined ? input.scheduledAt : existing.scheduled_at,
        input.retryCount !== undefined
          ? Number(input.retryCount)
          : existing.retry_count,
        input.retryDelaySeconds !== undefined
          ? Number(input.retryDelaySeconds)
          : existing.retry_delay_seconds,
        JSON.stringify(input.keypadActions ?? existing.keypad_actions),
        input.status ?? existing.status,
        timestamp,
        id,
      );
    if (Array.isArray(input.leadIds)) {
      this.replaceCampaignLeads(id, input.leadIds);
    }
    return this.getCampaign(id);
  }

  setCampaignStatus(id, status) {
    this.db
      .prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), id);
    return this.getCampaign(id);
  }

  getCampaign(id) {
    const campaign = mapCampaign(
      this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id),
    );
    if (!campaign) return null;
    return {
      ...campaign,
      leads: this.listCampaignLeads(id),
    };
  }

  listCampaigns() {
    return this.db
      .prepare('SELECT * FROM campaigns ORDER BY created_at DESC')
      .all()
      .map((row) => {
        const campaign = mapCampaign(row);
        const counts = this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM campaign_leads WHERE campaign_id = ?',
          )
          .get(campaign.id);
        return { ...campaign, lead_count: counts.count };
      });
  }

  listCampaignLeads(campaignId) {
    return this.db
      .prepare(`
        SELECT leads.*, campaign_leads.outcome, campaign_leads.assigned_at
        FROM campaign_leads
        JOIN leads ON leads.id = campaign_leads.lead_id
        WHERE campaign_leads.campaign_id = ?
        ORDER BY campaign_leads.assigned_at DESC
      `)
      .all(campaignId)
      .map((row) => mapLead(row));
  }

  assignLeadsToCampaign(campaignId, leadIds) {
    const assignedAt = now();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, outcome, assigned_at)
      VALUES (?, ?, NULL, ?)
    `);
    for (const leadId of leadIds) {
      insert.run(campaignId, leadId, assignedAt);
    }
    this.db
      .prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?')
      .run(assignedAt, campaignId);
    return this.listCampaignLeads(campaignId);
  }

  replaceCampaignLeads(campaignId, leadIds) {
    this.db
      .prepare('DELETE FROM campaign_leads WHERE campaign_id = ?')
      .run(campaignId);
    return this.assignLeadsToCampaign(campaignId, leadIds);
  }

  setCampaignLeadOutcome(campaignId, leadId, outcome) {
    const assignedAt = now();
    this.db
      .prepare(`
        INSERT INTO campaign_leads (campaign_id, lead_id, outcome, assigned_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(campaign_id, lead_id) DO UPDATE SET outcome = excluded.outcome
      `)
      .run(campaignId, leadId, outcome, assignedAt);
  }

  createCall({ leadId, campaignId, provider, retryAttempt = 0 }) {
    const timestamp = now();
    const call = {
      id: randomUUID(),
      lead_id: leadId,
      campaign_id: campaignId,
      provider,
      provider_call_id: null,
      status: 'queued',
      selected_digit: null,
      interpreted_response: null,
      duration_seconds: null,
      recording_url: null,
      error_message: null,
      retry_attempt: retryAttempt,
      started_at: null,
      answered_at: null,
      completed_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.db
      .prepare(`
        INSERT INTO calls (
          id, lead_id, campaign_id, provider, provider_call_id, status,
          selected_digit, interpreted_response, duration_seconds, recording_url,
          error_message, retry_attempt, started_at, answered_at, completed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        call.id,
        call.lead_id,
        call.campaign_id,
        call.provider,
        call.provider_call_id,
        call.status,
        call.selected_digit,
        call.interpreted_response,
        call.duration_seconds,
        call.recording_url,
        call.error_message,
        call.retry_attempt,
        call.started_at,
        call.answered_at,
        call.completed_at,
        call.created_at,
        call.updated_at,
      );
    return this.getCall(call.id);
  }

  findActiveCall(campaignId, leadId) {
    const placeholders = ACTIVE_CALL_STATUSES.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `SELECT * FROM calls
           WHERE campaign_id = ? AND lead_id = ? AND status IN (${placeholders})
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(campaignId, leadId, ...ACTIVE_CALL_STATUSES) ?? null
    );
  }

  markCallStarted(id, { providerCallId, status = 'initiated' }) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE calls
        SET provider_call_id = ?, status = ?, started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE id = ?
      `)
      .run(providerCallId, status, timestamp, timestamp, id);
    return this.getCall(id);
  }

  markCallFailed(id, message) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE calls
        SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(message, timestamp, timestamp, id);
    return this.getCall(id);
  }

  getCall(id) {
    return mapCall(
      this.db
        .prepare(`
          SELECT calls.*, leads.name AS lead_name, leads.phone, leads.email,
                 campaigns.name AS campaign_name, campaigns.mode AS campaign_mode,
                 campaigns.keypad_actions_json
          FROM calls
          JOIN leads ON leads.id = calls.lead_id
          JOIN campaigns ON campaigns.id = calls.campaign_id
          WHERE calls.id = ?
        `)
        .get(id),
    );
  }

  getCallByProviderId(providerCallId) {
    return (
      this.db
        .prepare('SELECT * FROM calls WHERE provider_call_id = ?')
        .get(providerCallId) ?? null
    );
  }

  listCalls({
    search = '',
    status = '',
    campaignId = '',
    digit = '',
  } = {}) {
    const clauses = [];
    const params = [];
    if (search) {
      clauses.push(
        `(leads.name LIKE ? OR leads.phone LIKE ? OR IFNULL(calls.provider_call_id, '') LIKE ? OR campaigns.name LIKE ?)`,
      );
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (status) {
      clauses.push('calls.status = ?');
      params.push(status);
    }
    if (campaignId) {
      clauses.push('calls.campaign_id = ?');
      params.push(campaignId);
    }
    if (digit) {
      clauses.push('calls.selected_digit = ?');
      params.push(digit);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`
        SELECT calls.*, leads.name AS lead_name, leads.phone, leads.email,
               campaigns.name AS campaign_name, campaigns.mode AS campaign_mode,
               campaigns.keypad_actions_json
        FROM calls
        JOIN leads ON leads.id = calls.lead_id
        JOIN campaigns ON campaigns.id = calls.campaign_id
        ${where}
        ORDER BY calls.created_at DESC
      `)
      .all(...params)
      .map(mapCall);
  }

  applyCallEvent(callId, event) {
    const eventId = event.eventId || randomUUID();
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO call_events (
          id, call_id, provider_event_id, status, selected_digit,
          duration_seconds, recording_url, occurred_at, received_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        callId,
        eventId,
        event.status ?? null,
        event.selectedDigit ?? null,
        event.durationSeconds ?? null,
        event.recordingUrl ?? null,
        event.occurredAt ?? null,
        now(),
        JSON.stringify(event.raw ?? event),
      );

    if (result.changes === 0) {
      return { duplicate: true, call: this.getCall(callId) };
    }

    const call = this.getCall(callId);
    const campaign = this.getCampaign(call.campaign_id);
    const selectedDigit =
      event.selectedDigit !== undefined && event.selectedDigit !== null
        ? String(event.selectedDigit)
        : call.selected_digit;
    const interpreted = interpretDigit(selectedDigit, campaign?.keypad_actions);
    const status = event.status ?? call.status;
    const timestamp = now();
    let answeredAt = call.answered_at;
    let completedAt = call.completed_at;
    let startedAt = call.started_at;
    if (status === 'ringing' || status === 'initiated') {
      startedAt = startedAt ?? timestamp;
    }
    if (status === 'answered') {
      answeredAt = answeredAt ?? timestamp;
    }
    if (
      ['completed', 'busy', 'no_answer', 'failed', 'rejected'].includes(status)
    ) {
      completedAt = completedAt ?? timestamp;
    }

    this.db
      .prepare(`
        UPDATE calls SET
          status = ?,
          selected_digit = ?,
          interpreted_response = ?,
          duration_seconds = ?,
          recording_url = ?,
          error_message = CASE
            WHEN ? IN ('failed', 'busy', 'no_answer', 'rejected')
              THEN COALESCE(error_message, ?)
            ELSE error_message
          END,
          started_at = ?,
          answered_at = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        selectedDigit,
        interpreted,
        event.durationSeconds ?? call.duration_seconds,
        event.recordingUrl ?? call.recording_url,
        status,
        status,
        startedAt,
        answeredAt,
        completedAt,
        timestamp,
        callId,
      );

    return { duplicate: false, call: this.getCall(callId) };
  }

  listCallEvents(callId) {
    return this.db
      .prepare('SELECT * FROM call_events WHERE call_id = ? ORDER BY received_at ASC')
      .all(callId)
      .map(mapEvent);
  }

  createFollowUp(input) {
    const timestamp = now();
    const followUp = {
      id: randomUUID(),
      type: input.type,
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      call_id: input.callId,
      status: input.status ?? 'pending',
      recipient_email: input.recipientEmail ?? null,
      link_placeholder: input.linkPlaceholder ?? null,
      notes: input.notes ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO follow_ups (
          id, type, lead_id, campaign_id, call_id, status,
          recipient_email, link_placeholder, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        followUp.id,
        followUp.type,
        followUp.lead_id,
        followUp.campaign_id,
        followUp.call_id,
        followUp.status,
        followUp.recipient_email,
        followUp.link_placeholder,
        followUp.notes,
        followUp.created_at,
        followUp.updated_at,
      );
    if (result.changes === 0) {
      return {
        created: false,
        followUp: this.getFollowUpByCallAndType(input.callId, input.type),
      };
    }
    return { created: true, followUp: this.getFollowUp(followUp.id) };
  }

  getFollowUp(id) {
    return mapFollowUp(
      this.db
        .prepare(`
          SELECT follow_ups.*, leads.name AS lead_name, leads.phone,
                 campaigns.name AS campaign_name
          FROM follow_ups
          JOIN leads ON leads.id = follow_ups.lead_id
          JOIN campaigns ON campaigns.id = follow_ups.campaign_id
          WHERE follow_ups.id = ?
        `)
        .get(id),
    );
  }

  getFollowUpByCallAndType(callId, type) {
    return mapFollowUp(
      this.db
        .prepare('SELECT * FROM follow_ups WHERE call_id = ? AND type = ?')
        .get(callId, type),
    );
  }

  listFollowUps({ status = '', type = '' } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push('follow_ups.status = ?');
      params.push(status);
    }
    if (type) {
      clauses.push('follow_ups.type = ?');
      params.push(type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`
        SELECT follow_ups.*, leads.name AS lead_name, leads.phone,
               campaigns.name AS campaign_name
        FROM follow_ups
        JOIN leads ON leads.id = follow_ups.lead_id
        JOIN campaigns ON campaigns.id = follow_ups.campaign_id
        ${where}
        ORDER BY follow_ups.created_at DESC
      `)
      .all(...params)
      .map(mapFollowUp);
  }

  updateFollowUpStatus(id, status) {
    this.db
      .prepare('UPDATE follow_ups SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), id);
    return this.getFollowUp(id);
  }

  count(sql, params = []) {
    return this.db.prepare(sql).get(...params).count;
  }

  getSummary() {
    const total = this.count('SELECT COUNT(*) AS count FROM calls');
    const interested = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE selected_digit = '1'",
    );
    const answered = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE status IN ('answered', 'completed')",
    );
    const followUp = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE selected_digit = '2'",
    );
    return { total, answered, interested, followUp };
  }

  getDashboardMetrics() {
    const totalLeads = this.count('SELECT COUNT(*) AS count FROM leads');
    const consentedLeads = this.count(
      "SELECT COUNT(*) AS count FROM leads WHERE consent_status = 'granted'",
    );
    const activeCampaigns = this.count(
      "SELECT COUNT(*) AS count FROM campaigns WHERE status IN ('running', 'scheduled', 'paused')",
    );
    const callsInitiated = this.count('SELECT COUNT(*) AS count FROM calls');
    const answeredCalls = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE status IN ('answered', 'completed') OR answered_at IS NOT NULL",
    );
    const interestedLeads = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE selected_digit = '1'",
    );
    const callbackRequests = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE selected_digit = '2'",
    );
    const notInterested = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE selected_digit = '3'",
    );
    const humanAgentRequests = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE selected_digit = '9'",
    );
    const failedOrNoAnswer = this.count(
      "SELECT COUNT(*) AS count FROM calls WHERE status IN ('failed', 'no_answer', 'busy', 'rejected')",
    );
    const answerRate =
      callsInitiated === 0 ? 0 : Number((answeredCalls / callsInitiated).toFixed(4));
    const interestConversionRate =
      answeredCalls === 0
        ? 0
        : Number((interestedLeads / answeredCalls).toFixed(4));

    const recentCalls = this.listCalls().slice(0, 8);
    const recentCampaigns = this.listCampaigns().slice(0, 6);
    const pendingFollowUps = this.listFollowUps({ status: 'pending' }).slice(0, 8);

    const campaignSummaries = this.db
      .prepare(`
        SELECT
          campaigns.id,
          campaigns.name,
          campaigns.status,
          (
            SELECT COUNT(*) FROM campaign_leads
            WHERE campaign_leads.campaign_id = campaigns.id
          ) AS assigned_leads,
          (
            SELECT COUNT(*) FROM calls
            WHERE calls.campaign_id = campaigns.id
          ) AS calls,
          (
            SELECT COUNT(*) FROM calls
            WHERE calls.campaign_id = campaigns.id
              AND (calls.status IN ('answered', 'completed') OR calls.answered_at IS NOT NULL)
          ) AS answered,
          (
            SELECT COUNT(*) FROM calls
            WHERE calls.campaign_id = campaigns.id
              AND calls.selected_digit = '1'
          ) AS interested,
          (
            SELECT COUNT(*) FROM calls
            WHERE calls.campaign_id = campaigns.id
              AND calls.status IN ('failed', 'no_answer', 'busy', 'rejected')
          ) AS failed
        FROM campaigns
        ORDER BY campaigns.created_at DESC
      `)
      .all();

    return {
      totalLeads,
      consentedLeads,
      activeCampaigns,
      callsInitiated,
      answeredCalls,
      interestedLeads,
      callbackRequests,
      notInterested,
      humanAgentRequests,
      failedOrNoAnswer,
      answerRate,
      interestConversionRate,
      recentCalls,
      recentCampaigns,
      pendingFollowUps,
      campaignSummaries,
      ...this.getSummary(),
    };
  }

  createVoiceStream(input) {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO voice_streams (
          id, stream_sid, call_sid, app_call_id, state, audio_format_json,
          custom_parameters_json, opened_at, closed_at, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `)
      .run(
        input.id,
        input.streamSid,
        input.callSid ?? null,
        input.appCallId ?? null,
        input.state,
        JSON.stringify(input.audioFormat ?? null),
        JSON.stringify(input.customParameters ?? {}),
        input.openedAt ?? timestamp,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.getVoiceStream(input.streamSid);
  }

  getVoiceStream(streamSid) {
    const row = this.db
      .prepare('SELECT * FROM voice_streams WHERE stream_sid = ?')
      .get(streamSid);
    if (!row) return null;
    return {
      ...row,
      audio_format: parseJson(row.audio_format_json, null),
      custom_parameters: parseJson(row.custom_parameters_json, {}),
      metadata: parseJson(row.metadata_json, {}),
    };
  }

  listVoiceStreams() {
    return this.db
      .prepare('SELECT * FROM voice_streams ORDER BY created_at DESC')
      .all()
      .map((row) => ({
        ...row,
        audio_format: parseJson(row.audio_format_json, null),
        custom_parameters: parseJson(row.custom_parameters_json, {}),
        metadata: parseJson(row.metadata_json, {}),
      }));
  }

  closeVoiceStream(streamSid, { closedAt, metadata } = {}) {
    const existing = this.getVoiceStream(streamSid);
    if (!existing) return null;
    this.db
      .prepare(`
        UPDATE voice_streams
        SET state = 'closed',
            closed_at = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE stream_sid = ?
      `)
      .run(
        closedAt ?? now(),
        JSON.stringify({ ...(existing.metadata ?? {}), ...(metadata ?? {}) }),
        now(),
        streamSid,
      );
    return this.getVoiceStream(streamSid);
  }

  addVoiceStreamEvent(input) {
    const id = randomUUID();
    this.db
      .prepare(`
        INSERT INTO voice_stream_events (
          id, stream_sid, event_type, sequence_number, payload_size,
          validation_result, timestamp_ms, raw_audio_b64, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.streamSid,
        input.eventType,
        input.sequenceNumber ?? null,
        input.payloadSize ?? null,
        input.validationResult ?? null,
        input.timestampMs ?? null,
        input.rawAudioB64 ?? null,
        JSON.stringify(input.metadata ?? {}),
        now(),
      );
    return id;
  }

  listVoiceStreamEvents(streamSid) {
    return this.db
      .prepare(
        `SELECT * FROM voice_stream_events
         WHERE stream_sid = ?
         ORDER BY created_at ASC`,
      )
      .all(streamSid)
      .map((row) => ({
        ...row,
        metadata: parseJson(row.metadata_json, {}),
      }));
  }

  recordSmartPingCallStatusEvent(input) {
    const existing = this.db
      .prepare('SELECT * FROM smartping_call_status_events WHERE event_key = ?')
      .get(input.eventKey);
    if (existing) {
      return {
        duplicate: true,
        id: existing.id,
        eventKey: existing.event_key,
        callRef: existing.call_ref,
        status: existing.status,
        phoneHash: existing.phone_hash,
        createdAt: existing.created_at,
      };
    }

    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO smartping_call_status_events (
          id, event_key, call_ref, status, phone_hash, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.eventKey,
        input.callRef ?? null,
        input.status ?? null,
        input.phoneHash ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
      );

    return {
      duplicate: false,
      id,
      eventKey: input.eventKey,
      callRef: input.callRef ?? null,
      status: input.status ?? null,
      phoneHash: input.phoneHash ?? null,
      createdAt: timestamp,
    };
  }

  #mapStreamTestCall(row) {
    if (!row) return null;
    return {
      ...row,
      protocol_events: parseJson(row.protocol_events_json, {}),
      timeline: parseJson(row.timeline_json, []),
      metadata: parseJson(row.metadata_json, {}),
    };
  }

  createStreamTestCall(input = {}) {
    const id = input.id || randomUUID();
    const timestamp = now();
    const publicRef =
      input.publicRef || `TC-${id.replace(/-/g, '').slice(0, 10)}`;
    this.db
      .prepare(`
        INSERT INTO stream_test_calls (
          id, public_ref, session_id, provider_call_id, stream_sid, call_sid, app_call_id,
          destination_masked, did_masked, status,
          requested_at, initiated_at, ringing_at, answered_at, streaming_at, ended_at,
          duration_seconds, ws_accepted, ws_opened_at, ws_closed_at, ws_close_code,
          protocol_events_json, audio_status, audio_queued_at, audio_completed_at, audio_error,
          webhook_received_at, webhook_duplicate, webhook_status, failure_category,
          timeline_json, metadata_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `)
      .run(
        id,
        publicRef,
        input.sessionId ?? null,
        input.providerCallId ?? null,
        input.streamSid ?? null,
        input.callSid ?? null,
        input.appCallId ?? null,
        input.destinationMasked ?? null,
        input.didMasked ?? null,
        input.status ?? 'unknown',
        input.requestedAt ?? null,
        input.initiatedAt ?? null,
        input.ringingAt ?? null,
        input.answeredAt ?? null,
        input.streamingAt ?? null,
        input.endedAt ?? null,
        input.durationSeconds ?? null,
        input.wsAccepted === true || input.wsAccepted === 1 ? 1 : input.wsAccepted === false ? 0 : null,
        input.wsOpenedAt ?? null,
        input.wsClosedAt ?? null,
        input.wsCloseCode ?? null,
        JSON.stringify(input.protocolEvents ?? {}),
        input.audioStatus ?? null,
        input.audioQueuedAt ?? null,
        input.audioCompletedAt ?? null,
        input.audioError ?? null,
        input.webhookReceivedAt ?? null,
        input.webhookDuplicate ? 1 : 0,
        input.webhookStatus ?? null,
        input.failureCategory ?? null,
        JSON.stringify(input.timeline ?? []),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    const created = this.getStreamTestCall(id);
    try {
      this.syncDialedCallFromStationRow(created);
    } catch {
      // ignore
    }
    return created;
  }

  getStreamTestCall(id) {
    const row = this.db
      .prepare('SELECT * FROM stream_test_calls WHERE id = ?')
      .get(id);
    return this.#mapStreamTestCall(row);
  }

  getStreamTestCallByPublicRef(publicRef) {
    const row = this.db
      .prepare('SELECT * FROM stream_test_calls WHERE public_ref = ? OR id = ?')
      .get(publicRef, publicRef);
    return this.#mapStreamTestCall(row);
  }

  findStreamTestCall({
    streamSid,
    callSid,
    appCallId,
    sessionId,
    providerCallId,
  } = {}) {
    if (sessionId) {
      const bySession = this.db
        .prepare('SELECT * FROM stream_test_calls WHERE session_id = ? ORDER BY created_at DESC')
        .get(sessionId);
      if (bySession) return this.#mapStreamTestCall(bySession);
    }
    if (streamSid) {
      const byStream = this.db
        .prepare('SELECT * FROM stream_test_calls WHERE stream_sid = ? ORDER BY created_at DESC')
        .get(streamSid);
      if (byStream) return this.#mapStreamTestCall(byStream);
    }
    if (callSid) {
      const byCall = this.db
        .prepare(
          `SELECT * FROM stream_test_calls
           WHERE call_sid = ? OR provider_call_id = ?
           ORDER BY created_at DESC`,
        )
        .get(callSid, callSid);
      if (byCall) return this.#mapStreamTestCall(byCall);
    }
    if (appCallId) {
      const byApp = this.db
        .prepare('SELECT * FROM stream_test_calls WHERE app_call_id = ? ORDER BY created_at DESC')
        .get(appCallId);
      if (byApp) return this.#mapStreamTestCall(byApp);
    }
    if (providerCallId) {
      const byProvider = this.db
        .prepare(
          'SELECT * FROM stream_test_calls WHERE provider_call_id = ? ORDER BY created_at DESC',
        )
        .get(providerCallId);
      if (byProvider) return this.#mapStreamTestCall(byProvider);
    }
    return null;
  }

  updateStreamTestCall(id, patch = {}) {
    const existing = this.getStreamTestCall(id);
    if (!existing) return null;
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE stream_test_calls SET
          provider_call_id = ?,
          stream_sid = ?,
          call_sid = ?,
          app_call_id = ?,
          destination_masked = ?,
          did_masked = ?,
          status = ?,
          requested_at = ?,
          initiated_at = ?,
          ringing_at = ?,
          answered_at = ?,
          streaming_at = ?,
          ended_at = ?,
          duration_seconds = ?,
          ws_accepted = ?,
          ws_opened_at = ?,
          ws_closed_at = ?,
          ws_close_code = ?,
          protocol_events_json = ?,
          audio_status = ?,
          audio_queued_at = ?,
          audio_completed_at = ?,
          audio_error = ?,
          webhook_received_at = ?,
          webhook_duplicate = ?,
          webhook_status = ?,
          failure_category = ?,
          timeline_json = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        patch.providerCallId ?? existing.provider_call_id,
        patch.streamSid ?? existing.stream_sid,
        patch.callSid ?? existing.call_sid,
        patch.appCallId ?? existing.app_call_id,
        patch.destinationMasked ?? existing.destination_masked,
        patch.didMasked ?? existing.did_masked,
        patch.status ?? existing.status,
        patch.requestedAt ?? existing.requested_at,
        patch.initiatedAt ?? existing.initiated_at,
        patch.ringingAt ?? existing.ringing_at,
        patch.answeredAt ?? existing.answered_at,
        patch.streamingAt ?? existing.streaming_at,
        patch.endedAt ?? existing.ended_at,
        patch.durationSeconds ?? existing.duration_seconds,
        patch.wsAccepted === true || patch.wsAccepted === 1
          ? 1
          : patch.wsAccepted === false || patch.wsAccepted === 0
            ? 0
            : existing.ws_accepted,
        patch.wsOpenedAt ?? existing.ws_opened_at,
        patch.wsClosedAt ?? existing.ws_closed_at,
        patch.wsCloseCode ?? existing.ws_close_code,
        JSON.stringify(patch.protocolEvents ?? existing.protocol_events ?? {}),
        patch.audioStatus ?? existing.audio_status,
        patch.audioQueuedAt ?? existing.audio_queued_at,
        patch.audioCompletedAt ?? existing.audio_completed_at,
        patch.audioError ?? existing.audio_error,
        patch.webhookReceivedAt ?? existing.webhook_received_at,
        patch.webhookDuplicate === true || patch.webhookDuplicate === 1
          ? 1
          : patch.webhookDuplicate === false || patch.webhookDuplicate === 0
            ? 0
            : existing.webhook_duplicate,
        patch.webhookStatus ?? existing.webhook_status,
        patch.failureCategory ?? existing.failure_category,
        JSON.stringify(patch.timeline ?? existing.timeline ?? []),
        JSON.stringify(patch.metadata ?? existing.metadata ?? {}),
        timestamp,
        id,
      );
    const updated = this.getStreamTestCall(id);
    try {
      this.syncDialedCallFromStationRow(updated);
    } catch {
      // dialed_calls sync must not break stream monitoring
    }
    return updated;
  }

  listStreamTestCalls(filters = {}) {
    let rows = this.db
      .prepare('SELECT * FROM stream_test_calls ORDER BY created_at DESC')
      .all()
      .map((row) => this.#mapStreamTestCall(row));

    if (filters.status) {
      const status = String(filters.status).toLowerCase();
      rows = rows.filter((row) => String(row.status).toLowerCase() === status);
    }
    if (filters.outcome === 'completed') {
      rows = rows.filter((row) => row.status === 'completed');
    }
    if (filters.outcome === 'failed') {
      rows = rows.filter((row) =>
        ['failed', 'rejected'].includes(String(row.status).toLowerCase()),
      );
    }
    if (filters.websocket === 'accepted') {
      rows = rows.filter((row) => row.ws_accepted === 1);
    }
    if (filters.websocket === 'rejected') {
      rows = rows.filter((row) => row.ws_accepted === 0);
    }
    if (filters.webhook === 'received') {
      rows = rows.filter((row) => Boolean(row.webhook_received_at));
    }
    if (filters.webhook === 'missing') {
      rows = rows.filter((row) => !row.webhook_received_at);
    }
    if (filters.q) {
      const q = String(filters.q).toLowerCase();
      rows = rows.filter(
        (row) =>
          String(row.public_ref || '').toLowerCase().includes(q) ||
          String(row.id || '').toLowerCase().includes(q) ||
          String(row.stream_sid || '').toLowerCase().includes(q),
      );
    }
    if (filters.from) {
      const from = Date.parse(filters.from);
      rows = rows.filter((row) => Date.parse(row.created_at) >= from);
    }
    if (filters.to) {
      const to = Date.parse(filters.to);
      rows = rows.filter((row) => Date.parse(row.created_at) <= to);
    }
    return rows;
  }

  #mapDialedCall(row) {
    if (!row) return null;
    return {
      id: row.id,
      public_ref: row.public_ref,
      app_call_id: row.app_call_id,
      provider_call_id: row.provider_call_id,
      destination_masked: row.destination_masked,
      did_masked: row.did_masked,
      status: row.status,
      selected_digit: row.selected_digit,
      interpreted_response: row.interpreted_response,
      duration_seconds: row.duration_seconds,
      voice: row.voice,
      source: row.source || 'outbound-dialer',
      answered_at: row.answered_at,
      completed_at: row.completed_at,
      started_at: row.started_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      metadata: parseJson(row.metadata_json, {}),
      // Shape compatible with Calls UI /api/calls items
      lead_name: row.destination_masked || 'Outbound',
      phone: row.destination_masked || '—',
      campaign_name: 'Outbound dialer',
      stationRef: row.public_ref,
      pickupCode: row.answered_at
        ? 'picked_up'
        : ['failed', 'no_answer', 'busy', 'rejected'].includes(
              String(row.status || '').toLowerCase(),
            )
          ? 'not_picked_up'
          : ['ringing', 'initiated', 'requested'].includes(
                String(row.status || '').toLowerCase(),
              )
            ? String(row.status).toLowerCase()
            : null,
      pickedUp: Boolean(row.answered_at),
    };
  }

  createDialedCall(input = {}) {
    const publicRef =
      input.publicRef || `OB-${Date.now().toString(36)}`;
    const existing = this.getDialedCallByPublicRef(publicRef);
    if (existing) {
      return this.updateDialedCall(publicRef, {
        appCallId: input.appCallId,
        providerCallId: input.providerCallId,
        destinationMasked: input.destinationMasked,
        didMasked: input.didMasked,
        status: input.status,
        selectedDigit: input.selectedDigit,
        interpretedResponse: input.interpretedResponse,
        durationSeconds: input.durationSeconds,
        voice: input.voice,
        answeredAt: input.answeredAt,
        completedAt: input.completedAt,
        startedAt: input.startedAt,
        metadata: input.metadata,
      });
    }
    const id = input.id || randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO dialed_calls (
          id, public_ref, app_call_id, provider_call_id,
          destination_masked, did_masked, status,
          selected_digit, interpreted_response, duration_seconds, voice, source,
          answered_at, completed_at, started_at, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        publicRef,
        input.appCallId ?? null,
        input.providerCallId ?? null,
        input.destinationMasked ?? null,
        input.didMasked ?? null,
        input.status ?? 'initiated',
        input.selectedDigit ?? null,
        input.interpretedResponse ?? null,
        input.durationSeconds ?? null,
        input.voice ?? null,
        input.source ?? 'outbound-dialer',
        input.answeredAt ?? null,
        input.completedAt ?? null,
        input.startedAt ?? timestamp,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.getDialedCallByPublicRef(publicRef);
  }

  getDialedCallByPublicRef(publicRef) {
    if (!publicRef) return null;
    const row = this.db
      .prepare('SELECT * FROM dialed_calls WHERE public_ref = ? OR id = ?')
      .get(publicRef, publicRef);
    return this.#mapDialedCall(row);
  }

  getDialedCallByAppCallId(appCallId) {
    if (!appCallId) return null;
    const row = this.db
      .prepare(
        'SELECT * FROM dialed_calls WHERE app_call_id = ? ORDER BY created_at DESC',
      )
      .get(appCallId);
    return this.#mapDialedCall(row);
  }

  updateDialedCall(publicRefOrId, patch = {}) {
    const existing = this.getDialedCallByPublicRef(publicRefOrId);
    if (!existing) return null;
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE dialed_calls SET
          provider_call_id = ?,
          destination_masked = ?,
          did_masked = ?,
          status = ?,
          selected_digit = ?,
          interpreted_response = ?,
          duration_seconds = ?,
          voice = ?,
          answered_at = ?,
          completed_at = ?,
          started_at = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        patch.providerCallId ?? existing.provider_call_id,
        patch.destinationMasked ?? existing.destination_masked,
        patch.didMasked ?? existing.did_masked,
        patch.status ?? existing.status,
        patch.selectedDigit !== undefined
          ? patch.selectedDigit
          : existing.selected_digit,
        patch.interpretedResponse !== undefined
          ? patch.interpretedResponse
          : existing.interpreted_response,
        patch.durationSeconds !== undefined
          ? patch.durationSeconds
          : existing.duration_seconds,
        patch.voice ?? existing.voice,
        patch.answeredAt !== undefined
          ? patch.answeredAt
          : existing.answered_at,
        patch.completedAt !== undefined
          ? patch.completedAt
          : existing.completed_at,
        patch.startedAt ?? existing.started_at,
        JSON.stringify(patch.metadata ?? existing.metadata ?? {}),
        timestamp,
        existing.id,
      );
    return this.getDialedCallByPublicRef(existing.public_ref);
  }

  /**
   * Keep dialed_calls in sync when a linked stream_test_calls row changes.
   */
  syncDialedCallFromStationRow(stationRow) {
    if (!stationRow) return null;
    const meta = stationRow.metadata || {};
    const isOutbound =
      meta.source === 'outbound-dialer' ||
      String(stationRow.public_ref || '').startsWith('OB-');
    if (!isOutbound) return null;

    let dialed =
      this.getDialedCallByPublicRef(stationRow.public_ref) ||
      this.getDialedCallByAppCallId(stationRow.app_call_id);
    if (!dialed) {
      dialed = this.createDialedCall({
        publicRef: stationRow.public_ref,
        appCallId: stationRow.app_call_id,
        providerCallId: stationRow.provider_call_id,
        destinationMasked: stationRow.destination_masked,
        didMasked: stationRow.did_masked,
        status: stationRow.status || 'initiated',
        selectedDigit: meta.selectedDigit ?? null,
        interpretedResponse: meta.keypadLabel ?? null,
        durationSeconds: stationRow.duration_seconds,
        voice: meta.voice ?? null,
        startedAt: stationRow.initiated_at || stationRow.requested_at,
        answeredAt: stationRow.answered_at,
        completedAt: stationRow.ended_at,
        metadata: meta,
      });
      return dialed;
    }

    const terminal = ['completed', 'failed', 'rejected', 'busy', 'no_answer', 'cancelled'];
    const status = stationRow.status || dialed.status;
    return this.updateDialedCall(dialed.public_ref, {
      providerCallId: stationRow.provider_call_id,
      destinationMasked: stationRow.destination_masked,
      didMasked: stationRow.did_masked,
      status,
      selectedDigit:
        meta.selectedDigit !== undefined ? meta.selectedDigit : undefined,
      interpretedResponse:
        meta.keypadLabel !== undefined ? meta.keypadLabel : undefined,
      durationSeconds: stationRow.duration_seconds,
      voice: meta.voice ?? undefined,
      answeredAt: stationRow.answered_at,
      completedAt: terminal.includes(String(status).toLowerCase())
        ? stationRow.ended_at || dialed.completed_at || now()
        : stationRow.ended_at,
      startedAt:
        stationRow.initiated_at ||
        stationRow.requested_at ||
        dialed.started_at,
      metadata: meta,
    });
  }

  listDialedCalls({ search = '', status = '', digit = '' } = {}) {
    let rows = this.db
      .prepare('SELECT * FROM dialed_calls ORDER BY created_at DESC')
      .all()
      .map((row) => this.#mapDialedCall(row));

    if (status) {
      const s = String(status).toLowerCase();
      rows = rows.filter((row) => String(row.status).toLowerCase() === s);
    }
    if (digit) {
      rows = rows.filter((row) => String(row.selected_digit || '') === String(digit));
    }
    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter(
        (row) =>
          String(row.public_ref || '').toLowerCase().includes(q) ||
          String(row.destination_masked || '').toLowerCase().includes(q) ||
          String(row.app_call_id || '').toLowerCase().includes(q) ||
          String(row.interpreted_response || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }
}
