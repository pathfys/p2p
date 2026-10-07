/**
 * FeedHub — общий кэш стаканов. Держит ОДНУ upstream-подписку на рынок
 * (asset:fiat:side) по всем известным биржам и раздаёт события множеству
 * клиентов (WS-соединений), фильтруя по запрошенным ими биржам. Тот же кэш
 * читает REST при создании сделки (проверка офера, цена, «лучший стакан»),
 * поэтому стрим и деньги видят один и тот же стакан.
 *
 * Это серверная граница доверия к данным бирж: все входящие оферы проходят
 * normalizeOffer (мусор/инъекции отбрасываются) до попадания в кэш.
 */
import type { Clock, ExchangeFeed, FeedEvent, FeedSubscription, Logger } from '../ports.js';
import type { Offer, Side } from '../domain/types.js';
import { normalizeOffer, medianPrice, rankBestIds } from '../domain/offer.js';
import { usdtToAsset } from '../domain/money.js';

/** Нормализованное событие, уходящее клиенту (сериализуется в WS-кадр). */
export type ClientEvent = FeedEvent;

interface ClientReg {
  exchanges: Set<string>;
  emit: (e: ClientEvent) => void;
}

interface Market {
  key: string;
  asset: string;
  fiat: string;
  side: Side;
  offers: Map<string, Offer>;
  upstream: FeedSubscription;
  clients: Set<ClientReg>;
  lastAccess: number;
}

export interface MarketView {
  offers: Offer[];
  median: number;
}

const IDLE_EVICT_MS = 120_000;
const MAX_OFFERS_PER_MARKET = 4000; // потолок против раздувания памяти кривым адаптером

export class FeedHub {
  private readonly markets = new Map<string, Market>();
  private readonly known: ReadonlySet<string>;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly feed: ExchangeFeed,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    this.known = feed.knownExchanges();
  }

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.evictIdle(), 30_000);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const m of this.markets.values()) m.upstream.close();
    this.markets.clear();
  }

  knownExchanges(): ReadonlySet<string> {
    return this.known;
  }

  private marketKey(asset: string, fiat: string, side: Side): string {
    return `${asset}:${fiat}:${side}`;
  }

  /** Создаёт (при необходимости) рынок с upstream-подпиской по всем биржам. */
  private ensureMarket(asset: string, fiat: string, side: Side): Market {
    const key = this.marketKey(asset, fiat, side);
    let m = this.markets.get(key);
    if (m) {
      m.lastAccess = this.clock.now();
      return m;
    }
    const offers = new Map<string, Offer>();
    const clients = new Set<ClientReg>();
    const market: Market = {
      key, asset, fiat, side, offers, clients,
      lastAccess: this.clock.now(),
      upstream: undefined as unknown as FeedSubscription,
    };
    market.upstream = this.feed.subscribe(
      { exchanges: [...this.known], asset, fiat, side },
      (e) => this.onUpstream(market, e),
    );
    this.markets.set(key, market);
    this.log.log('info', 'market opened', { market: key });
    return market;
  }

  private onUpstream(market: Market, e: FeedEvent): void {
    // 1) обновляем кэш (граница доверия — normalizeOffer)
    if (e.kind === 'snapshot') {
      for (const [id, o] of market.offers) if (o.exchange === e.exchange) market.offers.delete(id);
      const clean: Offer[] = [];
      for (const raw of e.offers) {
        const o = normalizeOffer(raw, { knownExchanges: this.known });
        if (!o || o.exchange !== e.exchange || o.asset !== market.asset || o.fiat !== market.fiat || o.side !== market.side) continue;
        if (!market.offers.has(o.id) && market.offers.size >= MAX_OFFERS_PER_MARKET) continue;
        market.offers.set(o.id, o);
        clean.push(o);
      }
      this.fanout(market, { ...e, offers: clean });
      return;
    }
    if (e.kind === 'update') {
      const upsert: Offer[] = [];
      for (const raw of e.upsert) {
        const o = normalizeOffer(raw, { knownExchanges: this.known });
        if (!o || o.exchange !== e.exchange || o.asset !== market.asset || o.fiat !== market.fiat || o.side !== market.side) continue;
        if (!market.offers.has(o.id) && market.offers.size >= MAX_OFFERS_PER_MARKET) continue;
        market.offers.set(o.id, o);
        upsert.push(o);
      }
      const remove: string[] = [];
      for (const id of e.remove) {
        if (typeof id === 'string' && market.offers.delete(id)) remove.push(id);
      }
      this.fanout(market, { ...e, upsert, remove });
      return;
    }
    // status / log пробрасываем как есть
    this.fanout(market, e);
  }

  private fanout(market: Market, e: FeedEvent): void {
    for (const c of market.clients) {
      if (e.kind === 'log') {
        if (e.exchange === null || c.exchanges.has(e.exchange)) c.emit(e);
      } else if (c.exchanges.has(e.exchange)) {
        c.emit(e);
      }
    }
  }

  /**
   * Подписка клиента (WS). Шлёт стартовый snapshot по каждой запрошенной бирже
   * из текущего кэша, затем проксирует события. Возвращает функцию отписки.
   */
  subscribeClient(
    params: { exchanges: string[]; asset: string; fiat: string; side: Side },
    emit: (e: ClientEvent) => void,
  ): () => void {
    const exchanges = new Set(params.exchanges.filter((id) => this.known.has(id)));
    const market = this.ensureMarket(params.asset, params.fiat, params.side);
    const reg: ClientReg = { exchanges, emit };
    market.clients.add(reg);
    market.lastAccess = this.clock.now();

    // стартовые снапшоты из кэша — по одному на биржу (как ждёт фронт)
    const now = this.clock.now();
    for (const ex of exchanges) {
      const offers = [...market.offers.values()].filter((o) => o.exchange === ex);
      if (offers.length) emit({ kind: 'snapshot', exchange: ex, ts: now, offers });
    }

    return () => {
      market.clients.delete(reg);
    };
  }

  /** Срез рынка для REST (проверка офера, медиана). Поднимает рынок при нужде. */
  getMarket(asset: string, fiat: string, side: Side): MarketView {
    const market = this.ensureMarket(asset, fiat, side);
    const offers = [...market.offers.values()];
    return { offers, median: medianPrice(offers) };
  }

  /** «Лучший стакан» — член топ-N по quickScore в полном стакане рынка. */
  isBestOffer(asset: string, fiat: string, side: Side, offerId: string, volumeUsdt: number): boolean {
    const market = this.markets.get(this.marketKey(asset, fiat, side));
    if (!market) return false;
    const offers = [...market.offers.values()];
    const median = medianPrice(offers);
    const needAsset = usdtToAsset(volumeUsdt, asset) || 1;
    return rankBestIds(offers, median, side, needAsset, 3).has(offerId);
  }

  private evictIdle(): void {
    const now = this.clock.now();
    for (const [key, m] of this.markets) {
      if (m.clients.size === 0 && now - m.lastAccess > IDLE_EVICT_MS) {
        m.upstream.close();
        this.markets.delete(key);
        this.log.log('info', 'market evicted', { market: key });
      }
    }
  }
}
