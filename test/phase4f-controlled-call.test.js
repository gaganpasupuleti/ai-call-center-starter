import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase4fCustomParameters,
  createOneShotFetch,
  generatePhase4fRunId,
  hashApprovalId,
  isPhase4fSession,
  validatePhase4fLiveGates,
  validatePhase4fPreflightFlags,
  PHASE4F_MAX_DURATION_MS,
  PHASE4F_MAX_TURNS,
  PHASE4F_SOURCE,
} from '../src/streaming/phase4f/guards.js';
import {
  executeSingleVoicebotCall,
  executeVoicebotCall,
  SmartPingLiveCallsDisabledError,
  toRedactedRequestPreview,
  buildVoicebotCallRequest,
} from '../src/streaming/smartping/request-builder.js';
import { matchIntent } from '../src/streaming/response/intent-matcher.js';
import { ResponseActionExecutor } from '../src/streaming/actions/response-action-executor.js';
import { VoiceConversationController } from '../src/streaming/conversation/controller.js';
import { COMPLETION_REASONS } from '../src/streaming/conversation/lifecycle.js';
import { validateGreetingMulaw } from '../src/streaming/phase4f/prepare-greeting.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'tok_phase4f_secret_do_not_leak';
const PHONE = '+919811112222';

function phase4fEnv(overrides = {}) {
  return {
    PHASE4F_OPERATOR_APPROVED: 'true',
    PHASE4F_DESTINATION_CONSENTED: 'true',
    PHASE4F_ENGLISH_VOICE_REVIEWED: 'true',
    PHASE4F_EXPECTED_ENVIRONMENT: 'speech-e2e',
    PHASE4F_LANGUAGE: 'en',
    PHASE4F_MAX_NETWORK_REQUESTS: '1',
    PHASE4F_APPROVAL_ID: 'approval-test-001',
    SMARTPING_DRY_RUN: 'false',
    SMARTPING_LIVE_CALLS_ENABLED: 'true',
    SMARTPING_SINGLE_CALL_ENABLED: 'true',
    ...overrides,
  };
}

test('phase4f defaults / dry-run never make a network request', async () => {
  let fetched = false;
  const result = await executeSingleVoicebotCall(
    {
      baseUrl: 'https://smartping.example',
      outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
      apiToken: SECRET,
      didNumber: '08000000000',
      streamUrl: 'wss://example.com/ws/voice/smartping',
      dryRun: true,
      liveCallsEnabled: false,
      singleCallEnabled: false,
    },
    {
      phoneNumber: PHONE,
      confirm: false,
      customParameters: { app_call_id: 'p4f-test' },
      fetchImpl: async () => {
        fetched = true;
        return { status: 200, text: async () => '{}' };
      },
    },
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.networkRequestMade, false);
  assert.equal(fetched, false);
});

test('consent flag is mandatory for live gates', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: 'a1',
    language: 'en',
    env: phase4fEnv({ PHASE4F_DESTINATION_CONSENTED: 'false' }),
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.includes('destination_consent_required'));
});

test('operator approval flag is mandatory', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: 'a1',
    language: 'en',
    env: phase4fEnv({ PHASE4F_OPERATOR_APPROVED: 'false' }),
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.includes('operator_approval_required'));
});

test('human voice-review flag is mandatory', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: 'a1',
    language: 'en',
    env: phase4fEnv({ PHASE4F_ENGLISH_VOICE_REVIEWED: 'false' }),
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.includes('voice_review_required'));
  const soft = validatePhase4fPreflightFlags(
    phase4fEnv({ PHASE4F_ENGLISH_VOICE_REVIEWED: 'false' }),
  );
  assert.equal(soft.ok, false);
  assert.ok(soft.errors.includes('voice_review_required'));
});

test('approval ID is mandatory', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: '',
    language: 'en',
    env: phase4fEnv({ PHASE4F_APPROVAL_ID: '' }),
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.includes('approval_id_required'));
  assert.equal(hashApprovalId(''), null);
  assert.equal(hashApprovalId('abc').length, 16);
});

test('English is the only Phase 4F language', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: 'a1',
    language: 'te',
    env: phase4fEnv(),
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.includes('language_must_be_en'));
});

test('production environment is rejected', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: 'a1',
    language: 'en',
    env: phase4fEnv({
      PHASE4F_EXPECTED_ENVIRONMENT: 'production',
    }),
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.includes('production_environment_rejected'));
});

test('maximum network request count must equal one', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: 'a1',
    language: 'en',
    env: phase4fEnv({ PHASE4F_MAX_NETWORK_REQUESTS: '2' }),
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.includes('max_network_requests_must_be_1'));
});

