/**
 * Stage 1 single-call CLI — fail-closed.
 *
 * Never places a call unless:
 * - SMARTPING_DRY_RUN=false
 * - SMARTPING_LIVE_CALLS_ENABLED=true
 * - SMARTPING_SINGLE_CALL_ENABLED=true
 * - --confirm is passed
 * - destination / DID / base URL / token come from environment
 *
 * Does not log credentials or phone numbers.
 */
import { getConfig } from '../src/config.js';
import {
  executeSingleVoicebotCall,
  SmartPingLiveCallsDisabledError,
} from '../src/streaming/smartping/request-builder.js';

function parseArgs(argv) {
  const args = { confirm: false, dryRunPreview: false };
  for (const part of argv) {
    if (part === '--confirm') args.confirm = true;
    if (part === '--dry-run-preview') args.dryRunPreview = true;
  }
  return args;
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const config = getConfig().smartPing;

  const destination = process.env.SMARTPING_TEST_PHONE_NUMBER ?? '';
  const checks = {
    baseUrlConfigured: hasValue(config.baseUrl),
    didConfigured: hasValue(config.didNumber),
    tokenConfigured: hasValue(config.apiToken),
    streamUrlConfigured: hasValue(config.streamUrl),
    destinationConfigured: hasValue(destination),
    dryRun: config.dryRun !== false,
    liveCallsEnabled: config.liveCallsEnabled === true,
    singleCallEnabled: config.singleCallEnabled === true,
    confirm: cli.confirm === true,
    playbackMode: config.playbackMode,
  };

  console.log(
    JSON.stringify(
      {
        event: 'single_call_precheck',
        ...checks,
        note: 'Destination and secrets are read from env only and are never printed.',
      },
      null,
      2,
    ),
  );

  if (!cli.confirm && !cli.dryRunPreview) {
    console.error(
      'Refusing to proceed: pass --dry-run-preview for a redacted preview, or --confirm only after explicit approval.',
    );
    process.exit(2);
  }

  if (!checks.destinationConfigured) {
    console.error('SMARTPING_TEST_PHONE_NUMBER is not set.');
    process.exit(2);
  }

  const effectiveConfig = cli.dryRunPreview
    ? { ...config, dryRun: true }
    : config;

  try {
    const result = await executeSingleVoicebotCall(effectiveConfig, {
      phoneNumber: destination,
      confirm: cli.confirm === true && !cli.dryRunPreview,
      customParameters: {
        app_call_id: 'stage1-single-call',
        source: 'place-test-call-cli',
      },
    });

    console.log(
      JSON.stringify(
        {
          event: 'single_call_result',
          dryRun: result.dryRun === true,
          networkRequestMade: result.networkRequestMade === true,
          singleCall: result.singleCall === true,
          httpStatus: result.httpStatus ?? null,
          responseBodyBytes: result.responseBodyBytes ?? null,
          responseParsePending: result.responseParsePending === true,
          destinationConfigured: result.preview?.destinationConfigured === true,
          didConfigured: result.preview?.didConfigured === true,
          tokenConfigured: result.preview?.tokenConfigured === true,
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
        networkRequestMade: false,
      }),
    );
    process.exit(1);
  }
}

main();
