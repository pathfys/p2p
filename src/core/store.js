/**
 * Reactive store with namespaced subscriptions + selective localStorage persistence.
 * Ephemeral slices (offers, logs, wires) stay in memory only.
 */
import { uid } from './format.js';

// ключ не переименовываем вслед за продуктом — иначе у всех слетит сохранённое состояние
const LS_KEY = 'p2pdesk.state.v1';
const PERSIST = ['balance', 'cards', 'settings', 'kyc', 'purchases', 'ui', 'filters', 'profile', 'stats'];

export const PAY_METHODS = [
  { id: 'sber',      name: 'Сбербанк',    risk: 0.08, tint: '#2ecc71' },
  { id: 'tbank',     name: 'Т-Банк',      risk: 0.07, tint: '#ffdd2d' },
  { id: 'alfa',      name: 'Альфа-Банк',  risk: 0.10, tint: '#ef3124' },
  { id: 'vtb',       name: 'ВТБ',         risk: 0.12, tint: '#0a2896' },
  { id: 'raif',      name: 'Райффайзен',  risk: 0.11, tint: '#fee600' },
  { id: 'ozon',      name: 'Ozon Банк',   risk: 0.14, tint: '#005bff' },
  { id: 'sbp',       name: 'СБП',         risk: 0.09, tint: '#1eb4a6' },
  { id: 'yoomoney',  name: 'ЮMoney',      risk: 0.22, tint: '#8b3ffd' },
  { id: 'cash',      name: 'Наличные',    risk: 0.34, tint: '#9aa4a1' },
  { id: 'wire',      name: 'SWIFT/SEPA',  risk: 0.18, tint: '#4ea8ff' },
];

export const KYC_LEVELS = [
  { level: 0, name: 'Не верифицирован', dayLimit: 0,     monthLimit: 0,      needs: [] },
  { level: 1, name: 'Базовый',          dayLimit: 10000, monthLimit: 100000, needs: ['personal', 'document'] },
  { level: 2, name: 'Расширенный',      dayLimit: 100000, monthLimit: 1500000, needs: ['personal', 'document', 'selfie', 'address'] },
  { level: 3, name: 'Корпоративный',    dayLimit: Infinity, monthLimit: Infinity, needs: ['personal', 'document', 'selfie', 'address', 'company'] },
];

export const PLANS = [
  { id: 'starter', name: 'Starter', price: 0,   seats: 1,  apiCalls: 5000,   exchanges: 3 },
  { id: 'pro',     name: 'Pro',     price: 149, seats: 5,  apiCalls: 250000, exchanges: 8 },
  { id: 'scale',   name: 'Scale',   price: 690, seats: 25, apiCalls: 5000000, exchanges: 8 },
];

function defaults() {
  return {
    balance: { usdt: 4820.47, locked: 0 },

    cards: [
      { id: uid('card'), bank: 'sber',  label: 'Сбербанк',   number: '4276551234567890', balance: 452800, limit: 600000, currency: 'RUB', active: true },
      { id: uid('card'), bank: 'tbank', label: 'Т-Банк',     number: '5536913098761234', balance: 142300, limit: 400000, currency: 'RUB', active: true },
      { id: uid('card'), bank: 'alfa',  label: 'Альфа-Банк', number: '4154812233445566', balance: 56900,  limit: 300000, currency: 'RUB', active: false },
    ],

    purchases: [],

    filters: {
      asset: 'USDT',
      fiat: 'RUB',
      side: 'buy',
      exchanges: ['binance', 'bybit', 'okx', 'bitget', 'htx', 'kucoin', 'mexc', 'gate'],
      methods: [],
      priceMin: null,
      priceMax: null,
      amountMin: null,
      amountMax: null,
      minCompletion: 90,
      minOrders: 50,
      verifiedOnly: false,
      proOnly: false,
      onlineOnly: true,
      hideBlocked: true,
      fitsVolume: true,
      sort: 'price',
    },

    settings: {
      // connection
      wsUrl: 'wss://api.p2plight.local/v1/stream',
      feedMode: 'mock',        // mock | live
      autoReconnect: true,
      throttleMs: 450,
      maxLogs: 400,
      logLevels: ['info', 'up', 'down', 'new', 'gone', 'warn', 'alert', 'trade'],
      // trading
      volume: 2000,
      maxPerDeal: 50000,
      dayLimit: 150000,
      slippageTol: 1.0,
      minSpread: 0.6,
      targetMargin: 1.8,
      exchangeFee: 0.1,
      autoRejectRisky: true,
      confirmDeals: true,
      // AI
      aiEnabled: true,
      minConfidence: 60,
      weights: { reputation: 25, price: 25, liquidity: 15, method: 15, speed: 10, exchange: 10 },
      // notifications
      notifySpread: true,
      notifySpreadPct: 1.5,
      notifyNewMerchant: false,
      notifyDealStatus: true,
      // appearance
      theme: 'dark',
      compactRows: false,
      hideBalanceDefault: false,
      haptics: true,
      // keys (stored locally only)
      apiKeys: {},
    },

    kyc: {
      status: 'none',          // none | draft | pending | approved | rejected
      level: 0,
      submittedAt: null,
      reviewedAt: null,
      rejectReason: null,
      data: {
        firstName: '', lastName: '', birthDate: '', country: 'RU',
        docType: 'passport', docNumber: '', docExpiry: '',
        selfie: false, docScan: false,
        address: '', city: '', zip: '',
        company: '', taxId: '', companyCountry: 'RU',
      },
      steps: { personal: false, document: false, selfie: false, address: false, company: false },
    },

    profile: {
      name: 'Арт Тр.',
      handle: '@trader',
      tgId: null,
      photo: null,
      plan: 'pro',
      apiToken: 'p2pd_live_' + Math.random().toString(36).slice(2, 12),
      twoFa: false,
      seatsUsed: 2,
      apiUsed: 48320,
      joinedAt: Date.now() - 86400000 * 94,
    },

    stats: { volumeUsdt: 0, deals: 0, won: 0, spreadSum: 0, profitUsdt: 0, dayVolume: 0, dayKey: new Date().toDateString() },

    ui: { tab: 'home', balanceHidden: false, logPaused: false, pickedOffer: null },

    // ---- ephemeral ----
    offers: {},     // id -> offer
    wires: {},      // exchange -> {state, latency, msgs, lastTs}
    logs: [],
    market: { median: 0, best: 0, prev: 0, history: [] },
  };
}

