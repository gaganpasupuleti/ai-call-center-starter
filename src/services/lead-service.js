import { normalizeConsentStatus } from '../constants.js';
import { validatePhone } from '../http.js';

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).trim()).filter(Boolean);
  }
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  return value
    .split(/[|,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', ''].includes(normalized)) return false;
  return fallback;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeHeader(header) {
  return header.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const HEADER_ALIASES = {
  name: 'name',
  full_name: 'name',
  phone: 'phone',
  phone_number: 'phone',
  email: 'email',
  email_address: 'email',
  language: 'language',
  tags: 'tags',
  source: 'source',
  consent: 'consent',
  consent_status: 'consent_status',
  do_not_call: 'do_not_call',
  dnc: 'do_not_call',
  notes: 'notes',
};

export class LeadService {
  constructor({ repository }) {
    this.repository = repository;
  }

  normalizeLeadInput(body, { partial = false } = {}) {
    const name =
      body.name === undefined
        ? undefined
        : String(body.name ?? '').trim();
    const phone =
      body.phone === undefined
        ? undefined
        : String(body.phone ?? '').trim();

    if (!partial || body.name !== undefined) {
      if (!name) {
        throw Object.assign(new Error('name is required'), { statusCode: 400 });
      }
    }
    if (!partial || body.phone !== undefined) {
      if (!phone) {
        throw Object.assign(new Error('phone is required'), { statusCode: 400 });
      }
      if (!validatePhone(phone)) {
        throw Object.assign(
          new Error('phone must use E.164 format, for example +919876543210'),
          { statusCode: 400 },
        );
      }
    }

    const hasConsentInput =
      body.consentStatus !== undefined ||
      body.consent_status !== undefined ||
      typeof body.consent === 'boolean';
    const consentStatus = hasConsentInput
      ? normalizeConsentStatus(body.consentStatus ?? body.consent_status, {
          consentBoolean:
            typeof body.consent === 'boolean' ? body.consent : undefined,
        })
      : partial
        ? undefined
        : 'pending';

    return {
      name,
      phone,
      email: body.email === undefined ? undefined : body.email?.trim() || null,
      language:
        body.language === undefined ? undefined : body.language?.trim() || null,
      tags: body.tags === undefined ? undefined : parseTags(body.tags),
      source: body.source === undefined ? undefined : body.source?.trim() || null,
      consentStatus,
      consentTimestamp:
        body.consentTimestamp === undefined
          ? undefined
          : body.consentTimestamp || null,
      doNotCall:
        body.doNotCall === undefined && body.do_not_call === undefined
          ? undefined
          : parseBoolean(body.doNotCall ?? body.do_not_call, false),
      notes: body.notes === undefined ? undefined : body.notes?.trim() || null,
    };
  }

  createLead(body) {
    const input = this.normalizeLeadInput(body);
    return this.repository.createLead(input);
  }

  updateLead(id, body) {
    const existing = this.repository.getLead(id);
    if (!existing) {
      throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
    }
    const input = this.normalizeLeadInput(body, { partial: true });
    return this.repository.updateLead(id, input);
  }

  importCsv(csvText) {
    if (typeof csvText !== 'string' || csvText.trim().length === 0) {
      throw Object.assign(new Error('CSV content is required'), { statusCode: 400 });
    }

    const lines = csvText
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 2) {
      throw Object.assign(new Error('CSV must include a header row and at least one data row'), {
        statusCode: 400,
      });
    }

    const headers = splitCsvLine(lines[0]).map(normalizeHeader);
    const fields = headers.map((header) => HEADER_ALIASES[header] ?? null);
    if (!fields.includes('name') || !fields.includes('phone')) {
      throw Object.assign(
        new Error('CSV must include name and phone columns'),
        { statusCode: 400 },
      );
    }

    const imported = [];
    const skipped = [];
    const failed = [];

    for (let index = 1; index < lines.length; index += 1) {
      const rowNumber = index + 1;
      const cells = splitCsvLine(lines[index]);
      const row = {};
      fields.forEach((field, fieldIndex) => {
        if (!field) return;
        row[field] = cells[fieldIndex] ?? '';
      });

      try {
        if (this.repository.getLeadByPhone(row.phone?.trim())) {
          skipped.push({
            row: rowNumber,
            phone: row.phone,
            reason: 'Duplicate phone number',
          });
          continue;
        }

        const consentRaw = row.consent_status || row.consent;
        let consentBoolean;
        let consentStatus;
        if (typeof consentRaw === 'string' && consentRaw.trim()) {
          const normalized = consentRaw.trim().toLowerCase();
          if (['true', 'yes', 'y', '1', 'granted'].includes(normalized)) {
            consentStatus = 'granted';
          } else if (['false', 'no', 'n', '0', 'pending', 'missing'].includes(normalized)) {
            consentStatus = 'pending';
          } else {
            consentStatus = normalizeConsentStatus(normalized);
          }
        } else {
          consentBoolean = false;
          consentStatus = 'pending';
        }

        const lead = this.createLead({
          name: row.name,
          phone: row.phone,
          email: row.email,
          language: row.language,
          tags: row.tags,
          source: row.source || 'csv-import',
          consentStatus,
          consent: consentBoolean,
          doNotCall: row.do_not_call,
          notes: row.notes,
        });
        imported.push({ row: rowNumber, id: lead.id, phone: lead.phone });
      } catch (error) {
        failed.push({
          row: rowNumber,
          phone: row.phone || null,
          reason: error.message,
        });
      }
    }

    return {
      imported: imported.length,
      skipped: skipped.length,
      failed: failed.length,
      importedRows: imported,
      skippedRows: skipped,
      failedRows: failed,
    };
  }
}
