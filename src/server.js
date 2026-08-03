import http from 'node:http';
import { getConfig } from './config.js';
import { Repository } from './database.js';
import { createProvider } from './providers/index.js';
import { createApp } from './app.js';
import { StreamSessionManager } from './streaming/session-manager.js';
import { CallStationTracker } from './streaming/call-station-tracker.js';
import { attachVoiceStreaming } from './streaming/websocket-gateway.js';
import { STREAM_PATH } from './streaming/constants.js';
import { getOutboundPromptStore } from './streaming/outbound/prompt-store.js';
import { VoicePipeline } from './streaming/ai/pipeline.js';
import { createTextToSpeechProvider } from './streaming/tts/tts-provider-factory.js';
import { KOKORO_DEFAULT_VOICE } from './streaming/tts/kokoro-voices.js';
import { PIPER_DEFAULT_VOICE } from './streaming/tts/piper-voices.js';

const config = getConfig();
const repository = new Repository(config.databasePath);
const provider = createProvider(config);
const promptStore = getOutboundPromptStore();
const callStation = new CallStationTracker({
  repository,
  config: config.smartPing,
});
const voicePipeline = new VoicePipeline({
  tts: createTextToSpeechProvider(config),
  ttsConfig: config,
  defaultVoice:
    config.voiceTtsProvider === 'kokoro' || config.voiceTtsProvider === 'local'
      ? config.kokoro?.defaultVoice || KOKORO_DEFAULT_VOICE
      : config.voiceTtsProvider === 'piper'
        ? config.piper?.defaultVoice || PIPER_DEFAULT_VOICE
        : null,
});
const sessionManager = new StreamSessionManager({
  repository,
  config: config.smartPing,
  callStation,
  promptStore,
  appConfig: config,
  pipeline: voicePipeline,
});
callStation.setSessionManager(sessionManager);
const acceptingConnections = { current: true };
const server = http.createServer(
  createApp({
    repository,
    provider,
    config,
    sessionManager,
    callStation,
    promptStore,
  }),
);

const { pathname } = attachVoiceStreaming({
  server,
  sessionManager,
  config: config.smartPing,
  acceptingConnections,
});

let shuttingDown = false;

server.listen(config.port, config.host, () => {
  console.log(
    `AI Call Center listening at http://${config.host}:${config.port} (provider: ${provider.name}, exposure=${config.exposureMode})`,
  );
  console.log(`SmartPing voice stream endpoint path: ${pathname || STREAM_PATH}`);
  console.log(
    `SmartPing dry-run=${config.smartPing.dryRun !== false} liveCalls=${config.smartPing.liveCallsEnabled === true} streamAuth=${config.smartPing.streamAuthMode}`,
  );
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  acceptingConnections.current = false;
  console.log(`Received ${signal}; shutting down gracefully`);

  // Stop accepting new HTTP connections and close active sockets/queues.
  sessionManager.closeAll('shutdown');

  // Railway sends SIGTERM on redeploy/stop. Exit 0 after cleanup so
  // replacement shutdowns are not reported as application crashes.
  const exitCode = signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1;

  const forceTimer = setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(exitCode);
  }, 8_000);
  forceTimer.unref?.();

  server.close(() => {
    try {
      repository.close();
    } catch {
      // ignore close races
    }
    clearTimeout(forceTimer);
    process.exit(exitCode);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
