import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getPublicSettings } from './config.js';
import { FOLLOW_UP_STATUSES } from './constants.js';
import { readJson, sendJson, servePublicFile } from './http.js';
import { CallService } from './services/call-service.js';
import { CampaignService } from './services/campaign-service.js';
import { LeadService } from './services/lead-service.js';
import {
  executeVoicebotCall,
  executeSingleVoicebotCall,
  toRedactedRequestPreview,
  buildVoicebotCallRequest,
} from './streaming/smartping/request-builder.js';
import { safeErrorMessage } from './streaming/redaction.js';
import { authorizeStreamCommand } from './streaming/stream-auth.js';
import {
  authorizeCallStatusWebhook,
  createRateLimiter,
  hashEventKey,
  logWebhookEvent,
  normalizeCallStatusPayload,
} from './streaming/smartping/call-status-webhook.js';
import {
  classifyUserAgent,
  clientIpFromRequest,
  sanitizeIp,
} from './streaming/stream-logger.js';
import { CallStationTracker } from './streaming/call-station-tracker.js';
import {
  normalizeOutboundMessage,
  normalizeOutboundPhone,
  normalizeOutboundVoice,
  normalizeRepeatCount,
  normalizeInteractiveMenu,
  buildInteractivePromptText,
  formatTransferPhone,
  voiceMeta,
  OUTBOUND_VOICE_OPTIONS,
  OUTBOUND_LANGUAGE_OPTIONS,
} from './streaming/outbound/phone.js';
import { getOutboundPromptStore } from './streaming/outbound/prompt-store.js';
import {
  getTtsHealth,
  getCombinedTtsHealth,
  TtsError,
  teluguVoiceNeedsTeluguScript,
  synthesizeOutboundAudio,
} from './streaming/tts/tts-provider-factory.js';
import {
  concatMulawWithRepeats,
  mulawToWavBase64,
} from './streaming/tts/mulaw-encode.js';
import { maskPhone } from './streaming/call-station.js';
import { KOKORO_DEFAULT_VOICE } from './streaming/tts/kokoro-voices.js';
import { getSpeechReadiness } from './streaming/conversation/readiness.js';
import { globalSpeechMetrics } from './streaming/conversation/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(__dirname, '..', 'public');

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual ?? '');
  const expectedBuffer = Buffer.from(expected ?? '');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`${name} is required`), { statusCode: 400 });
  }
  return value.trim();
}

