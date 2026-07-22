import { IntegrationPendingError } from '../../providers/smartping-provider.js';

/**
 * SmartPing's VoiceStreaming documentation does not include an outbound
 * success/error response example. Keep parsing isolated until a sample arrives.
 */
export function parseVoicebotCallResponse(_response) {
  throw new IntegrationPendingError(
    'SmartPing outbound response parsing is waiting for an official sample success/error response.',
  );
}

export function extractProviderCallId(_parsedResponse) {
  throw new IntegrationPendingError(
    'SmartPing provider call ID field is undocumented. Waiting for an official sample response.',
  );
}
