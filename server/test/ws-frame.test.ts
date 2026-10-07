import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encodeText, acceptKey } from '../src/adapters/ws/frame.js';

/** Клиентский (маскированный) текстовый кадр. len<126 для простоты. */
function maskedText(str: string): Buffer {
  const payload = Buffer.from(str, 'utf8');
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

test('декодирование маскированного текстового кадра', () => {
  const d = new FrameDecoder(1 << 20);
  const out = d.push(maskedText('{"op":"ping"}'));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, 'message');
  assert.equal((out[0] as { data: string }).data, '{"op":"ping"}');
});

test('склейка кадра из нескольких chunk-ов', () => {
  const d = new FrameDecoder(1 << 20);
  const frame = maskedText('hello');
  assert.equal(d.push(frame.subarray(0, 3)).length, 0, 'ждём больше байт');
  const out = d.push(frame.subarray(3));
  assert.equal((out[0] as { data: string }).data, 'hello');
});

test('немаскированный клиентский кадр — protocol error', () => {
  const d = new FrameDecoder(1 << 20);
  const payload = Buffer.from('x', 'utf8');
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]); // нет mask-бита
  const out = d.push(frame);
  assert.equal(out[0]!.type, 'error');
  assert.equal((out[0] as { code: number }).code, 1002);
});

test('серверный encodeText: FIN+TEXT, без маски', () => {
  const buf = encodeText('hi');
  assert.equal(buf[0], 0x81);
  assert.equal(buf[1], 0x02); // длина 2, mask-бит снят
  assert.equal(buf.subarray(2).toString('utf8'), 'hi');
});

test('acceptKey по примеру RFC 6455', () => {
  // ключ из RFC → известный accept
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});
