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

export const ASSETS = [
  { id: 'USDT', name: 'Tether',   icon: './assets/coins/usdt.png', base: { RUB: 97.4, USD: 1.0, EUR: 0.92, UAH: 41.3, KZT: 492 }, dp: 2 },
  { id: 'BTC',  name: 'Bitcoin',  icon: './assets/coins/btc.png',  base: { RUB: 6_380_000, USD: 65_400, EUR: 60_100, UAH: 2_700_000, KZT: 32_100_000 }, dp: 6 },
  { id: 'ETH',  name: 'Ethereum', icon: './assets/coins/eth.png',  base: { RUB: 247_000, USD: 2_530, EUR: 2_330, UAH: 104_000, KZT: 1_245_000 }, dp: 4 },
  { id: 'BNB',  name: 'BNB',      icon: './assets/coins/bnb.png',  base: { RUB: 57_900, USD: 594, EUR: 547, UAH: 24_500, KZT: 292_000 }, dp: 4 },
  { id: 'SOL',  name: 'Solana',   icon: './assets/coins/sol.png',  base: { RUB: 14_200, USD: 146, EUR: 134, UAH: 6_020, KZT: 71_800 }, dp: 4 },
  { id: 'TON',  name: 'Toncoin',  icon: './assets/coins/ton.png',  base: { RUB: 512, USD: 5.26, EUR: 4.84, UAH: 217, KZT: 2_590 }, dp: 3 },
];

export const AST = Object.fromEntries(ASSETS.map((a) => [a.id, a]));

export const FIATS = [
  { id: 'RUB', sym: '₽', name: 'Рубль' },
  { id: 'USD', sym: '$', name: 'Доллар' },
  { id: 'EUR', sym: '€', name: 'Евро' },
  { id: 'UAH', sym: '₴', name: 'Гривна' },
  { id: 'KZT', sym: '₸', name: 'Тенге' },
];

export const FIAT = Object.fromEntries(FIATS.map((f) => [f.id, f]));

/** Which payment rails exist per fiat — keeps the mock feed plausible. */
export const FIAT_METHODS = {
  RUB: ['sber', 'tbank', 'alfa', 'vtb', 'raif', 'ozon', 'sbp', 'yoomoney', 'cash'],
  USD: ['wire', 'cash'],
  EUR: ['wire', 'cash'],
  UAH: ['sbp', 'cash', 'wire'],
  KZT: ['sber', 'sbp', 'cash', 'wire'],
};
