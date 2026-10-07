/**
 * Топ мерчантов за период (неделя/месяц/всё время) по объёму USDT или числу
 * ордеров. Детерминированный генератор (seeded PRNG): состав стабилен, значения
 * зависят от периода. В проде это представление строится из закрытых сделок;
 * алгоритм ранжирования (сортировка по метрике) остаётся тем же.
 */
export type TopPeriod = 'week' | 'month' | 'all';
export type TopMetric = 'volume' | 'orders';

export const PERIODS: readonly TopPeriod[] = ['week', 'month', 'all'];
export const METRICS: readonly TopMetric[] = ['volume', 'orders'];

const PERIOD_MULT: Record<TopPeriod, number> = { week: 1, month: 4.3, all: 64 };

export const isPeriod = (v: string): v is TopPeriod => (PERIODS as readonly string[]).includes(v);
export const isMetric = (v: string): v is TopMetric => (METRICS as readonly string[]).includes(v);

export interface TopEntry {
  rank: number;
  name: string;
  exchange: string;
  volumeUsdt: number;
  orders: number;
  completion: number;
  rating: number;
  verified: boolean;
  pro: boolean;
}

const NAMES = [
  'CryptoBaron', 'AlphaDesk', 'FastSwap', 'UsdtKing', 'NordExchange', 'MerchantPro',
  'LiquidHub', 'SafeTrade', 'OtcWhale', 'PrimeP2P', 'GoldBridge', 'FlashDealer',
  'VostokPay', 'SilkRoad', 'EuroDesk', 'AsiaLiquid', 'TetherLord', 'QuickFiat',
  'IronVault', 'StableFlow', 'RapidCash', 'MetroSwap', 'OceanOtc', 'VertexPay',
  'ZenTrader', 'NovaDesk', 'ApexFiat', 'LunarSwap', 'TitanOtc', 'OrbitPay',
  'CobraDeals', 'FalconFx', 'MeridianP2P', 'HelixSwap', 'CedarTrade', 'AtlasDesk',
  'PulseFiat', 'VektorPay', 'DeltaWhale', 'KometaOtc',
];

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

interface Base {
  name: string;
  exchange: string;
  baseWeekVol: number;
  avgTicket: number;
  completion: number;
  rating: number;
  verified: boolean;
  pro: boolean;
}

/** Строит таблицу лидеров. `exchanges` — пул площадок для привязки мерчанта. */
export function buildLeaderboard(
  exchanges: readonly string[],
  period: TopPeriod,
  metric: TopMetric,
  limit = 30,
): TopEntry[] {
  const pool = exchanges.length ? exchanges : ['binance'];
  const roster: Base[] = NAMES.map((name) => {
    const r = mulberry32(hashStr(name));
    return {
      name,
      exchange: pool[Math.floor(r() * pool.length)]!,
      baseWeekVol: 40_000 + r() * 2_400_000,
      avgTicket: 280 + r() * 4200,
      completion: 0.93 + r() * 0.069,
      rating: 4.6 + r() * 0.39,
      verified: r() > 0.22,
      pro: r() > 0.6,
    };
  });

  const mult = PERIOD_MULT[period];
  const rows = roster.map((m) => {
    const j = mulberry32(hashStr(m.name + ':' + period))();
    const jitter = 0.72 + j * 0.56;
    const volumeUsdt = m.baseWeekVol * mult * jitter;
    const orders = Math.max(1, Math.round(volumeUsdt / m.avgTicket));
    return {
      name: m.name,
      exchange: m.exchange,
      volumeUsdt,
      orders,
      completion: m.completion,
      rating: m.rating,
      verified: m.verified,
      pro: m.pro,
    };
  });

  rows.sort((a, b) => (metric === 'volume' ? b.volumeUsdt - a.volumeUsdt : b.orders - a.orders));
  return rows.slice(0, limit).map((row, i) => ({ rank: i + 1, ...row }));
}
