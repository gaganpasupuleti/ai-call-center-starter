/**
 * Phase 4F / Stage 1 single-call CLI — fail-closed.
 *
 * Never places a call unless Phase 4F gates + --confirm are satisfied.
 * Never logs credentials or phone numbers.
 * Never retries the outbound request.
 *
 * Cursor / automation must not pass --confirm.
 */
import { getConfig } from '../src/config.js';
import {
  executeSingleVoicebotCall,
  SmartPingLiveCallsDisabledError,
} from '../src/streaming/smartping/request-builder.js';
import {
  buildPhase4fCustomParameters,
  createOneShotFetch,
  generatePhase4fRunId,
  hashApprovalId,
  validatePhase4fLiveGates,
  validatePhase4fPreflightFlags,
  PHASE4F_GREETING_TEXT,
} from '../src/streaming/phase4f/guards.js';

function parseArgs(argv) {
  const args = {
    confirm: false,
    dryRunPreview: false,
    approvalId: null,
    language: 'en',
    appCallId: null,
    skipGreetingPrepare: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === '--confirm') args.confirm = true;
    else if (part === '--dry-run-preview') args.dryRunPreview = true;
    else if (part === '--approval-id' && argv[i + 1]) {
      args.approvalId = argv[++i];
    } else if (part === '--language' && argv[i + 1]) {
      args.language = String(argv[++i]).trim().toLowerCase();
    } else if (part === '--app-call-id' && argv[i + 1]) {
      args.appCallId = argv[++i];
    } else if (part === '--skip-greeting-prepare') {
      args.skipGreetingPrepare = true;
    }
  }
  return args;
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

