import { getCombinedTtsHealth } from '../tts/tts-provider-factory.js';
import { globalSpeechMetrics } from './metrics.js';

/**
 * Safe speech dependency readiness (no private URLs or tokens).
 */
export async function getSpeechReadiness(config = {}, { fetchImpl } = {}) {
  const sttMock = (config.voiceSttProvider || 'mock') === 'mock';
  const ttsMock = (config.voiceTtsProvider || 'mock') === 'mock';
  const mode = ttsMock ? 'mock' : config.voiceTtsProvider || 'mock';

  const result = {
    mode,
    ready: true,
    voiceConversationEnabled: config.voiceConversationEnabled === true,
    voiceInteractionMode: config.voiceInteractionMode || 'dtmf',
    services: {
      stt: {
        configured: sttMock ? true : Boolean(config.stt?.streamUrl),
        reachable: sttMock ? true : null,
        ready: sttMock ? true : null,
        provider: sttMock ? 'mock' : 'faster-whisper-streaming',
      },
      englishTts: {
        provider: ttsMock ? 'mock' : 'kokoro',
        configured: ttsMock ? true : Boolean(config.kokoro?.baseUrl),
        reachable: ttsMock ? true : null,
      },
      teluguTts: {
        provider: ttsMock ? 'mock' : 'piper',
        configured: ttsMock ? true : Boolean(config.piper?.baseUrl),
        reachable: ttsMock ? true : null,
      },
    },
    metrics: globalSpeechMetrics.snapshot(),
  };

  if (!sttMock && config.stt?.streamUrl) {
    result.services.stt.reachable = await probeHttp(
      toHttpHealthUrl(config.stt.streamUrl, '/readyz'),
      fetchImpl,
    );
    result.services.stt.ready = result.services.stt.reachable;
  }

  if (!ttsMock) {
    const combined = await getCombinedTtsHealth(config);
    result.services.englishTts.configured =
      combined.providers?.english?.configured === true;
    result.services.englishTts.reachable =
      combined.providers?.english?.reachable === true;
    result.services.teluguTts.configured =
      combined.providers?.telugu?.configured === true;
    result.services.teluguTts.reachable =
      combined.providers?.telugu?.reachable === true;
  }

  result.ready =
    result.services.stt.ready !== false &&
    result.services.stt.reachable !== false &&
    (ttsMock ||
      (result.services.englishTts.reachable !== false &&
        result.services.teluguTts.reachable !== false));

  return result;
}

function toHttpHealthUrl(streamUrl, path) {
  try {
    const u = new URL(streamUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = path;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

async function probeHttp(url, fetchImpl) {
  if (!url) return false;
  const fetchFn = fetchImpl || globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetchFn(url, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
