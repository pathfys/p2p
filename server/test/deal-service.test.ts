import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedHub } from '../src/app/feed.service.js';
import { DealService } from '../src/app/deal.service.js';
import { SubscriptionService } from '../src/app/subscription.service.js';
import { UserEventBus } from '../src/app/user-events.js';
import {
  MemoryKycRepo, MemorySubscriptionRepo, MemoryBalanceRepo, MemoryCardRepo, MemoryDealRepo, MemoryTtlStore,
} from '../src/adapters/memory/repositories.js';
import { systemClock, cryptoIdGen } from '../src/adapters/infra.js';
import { DomainError } from '../src/domain/errors.js';
import type { ExchangeFeed, FeedEvent, FeedParams, FeedSubscription, Logger } from '../src/ports.js';
import type { Offer } from '../src/domain/types.js';

const nullLog: Logger = { log() {}, child() { return nullLog; } };

function offer(i: number, price: number): Offer {
  return {
    id: `binance:${i}`, exchange: 'binance', side: 'buy', asset: 'USDT', fiat: 'RUB',
    price, available: 100_000, min: 100, max: 1e9, methods: ['sber'],
    merchant: { id: `m${i}`, name: 'Shop', orders: 1000, completion: 0.99, rating: 5, verified: true, pro: false, avgReleaseMin: 5, online: true, blocked: false },
    kycRequired: 1, terms: '', ts: Date.now(),
  };
}

class StubFeed implements ExchangeFeed {
  constructor(private readonly offers: Offer[]) {}
  knownExchanges(): ReadonlySet<string> {
    return new Set(this.offers.map((o) => o.exchange));
  }
  subscribe(params: FeedParams, onEvent: (e: FeedEvent) => void): FeedSubscription {
    const byEx = new Map<string, Offer[]>();
    for (const o of this.offers) {
      if (o.asset === params.asset && o.fiat === params.fiat && o.side === params.side && params.exchanges.includes(o.exchange)) {
        const list = byEx.get(o.exchange) ?? [];
        list.push(o);
        byEx.set(o.exchange, list);
      }
    }
    for (const [ex, list] of byEx) onEvent({ kind: 'snapshot', exchange: ex, ts: Date.now(), offers: list });
    return { currentOffers: () => [...this.offers], close() {} };
  }
}

function harness() {
  const offers = [97, 98, 99, 100, 101, 102].map((p, i) => offer(i, p));
  const feed = new StubFeed(offers);
  const feedHub = new FeedHub(feed, systemClock, nullLog);
  const kyc = new MemoryKycRepo();
  const subRepo = new MemorySubscriptionRepo();
  const subs = new SubscriptionService(subRepo, systemClock);
  const balances = new MemoryBalanceRepo();
  const cards = new MemoryCardRepo();
  const dealRepo = new MemoryDealRepo();
  const idem = new MemoryTtlStore(systemClock.now);
  const deals = new DealService(dealRepo, feedHub, kyc, subs, balances, cards, idem, new UserEventBus(), cryptoIdGen, systemClock, nullLog);
  return { offers, feedHub, kyc, subs, cards, deals };
}

const APPROVED_L1 = { status: 'approved' as const, level: 1, pendingLevel: null, submittedAt: null, reviewedAt: null, rejectReason: null };
const isCode = (code: string) => (e: unknown): boolean => e instanceof DomainError && e.code === code;

test('успешная покупка + идемпотентность + списание карты', async () => {
  const h = harness();
  await h.kyc.set('u_1', APPROVED_L1);
  await h.cards.upsert('u_1', { id: 'card_1', label: 'c', bank: 'sber', last4: '1111', balance: 1e9, currency: 'RUB', active: true });
  const market = h.feedHub.getMarket('USDT', 'RUB', 'buy');
  assert.equal(market.offers.length, 6);
  const nonBest = h.offers.find((o) => !h.feedHub.isBestOffer('USDT', 'RUB', 'buy', o.id, 1000))!;

  const body = { offerId: nonBest.id, asset: 'USDT', fiat: 'RUB', side: 'buy', volumeUsdt: 1000, method: 'sber', cardId: 'card_1' };
  const d1 = await h.deals.create('u_1', body, 'idem-1');
  assert.equal(d1.status, 'created');
  assert.match(d1.ref, /^P2D-/);

  const d2 = await h.deals.create('u_1', body, 'idem-1'); // тот же ключ
  assert.equal(d2.id, d1.id, 'идемпотентность: тот же ордер');

  const card = await h.cards.get('u_1', 'card_1');
  assert.ok(card && card.balance < 1e9, 'карта списана один раз');
});

test('лучшие стаканы закрыты без quarter и открыты после подписки', async () => {
  const h = harness();
  await h.kyc.set('u_1', APPROVED_L1);
  await h.cards.upsert('u_1', { id: 'card_1', label: 'c', bank: 'sber', last4: '1111', balance: 1e9, currency: 'RUB', active: true });
  h.feedHub.getMarket('USDT', 'RUB', 'buy');
  const best = h.offers.find((o) => h.feedHub.isBestOffer('USDT', 'RUB', 'buy', o.id, 1000))!;
  const body = { offerId: best.id, asset: 'USDT', fiat: 'RUB', side: 'buy', volumeUsdt: 1000, method: 'sber', cardId: 'card_1' };

  await assert.rejects(h.deals.create('u_1', body, 'g-1'), isCode('plan_required'));
  await h.subs.subscribe('u_1', 'quarter');
  const d = await h.deals.create('u_1', body, 'g-2');
  assert.equal(d.status, 'created');
});

test('серверные проверки: KYC и дневной лимит', async () => {
  const h = harness();
  h.feedHub.getMarket('USDT', 'RUB', 'buy');
  const nonBest = h.offers.find((o) => !h.feedHub.isBestOffer('USDT', 'RUB', 'buy', o.id, 1000))!;

  // без KYC — отказ
  await assert.rejects(
    h.deals.create('u_2', { offerId: nonBest.id, asset: 'USDT', fiat: 'RUB', side: 'buy', volumeUsdt: 1000, method: 'sber', cardId: null }, 'k-1'),
    isCode('kyc_required'),
  );

  // с KYC уровня 1 (лимит 10 000 USDT/сутки) объём 20 000 — отказ
  await h.kyc.set('u_3', APPROVED_L1);
  await h.cards.upsert('u_3', { id: 'c3', label: 'c', bank: 'sber', last4: '2222', balance: 1e12, currency: 'RUB', active: true });
  await assert.rejects(
    h.deals.create('u_3', { offerId: nonBest.id, asset: 'USDT', fiat: 'RUB', side: 'buy', volumeUsdt: 20000, method: 'sber', cardId: 'c3' }, 'k-2'),
    isCode('limit_exceeded'),
  );
});

test('неизвестный Idempotency-Key длины 0 отклоняется', async () => {
  const h = harness();
  await h.kyc.set('u_1', APPROVED_L1);
  h.feedHub.getMarket('USDT', 'RUB', 'buy');
  const nonBest = h.offers[5]!;
  await assert.rejects(
    h.deals.create('u_1', { offerId: nonBest.id, asset: 'USDT', fiat: 'RUB', side: 'buy', volumeUsdt: 1000, method: 'sber', cardId: 'card_1' }, ''),
    isCode('validation'),
  );
});
