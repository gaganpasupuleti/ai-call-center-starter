/**
 * Phase 4F process-local safeguards (never enable on Railway app).
 */
import { createHash, randomBytes } from 'node:crypto';

export const PHASE4F_GREETING_TEXT =
  'Hello. This is a consented Code Quest automated voice test. You can say send details, call me back, not interested, or do not call. You can also press a keypad option.';

export const PHASE4F_VOICE_SAMPLES = [
  {
    id: 'greeting',
    text: PHASE4F_GREETING_TEXT,
  },
  {
    id: 'send_details',
    text: 'We will send the course details.',
  },
  {
    id: 'callback',
    text: 'We can call you back tomorrow.',
  },
  {
    id: 'closing',
    text: 'Thank you for your time. Goodbye.',
  },
];

export const PHASE4F_SOURCE = 'phase4f-consented-single-call';
export const PHASE4F_MAX_TURNS = 2;
export const PHASE4F_MAX_DURATION_MS = 90_000;
export const PHASE4F_BRANCH = 'phase-4f-controlled-smartping-call';
export const PHASE4F_EXPECTED_ENVIRONMENT = 'speech-e2e';
export const PHASE4F_APP_SERVICE = 'smartping-voice-stream-e2e';

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function envFlagFrom(env, name) {
  const v = String(env[name] ?? '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function generatePhase4fRunId(now = Date.now()) {
  const suffix = randomBytes(3).toString('hex');
  return `p4f-${now}-${suffix}`;
}

export function hashApprovalId(approvalId) {
  if (!hasValue(approvalId)) return null;
  return createHash('sha256')
    .update(String(approvalId).trim())
    .digest('hex')
    .slice(0, 16);
}

/**
 * Validate Phase 4F live-call gate conditions (process-local).
 * Does not print secrets or destinations.
 */
export function validatePhase4fLiveGates({
  confirm = false,
  approvalId = null,
  language = 'en',
  env = process.env,
} = {}) {
  const errors = [];
  const lang = String(language || env.PHASE4F_LANGUAGE || 'en')
    .trim()
    .toLowerCase();
  const expectedEnv = String(
    env.PHASE4F_EXPECTED_ENVIRONMENT || PHASE4F_EXPECTED_ENVIRONMENT,
  )
    .trim()
    .toLowerCase();
  const maxRequests = Number(env.PHASE4F_MAX_NETWORK_REQUESTS ?? 1);
  const approval = approvalId ?? env.PHASE4F_APPROVAL_ID ?? '';
  const railwayEnv = String(env.RAILWAY_ENVIRONMENT || '')
    .trim()
    .toLowerCase();

  if (confirm !== true) errors.push('confirm_required');
  if (!hasValue(approval)) errors.push('approval_id_required');
  if (lang !== 'en') errors.push('language_must_be_en');
  if (!envFlagFrom(env, 'PHASE4F_OPERATOR_APPROVED')) {
    errors.push('operator_approval_required');
  }
  if (!envFlagFrom(env, 'PHASE4F_DESTINATION_CONSENTED')) {
    errors.push('destination_consent_required');
  }
  if (!envFlagFrom(env, 'PHASE4F_ENGLISH_VOICE_REVIEWED')) {
    errors.push('voice_review_required');
  }
  if (expectedEnv !== 'speech-e2e') {
    errors.push('environment_must_be_speech_e2e');
  }
  if (railwayEnv === 'production' || expectedEnv === 'production') {
    errors.push('production_environment_rejected');
  }
  if (!Number.isFinite(maxRequests) || maxRequests !== 1) {
    errors.push('max_network_requests_must_be_1');
  }
  if (
    confirm === true &&
    String(env.SMARTPING_DRY_RUN ?? 'true').toLowerCase() !== 'false'
  ) {
    errors.push('smartping_dry_run_must_be_false');
  }
  if (confirm === true && !envFlagFrom(env, 'SMARTPING_LIVE_CALLS_ENABLED')) {
    errors.push('smartping_live_calls_required');
  }
  if (confirm === true && !envFlagFrom(env, 'SMARTPING_SINGLE_CALL_ENABLED')) {
    errors.push('smartping_single_call_required');
  }

  return {
    ok: errors.length === 0,
    errors,
    language: lang,
    expectedEnvironment: expectedEnv,
    maxNetworkRequests: maxRequests,
    approvalIdHash: hashApprovalId(approval),
    operatorApproved: envFlagFrom(env, 'PHASE4F_OPERATOR_APPROVED'),
    destinationConsented: envFlagFrom(env, 'PHASE4F_DESTINATION_CONSENTED'),
    voiceReviewed: envFlagFrom(env, 'PHASE4F_ENGLISH_VOICE_REVIEWED'),
  };
}

/**
 * Soft validation for dry-run / preflight (does not require live SmartPing flags).
 */
export function validatePhase4fPreflightFlags(env = process.env) {
  const errors = [];
  const lang = String(env.PHASE4F_LANGUAGE || 'en')
    .trim()
    .toLowerCase();
  const expectedEnv = String(
    env.PHASE4F_EXPECTED_ENVIRONMENT || PHASE4F_EXPECTED_ENVIRONMENT,
  )
    .trim()
    .toLowerCase();
  const maxRequests = Number(env.PHASE4F_MAX_NETWORK_REQUESTS ?? 1);
  const railwayEnv = String(env.RAILWAY_ENVIRONMENT || '')
    .trim()
    .toLowerCase();

  if (lang !== 'en') errors.push('language_must_be_en');
  if (expectedEnv !== 'speech-e2e') errors.push('environment_must_be_speech_e2e');
  if (railwayEnv === 'production' || expectedEnv === 'production') {
    errors.push('production_environment_rejected');
  }
  if (!Number.isFinite(maxRequests) || maxRequests !== 1) {
    errors.push('max_network_requests_must_be_1');
  }
  if (!envFlagFrom(env, 'PHASE4F_DESTINATION_CONSENTED')) {
    errors.push('destination_consent_required');
  }
  if (!envFlagFrom(env, 'PHASE4F_ENGLISH_VOICE_REVIEWED')) {
    errors.push('voice_review_required');
  }

  return {
    ok: errors.length === 0,
    errors,
    language: lang,
    expectedEnvironment: expectedEnv,
    maxNetworkRequests: maxRequests,
    destinationConsented: envFlagFrom(env, 'PHASE4F_DESTINATION_CONSENTED'),
    voiceReviewed: envFlagFrom(env, 'PHASE4F_ENGLISH_VOICE_REVIEWED'),
    operatorApproved: envFlagFrom(env, 'PHASE4F_OPERATOR_APPROVED'),
    destinationConfigured: hasValue(env.SMARTPING_TEST_PHONE_NUMBER),
    didConfigured: hasValue(env.SMARTPING_DID_NUMBER),
    tokenConfigured: hasValue(env.SMARTPING_API_TOKEN),
    streamUrlConfigured: hasValue(env.SMARTPING_STREAM_URL),
  };
}

export function buildPhase4fCustomParameters({
  phase4fRunId,
  appCallId,
  language = 'en',
}) {
  return {
    source: PHASE4F_SOURCE,
    phase4f_run_id: phase4fRunId,
    language: language === 'te' ? 'te' : 'en',
    interaction_mode: 'voice-dtmf',
    consented_test: 'true',
    app_call_id: appCallId,
  };
}

export function isPhase4fSession(session) {
  const params = session?.customParameters || {};
  return (
    String(params.source || '') === PHASE4F_SOURCE ||
    Boolean(params.phase4f_run_id)
  );
}

/**
 * Single-flight fetch wrapper: at most one network call; never retries.
 */
export function createOneShotFetch(fetchImpl = globalThis.fetch) {
  let used = 0;
  const wrapped = async (...args) => {
    if (used >= 1) {
      throw Object.assign(new Error('phase4f_max_network_requests_exceeded'), {
        code: 'phase4f_max_network_requests_exceeded',
        statusCode: 429,
      });
    }
    used += 1;
    return fetchImpl(...args);
  };
  wrapped.getRequestCount = () => used;
  return wrapped;
}