test('dry-run preview CLI makes zero requests', () => {
  const cli = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'place-test-call.mjs'),
      '--dry-run-preview',
      '--skip-greeting-prepare',
      '--app-call-id',
      'preview-app-call',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SMARTPING_BASE_URL: 'https://smartping.example',
        SMARTPING_API_TOKEN: SECRET,
        SMARTPING_DID_NUMBER: '08000000000',
        SMARTPING_TEST_PHONE_NUMBER: PHONE,
        SMARTPING_STREAM_URL: 'wss://example.com/ws/voice/smartping',
        SMARTPING_DRY_RUN: 'true',
        SMARTPING_LIVE_CALLS_ENABLED: 'false',
        SMARTPING_SINGLE_CALL_ENABLED: 'false',
        PHASE4F_DESTINATION_CONSENTED: 'true',
        PHASE4F_ENGLISH_VOICE_REVIEWED: 'true',
        PHASE4F_EXPECTED_ENVIRONMENT: 'speech-e2e',
        PHASE4F_LANGUAGE: 'en',
        PHASE4F_MAX_NETWORK_REQUESTS: '1',
      },
    },
  );
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /SINGLE_CALL_DRY_RUN_OK/);
  assert.equal(cli.stdout.includes(SECRET), false);
  assert.equal(cli.stderr.includes(SECRET), false);
  assert.equal(cli.stdout.includes(PHONE), false);
  assert.equal(cli.stderr.includes(PHONE), false);
  assert.match(cli.stdout, /"networkRequestMade": false/);
  assert.match(cli.stdout, /"dryRun": true/);
});

test('missing greeting prevents the live request', async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      executeSingleVoicebotCall(
        {
          baseUrl: 'https://smartping.example',
          outboundPath: '/x',
          apiToken: SECRET,
          didNumber: '08000000000',
          streamUrl: 'wss://example.com/ws',
          dryRun: false,
          liveCallsEnabled: true,
          singleCallEnabled: true,
        },
        {
          phoneNumber: PHONE,
          confirm: true,
          customParameters: {},
          requireAppCallId: true,
          maxNetworkRequests: 1,
          fetchImpl: async () => {
            fetched = true;
            return { status: 200, text: async () => '{}' };
          },
        },
      ),
    (err) => err?.code === 'greeting_missing',
  );
  assert.equal(fetched, false);
});

test('invalid greeting audio is rejected by validator', () => {
  const silence = Buffer.alloc(8000, 0xff);
  const bad = validateGreetingMulaw(silence);
  assert.equal(bad.valid, false);
  assert.ok(['silence_only', 'empty', 'too_short'].includes(bad.reason));
});

test('campaign executor remains blocked', async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      executeVoicebotCall(
        {
          baseUrl: 'https://smartping.example',
          outboundPath: '/x',
          apiToken: SECRET,
          didNumber: '08000000000',
          streamUrl: 'wss://example.com/ws',
          dryRun: false,
          liveCallsEnabled: true,
        },
        {
          phoneNumber: PHONE,
          fetchImpl: async () => {
            fetched = true;
            return { status: 200, text: async () => '{}' };
          },
        },
      ),
    (err) => err instanceof SmartPingLiveCallsDisabledError,
  );
  assert.equal(fetched, false);
});

test('single-call executor performs at most one fetch and never retries', async () => {
  let fetches = 0;
  const oneShot = createOneShotFetch(async () => {
    fetches += 1;
    return { status: 500, text: async () => 'err' };
  });
  const result = await executeSingleVoicebotCall(
    {
      baseUrl: 'https://smartping.example',
      outboundPath: '/x',
      apiToken: SECRET,
      didNumber: '08000000000',
      streamUrl: 'wss://example.com/ws',
      dryRun: false,
      liveCallsEnabled: true,
      singleCallEnabled: true,
    },
    {
      phoneNumber: PHONE,
      confirm: true,
      customParameters: { app_call_id: 'ready' },
      requireAppCallId: true,
      maxNetworkRequests: 1,
      fetchImpl: oneShot,
    },
  );
  assert.equal(result.networkRequestMade, true);
  assert.equal(result.retried, false);
  assert.equal(result.httpStatus, 500);
  assert.equal(fetches, 1);
  assert.equal(oneShot.getRequestCount(), 1);
  await assert.rejects(() => oneShot('https://example.com'), (err) =>
    /phase4f_max_network_requests_exceeded/.test(err.message),
  );
});

