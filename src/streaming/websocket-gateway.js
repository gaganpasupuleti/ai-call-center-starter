import { WebSocketServer } from 'ws';
import { STREAM_PATH } from './constants.js';
import { parseInboundMessage, ProtocolError } from './protocol.js';
import { safeErrorMessage } from './redaction.js';
import { authorizeStreamUpgrade, rejectUpgrade } from './stream-auth.js';

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

export function attachVoiceStreaming({
  server,
  sessionManager,
  config,
  acceptingConnections = { current: true },
}) {
  const pathname = resolveStreamPath(config.streamUrl, STREAM_PATH);
  const wss = new WebSocketServer({ noServer: true });
  const secrets = [
    config.apiToken,
    config.streamSharedSecret,
  ].filter(Boolean);

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (requestUrl.pathname !== pathname) {
      socket.destroy();
      return;
    }

    if (!acceptingConnections.current) {
      rejectUpgrade(socket, 503, 'Service is shutting down');
      return;
    }

    const auth = authorizeStreamUpgrade(request, config);
    if (!auth.ok) {
      rejectUpgrade(socket, auth.statusCode, auth.message);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    const session = sessionManager.attachSocket(ws);

    ws.on('message', async (data) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const event = parseInboundMessage(text);
        await sessionManager.handleNormalizedEvent(session, event);
      } catch (error) {
        const message = safeErrorMessage(error, secrets);
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

    ws.on('close', () => {
      sessionManager.closeSession(session, 'socket_close');
    });

    ws.on('error', () => {
      sessionManager.closeSession(session, 'socket_error');
    });
  });

  return { wss, pathname };
}