function load() {
  const base = defaults();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    for (const k of PERSIST) {
      if (saved[k] === undefined) continue;
      base[k] = (base[k] && !Array.isArray(base[k]) && typeof base[k] === 'object')
        ? deepMerge(base[k], saved[k])
        : saved[k];
    }
  } catch (e) { console.warn('[store] load failed', e); }
  return base;
}

function deepMerge(target, src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return src ?? target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(src)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && target && typeof target[k] === 'object' && !Array.isArray(target[k]))
      ? deepMerge(target[k], v)
      : v;
  }
  return out;
}

export const state = load();

const subs = new Map();   // channel -> Set<fn>

/** subscribe('balance', fn) — '*' hears everything */
export function on(channel, fn) {
  const chans = Array.isArray(channel) ? channel : [channel];
  for (const c of chans) {
    if (!subs.has(c)) subs.set(c, new Set());
    subs.get(c).add(fn);
  }
  return () => { for (const c of chans) subs.get(c)?.delete(fn); };
}

let saveTimer = null;
export function emit(channel, payload) {
  for (const fn of subs.get(channel) || []) { try { fn(payload, channel); } catch (e) { console.error(e); } }
  for (const fn of subs.get('*') || []) { try { fn(payload, channel); } catch (e) { console.error(e); } }
  if (PERSIST.includes(channel)) schedulePersist();
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 220);
}

export function persist() {
  try {
    const slice = {};
    for (const k of PERSIST) slice[k] = state[k];
    localStorage.setItem(LS_KEY, JSON.stringify(slice, (k, v) => (v === Infinity ? '∞' : v)));
  } catch (e) { console.warn('[store] persist failed', e); }
}

/** Mutate a slice and notify: set('balance', b => { b.usdt += 10 }) */
export function set(channel, mutator) {
  if (typeof mutator === 'function') mutator(state[channel]);
  else state[channel] = mutator;
  emit(channel, state[channel]);
  return state[channel];
}

export function resetAll() {
  localStorage.removeItem(LS_KEY);
  location.reload();
}

export function exportState() {
  const slice = {};
  for (const k of PERSIST) slice[k] = state[k];
  return JSON.stringify(slice, null, 2);
}

export function importState(json) {
  const parsed = JSON.parse(json);
  const slice = {};
  for (const k of PERSIST) if (parsed[k] !== undefined) slice[k] = parsed[k];
  localStorage.setItem(LS_KEY, JSON.stringify(slice));
  location.reload();
}

/* ---------- derived helpers ---------- */

export const kycInfo = () => KYC_LEVELS[state.kyc.level] || KYC_LEVELS[0];
export const plan = () => PLANS.find((p) => p.id === state.profile.plan) || PLANS[0];

export function canTrade() {
  if (state.kyc.status !== 'approved' || state.kyc.level < 1) {
    return { ok: false, code: 'kyc', msg: 'Нужна KYC-верификация (уровень 1 и выше)' };
  }
  return { ok: true };
}

export function rollDay() {
  const key = new Date().toDateString();
  if (state.stats.dayKey !== key) {
    state.stats.dayKey = key;
    state.stats.dayVolume = 0;
    emit('stats', state.stats);
  }
}
