/**
 * Минимальный кодек WebSocket (RFC 6455) — без внешних зависимостей, чтобы не
 * тянуть лишнюю поверхность атаки. Поддержаны текстовые кадры, фрагментация,
 * control-кадры (ping/pong/close). Жёсткие лимиты на размер (анти-DDoS):
 *   • кадры клиента ОБЯЗАНЫ быть маскированы (иначе protocol error);
 *   • control-кадр ≤125 байт и не фрагментируется;
 *   • суммарный размер сообщения ограничен maxMessageBytes.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1').update(secWebSocketKey + GUID).digest('base64');
}

export type Decoded =
  | { type: 'message'; data: string }
  | { type: 'ping'; data: Buffer }
  | { type: 'pong' }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error'; code: number; reason: string };

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentSize = 0;

  constructor(private readonly maxMessageBytes: number) {}

  /** Докладывает новые байты, возвращает разобранные события по порядку. */
  push(chunk: Buffer): Decoded[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Decoded[] = [];
    for (;;) {
      const r = this.readOne();
      if (r === 'need-more') break;
      if (r === 'consumed') continue;
      out.push(r);
      if (r.type === 'error' || r.type === 'close') break;
    }
    return out;
  }

  private readOne(): Decoded | 'need-more' | 'consumed' {
    const b = this.buf;
    if (b.length < 2) return 'need-more';
    const fin = (b[0]! & 0x80) !== 0;
    const rsv = b[0]! & 0x70;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    let len = b[1]! & 0x7f;
    let offset = 2;

    if (rsv !== 0) return this.fail(1002, 'RSV bits set');

    if (len === 126) {
      if (b.length < offset + 2) return 'need-more';
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return 'need-more';
      const big = b.readBigUInt64BE(offset);
      if (big > BigInt(this.maxMessageBytes)) return this.fail(1009, 'frame too large');
      len = Number(big);
      offset += 8;
    }
    if (len > this.maxMessageBytes) return this.fail(1009, 'frame too large');

    // клиент обязан маскировать
    if (!masked) return this.fail(1002, 'client frame not masked');
    if (b.length < offset + 4 + len) return 'need-more';
    const mask = b.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[offset + i]! ^ mask[i & 3]!;
    offset += len;

    // отрезаем обработанное
    this.buf = b.subarray(offset);

    const isControl = (opcode & 0x8) !== 0;
    if (isControl) {
      if (!fin) return this.fail(1002, 'fragmented control frame');
      if (len > 125) return this.fail(1002, 'control frame too large');
      if (opcode === OP_PING) return { type: 'ping', data: payload };
      if (opcode === OP_PONG) return { type: 'pong' };
      if (opcode === OP_CLOSE) {
        const code = len >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = len > 2 ? payload.subarray(2).toString('utf8') : '';
        return { type: 'close', code, reason };
      }
      return this.fail(1002, 'bad control opcode');
    }

    // данные: TEXT/BIN/CONT
    if (opcode === OP_BIN) return this.fail(1003, 'binary not accepted');
    if (opcode === OP_TEXT) {
      if (this.fragments.length) return this.fail(1002, 'expected continuation');
      if (fin) return this.finishMessage(payload);
      this.fragments = [payload];
      this.fragmentSize = payload.length;
      return 'consumed';
    }
    if (opcode === OP_CONT) {
      if (!this.fragments.length) return this.fail(1002, 'unexpected continuation');
      this.fragmentSize += payload.length;
      if (this.fragmentSize > this.maxMessageBytes) return this.fail(1009, 'message too large');
      this.fragments.push(payload);
      if (!fin) return 'consumed';
      const whole = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentSize = 0;
      return this.finishMessage(whole);
    }
    return this.fail(1002, 'bad opcode');
  }

  private finishMessage(payload: Buffer): Decoded {
    return { type: 'message', data: payload.toString('utf8') };
  }

  private fail(code: number, reason: string): Decoded {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    return { type: 'error', code, reason };
  }
}

/* ── сериализация серверных кадров (без маски) ── */

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export const encodeText = (s: string): Buffer => encodeFrame(OP_TEXT, Buffer.from(s, 'utf8'));
export const encodePong = (data: Buffer): Buffer => encodeFrame(OP_PONG, data.subarray(0, 125));
export const encodePing = (): Buffer => encodeFrame(OP_PING, Buffer.alloc(0));
export function encodeClose(code: number, reason = ''): Buffer {
  const r = Buffer.from(reason, 'utf8').subarray(0, 123);
  const body = Buffer.allocUnsafe(2 + r.length);
  body.writeUInt16BE(code, 0);
  r.copy(body, 2);
  return encodeFrame(OP_CLOSE, body);
}
