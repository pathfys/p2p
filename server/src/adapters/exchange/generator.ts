/**
 * Встроенный генератор стаканов — реализация порта ExchangeFeed без ключей
 * бирж. Эмитит ровно те нормализованные события, что отдавал бы реальный
 * адаптер (snapshot → update/status/log), поэтому WS-контракт работает
 * end-to-end. Прод-адаптер (http) реализует тот же порт поверх настоящих
 * венчурных эндпоинтов (см. docs/ws-protocol.md §4) и подменяется в main.ts.
 */
import type { ExchangeFeed, FeedEvent, FeedParams, FeedSubscription } from '../../ports.js';
import type { Offer, Side } from '../../domain/types.js';
import { assetRate, methodsFor } from '../../domain/money.js';

interface Venue {
  id: string;
  reliability: number;
  baseLatency: number;
}

const VENUES: Venue[] = [
  { id: 'binance', reliability: 0.97, baseLatency: 38 },
  { id: 'bybit', reliability: 0.95, baseLatency: 44 },
  { id: 'okx', reliability: 0.94, baseLatency: 52 },
  { id: 'bitget', reliability: 0.92, baseLatency: 61 },
  { id: 'htx', reliability: 0.9, baseLatency: 74 },
  { id: 'kucoin', reliability: 0.89, baseLatency: 83 },
  { id: 'mexc', reliability: 0.87, baseLatency: 91 },
  { id: 'gate', reliability: 0.86, baseLatency: 96 },
];
const VENUE_BY_ID = new Map(VENUES.map((v) => [v.id, v]));
const KNOWN = new Set(VENUES.map((v) => v.id));

