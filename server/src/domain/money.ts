/**
 * Деньги: активы (цена в USD), курсы валют, способы оплаты по валюте.
 * Сервер — источник истины по ценам; значения заданы здесь, в проде их место
 * в маркет-дата-адаптере. Формула едина: цена актива в валюте = usd × rate.
 */

export interface Asset {
  id: string;
  usd: number;
  dp: number;
}

export const ASSETS: Record<string, Asset> = {
  USDT: { id: 'USDT', usd: 1, dp: 2 },
  BTC: { id: 'BTC', usd: 65_400, dp: 6 },
  ETH: { id: 'ETH', usd: 2_530, dp: 4 },
  BNB: { id: 'BNB', usd: 594, dp: 4 },
  SOL: { id: 'SOL', usd: 146, dp: 4 },
  TON: { id: 'TON', usd: 5.26, dp: 3 },
};

/** Курс валюты к USD (1 USD = rate единиц валюты). Подмножество regions.js. */
export const CURRENCY_RATES: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, RUB: 97, UAH: 41, KZT: 492, TRY: 34, INR: 83,
  NGN: 1600, BRL: 5.4, ARS: 1000, VND: 25400, IDR: 15800, THB: 35, PHP: 58,
  PKR: 278, EGP: 49, AED: 3.67, SAR: 3.75, KRW: 1380, JPY: 150, CNY: 7.2,
  PLN: 4.0, CZK: 23, RON: 4.6, HUF: 360, ZAR: 18, MXN: 18, COP: 4100,
};

/** Идентификаторы способов оплаты из фронтового PAY_METHODS. */
export const PAY_METHOD_IDS = [
  'sber', 'tbank', 'alfa', 'vtb', 'ozon', 'sbp', 'yoomoney', 'cash', 'wire',
  'bank', 'card', 'sepa', 'wise', 'revolut', 'paypal',
] as const;

const RU_METHODS = ['sber', 'tbank', 'alfa', 'vtb', 'ozon', 'sbp', 'yoomoney'];
const EU_METHODS = ['sepa', 'revolut', 'wise', 'bank', 'card'];
const DEFAULT_METHODS = ['bank', 'card', 'wise', 'paypal', 'cash'];

const METHODS_BY_CUR: Record<string, string[]> = {
  RUB: RU_METHODS,
  EUR: EU_METHODS,
  GBP: ['revolut', 'wise', 'bank', 'card'],
  UAH: ['card', 'bank', 'wise'],
  KZT: ['card', 'bank', 'wise'],
};

export const isKnownAsset = (id: string): boolean => Object.hasOwn(ASSETS, id);
export const isKnownCurrency = (id: string): boolean => Object.hasOwn(CURRENCY_RATES, id);

export function methodsFor(currency: string): string[] {
  return METHODS_BY_CUR[currency] ?? DEFAULT_METHODS;
}

/** Цена 1 единицы актива в указанной валюте (0 для неизвестных). */
export function assetRate(asset: string, currency: string): number {
  const a = ASSETS[asset];
  const rate = CURRENCY_RATES[currency];
  if (!a || rate === undefined) return 0;
  return a.usd * rate;
}

/** Сколько единиц актива соответствует объёму в USDT при текущих ценах. */
export function usdtToAsset(usdt: number, asset: string): number {
  const a = ASSETS[asset];
  if (!a || a.usd <= 0) return 0;
  return usdt / a.usd;
}