test('phone numbers and tokens remain redacted', () => {
  const request = buildVoicebotCallRequest({
    baseUrl: 'https://smartping.example',
    outboundPath: '/x',
    apiToken: SECRET,
    phoneNumber: PHONE,
    didNumber: '08000000000',
    streamUrl: 'wss://example.com/ws',
    customParameters: buildPhase4fCustomParameters({
      phase4fRunId: 'p4f-1',
      appCallId: 'app-1',
    }),
  });
  const preview = toRedactedRequestPreview(request);
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PHONE), false);
  assert.equal(preview.body.phone_number, '[REDACTED]');
  assert.equal(preview.body.did_number, '[REDACTED]');
  assert.ok(!JSON.stringify(preview.body.channel_vars).includes(PHONE));
});

test('unique Phase 4F run ID is passed in custom parameters', () => {
  const runId = generatePhase4fRunId();
  assert.match(runId, /^p4f-\d+-[a-f0-9]+$/);
  const params = buildPhase4fCustomParameters({
    phase4fRunId: runId,
    appCallId: 'app-xyz',
    language: 'en',
  });
  assert.equal(params.source, PHASE4F_SOURCE);
  assert.equal(params.phase4f_run_id, runId);
  assert.equal(params.language, 'en');
  assert.equal(params.consented_test, 'true');
  assert.equal(params.app_call_id, 'app-xyz');
  assert.equal('phone_number' in params, false);
  assert.equal('approval_id' in params, false);
  assert.equal(isPhase4fSession({ customParameters: params }), true);
});

test('maximum two turns is enforced for phase4f sessions', async () => {
  assert.equal(PHASE4F_MAX_TURNS, 2);
  const finished = [];
  const controller = new VoiceConversationController({
    appConfig: {
      voiceConversationEnabled: true,
      voiceInteractionMode: 'voice-dtmf',
      voiceMaxTurns: 6,
    },
    hangup: () => {},
    closeSession: () => {},
    actionExecutor: new ResponseActionExecutor({ liveCallsEnabled: false }),
  });
  const session = {
    state: 'active',
    customParameters: {
      source: PHASE4F_SOURCE,
      phase4f_run_id: 'p4f-test',
    },
    metadata: { conversationTurn: 1 },
  };
  const out = await controller.processTurn(session, {
    reply: { intent: 'SEND_DETAILS', nextState: 'waiting_for_demo_interest' },
    actions: [],
  });
  assert.equal(session.metadata.conversationTurn, 2);
  assert.equal(out.forceCloseReason, COMPLETION_REASONS.MAX_TURNS);
  void finished;
});

test('maximum 90-second call duration constant is set', () => {
  assert.equal(PHASE4F_MAX_DURATION_MS, 90_000);
  assert.equal(COMPLETION_REASONS.PHASE4F_MAX_DURATION, 'phase4f_max_duration');
});

test('human transfer remains simulated when live gates closed', () => {
  const session = { metadata: {}, customParameters: {} };
  const executor = new ResponseActionExecutor({ liveCallsEnabled: false });
  const out = executor.execute(
    [{ type: 'transfer_queue', queue: 'admissions' }],
    session,
  );
  assert.equal(out.transferRequested, true);
  assert.equal(out.results[0].simulated, true);
});

test('follow-up action does not send a message', () => {
  const session = { metadata: {}, customParameters: {} };
  const executor = new ResponseActionExecutor({ liveCallsEnabled: false });
  const out = executor.execute(
    [{ type: 'create_follow_up', channel: 'whatsapp' }],
    session,
  );
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].recorded, true);
  assert.equal(session.metadata.recordedActions[0].live, false);
});

test('terminal stop / hang-up phrases map to DO_NOT_CALL', () => {
  for (const phrase of [
    'stop',
    'end the call',
    'hang up',
    'do not call',
    'do not call me again',
  ]) {
    const result = matchIntent(phrase, { language: 'en' });
    assert.equal(result.intent, 'DO_NOT_CALL', phrase);
  }
  assert.equal(
    matchIntent('not interested', { language: 'en' }).intent,
    'NOT_INTERESTED',
  );
});

test('live gates pass only when all phase4f conditions present', () => {
  const gates = validatePhase4fLiveGates({
    confirm: true,
    approvalId: 'ops-2026-07-30-a',
    language: 'en',
    env: phase4fEnv(),
  });
  assert.equal(gates.ok, true);
  assert.equal(gates.approvalIdHash.length, 16);
});

test('CLI without confirm or dry-run exits non-zero and places zero calls', () => {
  const cli = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'place-test-call.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SMARTPING_TEST_PHONE_NUMBER: PHONE,
        SMARTPING_API_TOKEN: SECRET,
      },
    },
  );
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout.includes(PHONE), false);
  assert.equal(cli.stderr.includes(SECRET), false);
});
