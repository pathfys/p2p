import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOffer, rankBestIds, medianPrice } from '../src/domain/offer.js';
import type { Offer } from '../src/domain/types.js';

const known = new Set(['binance', 'bybit']);
const opts = { knownExchanges: known };

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'binance:1', exchange: 'binance', side: 'buy', asset: 'USDT', fiat: 'RUB',
    price: 97.5, available: 1000, min: 500, max: 50000, methods: ['sber'],
    merchant: { id: 'm1', name: 'Shop', orders: 100, completion: 0.98, rating: 4.9 },
    kycRequired: 1, ts: Date.now(), ...over,
  };
}

test('валидный офер нормализуется', () => {
  const o = normalizeOffer(raw(), opts);
  assert.ok(o);
  assert.equal(o.exchange, 'binance');
  assert.equal(o.price, 97.5);
  assert.equal(o.merchant.completion, 0.98);
});

test('мусор и граничные случаи отбрасываются', () => {
  assert.equal(normalizeOffer(null, opts), null);
  assert.equal(normalizeOffer('x', opts), null);
  assert.equal(normalizeOffer(raw({ id: undefined }), opts), null);
  assert.equal(normalizeOffer(raw({ exchange: 'kraken' }), opts), null, 'неизвестная биржа');
  assert.equal(normalizeOffer(raw({ id: 'bybit:9', exchange: 'binance' }), opts), null, 'id не из той биржи');
  assert.equal(normalizeOffer(raw({ price: 'abc' }), opts), null, 'нечисловая цена');
  assert.equal(normalizeOffer(raw({ price: -1 }), opts), null, 'отрицательная цена');
  assert.equal(normalizeOffer(raw({ price: 1e13 }), opts), null, 'абсурдная цена');
  assert.equal(normalizeOffer(raw({ asset: 'DOGE' }), opts), null, 'неизвестный актив');
});

test('строки обрезаются, числа зажимаются', () => {
  const o = normalizeOffer(raw({
    merchant: { id: 'm', name: 'x'.repeat(500), orders: -5, completion: 2, rating: 99 },
    available: -10, methods: Array(50).fill('sber'),
  }), opts);
  assert.ok(o);
  assert.equal(o.merchant.name.length, 64);
  assert.equal(o.merchant.orders, 0);
  assert.equal(o.merchant.completion, 1);
  assert.equal(o.merchant.rating, 5);
  assert.equal(o.available, 0);
  assert.ok(o.methods.length <= 12);
});

test('rankBestIds и медиана', () => {
  const offers: Offer[] = [97, 98, 99, 100, 101].map((p, i) =>
    normalizeOffer(raw({ id: `binance:${i}`, price: p, merchant: { id: `m${i}`, name: 'n', orders: 1000, completion: 0.99, rating: 5 } }), opts)!);
  assert.equal(medianPrice(offers), 99);
  const best = rankBestIds(offers, 99, 'buy', 1, 3);
  // для buy лучшая — минимальная цена (97 → binance:0)
  assert.ok(best.has('binance:0'));
  assert.equal(best.size, 3);
});
