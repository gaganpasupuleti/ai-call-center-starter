/**
 * Phase 4F-A no-call preflight.
 * Never places a SmartPing outbound request.
 */
import { execSync } from 'node:child_process';
import {
  PHASE4F_APP_SERVICE,
  PHASE4F_BRANCH,
  PHASE4F_EXPECTED_ENVIRONMENT,
  PHASE4F_GREETING_TEXT,
  validatePhase4fPreflightFlags,
} from '../src/streaming/phase4f/guards.js';

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function flag(name) {
  const v = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function appHttpBase() {
  const fromEnv =
    process.env.PHASE4F_APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.SMARTPING_APP_BASE_URL ||
    '';
  if (hasValue(fromEnv)) return String(fromEnv).replace(/\/+$/, '');
  const stream = process.env.SMARTPING_STREAM_URL || '';
  try {
    const u = new URL(stream.replace(/^ws/i, 'http'));
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function gitBranch() {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function fetchJson(url, { method = 'GET', body = null, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const errors = [];
  const warnings = [];
  let networkRequestMade = false;

  const branch = gitBranch();
  if (branch !== PHASE4F_BRANCH) {
    errors.push(`git_branch_expected_${PHASE4F_BRANCH}_got_${branch || 'unknown'}`);
  }

  const soft = validatePhase4fPreflightFlags(process.env);
  if (!soft.ok) errors.push(...soft.errors);

  const expectedEnv = String(
    process.env.PHASE4F_EXPECTED_ENVIRONMENT || PHASE4F_EXPECTED_ENVIRONMENT,
  )
    .trim()
    .toLowerCase();
  if (expectedEnv !== 'speech-e2e') {
    errors.push('environment_must_be_speech_e2e');
  }

  const appService = String(
    process.env.PHASE4F_APP_SERVICE || PHASE4F_APP_SERVICE,
  ).trim();
  if (appService !== PHASE4F_APP_SERVICE) {
    errors.push('app_service_must_be_smartping_voice_stream_e2e');
  }

  if (!hasValue(process.env.SMARTPING_STREAM_URL)) {
    errors.push('stream_url_missing');
  }

  // Railway app live outbound flags must remain false in this process view
  // (operator also confirms via Railway dashboard / variables).
  if (flag('SMARTPING_LIVE_CALLS_ENABLED') && !flag('PHASE4F_ALLOW_LOCAL_LIVE_VIEW')) {
    // Process-local .env.phase4f may set live flags for the CLI; that is OK.
    // Preflight only fails if the *app* check below reports live=true.
  }

  const base = appHttpBase();
  let healthOk = false;
  let speechReadiness = false;
  let preparedPrompt = false;
  let railwayLiveFlagsSafe = null;
  let voiceTtsProvider = null;
  let englishVoice = null;
  let englishSpeakerId = null;
  let voiceConversationEnabled = null;
  let interactionMode = null;
  let sttReachable = null;
  let piperReachable = null;

  if (!hasValue(base)) {
    errors.push('app_base_url_missing');
  } else {
    const health = await fetchJson(`${base}/healthz`);
    healthOk = health.ok && health.json?.status === 'ok';
    if (!healthOk) errors.push('healthz_unhealthy');
    if (health.json?.liveCallsEnabled === true) {
      errors.push('app_healthz_reports_live_calls');
      railwayLiveFlagsSafe = false;
    } else if (healthOk) {
      railwayLiveFlagsSafe = true;
    }

    const settings = await fetchJson(`${base}/api/settings`);
    if (settings.ok) {
      const s = settings.json || {};
      voiceTtsProvider = s.voiceTtsProvider ?? s.ttsProvider ?? null;
      voiceConversationEnabled = s.voiceConversationEnabled ?? null;
      interactionMode = s.voiceInteractionMode ?? null;
      if (s.liveCallsEnabled === true || s.smartPingLiveCallsEnabled === true) {
        errors.push('app_settings_live_calls_enabled');
        railwayLiveFlagsSafe = false;
      }
      if (s.outboundDialerLive === true) {
        errors.push('app_outbound_dialer_live');
        railwayLiveFlagsSafe = false;
      }
      if (s.callProvider && s.callProvider !== 'mock') {
        warnings.push('call_provider_not_mock');
      }
    } else {
      warnings.push('settings_unreachable_stream_only_ok');
    }

    const readiness = await fetchJson(`${base}/api/speech/readiness`);
    speechReadiness = readiness.ok && readiness.json?.ready === true;
    if (!speechReadiness) errors.push('speech_readiness_not_ready');
    const r = readiness.json || {};
    voiceTtsProvider = voiceTtsProvider || r.mode || null;
    englishVoice = r.piperEnglishVoice || null;
    englishSpeakerId = r.piperEnglishSpeakerId ?? null;
    voiceConversationEnabled =
      voiceConversationEnabled ?? r.voiceConversationEnabled ?? null;
    interactionMode = interactionMode || r.voiceInteractionMode || null;
    sttReachable = r.services?.stt?.reachable ?? null;
    piperReachable =
      r.services?.englishTts?.reachable ??
      r.services?.teluguTts?.reachable ??
      null;
    if (r.requiredServices?.stt === true && sttReachable === false) {
      errors.push('stt_unreachable');
    }
    if (r.requiredServices?.piper === true && piperReachable === false) {
      errors.push('piper_unreachable');
    }
    if (String(voiceTtsProvider || '').toLowerCase() !== 'local-cpu') {
      errors.push('voice_tts_provider_must_be_local_cpu');
    }
    if (!hasValue(String(englishVoice || ''))) {
      errors.push('english_voice_not_configured');
    }
    if (englishSpeakerId == null || Number.isNaN(Number(englishSpeakerId))) {
      errors.push('english_speaker_id_not_configured');
    }
    if (voiceConversationEnabled !== true) {
      errors.push('voice_conversation_not_enabled');
    }
    if (String(interactionMode || '') !== 'voice-dtmf') {
      errors.push('interaction_mode_must_be_voice_dtmf');
    }

    // Prepare greeting on the app (local TTS + prompt store) — not SmartPing outbound.
    const greeting = await fetchJson(`${base}/api/speech/prepare-greeting`, {
      method: 'POST',
      body: { text: PHASE4F_GREETING_TEXT, source: 'phase4f-preflight' },
      timeoutMs: 60_000,
    });
    preparedPrompt = Boolean(greeting.ok && greeting.json?.appCallId);
    if (!preparedPrompt) {
      errors.push(
        greeting.json?.code || greeting.json?.error || 'greeting_prepare_failed',
      );
    }
  }

  if (!soft.destinationConsented) errors.push('consent_flag_false');
  if (!soft.voiceReviewed) errors.push('voice_review_flag_false');
  if (!soft.destinationConfigured) errors.push('destination_not_configured');
  if (!soft.didConfigured) errors.push('did_not_configured');
  if (!soft.tokenConfigured) errors.push('token_not_configured');
  if (soft.maxNetworkRequests !== 1) errors.push('max_network_requests_not_1');

  const ok = errors.length === 0;
  const report = {
    ok,
    environment: expectedEnv,
    language: soft.language,
    branch,
    application: appService,
    destinationConfigured: soft.destinationConfigured,
    didConfigured: soft.didConfigured,
    tokenConfigured: soft.tokenConfigured,
    streamUrlConfigured: soft.streamUrlConfigured,
    consentConfirmed: soft.destinationConsented,
    voiceReviewed: soft.voiceReviewed,
    operatorApproved: soft.operatorApproved,
    speechReadiness,
    healthOk,
    preparedPrompt,
    voiceTtsProvider,
    englishVoice,
    englishSpeakerId,
    voiceConversationEnabled,
    interactionMode,
    sttReachable,
    piperReachable,
    railwayLiveFlagsSafe,
    maxNetworkRequests: soft.maxNetworkRequests,
    networkRequestMade,
    errors,
    warnings,
  };

  console.log(JSON.stringify(report, null, 2));
  if (ok) {
    console.log('PHASE4F_PREFLIGHT_OK');
    process.exit(0);
  }
  console.error('PHASE4F_PREFLIGHT_FAILED');
  process.exit(1);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: err?.code || err?.message || 'preflight_crashed',
      networkRequestMade: false,
    }),
  );
  console.error('PHASE4F_PREFLIGHT_FAILED');
  process.exit(1);
});
