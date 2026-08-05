import {
  getCombinedTtsHealth,
  requiresKokoro,
  requiresPiper,
  englishUsesPiper,
  normalizeVoiceTtsProvider,
} from '../tts/tts-provider-factory.js';
import { loadPrecomputedCatalog } from '../tts/precomputed-audio-catalog.js';
import { globalSpeechMetrics } from './metrics.js';

/**
 * Safe speech dependency readiness (no private URLs or tokens).
 * Mode-dependent: local-cpu does not require Kokoro.
 */
export async function getSpeechReadiness(config = {}, { fetchImpl } = {}) {
  const sttMock = (config.voiceSttProvider || 'mock') === 'mock';
  const mode = normalizeVoiceTtsProvider(config.voiceTtsProvider || 'mock');
  const ttsMock = mode === 'mock';
  const needKokoro = !ttsMock && requiresKokoro(mode);
  const needPiper = !ttsMock && requiresPiper(mode);
  const enPiper = !ttsMock && englishUsesPiper(mode);

  const result = {
    mode,
    ready: true,
    voiceConversationEnabled: config.voiceConversationEnabled === true,
    voiceInteractionMode: config.voiceInteractionMode || 'dtmf',
    piperEnglishVoice: config.piper?.englishVoice || null,
    piperEnglishSpeakerId:
      config.piper?.englishSpeakerId == null
        ? null
        : config.piper.englishSpeakerId,
    requiredServices: {
      stt: !sttMock,
      piper: needPiper,
      kokoro: needKokoro,
      catalog:
        mode === 'precomputed-local' &&
        config.precomputedAudio?.enabled === true,
    },
    optionalServices: {
      kokoro: !needKokoro,
    },
    services: {
      stt: {
        configured: sttMock ? true : Boolean(config.stt?.streamUrl),
        reachable: sttMock ? true : null,
        ready: sttMock ? true : null,
        provider: sttMock ? 'mock' : 'faster-whisper-streaming',
      },
      englishTts: {
        provider: ttsMock ? 'mock' : enPiper ? 'piper' : 'kokoro',
        configured: ttsMock
          ? true
          : enPiper
            ? Boolean(config.piper?.baseUrl)
            : Boolean(config.kokoro?.baseUrl),
        reachable: ttsMock ? true : null,
        required: !ttsMock,
      },
      teluguTts: {
        provider: ttsMock ? 'mock' : 'piper',
        configured: ttsMock ? true : Boolean(config.piper?.baseUrl),
        reachable: ttsMock ? true : null,
        required: needPiper,
      },
      kokoro: {
        required: needKokoro,
        optional: !needKokoro,
        configured: Boolean(config.kokoro?.baseUrl),
        reachable: null,
      },
      catalog: {
        enabled: config.precomputedAudio?.enabled === true,
        ready: null,
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
    if (combined.optionalKokoro) {
      result.services.kokoro.reachable = combined.optionalKokoro.reachable;
    } else if (needKokoro) {
      result.services.kokoro.reachable = result.services.englishTts.reachable;
    }
  }

  if (mode === 'precomputed-local') {
    const catalog = loadPrecomputedCatalog(config);
    result.services.catalog.enabled = catalog.enabled;
    result.services.catalog.ready = catalog.ready === true;
  }

  const sttOk =
    result.services.stt.ready !== false &&
    result.services.stt.reachable !== false;
  const piperOk =
    !needPiper || result.services.teluguTts.reachable !== false;
  const englishOk =
    ttsMock || result.services.englishTts.reachable !== false;
  const kokoroOk = !needKokoro || result.services.kokoro.reachable !== false;
  const catalogOk =
    !result.requiredServices.catalog ||
    result.services.catalog.ready === true;

  result.ready = sttOk && piperOk && englishOk && kokoroOk && catalogOk;
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