const NAME_PREFIX = ['Crypto', 'Fast', 'Prime', 'Nord', 'Gold', 'Liquid', 'Stable', 'Rapid', 'Vertex', 'Atlas'];
const NAME_SUFFIX = ['Desk', 'Pay', 'Swap', 'OTC', 'Trade', 'Hub', 'King', 'Vault', 'Flow', 'Bridge'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/** Генерация стакана одной биржи для конкретной пары/стороны. */
class VenueBook {
  private readonly rnd: () => number;
  private readonly premium: number;
  private mid: number;
  private seq = 0;
  readonly offers = new Map<string, Offer>();

  constructor(
    private readonly venue: Venue,
    private readonly asset: string,
    private readonly fiat: string,
    private readonly side: Side,
  ) {
    this.rnd = mulberry32(hashStr(venue.id + asset + fiat + side));
    this.premium = (1 - venue.reliability) * 0.6 * (this.rnd() - 0.3);
    this.mid = assetRate(asset, fiat) * (1 + this.premium * 0.01);
    const count = 6 + Math.floor(this.rnd() * 8);
    for (let i = 0; i < count; i++) this.spawn(i);
  }

  private merchantName(r: () => number): string {
    const a = NAME_PREFIX[Math.floor(r() * NAME_PREFIX.length)]!;
    const b = NAME_SUFFIX[Math.floor(r() * NAME_SUFFIX.length)]!;
    return a + b + Math.floor(r() * 90 + 10);
  }

  private spawn(rank: number | null = null): Offer {
    const r = this.rnd;
    const id = `${this.venue.id}:${++this.seq}`;
    const idx = rank ?? Math.floor(r() * 10);
    const dev = (0.0015 + idx * 0.0011 + r() * 0.0014) * (this.side === 'buy' ? 1 : -1);
    const usdtMid = assetRate('USDT', this.fiat) || 1;
    const unit = assetRate(this.asset, this.fiat);
    const usdtScale = this.asset === 'USDT' ? 1 : unit / usdtMid;
    const liqUsdt = 400 + r() * r() * 90_000;
    const available = liqUsdt / usdtScale;
    const price = this.mid * (1 + dev);
    const minFiat = Math.round((500 + r() * 14_000) / 100) * 100;
    const maxFiat = Math.max(minFiat * 2, Math.round(available * price * (0.4 + r() * 0.6)));
    const pool = methodsFor(this.fiat);
    const nMethods = 1 + Math.floor(r() * Math.min(3, pool.length));
    const methods = [...pool].sort(() => r() - 0.5).slice(0, nMethods);

    const offer: Offer = {
      id,
      exchange: this.venue.id,
      side: this.side,
      asset: this.asset,
      fiat: this.fiat,
      price,
      available,
      min: minFiat,
      max: maxFiat,
      methods,
      merchant: {
        id: 'm_' + id,
        name: this.merchantName(r),
        orders: Math.floor(20 + r() ** 1.6 * 9000),
        completion: 0.8 + r() * 0.198,
        rating: Number((4.0 + r()).toFixed(2)),
        verified: r() < 0.62,
        pro: r() < 0.3,
        avgReleaseMin: Number((0.8 + r() * 14).toFixed(1)),
        online: r() < 0.88,
        blocked: r() < 0.04,
      },
      kycRequired: r() < 0.5 ? 1 : r() < 0.85 ? 2 : 0,
      terms: '',
      ts: Date.now(),
    };
    this.offers.set(id, offer);
    return offer;
  }

  snapshot(): Offer[] {
    return [...this.offers.values()].map((o) => ({ ...o, ts: Date.now() }));
  }

  tick(now: number): { upsert: Offer[]; remove: string[] } {
    const r = this.rnd;
    const base = assetRate(this.asset, this.fiat) * (1 + this.premium * 0.01);
    this.mid += (base - this.mid) * 0.06 + this.mid * (r() - 0.5) * 0.0009;

    const upsert: Offer[] = [];
    const remove: string[] = [];
    const ids = [...this.offers.keys()];
    const touch = 1 + Math.floor(r() * 3);
    for (let i = 0; i < touch && ids.length; i++) {
      const id = ids[Math.floor(r() * ids.length)]!;
      const o = this.offers.get(id);
      if (!o) continue;
      const next: Offer = {
        ...o,
        price: this.mid * (1 + ((o.price / this.mid - 1) + (r() - 0.5) * 0.0006)),
        available: Math.max(20, o.available * (0.94 + r() * 0.13)),
        ts: now,
      };
      this.offers.set(id, next);
      upsert.push(next);
    }
    if (r() < 0.14 && ids.length > 4) {
      const id = ids[Math.floor(r() * ids.length)]!;
      this.offers.delete(id);
      remove.push(id);
    }
    if (r() < 0.16 && this.offers.size < 18) upsert.push(this.spawn());
    return { upsert, remove };
  }
}

export class GeneratorFeed implements ExchangeFeed {
  constructor(private readonly tickMs: number) {}

  knownExchanges(): ReadonlySet<string> {
    return KNOWN;
  }

  subscribe(params: FeedParams, onEvent: (e: FeedEvent) => void): FeedSubscription {
    const books = new Map<string, VenueBook>();
    const timers: NodeJS.Timeout[] = [];
    let closed = false;

    const wanted = params.exchanges.filter((id) => VENUE_BY_ID.has(id));
    for (const id of wanted) {
      const venue = VENUE_BY_ID.get(id)!;
      const book = new VenueBook(venue, params.asset, params.fiat, params.side);
      books.set(id, book);
      onEvent({ kind: 'status', exchange: id, ts: Date.now(), state: 'connecting', latency: venue.baseLatency });
      // снапшоты приходят вразнобой — как реальные биржи, выходящие на связь
      const t = setTimeout(() => {
        if (closed) return;
        const now = Date.now();
        onEvent({ kind: 'snapshot', exchange: id, ts: now, offers: book.snapshot() });
        onEvent({ kind: 'status', exchange: id, ts: now, state: 'live', latency: venue.baseLatency });
        onEvent({ kind: 'log', ts: now, level: 'info', exchange: id, text: `snapshot · <b>${book.offers.size}</b> оферов` });
      }, 120 + Math.floor(Math.random() * 700));
      timers.push(t);
    }

    const interval = setInterval(() => {
      if (closed) return;
      const now = Date.now();
      for (const [id, book] of books) {
        const venue = VENUE_BY_ID.get(id)!;
        // имитация редкого таймаута площадки
        if (Math.random() > venue.reliability + 0.028) {
          onEvent({ kind: 'status', exchange: id, ts: now, state: 'connecting', latency: venue.baseLatency });
          onEvent({ kind: 'log', ts: now, level: 'warn', exchange: id, text: 'таймаут ответа, повтор запроса…' });
          continue;
        }
        const { upsert, remove } = book.tick(now);
        if (upsert.length || remove.length) {
          onEvent({ kind: 'update', exchange: id, ts: now, upsert, remove });
        }
      }
    }, this.tickMs);
    timers.push(interval);

    return {
      currentOffers: (): Offer[] => {
        const all: Offer[] = [];
        for (const book of books.values()) for (const o of book.offers.values()) all.push(o);
        return all;
      },
      close: (): void => {
        closed = true;
        for (const t of timers) clearInterval(t);
      },
    };
  }
}
