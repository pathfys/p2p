/**
 * Нормализация и санитизация офера — граница доверия к данным бирж.
 * Биржевые адаптеры отдают произвольный (и потенциально вредоносный) JSON:
 * строки вместо чисел, NaN, абсурдные значения, инъекции в именах мерчантов.
 * Здесь всё приводится к строгой форме Offer или отбрасывается (null).
 * Тот же инвариант продублирован на клиенте (feed.js), но доверенная граница — тут.
 */
import type { Offer, Side } from './types.js';
import { isKnownAsset, isKnownCurrency } from './money.js';

const MAX_PRICE = 1e12;
const MAX_QTY = 1e15;

const toNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const nonNeg = (v: unknown, def = 0): number => {
  const n = toNum(v);
  return Number.isFinite(n) ? Math.max(0, n) : def;
};
const clampStr = (v: unknown, def: string, max: number): string =>
  (typeof v === 'string' ? v : def).slice(0, max);

export interface NormalizeOpts {
  /** Разрешённые биржи: офер чужой/неизвестной биржи отбрасывается. */
  knownExchanges: ReadonlySet<string>;
}

/** @returns валидный Offer либо null для мусора. Никогда не бросает. */
export function normalizeOffer(raw: unknown, opts: NormalizeOpts): Offer | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const id = typeof o['id'] === 'string' ? o['id'].slice(0, 96) : null;
  const exchange = typeof o['exchange'] === 'string' ? o['exchange'].slice(0, 24) : null;
  if (!id || !exchange || !opts.knownExchanges.has(exchange)) return null;
  // id должен иметь форму "<exchange>:<...>" — защита от подмены пространства имён.
  if (!id.startsWith(exchange + ':')) return null;

  const price = toNum(o['price']);
  if (!(price > 0) || price > MAX_PRICE) return null;

  const asset = clampStr(o['asset'], 'USDT', 12);
  const fiat = clampStr(o['fiat'], 'RUB', 8);
  if (!isKnownAsset(asset) || !isKnownCurrency(fiat)) return null;

  const m = (o['merchant'] && typeof o['merchant'] === 'object' ? o['merchant'] : {}) as Record<string, unknown>;
  const side: Side = o['side'] === 'sell' ? 'sell' : 'buy';

  const methods = Array.isArray(o['methods'])
    ? (o['methods'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 12)
    : [];

  return {
    id,
    exchange,
    side,
    asset,
    fiat,
    price,
    available: Math.min(nonNeg(o['available']), MAX_QTY),
    min: Math.min(nonNeg(o['min']), MAX_QTY),
    max: Math.min(nonNeg(o['max']), MAX_QTY),
    methods,
    merchant: {
      id: clampStr(m['id'], id, 96),
      name: clampStr(m['name'], 'unknown', 64),
      orders: Math.min(Math.round(nonNeg(m['orders'])), 1e9),
      completion: Math.min(1, Math.max(0, toNum(m['completion']) || 0)),
      rating: Math.min(5, Math.max(0, toNum(m['rating']) || 0)),
      verified: Boolean(m['verified']),
      pro: Boolean(m['pro']),
      avgReleaseMin: Math.min(1440, nonNeg(m['avgReleaseMin'], 10)),
      online: m['online'] !== false,
      blocked: Boolean(m['blocked']),
    },
    kycRequired: Math.min(3, Math.max(0, Math.round(toNum(o['kycRequired']) || 0))),
    terms: typeof o['terms'] === 'string' ? o['terms'].slice(0, 600) : '',
    ts: Number.isFinite(toNum(o['ts'])) ? toNum(o['ts']) : Date.now(),
  };
}

/**
 * Лёгкая оценка качества офера (цена + репутация + ликвидность) — та же логика,
 * что на клиенте. Используется для серверного определения «лучших стаканов».
 */
export function quickScore(o: Offer, median: number, side: Side, needAsset: number): number {
  const dev = median ? (side === 'buy' ? (median - o.price) / median : (o.price - median) / median) : 0;
  const rep = o.merchant.completion * 0.6 + Math.min(1, o.merchant.orders / 3000) * 0.4;
  const liq = Math.min(1, o.available / (needAsset || 1));
  return dev * 55 + rep * 28 + liq * 17 + (o.merchant.online ? 4 : 0) + (o.merchant.verified ? 3 : 0);
}

/** id топ-N лучших оферов из списка (по quickScore). */
export function rankBestIds(offers: Offer[], median: number, side: Side, needAsset: number, n = 3): Set<string> {
  return new Set(
    [...offers]
      .sort((a, b) => quickScore(b, median, side, needAsset) - quickScore(a, median, side, needAsset))
      .slice(0, n)
      .map((o) => o.id),
  );
}

/** Медиана цен списка оферов (0 для пустого). */
export function medianPrice(offers: Offer[]): number {
  if (!offers.length) return 0;
  const p = offers.map((o) => o.price).sort((a, b) => a - b);
  const mid = p.length >> 1;
  return p.length % 2 ? p[mid]! : (p[mid - 1]! + p[mid]!) / 2;
}
