import { WebSocketServer } from 'ws';
import { STREAM_PATH } from './constants.js';
import { parseInboundMessage, ProtocolError } from './protocol.js';
import { safeErrorMessage } from './redaction.js';
import { authorizeStreamUpgrade, rejectUpgrade } from './stream-auth.js';
import {
  classifyUserAgent,
  clientIpFromRequest,
  logStreamEvent,
  newConnectionId,
  sanitizeIp,
} from './stream-logger.js';

function resolveStreamPath(streamUrl, fallback = STREAM_PATH) {
  if (!streamUrl) return fallback;
  try {
    const url = new URL(streamUrl);
    return url.pathname || fallback;
  } catch {
    if (String(streamUrl).startsWith('/')) return streamUrl;
    return fallback;
  }
}

function clearIdleTimer(ws) {
  if (ws.__idleTimer) {
    clearTimeout(ws.__idleTimer);
    ws.__idleTimer = null;
  }
}

function armIdleTimer(ws, idleTimeoutMs, onIdle) {
  clearIdleTimer(ws);
  if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
  ws.__idleTimer = setTimeout(() => onIdle(), idleTimeoutMs);
  ws.__idleTimer.unref?.();
}

export function attachVoiceStreaming({
  server,
  sessionManager,
  config,
  acceptingConnections = { current: true },
  logSink = console.log,
}) {
  const pathname = resolveStreamPath(config.streamUrl, STREAM_PATH);
  const maxConnections = Number(config.maxConnections ?? 20);
  const maxMessageBytes = Number(config.maxMessageBytes ?? 65_536);
  const idleTimeoutMs = Number(config.idleTimeoutMs ?? 60_000);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxMessageBytes,
  });
  const secrets = [
    config.apiToken,
    config.streamSharedSecret,
    config.webhookSharedSecret,
  ].filter(Boolean);
  let activeConnections = 0;

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const route = requestUrl.pathname;
    const connectionId = newConnectionId();
    const { ipPartial, ipHash } = sanitizeIp(clientIpFromRequest(request));
    const ua = classifyUserAgent(request.headers?.['user-agent']);

    if (route !== pathname) {
      logStreamEvent(
        {
          event: 'ws_upgrade_rejected',
          route,
          auth: 'rejected',
          authReason: 'wrong_route',
          connectionId,
          ipHash,
          ipPartial,
          ua,
        },
        logSink,
      );
      socket.destroy();
      return;
    }

    if (!acceptingConnections.current) {
      logStreamEvent(
        {
          event: 'ws_upgrade_auth',
          route: pathname,
          auth: 'rejected',
          authReason: 'shutting_down',
          connectionId,
          ipHash,
          ipPartial,
          ua,
        },
        logSink,
      );
      rejectUpgrade(socket, 503, 'Service is shutting down');
      return;
    }

    if (activeConnections >= maxConnections) {
      logStreamEvent(
        {
          event: 'ws_upgrade_auth',
          route: pathname,
          auth: 'rejected',
          authReason: 'connection_limit',
          connectionId,
          ipHash,
          ipPartial,
          ua,
          activeConnections,
        },
        logSink,
      );
      rejectUpgrade(socket, 503, 'Connection limit reached');
      return;
    }

    const auth = authorizeStreamUpgrade(request, config);
    logStreamEvent(
      {
        event: 'ws_upgrade_auth',
        route: pathname,
        auth: auth.auth,
        authReason: auth.authReason,
        connectionId,
        ipHash,
        ipPartial,
        ua,
        activeConnections,
      },
      logSink,
    );

    if (!auth.ok) {
      rejectUpgrade(socket, auth.statusCode, auth.message);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.__connectionId = connectionId;
      ws.__clientMeta = { ipHash, ipPartial, ua };
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    activeConnections += 1;
    const connectionId = ws.__connectionId || newConnectionId();
    const meta = ws.__clientMeta || sanitizeIp(clientIpFromRequest(request));
    const ua =
      ws.__clientMeta?.ua ||
      classifyUserAgent(request?.headers?.['user-agent']);

    logStreamEvent(
      {
        event: 'ws_open',
        route: pathname,
        auth: 'accepted',
        connectionId,
        ipHash: meta.ipHash,
        ipPartial: meta.ipPartial,
        ua,
        activeConnections,
      },
      logSink,
    );

    const session = sessionManager.attachSocket(ws);
    session.connectionId = connectionId;
    sessionManager.callStation?.onSessionOpened?.(session);

    const onIdle = () => {
      logStreamEvent(
        {
          event: 'ws_idle_timeout',
          route: pathname,
          connectionId,
          validationError: 'idle_timeout',
        },
        logSink,
      );
      try {
        ws.close(1001, 'idle_timeout');
      } catch {
        // ignore
      }
    };

    armIdleTimer(ws, idleTimeoutMs, onIdle);

    ws.on('message', async (data) => {
      armIdleTimer(ws, idleTimeoutMs, onIdle);
      try {
        const size = Buffer.isBuffer(data)
          ? data.length
          : Buffer.byteLength(String(data));
        if (size > maxMessageBytes) {
          logStreamEvent(
            {
              event: 'ws_protocol',
              route: pathname,
              connectionId,
              validationError: 'payload_too_large',
            },
            logSink,
          );
          ws.send(
            JSON.stringify({
              event: 'error',
              error: {
                code: 'payload_too_large',
                message: 'Message exceeds size limit',
              },
            }),
          );
          ws.close(1009, 'payload_too_large');
          return;
        }

        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const event = parseInboundMessage(text);
        logStreamEvent(
          {
            event: 'ws_protocol',
            route: pathname,
            connectionId,
            protocolEvent: event.event,
          },
          logSink,
        );
        await sessionManager.handleNormalizedEvent(session, event);
      } catch (error) {
        const message = safeErrorMessage(error, secrets);
        const validationError =
          error instanceof ProtocolError ? error.code : 'internal_error';
        logStreamEvent(
          {
            event: 'ws_protocol',
            route: pathname,
            connectionId,
            validationError,
          },
          logSink,
        );
        if (error instanceof ProtocolError) {
          ws.send(
            JSON.stringify({
              event: 'error',
              error: {
                code: error.code,
                message,
              },
            }),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            event: 'error',
            error: { code: 'internal_error', message },
          }),
        );
      }
    });

    ws.on('close', (closeCode) => {
      clearIdleTimer(ws);
      activeConnections = Math.max(0, activeConnections - 1);
      const code = Number(closeCode) || 0;
      session.wsCloseCode = code;
      if (session.ws) session.ws.closeCode = code;
      logStreamEvent(
        {
          event: 'ws_close',
          route: pathname,
          connectionId,
          closeCode: code,
          activeConnections,
        },
        logSink,
      );
      sessionManager.closeSession(session, 'socket_close');
    });

    ws.on('error', () => {
      clearIdleTimer(ws);
      sessionManager.closeSession(session, 'socket_error');
    });
  });

  return { wss, pathname, getActiveConnections: () => activeConnections };
}
