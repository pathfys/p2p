/**
 * WS-протокол (docs/ws-protocol.md). Поверх транспорта: auth → subscribe → ping.
 * Каждый серверный пуш нумеруется монотонным seq и несёт честный ts — без этого
 * клиентский дедуп и проверка свежести бессильны против replay. Весь текст логов
 * санитизируется здесь (XSS-граница). Один клиент = одна подписка на книгу.
 */
import type { Container } from '../../container.js';
import type { WsTransport } from './server.js';
import type { ClientEvent } from '../../app/feed.service.js';
import type { Side } from '../../domain/types.js';
import { TokenBucketLimiter } from '../security/ratelimit.js';
import { safeLogText } from '../security/sanitize.js';
import { isKnownAsset, isKnownCurrency } from '../../domain/money.js';
import { dayLimitFor } from '../../domain/kyc.js';
import { DomainError } from '../../domain/errors.js';

const AUTH_CLOSE_CODE = 4401;

export function makeWsHandler(c: Container): (t: WsTransport) => void {
  const known = c.feed.knownExchanges();

  return (t: WsTransport): void => {
    let seq = 0;
    let authed = false;
    let userId = '';
    let bookUnsub: (() => void) | null = null;
    let eventsUnsub: (() => void) | null = null;
    const subLimiter = new TokenBucketLimiter(60, 60_000, c.clock.now);

    const send = (ev: Record<string, unknown>): void => {
      t.sendJson({ ...ev, seq: ++seq, ts: c.clock.now() });
    };
    const sendErr = (code: string, message: string, exchange?: string): void => {
      send({ ev: 'error', data: { code, message, ...(exchange ? { exchange } : {}) } });
    };

    t.onClose(() => {
      bookUnsub?.();
      eventsUnsub?.();
      bookUnsub = null;
      eventsUnsub = null;
    });

    t.onMessage((text) => {
      if (text.length > 64 * 1024) return; // защита до JSON.parse
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return sendErr('bad_json', 'Кадр не является JSON');
      }
      const op = typeof msg['op'] === 'string' ? msg['op'] : '';
      switch (op) {
        case 'auth':
          void handleAuth(msg);
          return;
        case 'subscribe':
          handleSubscribe(msg);
          return;
        case 'unsubscribe':
          bookUnsub?.();
          bookUnsub = null;
          return;
        case 'ping':
          send({ ev: 'pong' });
          return;
        default:
          sendErr('bad_op', 'Неизвестная операция');
      }
    });

    async function handleAuth(msg: Record<string, unknown>): Promise<void> {
      if (authed) return; // повторный auth игнорируем
      const initData = typeof msg['initData'] === 'string' ? msg['initData'] : '';
      const nonce = typeof msg['nonce'] === 'string' ? msg['nonce'] : null;
      try {
        const r = await c.auth.authenticate(initData, nonce);
        authed = true;
        userId = r.user.id;
        // пуши пользователю (сделки/KYC) → в этот сокет
        eventsUnsub = c.events.on(userId, (push) => {
          send({ ev: push.type, data: push.data });
        });
        send({
          ev: 'auth',
          ok: true,
          data: { userId, kycLevel: r.kyc.level, plan: r.plan, limits: { dayUsdt: dayLimitFor(r.kyc.level) } },
        });
      } catch (e) {
        const code = e instanceof DomainError ? e.code : 'auth_failed';
        const message = e instanceof DomainError ? e.message : 'Ошибка аутентификации';
        send({ ev: 'error', data: { code, message } });
        t.close(AUTH_CLOSE_CODE, 'auth failed');
      }
    }

    function handleSubscribe(msg: Record<string, unknown>): void {
      if (!authed) return sendErr('unauthorized', 'Сначала auth');
      if (!subLimiter.take(userId).ok) return sendErr('rate_limited', 'Слишком частые подписки');

      const channel = typeof msg['channel'] === 'string' ? msg['channel'] : '';
      if (channel === 'p2p.logs') return; // логи идут вместе с книгой — no-op ack
      if (channel !== 'p2p.book') return sendErr('bad_channel', 'Неизвестный канал');

      const args = (msg['args'] && typeof msg['args'] === 'object' ? msg['args'] : {}) as Record<string, unknown>;
      const asset = String(args['asset'] ?? 'USDT');
      const fiat = String(args['fiat'] ?? 'RUB');
      const side: Side = args['side'] === 'sell' ? 'sell' : 'buy';
      if (!isKnownAsset(asset) || !isKnownCurrency(fiat)) return sendErr('bad_args', 'Неизвестный актив/валюта');

      const exRaw = Array.isArray(args['exchanges']) ? (args['exchanges'] as unknown[]) : [];
      const exchanges = exRaw.filter((x): x is string => typeof x === 'string' && known.has(x));
      if (!exchanges.length) return sendErr('bad_args', 'Не указаны известные биржи');

      // одна книга на клиента: закрываем предыдущую подписку
      bookUnsub?.();
      bookUnsub = c.feed.subscribeClient({ exchanges, asset, fiat, side }, (e) => emitFeed(e));
    }

    function emitFeed(e: ClientEvent): void {
      switch (e.kind) {
        case 'snapshot':
          send({ ev: 'snapshot', channel: 'p2p.book', exchange: e.exchange, data: { offers: e.offers } });
          return;
        case 'update':
          send({ ev: 'update', channel: 'p2p.book', exchange: e.exchange, data: { upsert: e.upsert, remove: e.remove } });
          return;
        case 'status':
          send({ ev: 'status', exchange: e.exchange, data: { state: e.state, latency: e.latency } });
          return;
        case 'log':
          send({ ev: 'log', data: { level: e.level, exchange: e.exchange, text: safeLogText(e.text) } });
          return;
        default:
          return;
      }
    }
  };
}