export function createApp({
  repository,
  provider,
  config,
  sessionManager = null,
  callStation = null,
  promptStore = null,
}) {
  const callService = new CallService({ repository, provider, config });
  const leadService = new LeadService({ repository });
  const campaignService = new CampaignService({ repository, callService });
  const station =
    callStation ||
    new CallStationTracker({
      repository,
      config: config.smartPing ?? {},
      sessionManager,
    });
  if (sessionManager && !sessionManager.callStation) {
    sessionManager.callStation = station;
  }
  station.setSessionManager?.(sessionManager);
  const outboundPrompts = promptStore || getOutboundPromptStore();
  if (sessionManager && !sessionManager.promptStore) {
    sessionManager.promptStore = outboundPrompts;
  }

  function outboundCredentialsReady() {
    return Boolean(
      config.smartPing?.baseUrl &&
        config.smartPing?.apiToken &&
        config.smartPing?.didNumber &&
        (config.smartPing?.streamUrlConfigured || config.smartPing?.streamUrl),
    );
  }

  function outboundLiveReady() {
    const classicGates =
      config.smartPing?.dryRun === false &&
      config.smartPing?.liveCallsEnabled === true &&
      config.smartPing?.singleCallEnabled === true;
    const dialerLive =
      config.outbound?.dialerLive === true && outboundCredentialsReady();
    return classicGates || dialerLive;
  }

  function outboundLiveConfig() {
    if (config.outbound?.dialerLive === true) {
      return {
        ...config.smartPing,
        dryRun: false,
        liveCallsEnabled: true,
        singleCallEnabled: true,
      };
    }
    return config.smartPing;
  }

  function isOutboundDialerPath(pathname) {
    return (
      pathname === '/' ||
      pathname === '/index.html' ||
      pathname === '/styles.css' ||
      pathname === '/app.js' ||
      pathname === '/health' ||
      pathname === '/api/settings' ||
      pathname === '/api/dashboard' ||
      pathname === '/api/summary' ||
      pathname === '/api/speech/readiness' ||
      pathname === '/api/speech/metrics' ||
      pathname === '/api/speech/session-turn' ||
      pathname === '/api/speech/inject-transcript' ||
      pathname.startsWith('/api/outbound/') ||
      pathname.startsWith('/api/call-station/') ||
      pathname.startsWith('/api/leads') ||
      pathname.startsWith('/api/campaigns') ||
      pathname.startsWith('/api/calls') ||
      pathname.startsWith('/api/dialed-calls') ||
      pathname.startsWith('/api/follow-ups')
    );
  }
  const secrets = [
    config.smartPing?.apiToken,
    config.smartPing?.streamSharedSecret,
    config.smartPing?.webhookSharedSecret,
    config.webhookSecret,
  ].filter(Boolean);
  const webhookRateLimiter = createRateLimiter({
    limitPerMinute: config.smartPing?.webhookRateLimitPerMinute ?? 60,
  });

  return async function app(request, response) {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader(
      'access-control-allow-headers',
      'content-type, x-webhook-secret, x-smartping-webhook-secret, authorization',
    );
    response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const webhookPath =
      config.smartPing?.webhookPath ?? '/webhooks/smartping/call-status';

    try {
      if (request.method === 'GET' && pathname === '/healthz') {
        return sendJson(response, 200, {
          status: 'ok',
          service: 'smartping-voice-stream',
          liveCallsEnabled: false,
        });
      }

      if (request.method === 'GET' && pathname === '/api/speech/readiness') {
        const readiness = await getSpeechReadiness(config);
        return sendJson(response, 200, readiness);
      }

      if (request.method === 'GET' && pathname === '/api/speech/metrics') {
        return sendJson(response, 200, {
          liveCallsEnabled: config.smartPing?.liveCallsEnabled === true,
          metrics: globalSpeechMetrics.snapshot(),
        });
      }

      if (request.method === 'GET' && pathname === '/api/speech/session-turn') {
        // Simulation-only observation (no audio, no secrets, no private URLs).
        if (
          config.smartPing?.liveCallsEnabled === true ||
          config.smartPing?.singleCallEnabled === true ||
          config.outbound?.dialerLive === true
        ) {
          return sendJson(response, 403, {
            error: 'Session turn inspection disabled while live-call gates are open',
            code: 'session_turn_forbidden',
          });
        }
        if (!sessionManager) {
          return sendJson(response, 503, { error: 'Session manager unavailable' });
        }
        const streamSid = String(url.searchParams.get('streamSid') || '').trim();
        if (!streamSid) {
          return sendJson(response, 400, {
            error: 'streamSid is required',
            code: 'invalid_session_turn',
          });
        }
        const session = sessionManager.get(streamSid);
        if (!session) {
          return sendJson(response, 404, { error: 'Session not found' });
        }
        const timing = session.metadata?.turnTiming || {};
        return sendJson(response, 200, {
          ok: true,
          streamSid,
          transcript: session.metadata?.lastTranscript || null,
          detectedLanguage:
            session.metadata?.detectedLanguage ||
            session.metadata?.lastTranscriptLanguage ||
            null,
          intent: session.metadata?.lastIntent || null,
          ttsProvider: session.metadata?.ttsProvider || null,
          ttsVoice: session.metadata?.ttsVoice || null,
          sttProvider: session.metadata?.sttProvider || null,
          voiceLifecycle: session.metadata?.voiceLifecycle || null,
          speechStarted: Boolean(timing.vadSpeechStartedAt),
          speechEnded: Boolean(timing.vadSpeechEndedAt),
          botMediaOut: Number(session.stats?.mediaOut || 0),
          completed: session.metadata?.voiceLifecycle === 'closed',
          timing: {
            speechDurationMs:
              timing.vadSpeechStartedAt && timing.vadSpeechEndedAt
                ? Date.parse(timing.vadSpeechEndedAt) -
                  Date.parse(timing.vadSpeechStartedAt)
                : null,
            speechEndToTranscriptMs: timing.speechEndToTranscriptMs ?? null,
            ttsDurationMs: timing.ttsDurationMs ?? null,
            speechEndToBotAudioMs: timing.speechEndToFirstBotAudioMs ?? null,
            turnDurationMs: timing.turnTotalMs ?? null,
            vadSpeechStartedAt: timing.vadSpeechStartedAt ?? null,
            vadSpeechEndedAt: timing.vadSpeechEndedAt ?? null,
            transcriptReceivedAt: timing.transcriptReceivedAt ?? null,
            playbackStartedAt: timing.playbackStartedAt ?? null,
            playbackCompletedAt: timing.playbackCompletedAt ?? null,
          },
          telephoneCalls: 0,
        });
      }

      if (request.method === 'POST' && pathname === '/api/speech/inject-transcript') {
        // Simulation-only: never available when live telephone gates are open.
        if (
          config.smartPing?.liveCallsEnabled === true ||
          config.smartPing?.singleCallEnabled === true ||
          config.outbound?.dialerLive === true
        ) {
          return sendJson(response, 403, {
            error: 'Transcript inject disabled while live-call gates are open',
            code: 'inject_forbidden',
          });
        }
        if (!sessionManager) {
          return sendJson(response, 503, { error: 'Session manager unavailable' });
        }
        const body = await readJson(request);
        const streamSid = String(body.streamSid || '').trim();
        const text = String(body.text || '').trim().slice(0, 2000);
        const language = body.language === 'te' ? 'te' : 'en';
        if (!streamSid || !text) {
          return sendJson(response, 400, {
            error: 'streamSid and text are required',
            code: 'invalid_inject',
          });
        }
        const session = sessionManager.get(streamSid);
        if (!session) {
          return sendJson(response, 404, { error: 'Session not found' });
        }
        await sessionManager.injectTranscript?.(session, {
          text,
          language,
          provider: body.provider || 'simulator',
        });
        return sendJson(response, 200, {
          ok: true,
          streamSid,
          intent: session.metadata?.lastIntent || null,
          ttsProvider: session.metadata?.ttsProvider || null,
          voiceLifecycle: session.metadata?.voiceLifecycle || null,
          telephoneCalls: 0,
        });
      }

      if (request.method === 'POST' && pathname === webhookPath) {
        return handleSmartPingCallStatusWebhook({
          request,
          response,
          config,
          repository,
          webhookRateLimiter,
          secrets,
          callStation: station,
        });
      }

      const streamCommandMatchEarly = pathname.match(
        /^\/api\/streams\/([^/]+)\/commands$/,
      );
      const commandAuth =
        request.method === 'POST' && streamCommandMatchEarly
          ? authorizeStreamCommand(request, config.smartPing ?? {})
          : { ok: false };
      const isAuthenticatedStreamCommand =
        request.method === 'POST' &&
        streamCommandMatchEarly &&
        config.exposureMode === 'stream-only' &&
        commandAuth.ok;

      const dialerSurfaceOpen =
        config.outbound?.dialerLive === true && isOutboundDialerPath(pathname);
      const speechOpsOpen =
        pathname === '/api/speech/readiness' ||
        pathname === '/api/speech/metrics' ||
        pathname === '/api/speech/session-turn' ||
        pathname === '/api/speech/inject-transcript';
      if (
        config.exposureMode === 'stream-only' &&
        !isAuthenticatedStreamCommand &&
        !dialerSurfaceOpen &&
        !speechOpsOpen &&
        pathname !== '/healthz'
      ) {
        return sendJson(response, 404, { error: 'Not found' });
      }

      if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return servePublicFile(response, publicDirectory, 'index.html');
      }
      if (request.method === 'GET' && pathname === '/styles.css') {
        return servePublicFile(response, publicDirectory, 'styles.css');
      }
      if (request.method === 'GET' && pathname === '/app.js') {
        return servePublicFile(response, publicDirectory, 'app.js');
      }

      if (request.method === 'GET' && pathname === '/health') {
        return sendJson(response, 200, {
          ok: true,
          provider: provider.name,
          timestamp: new Date().toISOString(),
        });
      }

      if (request.method === 'GET' && pathname === '/api/summary') {
        return sendJson(response, 200, repository.getSummary());
      }

      if (request.method === 'GET' && pathname === '/api/dashboard') {
        const campaign = repository.getDashboardMetrics();
        const liveSummary = station.getSummary?.() || null;
        const recentDialed = (repository.listDialedCalls?.({}) || []).slice(0, 12);
        return sendJson(response, 200, {
          ...campaign,
          liveCallStation: liveSummary,
          recentDialedCalls: recentDialed,
          // Dashboard keeps campaign recent calls; dialed rows live in dialed_calls table.
          recentCalls: campaign.recentCalls,
        });
      }

      if (request.method === 'GET' && pathname === '/api/settings') {
        return sendJson(response, 200, getPublicSettings(config, provider.name));
      }

      if (request.method === 'GET' && pathname === '/api/call-station/summary') {
        return sendJson(response, 200, station.getSummary());
      }

      if (request.method === 'GET' && pathname === '/api/call-station/health') {
        return sendJson(response, 200, station.getHealth(config.smartPing ?? {}));
      }

      if (request.method === 'GET' && pathname === '/api/call-station/calls') {
        const filters = {
          status: url.searchParams.get('status') || undefined,
          outcome: url.searchParams.get('outcome') || undefined,
          websocket: url.searchParams.get('websocket') || undefined,
          webhook: url.searchParams.get('webhook') || undefined,
          q: url.searchParams.get('q') || undefined,
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
        };
        return sendJson(response, 200, {
          items: station.listCalls(filters),
        });
      }

      const callStationDetailMatch = pathname.match(
        /^\/api\/call-station\/calls\/([^/]+)$/,
      );
      if (request.method === 'GET' && callStationDetailMatch) {
        const call = station.getCall(decodeURIComponent(callStationDetailMatch[1]));
        if (!call) return sendJson(response, 404, { error: 'Call not found' });
        return sendJson(response, 200, call);
      }

      if (request.method === 'GET' && pathname === '/api/outbound/health') {
        const tts = getTtsHealth({
          voice: config.outbound?.ttsVoice,
          config,
        });
        const localTts = await getCombinedTtsHealth(config);
        const liveGatesOpen = outboundLiveReady();
        return sendJson(response, 200, {
          destinationMasked: maskPhone(process.env.SMARTPING_TEST_PHONE_NUMBER || ''),
          destinationConfigured: Boolean(process.env.SMARTPING_TEST_PHONE_NUMBER),
          didMasked: maskPhone(config.smartPing?.didNumber || ''),
          dryRun: config.smartPing?.dryRun !== false,
          liveCallsEnabled: config.smartPing?.liveCallsEnabled === true,
          singleCallEnabled: config.smartPing?.singleCallEnabled === true,
          dialerLive: config.outbound?.dialerLive === true,
          credentialsReady: outboundCredentialsReady(),
          liveGatesOpen,
          liveCallActionAvailable: liveGatesOpen,
          liveCallMessage: liveGatesOpen
            ? 'Enter a number and message, confirm, then place the call.'
            : 'Set OUTBOUND_DIALER_LIVE=true in full mode with SmartPing credentials, or open classic live gates.',
          streamUrlConfigured: Boolean(config.smartPing?.streamUrlConfigured),
          playbackMode: config.smartPing?.playbackMode || 'pipeline',
          voiceTtsProvider: config.voiceTtsProvider || 'mock',
          outboundTtsProvider: config.outbound?.ttsProvider || 'inherit',
          tts,
          localTts,
          voiceOptions: OUTBOUND_VOICE_OPTIONS,
          languageOptions: OUTBOUND_LANGUAGE_OPTIONS,
          defaultVoice: config.outbound?.ttsVoice || KOKORO_DEFAULT_VOICE,
          messageMaxLength: 500,
          repeatMin: 1,
          repeatMax: 5,
        });
      }

      if (request.method === 'POST' && pathname === '/api/outbound/preview') {
        const body = await readJson(request);
        const phone = normalizeOutboundPhone(
          body.phoneNumber ?? body.phone_number ?? process.env.SMARTPING_TEST_PHONE_NUMBER,
        );
        const message = normalizeOutboundMessage(body.message ?? body.text);
        const repeatCount = normalizeRepeatCount(body.repeatCount ?? body.repeat);
        const voicePick = normalizeOutboundVoice(
          body.voice,
          config.outbound?.ttsVoice || KOKORO_DEFAULT_VOICE,
        );
        if (!phone.ok) {
          return sendJson(response, 400, { error: phone.error, code: phone.code });
        }
        if (!message.ok) {
          return sendJson(response, 400, { error: message.error, code: message.code });
        }
        if (!voicePick.ok) {
          return sendJson(response, 400, {
            error: voicePick.error,
            code: voicePick.code,
          });
        }
        if (teluguVoiceNeedsTeluguScript(voicePick.voice, message.text)) {
          return sendJson(response, 400, {
            error:
              'Telugu voices need Telugu script (తెలుగు). English letters will sound English — type in Telugu.',
            code: 'tts_telugu_script_required',
            requestedVoice: voicePick.voice,
          });
        }
        if (!config.smartPing?.baseUrl || !config.smartPing?.didNumber) {
          return sendJson(response, 400, {
            error: 'SmartPing base URL and DID must be configured',
          });
        }
        const built = buildVoicebotCallRequest({
          baseUrl: config.smartPing.baseUrl,
          outboundPath: config.smartPing.outboundPath,
          apiToken: config.smartPing.apiToken || '',
          phoneNumber: phone.phone,
          didNumber: config.smartPing.didNumber,
          streamUrl: config.smartPing.streamUrl,
          customParameters: {
            app_call_id: 'outbound-preview',
            source: 'outbound-dialer',
          },
        });
        // Estimate duration without requiring a full TTS round-trip when unhealthy.
        let audioMeta = {
          estimated: true,
          durationSeconds: null,
          ttsReady: getTtsHealth().ready,
        };
        try {
          const synthesized = await synthesizeOutboundAudio(
            message.text,
            {
              voice: voicePick.voice,
              requireMatchingScript: true,
              language: voiceMeta(voicePick.voice)?.language || 'en',
              voiceLanguage: voiceMeta(voicePick.voice)?.language,
            },
            config,
          );
          if (synthesized.voice !== voicePick.voice && synthesized.provider !== 'mock-tts') {
            return sendJson(response, 500, {
              error: 'Synthesized voice did not match the selected voice',
              code: 'tts_voice_mismatch',
              requestedVoice: voicePick.voice,
              voice: synthesized.voice,
            });
          }
          const playbackBytes = concatMulawWithRepeats(
            synthesized.bytes,
            repeatCount,
          );
          const previewAudio = mulawToWavBase64(playbackBytes);
          audioMeta = {
            estimated: false,
            durationSeconds: Number(
              (synthesized.durationSeconds * repeatCount).toFixed(3),
            ),
            singlePlayDurationSeconds: synthesized.durationSeconds,
            byteLength: synthesized.byteLength,
            energyRatio: synthesized.energyRatio,
            provider: synthesized.provider,
            voice: synthesized.voice,
            requestedVoice: voicePick.voice,
            locale: synthesized.locale || null,
            hasTeluguScript: synthesized.hasTeluguScript === true,
            cached: synthesized.cached === true,
            ttsReady: true,
            repeatCount,
            preview: previewAudio,
          };
        } catch (error) {
          const code = error instanceof TtsError ? error.code : error?.code || 'tts_error';
          const status =
            error instanceof TtsError ? error.statusCode || 500 : error?.statusCode || 500;
          if (
            code === 'tts_invalid_voice' ||
            code === 'tts_voice_mismatch' ||
            code === 'tts_telugu_script_required'
          ) {
            return sendJson(response, status, {
              error: error.message,
              code,
              requestedVoice: voicePick.voice,
            });
          }
          audioMeta = {
            estimated: true,
            durationSeconds: null,
            ttsReady: false,
            error: code,
            requestedVoice: voicePick.voice,
            repeatCount,
          };
        }
        return sendJson(response, 200, {
          ok: true,
          networkRequestMade: false,
          phoneMasked: phone.masked,
          messageLength: message.length,
          repeatCount,
          voice: voicePick.voice,
          preview: toRedactedRequestPreview(built),
          audio: audioMeta,
        });
      }

      if (request.method === 'POST' && pathname === '/api/outbound/call') {
        const body = await readJson(request);
        const phone = normalizeOutboundPhone(
          body.phoneNumber ?? body.phone_number ?? process.env.SMARTPING_TEST_PHONE_NUMBER,
        );
        const message = normalizeOutboundMessage(body.message ?? body.text);
        const repeatCount = normalizeRepeatCount(body.repeatCount ?? body.repeat);
        const voicePick = normalizeOutboundVoice(
          body.voice,
          config.outbound?.ttsVoice || KOKORO_DEFAULT_VOICE,
        );
        const confirm = body.confirm === true;
        if (!phone.ok) {
          return sendJson(response, 400, { error: phone.error, code: phone.code });
        }
        if (!message.ok) {
          return sendJson(response, 400, { error: message.error, code: message.code });
        }
        if (!voicePick.ok) {
          return sendJson(response, 400, {
            error: voicePick.error,
            code: voicePick.code,
          });
        }
        if (teluguVoiceNeedsTeluguScript(voicePick.voice, message.text)) {
          return sendJson(response, 400, {
            error:
              'Telugu voices need Telugu script (తెలుగు). English letters will sound English — type in Telugu.',
            code: 'tts_telugu_script_required',
            requestedVoice: voicePick.voice,
          });
        }
        if (!confirm) {
          return sendJson(response, 403, {
            error: 'Explicit confirm is required before placing a live call',
            code: 'confirm_required',
          });
        }

        const interactivePick = normalizeInteractiveMenu({
          interactive: body.interactive === true,
          voice: voicePick.voice,
          menu: body.interactiveMenu || body.menu,
        });
        if (!interactivePick.ok) {
          return sendJson(response, 400, {
            error: interactivePick.error,
            code: interactivePick.code,
          });
        }

        let agentTransfer = { ok: true, phone: null, digits: null, masked: null };
        if (interactivePick.interactive) {
          const agentRaw =
            body.agentPhone ??
            body.agent_phone ??
            body.agentNumber ??
            process.env.OUTBOUND_AGENT_PHONE ??
            '';
          if (String(agentRaw).trim()) {
            agentTransfer = formatTransferPhone(agentRaw);
            if (!agentTransfer.ok) {
              return sendJson(response, 400, {
                error:
                  'Agent mobile must be a 10-digit Indian number (for key 9 transfer)',
                code: 'invalid_agent_phone',
              });
            }
          }
        }

        const spokenText = buildInteractivePromptText(message.text, {
          interactive: interactivePick.interactive,
          voice: voicePick.voice,
        });
        if (teluguVoiceNeedsTeluguScript(voicePick.voice, spokenText)) {
          return sendJson(response, 400, {
            error:
              'Telugu voices need Telugu script (తెలుగు). English letters will sound English — type in Telugu.',
            code: 'tts_telugu_script_required',
            requestedVoice: voicePick.voice,
          });
        }

        const liveGatesOpen = outboundLiveReady();
        if (!liveGatesOpen) {
          return sendJson(response, 403, {
            error:
              'Outbound dialer live mode is not enabled. Set OUTBOUND_DIALER_LIVE=true (full mode) with SmartPing credentials, or open classic live gates.',
            code: 'live_gates_closed',
            networkRequestMade: false,
          });
        }

        let synthesized;
        try {
          synthesized = await synthesizeOutboundAudio(
            spokenText,
            {
              voice: voicePick.voice,
              requireMatchingScript: true,
              language: voiceMeta(voicePick.voice)?.language || 'en',
              voiceLanguage: voiceMeta(voicePick.voice)?.language,
            },
            config,
          );
        } catch (error) {
          const status = error?.statusCode || 500;
          return sendJson(response, status, {
            error: error?.message || 'TTS failed',
            code: error?.code || 'tts_error',
          });
        }
        if (
          synthesized.provider !== 'mock-tts' &&
          synthesized.voice !== voicePick.voice
        ) {
          return sendJson(response, 500, {
            error: 'Synthesized voice did not match the selected voice',
            code: 'tts_voice_mismatch',
            requestedVoice: voicePick.voice,
            voice: synthesized.voice,
          });
        }

        const responseAudio = {};
        if (interactivePick.interactive) {
          try {
            for (const [digit, text] of Object.entries(interactivePick.menu)) {
              const clip = await synthesizeOutboundAudio(
                text,
                {
                  voice: voicePick.voice,
                  requireMatchingScript: true,
                  language: voiceMeta(voicePick.voice)?.language || 'en',
                  voiceLanguage: voiceMeta(voicePick.voice)?.language,
                },
                config,
              );
              responseAudio[digit] = {
                text,
                bytes: clip.bytes,
                durationSeconds: clip.durationSeconds,
              };
            }
          } catch (error) {
            const status = error?.statusCode || 500;
            return sendJson(response, status, {
              error: error?.message || 'Interactive TTS failed',
              code: error?.code || 'tts_error',
            });
          }
        }

        const prompt = outboundPrompts.create({
          phoneMasked: phone.masked,
          messageLength: spokenText.length,
          repeatCount,
          mulawBytes: synthesized.bytes,
          durationSeconds: synthesized.durationSeconds,
          voice: synthesized.voice,
          provider: synthesized.provider,
          interactive: interactivePick.interactive,
          menu: interactivePick.menu,
          responses: interactivePick.interactive ? responseAudio : null,
          agentPhone: agentTransfer.phone,
          agentPhoneMasked: agentTransfer.masked,
        });

        let stationRow = null;
        try {
          stationRow = station.recordOutboundDialerCall?.({
            appCallId: prompt.appCallId,
            destinationMasked: phone.masked,
            destinationPhone: phone.phone,
            messageLength: spokenText.length,
            messageText: spokenText,
            repeatCount,
            voice: synthesized.voice,
            durationSeconds: synthesized.durationSeconds,
          });
        } catch {
          // monitoring must not block dial
        }

        const result = await executeSingleVoicebotCall(outboundLiveConfig(), {
          phoneNumber: phone.phone,
          confirm: true,
          customParameters: {
            app_call_id: prompt.appCallId,
            source: 'outbound-dialer',
            repeat_count: String(repeatCount),
            interactive: interactivePick.interactive ? '1' : '0',
          },
        });

        try {
          station.noteOutboundDialerResult?.(stationRow?.public_ref, {
            httpStatus: result.httpStatus,
            networkRequestMade: result.networkRequestMade === true,
            providerCallId: result.providerCallId || result.callId || null,
          });
        } catch {
          // monitoring must not block response
        }

        return sendJson(response, result.networkRequestMade ? 202 : 200, {
          ok: true,
          dryRun: result.dryRun === true,
          networkRequestMade: result.networkRequestMade === true,
          httpStatus: result.httpStatus ?? null,
          responseBodyBytes: result.responseBodyBytes ?? null,
          responseParsePending: result.responseParsePending === true,
          appCallId: prompt.appCallId,
          stationRef: stationRow?.public_ref || null,
          phoneMasked: phone.masked,
          messageLength: spokenText.length,
          repeatCount,
          interactive: interactivePick.interactive,
          interactiveDigits: interactivePick.interactive
            ? Object.keys(interactivePick.menu).filter((k) => k !== 'default')
            : [],
          agentTransfer: interactivePick.interactive
            ? {
                enabled: Boolean(agentTransfer.phone),
                agentMasked: agentTransfer.masked,
              }
            : { enabled: false, agentMasked: null },
          audio: {
            durationSeconds: Number(
              (synthesized.durationSeconds * repeatCount).toFixed(3),
            ),
            singlePlayDurationSeconds: synthesized.durationSeconds,
            provider: synthesized.provider,
            voice: synthesized.voice,
            cached: synthesized.cached === true,
          },
        });
      }

      if (request.method === 'GET' && pathname === '/api/streams') {
        const active = sessionManager?.list() ?? [];
        const stored = repository.listVoiceStreams();
        return sendJson(response, 200, { active, items: stored });
      }

      const streamCommandMatch = pathname.match(/^\/api\/streams\/([^/]+)\/commands$/);
      if (request.method === 'POST' && streamCommandMatch) {
        if (!sessionManager) {
          return sendJson(response, 503, { error: 'Streaming is unavailable' });
        }
        const session = sessionManager.get(streamCommandMatch[1]);
        if (!session) {
          return sendJson(response, 404, { error: 'Active stream not found' });
        }
        const body = await readJson(request);
        const command = requiredString(body.command, 'command');
        let result = null;
        switch (command) {
          case 'clear':
            result = { dropped: sessionManager.clearAudio(session) };
            break;
          case 'hangup':
            result = { sent: sessionManager.hangupCall(session) };
            break;
          case 'mark':
            result = {
              sent: sessionManager.sendMark(session, body.name || 'local-mark'),
            };
            break;
          case 'transfer_queue':
            result = {
              sent: sessionManager.transferToQueue(
                session,
                requiredString(body.queue || 'support', 'queue'),
              ),
            };
            break;
          case 'transfer_external':
            result = {
              sent: sessionManager.transferToExternalNumber(
                session,
                requiredString(body.phoneNumber ?? body.phone_number, 'phoneNumber'),
              ),
            };
            break;
          default:
            throw Object.assign(new Error('Unsupported stream command'), {
              statusCode: 400,
            });
        }
        return sendJson(response, 200, { ok: true, command, result });
      }

      const streamMatch = pathname.match(/^\/api\/streams\/([^/]+)$/);
      if (request.method === 'GET' && streamMatch) {
        const stream = repository.getVoiceStream(streamMatch[1]);
        if (!stream) return sendJson(response, 404, { error: 'Stream not found' });
        return sendJson(response, 200, {
          stream,
          events: repository.listVoiceStreamEvents(stream.stream_sid),
          active: sessionManager?.get(stream.stream_sid)
            ? sessionManager.list().find((item) => item.streamSid === stream.stream_sid)
            : null,
        });
      }

      if (request.method === 'POST' && pathname === '/api/smartping/outbound/preview') {
        const body = await readJson(request);
        const built = buildVoicebotCallRequest({
          baseUrl: config.smartPing.baseUrl || 'https://smartping.example',
          outboundPath: config.smartPing.outboundPath,
          apiToken: config.smartPing.apiToken || 'not-configured',
          phoneNumber: requiredString(body.phoneNumber ?? body.phone_number, 'phoneNumber'),
          didNumber:
            body.didNumber ??
            body.did_number ??
            config.smartPing.didNumber ??
            'not-configured',
          streamUrl:
            body.streamUrl ?? body.url ?? config.smartPing.streamUrl,
          customParameters:
            body.customParameters ?? body.channel_vars?.custom_parameters ?? {},
        });
        const executed = await executeVoicebotCall(
          { ...config.smartPing, dryRun: true, liveCallsEnabled: false },
          {
            phoneNumber: built.body.phone_number,
            didNumber: built.body.did_number,
            streamUrl: built.body.url,
            customParameters: built.body.channel_vars.custom_parameters,
            fetchImpl: async () => {
              throw new Error('Network fetch must not run during dry-run preview');
            },
          },
        );
        return sendJson(response, 200, {
          ...executed,
          preview: executed.preview ?? toRedactedRequestPreview(built),
        });
      }

      if (request.method === 'GET' && pathname === '/api/leads') {
        return sendJson(
          response,
          200,
          {
            items: repository.listLeads({
              search: url.searchParams.get('search') ?? '',
              consentStatus: url.searchParams.get('consentStatus') ?? '',
              doNotCall: url.searchParams.get('doNotCall') ?? '',
              tag: url.searchParams.get('tag') ?? '',
            }),
          },
        );
      }

      if (request.method === 'POST' && pathname === '/api/leads/import') {
        const body = await readJson(request);
        const csv = body.csv ?? body.content ?? '';
        return sendJson(response, 200, leadService.importCsv(csv));
      }

      if (request.method === 'POST' && pathname === '/api/leads') {
        const body = await readJson(request);
        const lead = leadService.createLead(body);
        return sendJson(response, 201, lead);
      }

      const leadMatch = pathname.match(/^\/api\/leads\/([^/]+)$/);
      if (leadMatch) {
        const leadId = leadMatch[1];
        if (request.method === 'GET') {
          const lead = repository.getLead(leadId);
          if (!lead) return sendJson(response, 404, { error: 'Lead not found' });
          return sendJson(response, 200, lead);
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          const lead = leadService.updateLead(leadId, body);
          return sendJson(response, 200, lead);
        }
      }

      if (request.method === 'GET' && pathname === '/api/campaigns') {
        return sendJson(response, 200, { items: repository.listCampaigns() });
      }

      if (request.method === 'POST' && pathname === '/api/campaigns') {
        const body = await readJson(request);
        const campaign = campaignService.createCampaign(body);
        return sendJson(response, 201, campaign);
      }

      const campaignMatch = pathname.match(/^\/api\/campaigns\/([^/]+)$/);
      if (campaignMatch) {
        const campaignId = campaignMatch[1];
        if (request.method === 'GET') {
          const campaign = repository.getCampaign(campaignId);
          if (!campaign) {
            return sendJson(response, 404, { error: 'Campaign not found' });
          }
          return sendJson(response, 200, campaign);
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          const campaign = campaignService.updateCampaign(campaignId, body);
          return sendJson(response, 200, campaign);
        }
      }

      const campaignAssignMatch = pathname.match(
        /^\/api\/campaigns\/([^/]+)\/leads$/,
      );
      if (request.method === 'POST' && campaignAssignMatch) {
        const body = await readJson(request);
        const campaign = campaignService.assignLeads(
          campaignAssignMatch[1],
          body.leadIds,
        );
        return sendJson(response, 200, campaign);
      }

      const campaignEligibilityMatch = pathname.match(
        /^\/api\/campaigns\/([^/]+)\/eligibility$/,
      );
      if (request.method === 'GET' && campaignEligibilityMatch) {
        return sendJson(
          response,
          200,
          campaignService.evaluateEligibility(campaignEligibilityMatch[1]),
        );
      }

      const campaignStartMatch = pathname.match(
        /^\/api\/campaigns\/([^/]+)\/start$/,
      );
      if (request.method === 'POST' && campaignStartMatch) {
        const body = await readJson(request);
        const result = await campaignService.startCampaign(campaignStartMatch[1], {
          confirm: body.confirm === true,
        });
        return sendJson(response, 202, result);
      }

      if (request.method === 'GET' && pathname === '/api/calls') {
        const dialed = repository.listDialedCalls({
          search: url.searchParams.get('search') ?? '',
          status: url.searchParams.get('status') ?? '',
          digit: url.searchParams.get('digit') ?? '',
        });
        const campaignCalls = repository.listCalls({
          search: url.searchParams.get('search') ?? '',
          status: url.searchParams.get('status') ?? '',
          campaignId: url.searchParams.get('campaignId') ?? '',
          digit: url.searchParams.get('digit') ?? '',
        });
        return sendJson(response, 200, {
          items: dialed,
          dialedCalls: dialed,
          campaignCalls,
        });
      }

      if (request.method === 'GET' && pathname === '/api/dialed-calls') {
        return sendJson(response, 200, {
          items: repository.listDialedCalls({
            search: url.searchParams.get('search') ?? '',
            status: url.searchParams.get('status') ?? '',
            digit: url.searchParams.get('digit') ?? '',
          }),
        });
      }

      if (request.method === 'POST' && pathname === '/api/calls/test') {
        const body = await readJson(request);
        const call = await callService.startTestCall({
          leadId: requiredString(body.leadId, 'leadId'),
          campaignId: requiredString(body.campaignId, 'campaignId'),
        });
        return sendJson(response, 202, call);
      }

      const callDetailMatch = pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (request.method === 'GET' && callDetailMatch) {
        const call = repository.getCall(callDetailMatch[1]);
        if (!call) return sendJson(response, 404, { error: 'Call not found' });
        const events = repository.listCallEvents(call.id);
        const followUps = repository
          .listFollowUps()
          .filter((item) => item.call_id === call.id);
        return sendJson(response, 200, { call, events, followUps });
      }

      const eventHistoryMatch = pathname.match(/^\/api\/calls\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventHistoryMatch) {
        const call = repository.getCall(eventHistoryMatch[1]);
        if (!call) {
          return sendJson(response, 404, { error: 'Call not found' });
        }
        return sendJson(response, 200, {
          call,
          items: repository.listCallEvents(call.id),
        });
      }

      if (request.method === 'GET' && pathname === '/api/follow-ups') {
        return sendJson(response, 200, {
          items: repository.listFollowUps({
            status: url.searchParams.get('status') ?? '',
            type: url.searchParams.get('type') ?? '',
          }),
        });
      }

      const followUpMatch = pathname.match(/^\/api\/follow-ups\/([^/]+)$/);
      if (request.method === 'PATCH' && followUpMatch) {
        const body = await readJson(request);
        const status = requiredString(body.status, 'status');
        if (!FOLLOW_UP_STATUSES.includes(status)) {
          throw Object.assign(new Error('status is invalid'), { statusCode: 400 });
        }
        const followUp = repository.updateFollowUpStatus(followUpMatch[1], status);
        if (!followUp) {
          return sendJson(response, 404, { error: 'Follow-up not found' });
        }
        return sendJson(response, 200, followUp);
      }

      const mockEventMatch = pathname.match(/^\/api\/mock\/calls\/([^/]+)\/events$/);
      if (request.method === 'POST' && mockEventMatch) {
        if (provider.name !== 'mock') {
          return sendJson(response, 404, { error: 'Mock simulation is disabled' });
        }
        const call = repository.getCall(mockEventMatch[1]);
        if (!call) return sendJson(response, 404, { error: 'Call not found' });
        const body = await readJson(request);
        const event = provider.normalizeWebhook({
          eventId: body.eventId ?? randomUUID(),
          providerCallId: call.provider_call_id,
          status: requiredString(body.status, 'status'),
          selectedDigit: body.selectedDigit,
          durationSeconds: body.durationSeconds,
          recordingUrl: body.recordingUrl,
        });
        return sendJson(response, 200, callService.processProviderEvent(event));
      }

      const webhookMatch = pathname.match(/^\/webhooks\/providers\/([^/]+)$/);
      if (request.method === 'POST' && webhookMatch) {
        if (webhookMatch[1] !== provider.name) {
          return sendJson(response, 404, { error: 'Provider is not active' });
        }
        if (!secretsMatch(request.headers['x-webhook-secret'], config.webhookSecret)) {
          return sendJson(response, 401, { error: 'Invalid webhook secret' });
        }
        const body = await readJson(request);
        const event = provider.normalizeWebhook(body, request.headers);
        return sendJson(response, 200, callService.processProviderEvent(event));
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const statusCode = error.statusCode ?? 500;
      return sendJson(response, statusCode, {
        error: safeErrorMessage(error, secrets),
        ...(error.callId ? { callId: error.callId } : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}

async function handleSmartPingCallStatusWebhook({
  request,
  response,
  config,
  repository,
  webhookRateLimiter,
  secrets,
  callStation = null,
}) {
  const route = config.smartPing?.webhookPath ?? '/webhooks/smartping/call-status';
  const { ipPartial, ipHash } = sanitizeIp(clientIpFromRequest(request));
  const ua = classifyUserAgent(request.headers?.['user-agent']);
  const rateKey = ipHash || 'unknown';

  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().includes('application/json')) {
    logWebhookEvent({
      event: 'webhook_rejected',
      route,
      auth: 'rejected',
      authReason: 'invalid_content_type',
      validationError: 'invalid_content_type',
    });
    return sendJson(response, 415, { error: 'Content-Type must be application/json' });
  }

  const rate = webhookRateLimiter.check(rateKey);
  if (!rate.ok) {
    logWebhookEvent({
      event: 'webhook_rejected',
      route,
      auth: 'rejected',
      authReason: 'rate_limited',
      validationError: 'rate_limited',
    });
    return sendJson(response, 429, { error: 'Rate limit exceeded' });
  }

  const auth = authorizeCallStatusWebhook(request, config.smartPing ?? {});
  if (!auth.ok) {
    logWebhookEvent({
      event: 'webhook_auth',
      route,
      auth: auth.auth,
      authReason: auth.authReason,
      validationError: auth.authReason,
    });
    return sendJson(response, auth.statusCode ?? 401, { error: auth.message });
  }

  let body;
  try {
    body = await readJson(
      request,
      config.smartPing?.webhookMaxBodyBytes ?? 16_384,
    );
  } catch (error) {
    logWebhookEvent({
      event: 'webhook_rejected',
      route,
      auth: auth.auth,
      authReason: auth.authReason,
      validationError: error.statusCode === 413 ? 'payload_too_large' : 'invalid_json',
    });
    throw error;
  }

  let normalized;
  try {
    normalized = normalizeCallStatusPayload(body);
  } catch (error) {
    logWebhookEvent({
      event: 'webhook_rejected',
      route,
      auth: auth.auth,
      authReason: auth.authReason,
      validationError: error.code ?? 'invalid_body',
    });
    throw error;
  }

  const eventKeyHash = hashEventKey(normalized.eventKey);
  const stored = repository.recordSmartPingCallStatusEvent({
    eventKey: normalized.eventKey,
    callRef: normalized.callRef,
    status: normalized.status,
    phoneHash: normalized.phoneHash,
    metadata: {
      fieldKeys: normalized.fieldKeys,
      schemaDependency: normalized.schemaDependency,
      ipPartial,
      ua,
    },
  });

  try {
    callStation?.onWebhook?.({
      callRef: normalized.callRef,
      status: normalized.status,
      duplicate: stored.duplicate === true,
      eventKey: normalized.eventKey,
    });
  } catch {
    // Monitoring must not fail webhook acceptance.
  }

  logWebhookEvent({
    event: stored.duplicate ? 'webhook_duplicate' : 'webhook_accepted',
    route,
    auth: auth.auth,
    authReason: auth.authReason,
    eventKeyHash,
  });

  return sendJson(response, 200, {
    ok: true,
    duplicate: stored.duplicate === true,
    accepted: true,
  });
}
