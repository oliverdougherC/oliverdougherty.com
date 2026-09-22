import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSE_REASONS,
  PACKET_TYPES,
  STREAM_TYPES,
  encodeClose,
  encodeContinue,
  encodeData,
  isAllowedOrigin,
  makeConnectFrame,
  mapConnectErrorToCloseReason,
  parseFrame,
  parsePortList,
  readSettings,
  validateDestination
} from '../src/wisp.js';

test('parses and encodes WISP frames', () => {
  const connect = parseFrame(makeConnectFrame({
    streamId: 7,
    hostname: 'example.com',
    port: 443
  }));

  assert.equal(connect.ok, true);
  assert.equal(connect.type, PACKET_TYPES.CONNECT);
  assert.equal(connect.streamId, 7);
  assert.equal(connect.streamType, STREAM_TYPES.TCP);
  assert.equal(connect.port, 443);
  assert.equal(connect.hostname, 'example.com');

  const data = parseFrame(encodeData(7, new Uint8Array([1, 2, 3])));
  assert.equal(data.ok, true);
  assert.equal(data.type, PACKET_TYPES.DATA);
  assert.deepEqual(Array.from(data.payload), [1, 2, 3]);

  const close = parseFrame(encodeClose(7, CLOSE_REASONS.VOLUNTARY));
  assert.equal(close.ok, true);
  assert.equal(close.reason, CLOSE_REASONS.VOLUNTARY);

  const cont = encodeContinue(0, 32);
  const view = new DataView(cont.buffer);
  assert.equal(view.getUint8(0), PACKET_TYPES.CONTINUE);
  assert.equal(view.getUint32(1, true), 0);
  assert.equal(view.getUint32(5, true), 32);
});

test('rejects malformed and oversized frames', () => {
  assert.equal(parseFrame(new Uint8Array([1, 2])).ok, false);

  const oversized = makeConnectFrame({
    streamId: 9,
    hostname: 'example.com',
    port: 443
  });
  const parsed = parseFrame(oversized, oversized.byteLength - 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, CLOSE_REASONS.THROTTLED);
  assert.equal(parsed.streamId, 9);
});

test('validates allowed origins', () => {
  const allowed = ['https://oliverdougherty.com', 'https://www.oliverdougherty.com', 'http://localhost', 'https://localhost'];
  assert.equal(isAllowedOrigin('https://oliverdougherty.com', allowed), true);
  assert.equal(isAllowedOrigin('https://www.oliverdougherty.com', allowed), true);
  assert.equal(isAllowedOrigin('http://localhost', allowed), true);
  assert.equal(isAllowedOrigin('https://localhost', allowed), true);
  assert.equal(isAllowedOrigin(null, allowed), true);
  assert.equal(isAllowedOrigin(undefined, allowed), true);
  assert.equal(isAllowedOrigin('https://evil.example', allowed), false);
});

test('parses settings with safe defaults', () => {
  const settings = readSettings({
    ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    ALLOWED_PORTS: '80,443,abc,70000',
    MAX_STREAMS: '12',
    MAX_FRAME_BYTES: '4096',
    WISP_BUFFER_PACKETS: '16'
  });

  assert.deepEqual(settings.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(settings.allowedPorts, [80, 443]);
  assert.equal(settings.maxStreams, 12);
  assert.equal(settings.maxFrameBytes, 4096);
  assert.equal(settings.bufferPackets, 16);
  assert.deepEqual(parsePortList('bad'), [80, 443]);
});

test('validates destination host and port policy', () => {
  assert.deepEqual(validateDestination('Example.COM', 443, [80, 443]), {
    ok: true,
    hostname: 'example.com',
    port: 443
  });

  assert.equal(validateDestination('example.com', 22, [80, 443]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('localhost', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('10.0.0.1', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('172.16.1.1', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('192.168.1.1', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('198.51.100.10', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('203.0.113.10', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('127.0.0.1', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('2001:db8::1', 80, [80]).reason, CLOSE_REASONS.BLOCKED);
  assert.equal(validateDestination('-bad.example', 80, [80]).reason, CLOSE_REASONS.INVALID_CONNECT);
});

test('maps connection errors to WISP close reasons', () => {
  assert.equal(mapConnectErrorToCloseReason(new Error('connection timed out')), CLOSE_REASONS.TIMEOUT);
  assert.equal(mapConnectErrorToCloseReason(new Error('connection refused')), CLOSE_REASONS.REFUSED);
  assert.equal(mapConnectErrorToCloseReason(new Error('dns lookup failed')), CLOSE_REASONS.UNREACHABLE);
  assert.equal(mapConnectErrorToCloseReason(new Error('socket closed')), CLOSE_REASONS.NETWORK_ERROR);
});