async function prepareGreetingOnApp({ fetchImpl = globalThis.fetch } = {}) {
  const base = appHttpBase();
  if (!hasValue(base)) {
    throw Object.assign(new Error('App base URL required to prepare greeting'), {
      code: 'app_base_url_missing',
    });
  }
  const res = await fetchImpl(`${base}/api/speech/prepare-greeting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: PHASE4F_GREETING_TEXT,
      source: 'phase4f-cli',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.appCallId) {
    throw Object.assign(
      new Error(json?.code || json?.error || 'greeting_prepare_failed'),
      {
        code: json?.code || 'greeting_prepare_failed',
        statusCode: res.status,
      },
    );
  }
  return json;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const config = getConfig().smartPing;
  const destination = process.env.SMARTPING_TEST_PHONE_NUMBER ?? '';
  const phase4fRunId = generatePhase4fRunId();

  if (!cli.confirm && !cli.dryRunPreview) {
    console.error(
      'Refusing to proceed: pass --dry-run-preview for a redacted preview, or --confirm only after explicit operator approval.',
    );
    process.exit(2);
  }

  if (cli.confirm) {
    const gates = validatePhase4fLiveGates({
      confirm: true,
      approvalId: cli.approvalId,
      language: cli.language,
      env: process.env,
    });
    console.log(
      JSON.stringify(
        {
          event: 'phase4f_live_gate_check',
          ok: gates.ok,
          errors: gates.errors,
          language: gates.language,
          expectedEnvironment: gates.expectedEnvironment,
          maxNetworkRequests: gates.maxNetworkRequests,
          approvalIdHash: gates.approvalIdHash,
          operatorApproved: gates.operatorApproved,
          destinationConsented: gates.destinationConsented,
          voiceReviewed: gates.voiceReviewed,
          phase4fRunId,
        },
        null,
        2,
      ),
    );
    if (!gates.ok) {
      console.error(
        JSON.stringify({
          event: 'single_call_blocked_or_failed',
          error: gates.errors[0] || 'phase4f_gates_failed',
          errors: gates.errors,
          networkRequestMade: false,
        }),
      );
      process.exit(2);
    }
  } else {
    const soft = validatePhase4fPreflightFlags(process.env);
    console.log(
      JSON.stringify(
        {
          event: 'phase4f_dry_run_gate_check',
          ok: soft.ok,
          errors: soft.errors,
          language: soft.language,
          destinationConfigured: soft.destinationConfigured,
          consentConfirmed: soft.destinationConsented,
          voiceReviewed: soft.voiceReviewed,
          phase4fRunId,
          note: 'Dry-run does not require live SmartPing flags or --confirm.',
        },
        null,
        2,
      ),
    );
  }

  if (!hasValue(destination)) {
    console.error('SMARTPING_TEST_PHONE_NUMBER is not set.');
    process.exit(2);
  }

  let appCallId = cli.appCallId;
  let preparedPrompt = Boolean(appCallId);
  if (!cli.skipGreetingPrepare && !appCallId) {
    try {
      const prepared = await prepareGreetingOnApp();
      appCallId = prepared.appCallId;
      preparedPrompt = true;
      console.log(
        JSON.stringify({
          event: 'phase4f_greeting_prepared',
          appCallId,
          provider: prepared.provider ?? null,
          voice: prepared.voice ?? null,
          durationSeconds: prepared.durationSeconds ?? null,
          networkRequestMade: false,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'phase4f_greeting_prepare_failed',
          error: err?.code || err?.message || 'greeting_prepare_failed',
          networkRequestMade: false,
        }),
      );
      if (cli.confirm) {
        process.exit(1);
      }
      // Dry-run may continue with a placeholder only for structure preview.
      appCallId = 'phase4f-preview-missing-greeting';
      preparedPrompt = false;
    }
  }

  if (cli.confirm && !preparedPrompt) {
    console.error(
      JSON.stringify({
        event: 'single_call_blocked_or_failed',
        error: 'greeting_missing',
        networkRequestMade: false,
      }),
    );
    process.exit(1);
  }

  const customParameters = buildPhase4fCustomParameters({
    phase4fRunId,
    appCallId,
    language: cli.language,
  });

  const effectiveConfig = cli.dryRunPreview
    ? { ...config, dryRun: true }
    : config;

  const oneShot = createOneShotFetch(globalThis.fetch);

  try {
    const result = await executeSingleVoicebotCall(effectiveConfig, {
      phoneNumber: destination,
      confirm: cli.confirm === true && !cli.dryRunPreview,
      customParameters,
      requireAppCallId: cli.confirm === true,
      maxNetworkRequests: 1,
      fetchImpl: oneShot,
    });

    console.log(
      JSON.stringify(
        {
          event: 'single_call_result',
          phase4fRunId,
          approvalIdHash: hashApprovalId(cli.approvalId || process.env.PHASE4F_APPROVAL_ID),
          dryRun: result.dryRun === true,
          networkRequestMade: result.networkRequestMade === true,
          singleCall: result.singleCall === true,
          retried: result.retried === true,
          fetchCount: oneShot.getRequestCount(),
          httpStatus: result.httpStatus ?? null,
          responseBodyBytes: result.responseBodyBytes ?? null,
          responseParsePending: result.responseParsePending === true,
          destinationConfigured: result.preview?.destinationConfigured === true,
          didConfigured: result.preview?.didConfigured === true,
          tokenConfigured: result.preview?.tokenConfigured === true,
          streamUrlConfigured: hasValue(config.streamUrl),
          preparedPrompt,
          appCallId,
          redactedPreview: result.preview ?? null,
        },
        null,
        2,
      ),
    );

    if (result.networkRequestMade) {
      console.log('SINGLE_CALL_NETWORK_REQUEST_MADE');
    } else {
      console.log('SINGLE_CALL_DRY_RUN_OK');
    }
  } catch (error) {
    const safeMessage =
      error instanceof SmartPingLiveCallsDisabledError
        ? error.message
        : error?.code || error?.name || 'single_call_failed';
    console.error(
      JSON.stringify({
        event: 'single_call_blocked_or_failed',
        error: safeMessage,
        phase4fRunId,
        networkRequestMade: error?.networkRequestMade === true,
        retried: false,
        fetchCount: oneShot.getRequestCount(),
      }),
    );
    process.exit(1);
  }
}

main();
