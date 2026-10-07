/**
 * WS-транспорт: апгрейд HTTP→WS, разбор кадров и защитные лимиты уровня
 * соединения (анти-DDoS):
 *   • лимит соединений с одного IP;
 *   • лимит входящих кадров/с (избыток отбрасывается, устойчивый флуд → close);
 *   • idle-timeout (нет кадров N мс → закрываем: мобильные сети рвут TCP молча);
 *   • серверный ping для проверки живости;
 *   • backpressure: медленный потребитель отключается, а не копит память.
 * Протокол поверх транспорта реализует gateway.ts.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Container } from '../../container.js';
import { FrameDecoder, acceptKey, encodeClose, encodePing, encodeText, encodePong } from './frame.js';
import { TokenBucketLimiter } from '../security/ratelimit.js';
import { clientIp } from '../http/http-util.js';

export interface WsTransport {
  readonly ip: string;
  sendJson(obj: unknown): void;
  close(code: number, reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

export function attachWebsocket(httpServer: Server, c: Container, onConnection: (t: WsTransport) => void): void {
  const perIp = new Map<string, number>();
  const maxPerIp = c.config.limits.wsMaxConnPerIp;
  const idleMs = c.config.limits.wsIdleTimeoutMs;
  const maxFrame = c.config.limits.wsMaxFrameBytes;
  const framesPerSec = c.config.limits.wsFramesPerSec;

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== c.config.http.wsPath) {
      return refuse(socket, 404, 'Not Found');
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (req.headers['upgrade']?.toLowerCase() !== 'websocket' || typeof key !== 'string' || version !== '13') {
      return refuse(socket, 400, 'Bad Request');
    }
    // Origin-allowlist как для REST: защита от cross-site WebSocket hijacking.
    // Браузер шлёт Origin на WS-рукопожатии; не-браузерные клиенты (без Origin) проходят.
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && origin.length > 0 && !c.config.corsOrigins.includes(origin)) {
      return refuse(socket, 403, 'Forbidden Origin');
    }

    const ip = clientIp(req);
    const count = perIp.get(ip) ?? 0;
    if (count >= maxPerIp) return refuse(socket, 429, 'Too Many Connections');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    perIp.set(ip, count + 1);

    const decoder = new FrameDecoder(maxFrame);
    const inboundLimiter = new TokenBucketLimiter(framesPerSec, 1000, c.clock.now);
    let closed = false;
    let lastRecv = c.clock.now();
    let dropped = 0;
    const msgCbs: ((t: string) => void)[] = [];
    const closeCbs: (() => void)[] = [];

    const transport: WsTransport = {
      ip,
      sendJson(obj: unknown): void {
        if (closed || socket.destroyed) return;
        // backpressure: медленный клиент — отключаем, не копим память
        if (socket.writableLength > 8 * 1024 * 1024) return destroy(1013, 'backpressure');
        socket.write(encodeText(JSON.stringify(obj)));
      },
      close: (code: number, reason = ''): void => destroy(code, reason),
      onMessage: (cb): void => void msgCbs.push(cb),
      onClose: (cb): void => void closeCbs.push(cb),
    };

    function destroy(code: number, reason: string): void {
      if (closed) return;
      closed = true;
      try {
        socket.write(encodeClose(code, reason));
      } catch {
        /* сокет уже мог закрыться */
      }
      socket.end();
      perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1));
      if ((perIp.get(ip) ?? 0) === 0) perIp.delete(ip);
      for (const cb of closeCbs) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    }

    if (head && head.length) feed(head);
    socket.on('data', feed);
    socket.on('error', () => destroy(1011, 'socket error'));
    socket.on('close', () => {
      if (!closed) {
        closed = true;
        perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1));
        if ((perIp.get(ip) ?? 0) === 0) perIp.delete(ip);
        for (const cb of closeCbs) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      }
    });

    const timer = setInterval(() => {
      if (closed) return;
      const now = c.clock.now();
      if (now - lastRecv > idleMs) return destroy(1001, 'idle timeout');
      if (!socket.destroyed) socket.write(encodePing());
    }, Math.max(1000, Math.floor(idleMs / 2)));
    if (typeof timer.unref === 'function') timer.unref();
    socket.on('close', () => clearInterval(timer));

    function feed(chunk: Buffer): void {
      if (closed) return;
      lastRecv = c.clock.now();
      let events;
      try {
        events = decoder.push(chunk);
      } catch {
        return destroy(1002, 'decode error');
      }
      for (const ev of events) {
        if (ev.type === 'message') {
          if (!inboundLimiter.take(ip + ':ws').ok) {
            // анти-флуд: кадр сверх лимита отбрасываем; устойчивый флуд — закрываем
            if (++dropped > framesPerSec) return destroy(1008, 'rate limit');
            continue;
          }
          for (const cb of msgCbs) cb(ev.data);
        } else if (ev.type === 'ping') {
          if (!socket.destroyed) socket.write(encodePong(ev.data));
        } else if (ev.type === 'close') {
          return destroy(1000, 'bye');
        } else if (ev.type === 'error') {
          return destroy(ev.code, ev.reason);
        }
        // pong — ничего не делаем
      }
    }

    onConnection(transport);
  });
}

function refuse(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}
