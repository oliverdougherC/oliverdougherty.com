import { connect } from 'cloudflare:sockets';
import {
  CLOSE_REASONS,
  PACKET_TYPES,
  STREAM_TYPES,
  encodeClose,
  encodeContinue,
  encodeData,
  isAllowedOrigin,
  mapConnectErrorToCloseReason,
  parseFrame,
  readSettings,
  validateDestination
} from './wisp.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers
    }
  });
}

function isWebSocketUpgrade(request) {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function sendSafe(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(frame);
  return true;
}

async function closeTcpStream(stream) {
  stream.closed = true;
  try {
    await stream.socket?.close();
  } catch {}
  try {
    await stream.writer?.close();
  } catch {
    try {
      await stream.writer?.abort();
    } catch {}
  }
  try {
    await stream.reader?.cancel();
  } catch {}
}

function handleWispSocket(webSocket, env) {
  const settings = readSettings(env);
  const streams = new Map();
  webSocket.binaryType = 'arraybuffer';

  const closeStream = async (streamId, reason = CLOSE_REASONS.VOLUNTARY, notify = true) => {
    const stream = streams.get(streamId);
    streams.delete(streamId);
    if (notify) {
      sendSafe(webSocket, encodeClose(streamId, reason));
    }
    if (stream) {
      await closeTcpStream(stream);
    }
  };

  const closeAllStreams = () => {
    const active = Array.from(streams.values());
    streams.clear();
    for (const stream of active) {
      void closeTcpStream(stream);
    }
  };

  const flushPending = async (stream) => {
    if (!stream.writer || stream.closed) {
      return;
    }

    while (stream.pending.length > 0 && !stream.closed) {
      const payload = stream.pending.shift();
      await stream.writer.write(payload);
      sendSafe(webSocket, encodeContinue(stream.streamId, settings.bufferPackets));
    }
  };

  const pumpTcpToWebSocket = async (stream) => {
    try {
      for (;;) {
        const { value, done } = await stream.reader.read();
        if (done || stream.closed) {
          break;
        }
        if (value) {
          sendSafe(webSocket, encodeData(stream.streamId, value));
        }
      }
      if (!stream.closed) {
        await closeStream(stream.streamId, CLOSE_REASONS.VOLUNTARY);
      }
    } catch (error) {
      if (!stream.closed) {
        await closeStream(stream.streamId, mapConnectErrorToCloseReason(error));
      }
    }
  };

  const connectStream = async (frame) => {
    if (frame.streamType !== STREAM_TYPES.TCP) {
      sendSafe(webSocket, encodeClose(frame.streamId, CLOSE_REASONS.INVALID_CONNECT));
      return;
    }
    if (streams.size >= settings.maxStreams) {
      sendSafe(webSocket, encodeClose(frame.streamId, CLOSE_REASONS.THROTTLED));
      return;
    }

    const destination = validateDestination(frame.hostname, frame.port, settings.allowedPorts);
    if (!destination.ok) {
      sendSafe(webSocket, encodeClose(frame.streamId, destination.reason));
      return;
    }

    const stream = {
      streamId: frame.streamId,
      pending: [],
      socket: null,
      reader: null,
      writer: null,
      closed: false
    };
    streams.set(frame.streamId, stream);

    try {
      const socket = connect(
        { hostname: destination.hostname, port: destination.port },
        { allowHalfOpen: true }
      );
      stream.socket = socket;
      await socket.opened;
      stream.reader = socket.readable.getReader();
      stream.writer = socket.writable.getWriter();
      sendSafe(webSocket, encodeContinue(frame.streamId, settings.bufferPackets));
      await flushPending(stream);
      void pumpTcpToWebSocket(stream);
    } catch (error) {
      await closeStream(frame.streamId, mapConnectErrorToCloseReason(error));
    }
  };

  const handleData = async (frame) => {
    const stream = streams.get(frame.streamId);
    if (!stream || stream.closed) {
      sendSafe(webSocket, encodeClose(frame.streamId, CLOSE_REASONS.INVALID_CONNECT));
      return;
    }

    try {
      if (!stream.writer) {
        stream.pending.push(frame.payload);
        return;
      }
      await stream.writer.write(frame.payload);
      sendSafe(webSocket, encodeContinue(frame.streamId, settings.bufferPackets));
    } catch (error) {
      await closeStream(frame.streamId, mapConnectErrorToCloseReason(error));
    }
  };

  const handleMessage = async (event) => {
    const data = typeof Blob !== 'undefined' && event.data instanceof Blob
      ? await event.data.arrayBuffer()
      : event.data;
    const frame = parseFrame(data, settings.maxFrameBytes);
    if (!frame.ok) {
      sendSafe(webSocket, encodeClose(frame.streamId, frame.reason));
      return;
    }

    switch (frame.type) {
      case PACKET_TYPES.CONNECT:
        await connectStream(frame);
        break;
      case PACKET_TYPES.DATA:
        await handleData(frame);
        break;
      case PACKET_TYPES.CLOSE:
        await closeStream(frame.streamId, frame.reason, false);
        break;
    }
  };

  sendSafe(webSocket, encodeContinue(0, settings.bufferPackets));
  webSocket.addEventListener('message', (event) => {
    event.waitUntil?.(handleMessage(event));
    if (!event.waitUntil) {
      void handleMessage(event);
    }
  });
  webSocket.addEventListener('close', closeAllStreams);
  webSocket.addEventListener('error', closeAllStreams);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const settings = readSettings(env);

    if (url.pathname === '/healthz') {
      return json({
        ok: true,
        protocol: 'wisp-v1',
        allowedPorts: settings.allowedPorts,
        maxStreams: settings.maxStreams,
        maxFrameBytes: settings.maxFrameBytes
      });
    }

    if (url.pathname !== '/wisp/') {
      return json({ ok: false, error: 'not_found' }, { status: 404 });
    }

    const origin = request.headers.get('origin');
    if (!isAllowedOrigin(origin, settings.allowedOrigins)) {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.set('X-Wisp-Origin-Rejected', String(origin ?? 'null'));
      headers.set('X-Wisp-Allowed-Origins', settings.allowedOrigins.join(', '));
      return new Response(
        JSON.stringify({ ok: false, error: 'origin_not_allowed', origin: origin ?? null }),
        { status: 403, headers }
      );
    }

    if (!isWebSocketUpgrade(request)) {
      return json({ ok: false, error: 'websocket_upgrade_required' }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    handleWispSocket(server, env);
    return new Response(null, { status: 101, webSocket: client });
  }
};
