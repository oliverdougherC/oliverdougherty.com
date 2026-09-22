export const PACKET_TYPES = {
  CONNECT: 0x01,
  DATA: 0x02,
  CONTINUE: 0x03,
  CLOSE: 0x04
};

export const STREAM_TYPES = {
  TCP: 0x01,
  UDP: 0x02
};

export const CLOSE_REASONS = {
  UNKNOWN: 0x01,
  VOLUNTARY: 0x02,
  NETWORK_ERROR: 0x03,
  INVALID_CONNECT: 0x41,
  UNREACHABLE: 0x42,
  TIMEOUT: 0x43,
  REFUSED: 0x44,
  BLOCKED: 0x48,
  THROTTLED: 0x49
};

const DEFAULT_ALLOWED_ORIGINS = ['https://oliverdougherty.com', 'https://www.oliverdougherty.com', 'http://localhost', 'https://localhost'];
const DEFAULT_ALLOWED_PORTS = [80, 443];
const DEFAULT_MAX_STREAMS = 32;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_BUFFER_PACKETS = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function parseList(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parsePortList(value, fallback = DEFAULT_ALLOWED_PORTS) {
  const parsed = parseList(value, [])
    .map((entry) => Number(entry))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);

  return parsed.length > 0 ? parsed : fallback;
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readSettings(env = {}) {
  return {
    allowedOrigins: parseList(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
    allowedPorts: parsePortList(env.ALLOWED_PORTS, DEFAULT_ALLOWED_PORTS),
    maxStreams: parsePositiveInteger(env.MAX_STREAMS, DEFAULT_MAX_STREAMS),
    maxFrameBytes: parsePositiveInteger(env.MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES),
    bufferPackets: parsePositiveInteger(env.WISP_BUFFER_PACKETS, DEFAULT_BUFFER_PACKETS)
  };
}

export function isAllowedOrigin(origin, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  if (origin === null || origin === undefined) {
    return true;
  }
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}

function normalizeBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function encodeContinue(streamId, bufferRemaining) {
  const frame = new Uint8Array(9);
  const view = new DataView(frame.buffer);
  view.setUint8(0, PACKET_TYPES.CONTINUE);
  view.setUint32(1, streamId, true);
  view.setUint32(5, bufferRemaining, true);
  return frame;
}

export function encodeClose(streamId, reason = CLOSE_REASONS.UNKNOWN) {
  const frame = new Uint8Array(6);
  const view = new DataView(frame.buffer);
  view.setUint8(0, PACKET_TYPES.CLOSE);
  view.setUint32(1, streamId, true);
  view.setUint8(5, reason);
  return frame;
}

export function encodeData(streamId, payload) {
  const bytes = normalizeBytes(payload);
  if (!bytes) {
    throw new TypeError('WISP DATA payload must be bytes.');
  }

  const frame = new Uint8Array(5 + bytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, PACKET_TYPES.DATA);
  view.setUint32(1, streamId, true);
  frame.set(bytes, 5);
  return frame;
}

export function parseFrame(data, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
  const bytes = normalizeBytes(data);
  if (!bytes) {
    return { ok: false, reason: CLOSE_REASONS.INVALID_CONNECT, message: 'Frame must be binary data.', streamId: 0 };
  }
  if (bytes.byteLength < 5) {
    return { ok: false, reason: CLOSE_REASONS.INVALID_CONNECT, message: 'Frame is too short.', streamId: 0 };
  }
  if (bytes.byteLength > maxFrameBytes) {
    const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
    return { ok: false, reason: CLOSE_REASONS.THROTTLED, message: 'Frame is too large.', streamId };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const streamId = view.getUint32(1, true);

  if (type === PACKET_TYPES.CONNECT) {
    if (bytes.byteLength < 8) {
      return { ok: false, reason: CLOSE_REASONS.INVALID_CONNECT, message: 'CONNECT frame is too short.', streamId };
    }

    const streamType = view.getUint8(5);
    const port = view.getUint16(6, true);
    const hostname = decoder.decode(bytes.subarray(8)).trim();
    return { ok: true, type, streamId, streamType, port, hostname };
  }

  if (type === PACKET_TYPES.DATA) {
    return { ok: true, type, streamId, payload: bytes.subarray(5) };
  }

  if (type === PACKET_TYPES.CLOSE) {
    return {
      ok: true,
      type,
      streamId,
      reason: bytes.byteLength > 5 ? view.getUint8(5) : CLOSE_REASONS.UNKNOWN
    };
  }

  return { ok: false, reason: CLOSE_REASONS.INVALID_CONNECT, message: `Unsupported packet type ${type}.`, streamId };
}

function parseIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });

  return octets.some((part) => part === null) ? null : octets;
}

function isBlockedIpv4(octets) {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isValidHostname(hostname) {
  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }

  const labels = hostname.split('.');
  return labels.every((label) => (
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9-]+$/i.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  ));
}

export function validateDestination(hostname, port, allowedPorts = DEFAULT_ALLOWED_PORTS) {
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    return { ok: false, reason: CLOSE_REASONS.BLOCKED, message: `Port ${port} is not allowed.` };
  }

  if (typeof hostname !== 'string') {
    return { ok: false, reason: CLOSE_REASONS.INVALID_CONNECT, message: 'Hostname must be a string.' };
  }

  const normalized = hostname.trim().toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return { ok: false, reason: CLOSE_REASONS.BLOCKED, message: 'Localhost destinations are blocked.' };
  }

  if (normalized.includes(':')) {
    return { ok: false, reason: CLOSE_REASONS.BLOCKED, message: 'IPv6 literal destinations are blocked.' };
  }

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isBlockedIpv4(ipv4)
      ? { ok: false, reason: CLOSE_REASONS.BLOCKED, message: 'Private or reserved IPv4 destinations are blocked.' }
      : { ok: true, hostname: normalized, port };
  }

  if (!isValidHostname(normalized)) {
    return { ok: false, reason: CLOSE_REASONS.INVALID_CONNECT, message: 'Hostname is malformed.' };
  }

  return { ok: true, hostname: normalized, port };
}

export function mapConnectErrorToCloseReason(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  if (/timeout|timed out/.test(message)) return CLOSE_REASONS.TIMEOUT;
  if (/refused/.test(message)) return CLOSE_REASONS.REFUSED;
  if (/unreachable|resolve|dns|not found|lookup/.test(message)) return CLOSE_REASONS.UNREACHABLE;
  return CLOSE_REASONS.NETWORK_ERROR;
}

export function makeConnectFrame({ streamId, hostname, port, streamType = STREAM_TYPES.TCP }) {
  const hostnameBytes = encoder.encode(hostname);
  const frame = new Uint8Array(8 + hostnameBytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, PACKET_TYPES.CONNECT);
  view.setUint32(1, streamId, true);
  view.setUint8(5, streamType);
  view.setUint16(6, port, true);
  frame.set(hostnameBytes, 8);
  return frame;
}
