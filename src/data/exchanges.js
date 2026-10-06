/**
 * Exchange registry. `endpoint` documents the venue's real public P2P source —
 * the backend adapter is what actually talks to it; the frontend only ever
 * speaks our own normalised WS protocol (see docs/ws-protocol.md).
 */
export const EXCHANGES = [
  { id: 'binance', name: 'Binance',  tag: 'BIN', tint: '#f0b90b', reliability: 0.97, baseLatency: 38,
    endpoint: 'POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search' },
  { id: 'bybit',   name: 'Bybit',    tag: 'BYB', tint: '#f7a600', reliability: 0.95, baseLatency: 44,
    endpoint: 'POST https://api2.bybit.com/fiat/otc/item/online' },
  { id: 'okx',     name: 'OKX',      tag: 'OKX', tint: '#dcdcdc', reliability: 0.94, baseLatency: 52,
    endpoint: 'GET https://www.okx.com/v3/c2c/tradingOrders/books' },
  { id: 'bitget',  name: 'Bitget',   tag: 'BTG', tint: '#00f0ff', reliability: 0.92, baseLatency: 61,
    endpoint: 'POST https://www.bitget.com/v1/p2p/pub/adv/queryAdvList' },
  { id: 'htx',     name: 'HTX',      tag: 'HTX', tint: '#1cc4b4', reliability: 0.90, baseLatency: 74,
    endpoint: 'GET https://otc-api.trygala.com/v1/data/trade-market' },
  { id: 'kucoin',  name: 'KuCoin',   tag: 'KCS', tint: '#24d4a0', reliability: 0.89, baseLatency: 83,
    endpoint: 'GET https://www.kucoin.com/_api/otc/ad/list' },
  { id: 'mexc',    name: 'MEXC',     tag: 'MXC', tint: '#2fd7c4', reliability: 0.87, baseLatency: 91,
    endpoint: 'GET https://otc.mexc.com/api/market/deal/list' },
  { id: 'gate',    name: 'Gate.io',  tag: 'GTE', tint: '#9fe870', reliability: 0.86, baseLatency: 96,
    endpoint: 'GET https://www.gate.io/json_svr/query_push' },
];

export const EX = Object.fromEntries(EXCHANGES.map((e) => [e.id, e]));

// Цена актива в USD (≈ в USDT). Цена в любой валюте = usd × курс валюты,
// поэтому новые валюты подключаются без правок здесь (см. regions.js).
export const ASSETS = [
  { id: 'USDT', name: 'Tether',   icon: './assets/coins/usdt.png', usd: 1,      dp: 2 },
  { id: 'BTC',  name: 'Bitcoin',  icon: './assets/coins/btc.png',  usd: 65_400, dp: 6 },
  { id: 'ETH',  name: 'Ethereum', icon: './assets/coins/eth.png',  usd: 2_530,  dp: 4 },
  { id: 'BNB',  name: 'BNB',      icon: './assets/coins/bnb.png',  usd: 594,    dp: 4 },
  { id: 'SOL',  name: 'Solana',   icon: './assets/coins/sol.png',  usd: 146,    dp: 4 },
  { id: 'TON',  name: 'Toncoin',  icon: './assets/coins/ton.png',  usd: 5.26,   dp: 3 },
];

export const AST = Object.fromEntries(ASSETS.map((a) => [a.id, a]));

import { CURRENCIES as _CUR, methodsFor as _methodsFor } from './regions.js';

// реэкспорт для обратной совместимости импортов из exchanges.js
export const CURRENCIES = _CUR;
export const CUR = _CUR;
export const FIAT = _CUR;          // для .sym lookups
export const methodsFor = _methodsFor;

/** Цена 1 единицы актива в указанной валюте. */
export function assetRate(asset, cur) {
  const a = AST[asset];
  const c = _CUR[cur];
  if (!a || !c) return 0;
  return a.usd * c.rate;
}
