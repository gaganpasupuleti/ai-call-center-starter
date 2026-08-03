#!/usr/bin/env node
/**
 * Fail-closed staging validation: exits non-zero if any live-call gate is unsafe.
 * Never prints secret values.
 *
 * Unset variables are treated as the documented safe defaults (same as app config).
 * Explicit unsafe values fail closed.
 */
const REQUIRED = {
  SMARTPING_DRY_RUN: 'true',
  SMARTPING_LIVE_CALLS_ENABLED: 'false',
  SMARTPING_SINGLE_CALL_ENABLED: 'false',
  OUTBOUND_DIALER_LIVE: 'false',
  CALL_PROVIDER: 'mock',
};

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

const failures = [];
for (const [key, expected] of Object.entries(REQUIRED)) {
  const raw = process.env[key];
  const actual =
    raw === undefined || String(raw).trim() === ''
      ? expected // unset → safe default
      : normalize(raw);
  if (actual !== expected) {
    failures.push({
      key,
      expected,
      actual: normalize(raw) === '' ? '<unset>' : normalize(raw),
    });
  }
}

const report = {
  ok: failures.length === 0,
  checked: Object.keys(REQUIRED),
  failures: failures.map((f) => ({
    key: f.key,
    expected: f.expected,
    actual: f.actual,
  })),
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error('NON_LIVE_ENVIRONMENT_UNSAFE');
  process.exit(1);
}
console.error('NON_LIVE_ENVIRONMENT_OK');
