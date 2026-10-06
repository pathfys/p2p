/* P2P Light — bundled app. github.com/pathfys/p2p */
(function () {
  'use strict';
  var __m = {}, __c = {};
  function __req(id) {
    if (__c[id]) return __c[id];
    var f = __m[id];
    if (!f) throw new Error('module not found: ' + id);
    var x = __c[id] = {};
    f(x, __req);
    return x;
  }
__m["src/core/format.js"] = function (__x, __req) {
/** Number / money / time formatting. */

const nf = (min, max) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: min, maximumFractionDigits: max });

const fmt2 = (n) => nf(2, 2).format(Number(n) || 0);
const fmt0 = (n) => nf(0, 0).format(Math.round(Number(n) || 0));
const fmtN = (n, d = 2) => nf(d, d).format(Number(n) || 0);

/** 1 234 567.89 -> "1.23M" for dense tiles */
function compact(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return fmtN(n, 2);
}

/** Split for the hero: "12 345" + ".67" */
function splitAmount(n, d = 2) {
  const s = fmtN(n, d);
  const sep = s.lastIndexOf(',');
  return sep === -1 ? [s, ''] : [s.slice(0, sep), s.slice(sep)];
}

const pct = (n, d = 2) => `${n > 0 ? '+' : ''}${fmtN(n, d)}%`;

const money = (n, cur, d = 2) => `${fmtN(n, d)} ${cur}`;

function hhmmss(ts = Date.now()) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

function ms(ts = Date.now()) {
  return hhmmss(ts) + '.' + String(new Date(ts).getMilliseconds()).padStart(3, '0');
}

function dateTime(ts) {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} ч назад`;
  return `${Math.floor(hr / 24)} дн назад`;
}

const mask = (s, keep = 4) => '•••• ' + String(s).slice(-keep);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  __x.compact = compact;
  __x.splitAmount = splitAmount;
  __x.hhmmss = hhmmss;
  __x.ms = ms;
  __x.dateTime = dateTime;
  __x.ago = ago;
  __x.fmt2 = fmt2;
  __x.fmt0 = fmt0;
  __x.fmtN = fmtN;
  __x.pct = pct;
  __x.money = money;
  __x.mask = mask;
  __x.clamp = clamp;
  __x.uid = uid;
};

__m["src/core/store.js"] = function (__x, __req) {
/**
 * Reactive store with namespaced subscriptions + selective localStorage persistence.
 * Ephemeral slices (offers, logs, wires) stay in memory only.
 */
const { uid } = __req("src/core/format.js");
// v2: баланс и карты стартуют пустыми; старое состояние v1 игнорируется
const LS_KEY = 'p2pdesk.state.v2';
const PERSIST = ['balance', 'cards', 'settings', 'kyc', 'purchases', 'ui', 'filters', 'profile', 'stats', 'region', 'quests', 'wheel'];

const PAY_METHODS = [
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
  // международные рельсы для валют вне РФ
  { id: 'bank',      name: 'Банк. перевод', risk: 0.12, tint: '#5b8def' },
  { id: 'card',      name: 'Карта',       risk: 0.16, tint: '#f7a600' },
  { id: 'sepa',      name: 'SEPA',        risk: 0.10, tint: '#003399' },
  { id: 'wise',      name: 'Wise',        risk: 0.13, tint: '#9fe870' },
  { id: 'revolut',   name: 'Revolut',     risk: 0.15, tint: '#0666eb' },
  { id: 'paypal',    name: 'PayPal',      risk: 0.24, tint: '#0070ba' },
];

const KYC_LEVELS = [
  { level: 0, name: 'Не верифицирован', dayLimit: 0,     monthLimit: 0,      needs: [] },
  { level: 1, name: 'Базовый',          dayLimit: 10000, monthLimit: 100000, needs: ['personal', 'document'] },
  { level: 2, name: 'Расширенный',      dayLimit: 100000, monthLimit: 1500000, needs: ['personal', 'document', 'selfie', 'address'] },
  { level: 3, name: 'Корпоративный',    dayLimit: Infinity, monthLimit: Infinity, needs: ['personal', 'document', 'selfie', 'address', 'company'] },
];

const PLANS = [
  { id: 'starter', name: 'Starter', price: 0,   seats: 1,  apiCalls: 5000,   exchanges: 3 },
  { id: 'pro',     name: 'Pro',     price: 149, seats: 5,  apiCalls: 250000, exchanges: 8 },
  { id: 'scale',   name: 'Scale',   price: 690, seats: 25, apiCalls: 5000000, exchanges: 8 },
];

function defaults() {
  return {
    // баланс и карты пустые — пользователь заводит сам
    balance: { usdt: 0, locked: 0 },

    cards: [],

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
      feedMode: 'mock',        // источник потока (переключается бэкендом)
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
      seatsUsed: 1,
      apiUsed: 0,
      joinedAt: Date.now(),
    },

    stats: { volumeUsdt: 0, deals: 0, won: 0, spreadSum: 0, profitUsdt: 0, dayVolume: 0, dayKey: new Date().toDateString() },

    // регион: null → показываем выбор при первом входе
    region: null,

    // еженедельные задания: счётчики недели + отметка о получении приза
    quests: { weekKey: weekKey(), deals: 0, volume: 0, claimed: false },

    // колесо фортуны: баланс прокрутов + история
    wheel: { spins: 1, lastResult: null, history: [] },

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

const state = load();

const subs = new Map();   // channel -> Set<fn>

/** subscribe('balance', fn) — '*' hears everything */
function on(channel, fn) {
  const chans = Array.isArray(channel) ? channel : [channel];
  for (const c of chans) {
    if (!subs.has(c)) subs.set(c, new Set());
    subs.get(c).add(fn);
  }
  return () => { for (const c of chans) subs.get(c)?.delete(fn); };
}

let saveTimer = null;
function emit(channel, payload) {
  for (const fn of subs.get(channel) || []) { try { fn(payload, channel); } catch (e) { console.error(e); } }
  for (const fn of subs.get('*') || []) { try { fn(payload, channel); } catch (e) { console.error(e); } }
  if (PERSIST.includes(channel)) schedulePersist();
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 220);
}

function persist() {
  try {
    const slice = {};
    for (const k of PERSIST) slice[k] = state[k];
    localStorage.setItem(LS_KEY, JSON.stringify(slice, (k, v) => (v === Infinity ? '∞' : v)));
  } catch (e) { console.warn('[store] persist failed', e); }
}

/** Mutate a slice and notify: set('balance', b => { b.usdt += 10 }) */
function set(channel, mutator) {
  if (typeof mutator === 'function') mutator(state[channel]);
  else state[channel] = mutator;
  emit(channel, state[channel]);
  return state[channel];
}

function resetAll() {
  localStorage.removeItem(LS_KEY);
  location.reload();
}

function exportState() {
  const slice = {};
  for (const k of PERSIST) slice[k] = state[k];
  return JSON.stringify(slice, null, 2);
}

function importState(json) {
  const parsed = JSON.parse(json);
  const slice = {};
  for (const k of PERSIST) if (parsed[k] !== undefined) slice[k] = parsed[k];
  localStorage.setItem(LS_KEY, JSON.stringify(slice));
  location.reload();
}

/* ---------- derived helpers ---------- */

const kycInfo = () => KYC_LEVELS[state.kyc.level] || KYC_LEVELS[0];
const plan = () => PLANS.find((p) => p.id === state.profile.plan) || PLANS[0];

function canTrade() {
  if (state.kyc.status !== 'approved' || state.kyc.level < 1) {
    return { ok: false, code: 'kyc', msg: 'Нужна KYC-верификация (уровень 1 и выше)' };
  }
  return { ok: true };
}

function rollDay() {
  const key = new Date().toDateString();
  if (state.stats.dayKey !== key) {
    state.stats.dayKey = key;
    state.stats.dayVolume = 0;
    emit('stats', state.stats);
  }
  rollWeek();
}

/* ---------- регион ---------- */

function setRegion(code) {
  const prev = state.region;
  state.region = code;
  emit('region', code);
  if (prev !== code) emit('quests', state.quests);   // «сменил регион» — для заданий
  persist();
}

/* ---------- еженедельные задания ---------- */

/** Понедельник текущей недели как ключ (YYYY-MM-DD). */
function weekKey(d = new Date()) {
  const t = new Date(d);
  const dow = (t.getDay() + 6) % 7;        // 0 = понедельник
  t.setDate(t.getDate() - dow);
  t.setHours(0, 0, 0, 0);
  return t.toISOString().slice(0, 10);
}

function rollWeek() {
  const key = weekKey();
  if (state.quests.weekKey !== key) {
    state.quests = { weekKey: key, deals: 0, volume: 0, claimed: false };
    emit('quests', state.quests);
  }
}

const QUESTS = [
  { id: 'deals',  title: 'Соверши 5 закупок',       target: 5,      metric: (s) => s.quests.deals },
  { id: 'volume', title: 'Наторгуй 10 000 USDT',    target: 10000,  metric: (s) => s.quests.volume },
  { id: 'kyc',    title: 'Пройди KYC-верификацию',  target: 1,      metric: (s) => (s.kyc.status === 'approved' ? 1 : 0) },
  { id: 'card',   title: 'Добавь платёжную карту',  target: 1,      metric: (s) => Math.min(1, s.cards.length) },
];

function questProgress() {
  rollWeek();
  const list = QUESTS.map((q) => {
    const cur = Math.min(q.target, q.metric(state));
    return { ...q, cur, done: cur >= q.target };
  });
  const doneCount = list.filter((q) => q.done).length;
  return { list, doneCount, total: QUESTS.length, allDone: doneCount === QUESTS.length };
}

/* ---------- колесо: защита от абуза ---------- */

const MAX_SPINS = 50;          // потолок прокрутов (ограничивает урон при подмене localStorage)

/** Изменить баланс прокрутов с зажимом в [0, MAX_SPINS]. */
function addSpins(n) {
  set('wheel', (w) => { w.spins = Math.max(0, Math.min(MAX_SPINS, (w.spins || 0) + n)); });
  return state.wheel.spins;
}

/** Списать один прокрут атомарно; false — если прокрутов нет. */
function consumeSpin() {
  if ((state.wheel.spins || 0) <= 0) return false;
  set('wheel', (w) => { w.spins = Math.max(0, w.spins - 1); });
  return true;
}

/** Забрать приз за выполнение всех заданий недели → +1 прокрут (одноразово в неделю). */
function claimQuestReward() {
  const p = questProgress();
  if (!p.allDone || state.quests.claimed) return false;
  set('quests', (q) => { q.claimed = true; });
  addSpins(1);
  return true;
}

/** Засчитать закупку в недельные задания. */
function trackDealForQuests(volumeUsdt) {
  rollWeek();
  set('quests', (q) => { q.deals += 1; q.volume += Math.max(0, volumeUsdt); });
}

  __x.on = on;
  __x.emit = emit;
  __x.persist = persist;
  __x.set = set;
  __x.resetAll = resetAll;
  __x.exportState = exportState;
  __x.importState = importState;
  __x.canTrade = canTrade;
  __x.rollDay = rollDay;
  __x.setRegion = setRegion;
  __x.weekKey = weekKey;
  __x.rollWeek = rollWeek;
  __x.questProgress = questProgress;
  __x.addSpins = addSpins;
  __x.consumeSpin = consumeSpin;
  __x.claimQuestReward = claimQuestReward;
  __x.trackDealForQuests = trackDealForQuests;
  __x.PAY_METHODS = PAY_METHODS;
  __x.KYC_LEVELS = KYC_LEVELS;
  __x.PLANS = PLANS;
  __x.state = state;
  __x.kycInfo = kycInfo;
  __x.plan = plan;
  __x.QUESTS = QUESTS;
  __x.MAX_SPINS = MAX_SPINS;
};

__m["src/core/dom.js"] = function (__x, __req) {
/** Tiny DOM helpers — no framework, no build step. */

/** Create an element: h('div.foo', {attrs}, ...children) */
function h(spec, props, ...children) {
  const [tagPart, ...classes] = String(spec).split('.');
  const el = document.createElement(tagPart || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  } else if (props !== undefined && props !== null) {
    children.unshift(props);
  }

  append(el, children);
  return el;
}

function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

const frag = (...children) => append(document.createDocumentFragment(), children);

const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

function mount(el, ...children) { clear(el); return append(el, children); }

/** Inline SVG icon set (stroke-based, 24-grid). */
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.9 3.6-6.5 8-6.5s8 2.6 8 6.5',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Zm10 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
  eyeOff: 'M3 3l18 18M10.6 10.7a2.6 2.6 0 0 0 3.6 3.7M6.6 6.8C4 8.4 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.3 4.3-.8M19.5 15.6C21.2 14 22 12 22 12s-3.6-6.5-10-6.5c-.7 0-1.3 0-2 .2',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  edit: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z',
  check: 'M4 12.5 9 17.5 20 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  chev: 'M9 5l7 7-7 7',
  chevDown: 'M5 9l7 7 7-7',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  filter: 'M3 5h18M6 12h12M10 19h4',
  shield: 'M12 3 5 6v6c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6l-7-3Z',
  shieldCheck: 'M12 3 5 6v6c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6l-7-3ZM9 12l2.2 2.2L15.5 10',
  alert: 'M12 3 2.5 20h19L12 3ZM12 9v5M12 17.2v.3',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8.2v.3M12 11.5V16',
  zap: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  cpu: 'M8 8h8v8H8zM4 9V7a3 3 0 0 1 3-3h2M15 4h2a3 3 0 0 1 3 3v2M20 15v2a3 3 0 0 1-3 3h-2M9 20H7a3 3 0 0 1-3-3v-2',
  wallet: 'M3 8.5A2.5 2.5 0 0 1 5.5 6H18a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8.5ZM3 10h18M16.5 14.5h.5',
  card: 'M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8ZM3 10.5h18M6.5 15H11',
  trash: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13',
  refresh: 'M20 11a8 8 0 1 0-2.4 6.3M20 5.5V11h-5.5',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4.5 19 12 7 19.5v-15Z',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  upload: 'M12 16V4M7 8l5-5 5 5M4 20h16',
  copy: 'M9 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4M3 11a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3.2 2',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 17.5l9 5 9-5',
  key: 'M14.5 9.5a4 4 0 1 0-4.2 4L9 15l-2 .3.3 2L5 19l1 3 2.8-1.5.4-2.6 2.3-2.3M16.6 7.4h.3',
  link: 'M9.5 14.5 14.5 9.5M8 12 6 14a3.5 3.5 0 0 0 5 5l2-2M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2',
  doc: 'M6 3h7l5 5v13H6V3ZM13 3v5h5M9 13h6M9 17h6',
  camera: 'M3 9a3 3 0 0 1 3-3h1.5L9 4h6l1.5 2H18a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Zm9 8.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5M16.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.6c2.4.7 4 2.5 4 5.4',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9ZM10 19a2.2 2.2 0 0 0 4 0',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9h17M3.5 15h17M12 3c-2.5 3-2.5 15 0 18M12 3c2.5 3 2.5 15 0 18',
  database: 'M12 7.5c4.4 0 8-1 8-2.2S16.4 3 12 3 4 4 4 5.3s3.6 2.2 8 2.2ZM4 5.3v13.4C4 20 7.6 21 12 21s8-1 8-2.3V5.3M4 12c0 1.3 3.6 2.3 8 2.3s8-1 8-2.3',
  flame: 'M12 21c3.9 0 6-2.4 6-5.6 0-3.9-3.3-5.4-3.3-8.9 0-1.4.4-2.5.4-2.5S12 5 10.5 8.6C9.4 11.3 6 11.8 6 15.4 6 18.6 8.1 21 12 21Zm0-3.2c1.3 0 2.1-.9 2.1-2.1 0-1.6-1.8-2.2-1.8-3.7 0 0-1.9 1.3-2.3 2.9-.2.9.6 2.9 2 2.9Z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0-3.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  bookmark: 'M6 3h12v18l-6-4.5L6 21V3Z',
  scale: 'M12 4v16M7 20h10M12 7 5 9l3.5 5L12 9l3.5 5L19 9l-7-2Z',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM21 21l-5.2-5.2',
};

function icon(name, props = {}) {
  const d = ICONS[name] || ICONS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', props.sw || '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (props.class) svg.setAttribute('class', props.class);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

function sparkline(points, color = 'currentColor') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  if (!points.length) return svg;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((v, i) =>
    `${i ? 'L' : 'M'}${(i / (points.length - 1) * 100).toFixed(2)},${(30 - (v - min) / span * 26).toFixed(2)}`
  ).join(' ');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `${d} L100,32 L0,32 Z`);
  area.setAttribute('fill', color);
  area.setAttribute('opacity', '.14');
  svg.append(area, path);
  return svg;
}

  __x.h = h;
  __x.append = append;
  __x.clear = clear;
  __x.mount = mount;
  __x.icon = icon;
  __x.sparkline = sparkline;
  __x.frag = frag;
  __x.qs = qs;
  __x.qsa = qsa;
};

__m["src/services/telegram.js"] = function (__x, __req) {
/**
 * Telegram WebApp adapter with a browser fallback, so the app is testable
 * outside Telegram (desktop browser) and native-feeling inside it.
 */
const { state, set } = __req("src/core/store.js");
const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
const inTelegram = Boolean(tg?.initData !== undefined && tg?.platform && tg.platform !== 'unknown');

function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    if (tg.setHeaderColor) tg.setHeaderColor('#0b0c0f');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#0b0c0f');

    const u = tg.initDataUnsafe?.user;
    if (u) {
      set('profile', (p) => {
        p.tgId = u.id;
        p.name = [u.first_name, u.last_name].filter(Boolean).join(' ') || p.name;
        p.handle = u.username ? '@' + u.username : p.handle;
        p.photo = u.photo_url || p.photo;
      });
    }
  } catch (e) { console.warn('[tg] init', e); }
}

function haptic(kind = 'light') {
  if (!state.settings.haptics) return;
  const hf = tg?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === 'success' || kind === 'error' || kind === 'warning') hf.notificationOccurred(kind);
    else if (kind === 'select') hf.selectionChanged();
    else hf.impactOccurred(kind);
  } catch { /* noop */ }
}

/** Back button is wired to closing the top layer (sheet) when one is open. */
function setBackButton(visible, handler) {
  const bb = tg?.BackButton;
  if (!bb) return;
  try {
    bb.offClick();
    if (visible) { bb.onClick(handler); bb.show(); } else bb.hide();
  } catch { /* noop */ }
}

function closeApp() { try { tg?.close(); } catch { /* noop */ } }

/** initData must be verified server-side (HMAC with the bot token) before trusting it. */
const initData = tg?.initData || '';

  __x.initTelegram = initTelegram;
  __x.haptic = haptic;
  __x.setBackButton = setBackButton;
  __x.closeApp = closeApp;
  __x.inTelegram = inTelegram;
  __x.initData = initData;
};

__m["src/core/router.js"] = function (__x, __req) {
const { h, icon, qs, mount, clear } = __req("src/core/dom.js");
const { state, set, on } = __req("src/core/store.js");
const { haptic } = __req("src/services/telegram.js");
const TABS = [
  { id: 'home',     label: 'Главная',   icon: 'home',    title: 'P2P LIGHT',   sub: 'ai p2p terminal' },
  { id: 'p2p',      label: 'P2P',       icon: 'layers',  title: 'СТАКАНЫ',   sub: 'live order books' },
  { id: 'settings', label: 'Настройки', icon: 'sliders', title: 'НАСТРОЙКИ', sub: 'feed · trading · ai' },
  { id: 'profile',  label: 'Профиль',   icon: 'user',    title: 'ПРОФИЛЬ',   sub: 'kyc · plan · security' },
];

const screens = new Map();
let current = null;
let teardown = null;

function register(id, factory) { screens.set(id, factory); }

function navigate(tabId, params = {}) {
  if (!screens.has(tabId)) tabId = 'home';
  if (current === tabId && !params.force) return;

  teardown?.();
  teardown = null;

  current = tabId;
  set('ui', (u) => { u.tab = tabId; });

  const tab = TABS.find((t) => t.id === tabId);
  qs('#screen-title').textContent = tab.title;
  qs('#screen-sub').textContent = tab.sub;
  clear(qs('#topbar-slot'));

  const view = qs('#view');
  const built = screens.get(tabId)({ params, slot: qs('#topbar-slot') });
  const node = built?.node ?? built;
  teardown = built?.destroy ?? null;

  mount(view, h('div.screen', node));
  view.scrollTop = 0;
  window.scrollTo({ top: 0 });
  renderTabbar();
}

function renderTabbar() {
  const bar = qs('#tabbar');
  mount(bar, TABS.map((t) => {
    const active = current === t.id;
    const needsKyc = t.id === 'profile' && state.kyc.status !== 'approved';
    return h('button.tab', {
      role: 'tab',
      'aria-current': active ? 'page' : null,
      'aria-selected': active ? 'true' : 'false',
      onClick: () => { haptic('select'); navigate(t.id); },
    }, icon(t.icon), h('span', t.label), needsKyc ? h('i.tab-dot') : null);
  }));
}

// the Профиль tab carries an alert dot until KYC is approved
on('kyc', () => { if (current) renderTabbar(); });

const currentTab = () => current;

  __x.register = register;
  __x.navigate = navigate;
  __x.renderTabbar = renderTabbar;
  __x.currentTab = currentTab;
  __x.TABS = TABS;
};

__m["src/data/regions.js"] = function (__x, __req) {
/**
 * Регионы и валюты. Флаги — эмодзи из ISO-кода страны.
 * Курс валюты = сколько единиц за 1 USD (≈ за 1 USDT).
 * Данные для витрины P2P; на проде приходят с бэкенда.
 */

const CURRENCIES = {
  USD: { id: "USD", sym: "$", name: "\u0414\u043e\u043b\u043b\u0430\u0440 \u0421\u0428\u0410", rate: 1 },
  EUR: { id: "EUR", sym: "\u20ac", name: "\u0415\u0432\u0440\u043e", rate: 0.92 },
  GBP: { id: "GBP", sym: "\u00a3", name: "\u0424\u0443\u043d\u0442", rate: 0.79 },
  RUB: { id: "RUB", sym: "\u20bd", name: "\u0420\u0443\u0431\u043b\u044c", rate: 97 },
  UAH: { id: "UAH", sym: "\u20b4", name: "\u0413\u0440\u0438\u0432\u043d\u0430", rate: 41 },
  KZT: { id: "KZT", sym: "\u20b8", name: "\u0422\u0435\u043d\u0433\u0435", rate: 492 },
  TRY: { id: "TRY", sym: "\u20ba", name: "\u041b\u0438\u0440\u0430", rate: 34 },
  INR: { id: "INR", sym: "\u20b9", name: "\u0420\u0443\u043f\u0438\u044f", rate: 83 },
  NGN: { id: "NGN", sym: "\u20a6", name: "\u041d\u0430\u0439\u0440\u0430", rate: 1600 },
  BRL: { id: "BRL", sym: "R$", name: "\u0420\u0435\u0430\u043b", rate: 5.4 },
  ARS: { id: "ARS", sym: "$", name: "\u041f\u0435\u0441\u043e", rate: 1000 },
  VND: { id: "VND", sym: "\u20ab", name: "\u0414\u043e\u043d\u0433", rate: 25400 },
  IDR: { id: "IDR", sym: "Rp", name: "\u0420\u0443\u043f\u0438\u044f", rate: 15800 },
  THB: { id: "THB", sym: "\u0e3f", name: "\u0411\u0430\u0442", rate: 35 },
  PHP: { id: "PHP", sym: "\u20b1", name: "\u041f\u0435\u0441\u043e", rate: 58 },
  PKR: { id: "PKR", sym: "\u20a8", name: "\u0420\u0443\u043f\u0438\u044f", rate: 278 },
  EGP: { id: "EGP", sym: "E\u00a3", name: "\u0424\u0443\u043d\u0442", rate: 49 },
  AED: { id: "AED", sym: "\u0434\u0445", name: "\u0414\u0438\u0440\u0445\u0430\u043c", rate: 3.67 },
  SAR: { id: "SAR", sym: "\ufdfc", name: "\u0420\u0438\u044f\u043b", rate: 3.75 },
  KRW: { id: "KRW", sym: "\u20a9", name: "\u0412\u043e\u043d\u0430", rate: 1380 },
  JPY: { id: "JPY", sym: "\u00a5", name: "\u0418\u0435\u043d\u0430", rate: 150 },
  CNY: { id: "CNY", sym: "\u00a5", name: "\u042e\u0430\u043d\u044c", rate: 7.2 },
  PLN: { id: "PLN", sym: "z\u0142", name: "\u0417\u043b\u043e\u0442\u044b\u0439", rate: 4.0 },
  CZK: { id: "CZK", sym: "K\u010d", name: "\u041a\u0440\u043e\u043d\u0430", rate: 23 },
  RON: { id: "RON", sym: "lei", name: "\u041b\u0435\u0439", rate: 4.6 },
  HUF: { id: "HUF", sym: "Ft", name: "\u0424\u043e\u0440\u0438\u043d\u0442", rate: 360 },
  ZAR: { id: "ZAR", sym: "R", name: "\u0420\u044d\u043d\u0434", rate: 18 },
  MXN: { id: "MXN", sym: "$", name: "\u041f\u0435\u0441\u043e", rate: 18 },
  COP: { id: "COP", sym: "$", name: "\u041f\u0435\u0441\u043e", rate: 4100 },
  PEN: { id: "PEN", sym: "S/", name: "\u0421\u043e\u043b\u044c", rate: 3.75 },
  CLP: { id: "CLP", sym: "$", name: "\u041f\u0435\u0441\u043e", rate: 950 },
  UZS: { id: "UZS", sym: "so'm", name: "\u0421\u0443\u043c", rate: 12700 },
  AZN: { id: "AZN", sym: "\u20bc", name: "\u041c\u0430\u043d\u0430\u0442", rate: 1.7 },
  AMD: { id: "AMD", sym: "\u058f", name: "\u0414\u0440\u0430\u043c", rate: 390 },
  GEL: { id: "GEL", sym: "\u20be", name: "\u041b\u0430\u0440\u0438", rate: 2.7 },
  BYN: { id: "BYN", sym: "Br", name: "\u0420\u0443\u0431.", rate: 3.3 },
  MDL: { id: "MDL", sym: "L", name: "\u041b\u0435\u0439", rate: 18 },
  KGS: { id: "KGS", sym: "\u0441", name: "\u0421\u043e\u043c", rate: 87 },
  TJS: { id: "TJS", sym: "SM", name: "\u0421\u043e\u043c\u043e\u043d\u0438", rate: 10.6 },
  MNT: { id: "MNT", sym: "\u20ae", name: "\u0422\u0443\u0433\u0440\u0438\u043a", rate: 3400 },
  CAD: { id: "CAD", sym: "$", name: "\u0414\u043e\u043b\u043b\u0430\u0440", rate: 1.36 },
  AUD: { id: "AUD", sym: "$", name: "\u0414\u043e\u043b\u043b\u0430\u0440", rate: 1.5 },
  CHF: { id: "CHF", sym: "Fr", name: "\u0424\u0440\u0430\u043d\u043a", rate: 0.88 },
  SEK: { id: "SEK", sym: "kr", name: "\u041a\u0440\u043e\u043d\u0430", rate: 10.6 },
  NOK: { id: "NOK", sym: "kr", name: "\u041a\u0440\u043e\u043d\u0430", rate: 10.7 },
  DKK: { id: "DKK", sym: "kr", name: "\u041a\u0440\u043e\u043d\u0430", rate: 6.9 },
  HKD: { id: "HKD", sym: "$", name: "\u0414\u043e\u043b\u043b\u0430\u0440", rate: 7.8 },
  SGD: { id: "SGD", sym: "$", name: "\u0414\u043e\u043b\u043b\u0430\u0440", rate: 1.34 },
  MYR: { id: "MYR", sym: "RM", name: "\u0420\u0438\u043d\u0433\u0433\u0438\u0442", rate: 4.5 },
  BDT: { id: "BDT", sym: "\u09f3", name: "\u0422\u0430\u043a\u0430", rate: 120 },
  LKR: { id: "LKR", sym: "Rs", name: "\u0420\u0443\u043f\u0438\u044f", rate: 300 },
  KES: { id: "KES", sym: "KSh", name: "\u0428\u0438\u043b\u043b\u0438\u043d\u0433", rate: 129 },
  GHS: { id: "GHS", sym: "\u20b5", name: "\u0421\u0435\u0434\u0438", rate: 15 },
  TZS: { id: "TZS", sym: "TSh", name: "\u0428\u0438\u043b\u043b\u0438\u043d\u0433", rate: 2700 },
  UGX: { id: "UGX", sym: "USh", name: "\u0428\u0438\u043b\u043b\u0438\u043d\u0433", rate: 3700 },
  MAD: { id: "MAD", sym: "DH", name: "\u0414\u0438\u0440\u0445\u0430\u043c", rate: 10 },
  DZD: { id: "DZD", sym: "\u0434\u0437", name: "\u0414\u0438\u043d\u0430\u0440", rate: 134 },
  TND: { id: "TND", sym: "DT", name: "\u0414\u0438\u043d\u0430\u0440", rate: 3.1 },
  XAF: { id: "XAF", sym: "FCFA", name: "\u0424\u0440\u0430\u043d\u043a", rate: 600 },
  XOF: { id: "XOF", sym: "CFA", name: "\u0424\u0440\u0430\u043d\u043a", rate: 600 },
  ETB: { id: "ETB", sym: "Br", name: "\u0411\u044b\u0440", rate: 120 },
  ILS: { id: "ILS", sym: "\u20aa", name: "\u0428\u0435\u043a\u0435\u043b\u044c", rate: 3.7 },
  JOD: { id: "JOD", sym: "JD", name: "\u0414\u0438\u043d\u0430\u0440", rate: 0.71 },
  QAR: { id: "QAR", sym: "QR", name: "\u0420\u0438\u0430\u043b", rate: 3.64 },
  KWD: { id: "KWD", sym: "KD", name: "\u0414\u0438\u043d\u0430\u0440", rate: 0.31 },
  BHD: { id: "BHD", sym: "BD", name: "\u0414\u0438\u043d\u0430\u0440", rate: 0.38 },
  OMR: { id: "OMR", sym: "\ufdfc", name: "\u0420\u0438\u0430\u043b", rate: 0.385 },
  IQD: { id: "IQD", sym: "\u0639.\u062f", name: "\u0414\u0438\u043d\u0430\u0440", rate: 1310 },
  LBP: { id: "LBP", sym: "\u0644.\u0644", name: "\u0424\u0443\u043d\u0442", rate: 89000 },
  NPR: { id: "NPR", sym: "\u0930\u0942", name: "\u0420\u0443\u043f\u0438\u044f", rate: 133 },
  MMK: { id: "MMK", sym: "K", name: "\u041a\u044c\u044f\u0442", rate: 2100 },
  KHR: { id: "KHR", sym: "\u17db", name: "\u0420\u0438\u0435\u043b\u044c", rate: 4100 },
  LAK: { id: "LAK", sym: "\u20ad", name: "\u041a\u0438\u043f", rate: 21000 },
  TWD: { id: "TWD", sym: "NT$", name: "\u0414\u043e\u043b\u043b\u0430\u0440", rate: 32 },
  NZD: { id: "NZD", sym: "$", name: "\u0414\u043e\u043b\u043b\u0430\u0440", rate: 1.65 },
  BOB: { id: "BOB", sym: "Bs", name: "\u0411\u043e\u043b\u0438\u0432\u0438\u0430\u043d\u043e", rate: 6.9 },
  PYG: { id: "PYG", sym: "\u20b2", name: "\u0413\u0443\u0430\u0440\u0430\u043d\u0438", rate: 7500 },
  UYU: { id: "UYU", sym: "$U", name: "\u041f\u0435\u0441\u043e", rate: 40 },
  VES: { id: "VES", sym: "Bs", name: "\u0411\u043e\u043b\u0438\u0432\u0430\u0440", rate: 40 },
  DOP: { id: "DOP", sym: "RD$", name: "\u041f\u0435\u0441\u043e", rate: 60 },
  GTQ: { id: "GTQ", sym: "Q", name: "\u041a\u0435\u0442\u0441\u0430\u043b\u044c", rate: 7.8 },
  CRC: { id: "CRC", sym: "\u20a1", name: "\u041a\u043e\u043b\u043e\u043d", rate: 510 },
  TMT: { id: "TMT", sym: "m", name: "\u041c\u0430\u043d\u0430\u0442", rate: 3.5 },
  RSD: { id: "RSD", sym: "\u0434\u0438\u043d", name: "\u0414\u0438\u043d\u0430\u0440", rate: 108 },
  BGN: { id: "BGN", sym: "\u043b\u0432", name: "\u041b\u0435\u0432", rate: 1.8 },
  HRK: { id: "HRK", sym: "kn", name: "\u041a\u0443\u043d\u0430", rate: 6.9 },
  ISK: { id: "ISK", sym: "kr", name: "\u041a\u0440\u043e\u043d\u0430", rate: 138 },
};
const CUR = CURRENCIES;
const FIAT = CURRENCIES;   // обратная совместимость для .sym

/** Эмодзи-флаг из 2-буквенного кода страны. */
function flagOf(code) {
  return String(code).toUpperCase().replace(/[A-Z]/g, (c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65));
}

const COUNTRIES = [
  { code: "RU", name: "\u0420\u043e\u0441\u0441\u0438\u044f", cur: "RUB" },
  { code: "UA", name: "\u0423\u043a\u0440\u0430\u0438\u043d\u0430", cur: "UAH" },
  { code: "KZ", name: "\u041a\u0430\u0437\u0430\u0445\u0441\u0442\u0430\u043d", cur: "KZT" },
  { code: "BY", name: "\u0411\u0435\u043b\u0430\u0440\u0443\u0441\u044c", cur: "BYN" },
  { code: "UZ", name: "\u0423\u0437\u0431\u0435\u043a\u0438\u0441\u0442\u0430\u043d", cur: "UZS" },
  { code: "AZ", name: "\u0410\u0437\u0435\u0440\u0431\u0430\u0439\u0434\u0436\u0430\u043d", cur: "AZN" },
  { code: "AM", name: "\u0410\u0440\u043c\u0435\u043d\u0438\u044f", cur: "AMD" },
  { code: "GE", name: "\u0413\u0440\u0443\u0437\u0438\u044f", cur: "GEL" },
  { code: "KG", name: "\u041a\u0438\u0440\u0433\u0438\u0437\u0438\u044f", cur: "KGS" },
  { code: "TJ", name: "\u0422\u0430\u0434\u0436\u0438\u043a\u0438\u0441\u0442\u0430\u043d", cur: "TJS" },
  { code: "TM", name: "\u0422\u0443\u0440\u043a\u043c\u0435\u043d\u0438\u044f", cur: "TMT" },
  { code: "MD", name: "\u041c\u043e\u043b\u0434\u043e\u0432\u0430", cur: "MDL" },
  { code: "US", name: "\u0421\u0428\u0410", cur: "USD" },
  { code: "CA", name: "\u041a\u0430\u043d\u0430\u0434\u0430", cur: "CAD" },
  { code: "MX", name: "\u041c\u0435\u043a\u0441\u0438\u043a\u0430", cur: "MXN" },
  { code: "BR", name: "\u0411\u0440\u0430\u0437\u0438\u043b\u0438\u044f", cur: "BRL" },
  { code: "AR", name: "\u0410\u0440\u0433\u0435\u043d\u0442\u0438\u043d\u0430", cur: "ARS" },
  { code: "CO", name: "\u041a\u043e\u043b\u0443\u043c\u0431\u0438\u044f", cur: "COP" },
  { code: "PE", name: "\u041f\u0435\u0440\u0443", cur: "PEN" },
  { code: "CL", name: "\u0427\u0438\u043b\u0438", cur: "CLP" },
  { code: "VE", name: "\u0412\u0435\u043d\u0435\u0441\u0443\u044d\u043b\u0430", cur: "VES" },
  { code: "BO", name: "\u0411\u043e\u043b\u0438\u0432\u0438\u044f", cur: "BOB" },
  { code: "PY", name: "\u041f\u0430\u0440\u0430\u0433\u0432\u0430\u0439", cur: "PYG" },
  { code: "UY", name: "\u0423\u0440\u0443\u0433\u0432\u0430\u0439", cur: "UYU" },
  { code: "EC", name: "\u042d\u043a\u0432\u0430\u0434\u043e\u0440", cur: "USD" },
  { code: "DO", name: "\u0414\u043e\u043c\u0438\u043d\u0438\u043a\u0430\u043d\u0430", cur: "DOP" },
  { code: "GT", name: "\u0413\u0432\u0430\u0442\u0435\u043c\u0430\u043b\u0430", cur: "GTQ" },
  { code: "CR", name: "\u041a\u043e\u0441\u0442\u0430-\u0420\u0438\u043a\u0430", cur: "CRC" },
  { code: "PA", name: "\u041f\u0430\u043d\u0430\u043c\u0430", cur: "USD" },
  { code: "GB", name: "\u0412\u0435\u043b\u0438\u043a\u043e\u0431\u0440\u0438\u0442\u0430\u043d\u0438\u044f", cur: "GBP" },
  { code: "DE", name: "\u0413\u0435\u0440\u043c\u0430\u043d\u0438\u044f", cur: "EUR" },
  { code: "FR", name: "\u0424\u0440\u0430\u043d\u0446\u0438\u044f", cur: "EUR" },
  { code: "IT", name: "\u0418\u0442\u0430\u043b\u0438\u044f", cur: "EUR" },
  { code: "ES", name: "\u0418\u0441\u043f\u0430\u043d\u0438\u044f", cur: "EUR" },
  { code: "PT", name: "\u041f\u043e\u0440\u0442\u0443\u0433\u0430\u043b\u0438\u044f", cur: "EUR" },
  { code: "NL", name: "\u041d\u0438\u0434\u0435\u0440\u043b\u0430\u043d\u0434\u044b", cur: "EUR" },
  { code: "BE", name: "\u0411\u0435\u043b\u044c\u0433\u0438\u044f", cur: "EUR" },
  { code: "AT", name: "\u0410\u0432\u0441\u0442\u0440\u0438\u044f", cur: "EUR" },
  { code: "IE", name: "\u0418\u0440\u043b\u0430\u043d\u0434\u0438\u044f", cur: "EUR" },
  { code: "GR", name: "\u0413\u0440\u0435\u0446\u0438\u044f", cur: "EUR" },
  { code: "FI", name: "\u0424\u0438\u043d\u043b\u044f\u043d\u0434\u0438\u044f", cur: "EUR" },
  { code: "PL", name: "\u041f\u043e\u043b\u044c\u0448\u0430", cur: "PLN" },
  { code: "CZ", name: "\u0427\u0435\u0445\u0438\u044f", cur: "CZK" },
  { code: "SK", name: "\u0421\u043b\u043e\u0432\u0430\u043a\u0438\u044f", cur: "EUR" },
  { code: "RO", name: "\u0420\u0443\u043c\u044b\u043d\u0438\u044f", cur: "RON" },
  { code: "HU", name: "\u0412\u0435\u043d\u0433\u0440\u0438\u044f", cur: "HUF" },
  { code: "BG", name: "\u0411\u043e\u043b\u0433\u0430\u0440\u0438\u044f", cur: "BGN" },
  { code: "RS", name: "\u0421\u0435\u0440\u0431\u0438\u044f", cur: "RSD" },
  { code: "HR", name: "\u0425\u043e\u0440\u0432\u0430\u0442\u0438\u044f", cur: "EUR" },
  { code: "SI", name: "\u0421\u043b\u043e\u0432\u0435\u043d\u0438\u044f", cur: "EUR" },
  { code: "LT", name: "\u041b\u0438\u0442\u0432\u0430", cur: "EUR" },
  { code: "LV", name: "\u041b\u0430\u0442\u0432\u0438\u044f", cur: "EUR" },
  { code: "EE", name: "\u042d\u0441\u0442\u043e\u043d\u0438\u044f", cur: "EUR" },
  { code: "CH", name: "\u0428\u0432\u0435\u0439\u0446\u0430\u0440\u0438\u044f", cur: "CHF" },
  { code: "SE", name: "\u0428\u0432\u0435\u0446\u0438\u044f", cur: "SEK" },
  { code: "NO", name: "\u041d\u043e\u0440\u0432\u0435\u0433\u0438\u044f", cur: "NOK" },
  { code: "DK", name: "\u0414\u0430\u043d\u0438\u044f", cur: "DKK" },
  { code: "IS", name: "\u0418\u0441\u043b\u0430\u043d\u0434\u0438\u044f", cur: "ISK" },
  { code: "TR", name: "\u0422\u0443\u0440\u0446\u0438\u044f", cur: "TRY" },
  { code: "IL", name: "\u0418\u0437\u0440\u0430\u0438\u043b\u044c", cur: "ILS" },
  { code: "AE", name: "\u041e\u0410\u042d", cur: "AED" },
  { code: "SA", name: "\u0421\u0430\u0443\u0434\u043e\u0432\u0441\u043a\u0430\u044f \u0410\u0440\u0430\u0432\u0438\u044f", cur: "SAR" },
  { code: "QA", name: "\u041a\u0430\u0442\u0430\u0440", cur: "QAR" },
  { code: "KW", name: "\u041a\u0443\u0432\u0435\u0439\u0442", cur: "KWD" },
  { code: "BH", name: "\u0411\u0430\u0445\u0440\u0435\u0439\u043d", cur: "BHD" },
  { code: "OM", name: "\u041e\u043c\u0430\u043d", cur: "OMR" },
  { code: "JO", name: "\u0418\u043e\u0440\u0434\u0430\u043d\u0438\u044f", cur: "JOD" },
  { code: "LB", name: "\u041b\u0438\u0432\u0430\u043d", cur: "LBP" },
  { code: "IQ", name: "\u0418\u0440\u0430\u043a", cur: "IQD" },
  { code: "IR", name: "\u0418\u0440\u0430\u043d", cur: "USD" },
  { code: "EG", name: "\u0415\u0433\u0438\u043f\u0435\u0442", cur: "EGP" },
  { code: "MA", name: "\u041c\u0430\u0440\u043e\u043a\u043a\u043e", cur: "MAD" },
  { code: "DZ", name: "\u0410\u043b\u0436\u0438\u0440", cur: "DZD" },
  { code: "TN", name: "\u0422\u0443\u043d\u0438\u0441", cur: "TND" },
  { code: "NG", name: "\u041d\u0438\u0433\u0435\u0440\u0438\u044f", cur: "NGN" },
  { code: "KE", name: "\u041a\u0435\u043d\u0438\u044f", cur: "KES" },
  { code: "GH", name: "\u0413\u0430\u043d\u0430", cur: "GHS" },
  { code: "TZ", name: "\u0422\u0430\u043d\u0437\u0430\u043d\u0438\u044f", cur: "TZS" },
  { code: "UG", name: "\u0423\u0433\u0430\u043d\u0434\u0430", cur: "UGX" },
  { code: "ZA", name: "\u042e\u0410\u0420", cur: "ZAR" },
  { code: "ET", name: "\u042d\u0444\u0438\u043e\u043f\u0438\u044f", cur: "ETB" },
  { code: "CM", name: "\u041a\u0430\u043c\u0435\u0440\u0443\u043d", cur: "XAF" },
  { code: "CI", name: "\u041a\u043e\u0442-\u0434\u2019\u0418\u0432\u0443\u0430\u0440", cur: "XOF" },
  { code: "SN", name: "\u0421\u0435\u043d\u0435\u0433\u0430\u043b", cur: "XOF" },
  { code: "CN", name: "\u041a\u0438\u0442\u0430\u0439", cur: "CNY" },
  { code: "IN", name: "\u0418\u043d\u0434\u0438\u044f", cur: "INR" },
  { code: "PK", name: "\u041f\u0430\u043a\u0438\u0441\u0442\u0430\u043d", cur: "PKR" },
  { code: "BD", name: "\u0411\u0430\u043d\u0433\u043b\u0430\u0434\u0435\u0448", cur: "BDT" },
  { code: "LK", name: "\u0428\u0440\u0438-\u041b\u0430\u043d\u043a\u0430", cur: "LKR" },
  { code: "NP", name: "\u041d\u0435\u043f\u0430\u043b", cur: "NPR" },
  { code: "ID", name: "\u0418\u043d\u0434\u043e\u043d\u0435\u0437\u0438\u044f", cur: "IDR" },
  { code: "TH", name: "\u0422\u0430\u0438\u043b\u0430\u043d\u0434", cur: "THB" },
  { code: "VN", name: "\u0412\u044c\u0435\u0442\u043d\u0430\u043c", cur: "VND" },
  { code: "PH", name: "\u0424\u0438\u043b\u0438\u043f\u043f\u0438\u043d\u044b", cur: "PHP" },
  { code: "MY", name: "\u041c\u0430\u043b\u0430\u0439\u0437\u0438\u044f", cur: "MYR" },
  { code: "SG", name: "\u0421\u0438\u043d\u0433\u0430\u043f\u0443\u0440", cur: "SGD" },
  { code: "HK", name: "\u0413\u043e\u043d\u043a\u043e\u043d\u0433", cur: "HKD" },
  { code: "TW", name: "\u0422\u0430\u0439\u0432\u0430\u043d\u044c", cur: "TWD" },
  { code: "KR", name: "\u042e\u0436\u043d\u0430\u044f \u041a\u043e\u0440\u0435\u044f", cur: "KRW" },
  { code: "JP", name: "\u042f\u043f\u043e\u043d\u0438\u044f", cur: "JPY" },
  { code: "MN", name: "\u041c\u043e\u043d\u0433\u043e\u043b\u0438\u044f", cur: "MNT" },
  { code: "MM", name: "\u041c\u044c\u044f\u043d\u043c\u0430", cur: "MMK" },
  { code: "KH", name: "\u041a\u0430\u043c\u0431\u043e\u0434\u0436\u0430", cur: "KHR" },
  { code: "LA", name: "\u041b\u0430\u043e\u0441", cur: "LAK" },
  { code: "AU", name: "\u0410\u0432\u0441\u0442\u0440\u0430\u043b\u0438\u044f", cur: "AUD" },
  { code: "NZ", name: "\u041d\u043e\u0432\u0430\u044f \u0417\u0435\u043b\u0430\u043d\u0434\u0438\u044f", cur: "NZD" },
];
for (const c of COUNTRIES) c.flag = flagOf(c.code);
const COUNTRY = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));

const CUR_METHODS = {
  RUB: ['sber', 'tbank', 'alfa', 'vtb', 'raif', 'ozon', 'sbp', 'yoomoney', 'cash'],
  UAH: ['card', 'cash', 'wise', 'swift'],
  KZT: ['card', 'cash', 'wise', 'swift'],
  BYN: ['card', 'cash', 'swift'],
  USD: ['wire', 'card', 'wise', 'paypal', 'cash'],
  EUR: ['sepa', 'card', 'revolut', 'wise', 'cash'],
  GBP: ['card', 'revolut', 'wise', 'paypal', 'cash'],
  TRY: ['bank', 'card', 'cash', 'wise'],
  INR: ['bank', 'card', 'cash', 'wise'],
  NGN: ['bank', 'card', 'cash'],
  BRL: ['bank', 'card', 'cash', 'wise'],
  AED: ['bank', 'card', 'cash', 'wise'],
};
const DEFAULT_METHODS = ['bank', 'card', 'cash', 'wise'];

/** Способы оплаты, доступные для валюты. */
function methodsFor(cur) {
  return CUR_METHODS[cur] || DEFAULT_METHODS;
}

const DEFAULT_COUNTRY = 'RU';


  __x.flagOf = flagOf;
  __x.methodsFor = methodsFor;
  __x.CURRENCIES = CURRENCIES;
  __x.CUR = CUR;
  __x.FIAT = FIAT;
  __x.COUNTRIES = COUNTRIES;
  __x.COUNTRY = COUNTRY;
  __x.DEFAULT_COUNTRY = DEFAULT_COUNTRY;
};

__m["src/data/exchanges.js"] = function (__x, __req) {
/**
 * Exchange registry. `endpoint` documents the venue's real public P2P source —
 * the backend adapter is what actually talks to it; the frontend only ever
 * speaks our own normalised WS protocol (see docs/ws-protocol.md).
 */
const EXCHANGES = [
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

const EX = Object.fromEntries(EXCHANGES.map((e) => [e.id, e]));

// Цена актива в USD (≈ в USDT). Цена в любой валюте = usd × курс валюты,
// поэтому новые валюты подключаются без правок здесь (см. regions.js).
const ASSETS = [
  { id: 'USDT', name: 'Tether',   icon: 'data:image/png;base64,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', usd: 1,      dp: 2 },
  { id: 'BTC',  name: 'Bitcoin',  icon: 'data:image/png;base64,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',  usd: 65_400, dp: 6 },
  { id: 'ETH',  name: 'Ethereum', icon: 'data:image/png;base64,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',  usd: 2_530,  dp: 4 },
  { id: 'BNB',  name: 'BNB',      icon: 'data:image/png;base64,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',  usd: 594,    dp: 4 },
  { id: 'SOL',  name: 'Solana',   icon: 'data:image/png;base64,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',  usd: 146,    dp: 4 },
  { id: 'TON',  name: 'Toncoin',  icon: 'data:image/png;base64,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',  usd: 5.26,   dp: 3 },
];

const AST = Object.fromEntries(ASSETS.map((a) => [a.id, a]));

const { CURRENCIES: _CUR, methodsFor: _methodsFor } = __req("src/data/regions.js");
// реэкспорт для обратной совместимости импортов из exchanges.js
const CURRENCIES = _CUR;
const CUR = _CUR;
const FIAT = _CUR;          // для .sym lookups
const methodsFor = _methodsFor;

/** Цена 1 единицы актива в указанной валюте. */
function assetRate(asset, cur) {
  const a = AST[asset];
  const c = _CUR[cur];
  if (!a || !c) return 0;
  return a.usd * c.rate;
}

  __x.assetRate = assetRate;
  __x.EXCHANGES = EXCHANGES;
  __x.EX = EX;
  __x.ASSETS = ASSETS;
  __x.AST = AST;
  __x.CURRENCIES = CURRENCIES;
  __x.CUR = CUR;
  __x.FIAT = FIAT;
  __x.methodsFor = methodsFor;
};

__m["src/data/merchants.js"] = function (__x, __req) {
/** Merchant name pool for the mock feed — deterministic per exchange via seed. */
const FIRST = ['Crypto', 'Fast', 'Alpha', 'Prime', 'Delta', 'Nord', 'Volga', 'Siber', 'Astra', 'Quantum',
  'Orbit', 'Vertex', 'Titan', 'Lunar', 'Zenit', 'Atlas', 'Nexus', 'Cobalt', 'Granit', 'Omega'];
const SECOND = ['Exchange', 'Trade', 'Capital', 'Pay', 'Desk', 'Broker', 'Hub', 'Group', 'Finance', 'Swap',
  'Flow', 'Point', 'Line', 'Bridge', 'Station'];
const SOLO = ['RubleKing', 'FiatMaster', 'TetherDom', 'SwiftRuble', 'P2P_Boss', 'MoneyRiver', 'ExpressCash',
  'SafeDeal24', 'TopChange', 'InstantPay', 'GoldStream', 'WhiteSwap', 'RocketOTC', 'BlueHarbor'];

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function merchantName(rnd) {
  if (rnd() < 0.42) return SOLO[Math.floor(rnd() * SOLO.length)] + (rnd() < 0.4 ? Math.floor(10 + rnd() * 89) : '');
  return FIRST[Math.floor(rnd() * FIRST.length)] + SECOND[Math.floor(rnd() * SECOND.length)];
}

/* Условия сделки (ремарка, которую пишет контрагент). Правдоподобные,
   собираются из нескольких клауз — детерминированно по rnd мерчанта. */
const T_INTRO = [
  'Онлайн, отвечаю быстро.',
  'Работаю ежедневно 9:00–23:00 МСК.',
  'Опытный трейдер, тысячи сделок.',
  'Быстрый релиз сразу после оплаты.',
  'Автоматическая выдача реквизитов.',
];
const T_PAY = [
  'Оплата строго с личной карты, переводы от третьих лиц не принимаю.',
  'Реквизиты выдаю только после открытия ордера.',
  'Оплата в течение 15 минут после открытия сделки.',
  'Отправляйте точную сумму до копейки.',
  'Принимаю перевод только с карты, оформленной на ваше имя.',
];
const T_RULE = [
  'В комментарии к переводу ничего не указывать.',
  'После оплаты нажмите «Оплачено» и приложите чек.',
  'Назначение платежа оставляйте пустым.',
  'Чек/квитанция об оплате обязательны.',
  'Без примечаний к платежу — иначе возврат.',
];
const T_OUTRO = [
  'Приятных сделок 🤝',
  'Спасибо за сделку!',
  'Жду оплату.',
  'Хорошего дня!',
  '',
];

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

function merchantTerms(rnd) {
  const parts = [pick(rnd, T_INTRO), pick(rnd, T_PAY), pick(rnd, T_RULE)];
  if (rnd() < 0.6) parts.push(pick(rnd, T_OUTRO));
  return parts.filter(Boolean).join('\n');
}

  __x.mulberry = mulberry;
  __x.hashStr = hashStr;
  __x.merchantName = merchantName;
  __x.merchantTerms = merchantTerms;
};

__m["src/services/logs.js"] = function (__x, __req) {
/** Ring-buffer log service for the P2P console. */
const { state, emit } = __req("src/core/store.js");
let seq = 0;

function log(level, exchange, message, meta = null) {
  const entry = { id: ++seq, ts: Date.now(), level, exchange: exchange || 'sys', message, meta };
  state.logs.push(entry);
  const max = state.settings.maxLogs || 400;
  if (state.logs.length > max) state.logs.splice(0, state.logs.length - max);
  emit('logs', entry);
  return entry;
}

function clearLogs() {
  state.logs.length = 0;
  emit('logs', null);
}

function exportLogs() {
  return JSON.stringify(state.logs, null, 2);
}

  __x.log = log;
  __x.clearLogs = clearLogs;
  __x.exportLogs = exportLogs;
};

__m["src/services/feed.js"] = function (__x, __req) {
/**
 * Feed layer — the single source of P2P order-book data for the UI.
 *
 *   mock  : local generator that emits the exact same normalised events a
 *           backend would, so every screen is fully exercised offline.
 *   live  : WebSocket client speaking the protocol in docs/ws-protocol.md.
 *
 * The UI never touches exchange APIs directly: a venue adapter on the backend
 * normalises Binance/Bybit/OKX/... into one offer shape and streams it here.
 */
const { state, emit, set } = __req("src/core/store.js");
const { EXCHANGES, EX, AST, assetRate, methodsFor } = __req("src/data/exchanges.js");
const { mulberry, hashStr, merchantName, merchantTerms } = __req("src/data/merchants.js");
const { log } = __req("src/services/logs.js");
let mode = 'mock';
let running = false;
let tickTimer = null;
let statusTimer = null;
let ws = null;
let wsRetry = 0;
let reqId = 0;
const venues = new Map();     // exchange -> MockVenue

/* ============================================================
   Защита фронта (режим live): флуд/DDoS и replay-атаки.
   Сервер обязан проверять то же со своей стороны — клиентские
   лимиты только оберегают UI-поток и не являются гарантией.
   ============================================================ */
const MAX_OFFERS   = 1500;    // потолок оферов в памяти (защита от раздувания)
const MAX_BATCH    = 600;     // максимум upsert/remove за один кадр
const MAX_FRAME    = 512 * 1024;  // максимальный размер кадра, байт
const INBOUND_LIMIT = 300;    // кадров/с до отбрасывания (анти-флуд)
const FRESH_FUTURE = 60_000;  // допуск рассинхрона часов вперёд, мс
const FRESH_PAST   = 120_000; // кадр старше — считаем replay'ем, мс
const DEDUPE_CAP   = 1024;    // размер окна недавних id

const inbound = { winStart: 0, count: 0, dropped: 0, warned: 0 };
const seenIds = [];           // ring недавних id кадров
const seenSet = new Set();

/** Пропускная способность входящего потока: true — кадр принимаем. */
function rateOk() {
  const now = Date.now();
  if (now - inbound.winStart > 1000) {
    if (inbound.dropped && now - inbound.warned > 3000) {
      log('warn', 'sys', `перегрузка потока: отброшено <b>${inbound.dropped}</b> кадров/с`);
      inbound.warned = now;
    }
    inbound.winStart = now; inbound.count = 0; inbound.dropped = 0;
  }
  if (inbound.count++ >= INBOUND_LIMIT) { inbound.dropped++; return false; }
  return true;
}

/** Свежесть по метке времени: защита от воспроизведения старых кадров. */
function fresh(ts) {
  if (ts === undefined || ts === null) return true;
  const n = Number(ts);
  if (!Number.isFinite(n)) return false;
  const now = Date.now();
  return n <= now + FRESH_FUTURE && now - n <= FRESH_PAST;
}

/** Дедупликация по id/seq: точный повтор кадра — replay, отбрасываем. */
function duplicate(key) {
  if (key === undefined || key === null) return false;
  const k = String(key);
  if (seenSet.has(k)) return true;
  seenSet.add(k); seenIds.push(k);
  if (seenIds.length > DEDUPE_CAP) seenSet.delete(seenIds.shift());
  return false;
}

function resetGuards() {
  inbound.winStart = 0; inbound.count = 0; inbound.dropped = 0; inbound.warned = 0;
  seenIds.length = 0; seenSet.clear();
}

let resubTimer = null;        // дебаунс пере-подписки (анти-флуд subscribe)

/** Криптослучайный одноразовый токен для auth/идемпотентности. */
function newNonce() {
  try {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
}

/* ============================ public API ============================ */

function startFeed() {
  if (running) return;
  running = true;
  mode = state.settings.feedMode;
  log('info', 'sys', 'Поток данных <b>запущен</b>');
  if (mode === 'live') connectWs(); else startMock();
  statusTimer = setInterval(heartbeat, 2000);
}

function stopFeed() {
  running = false;
  clearInterval(tickTimer); tickTimer = null;
  clearInterval(statusTimer); statusTimer = null;
  clearTimeout(resubTimer); resubTimer = null;
  resetGuards();
  if (ws) { try { ws.close(1000, 'client stop'); } catch {} ws = null; }
  venues.clear();
  for (const id of Object.keys(state.wires)) state.wires[id] = { state: 'idle', latency: 0, msgs: 0, lastTs: 0 };
  emit('wires', state.wires);
}

function restartFeed() {
  stopFeed();
  state.offers = {};
  emit('offers', { reason: 'restart' });
  startFeed();
}

/**
 * Re-subscribe after the user changes asset / fiat / side / exchanges.
 * Очистка стакана — сразу (отклик UI), а сам subscribe/seed дебаунсится,
 * чтобы быстрые переключения фильтров не слали серверу шквал подписок.
 */
function resubscribe() {
  state.offers = {};
  emit('offers', { reason: 'resubscribe' });
  clearTimeout(resubTimer);
  resubTimer = setTimeout(doSubscribe, 220);
}

function doSubscribe() {
  if (!running) return;
  const f = state.filters;
  log('info', 'sys', `Подписка <b>${f.asset}/${f.fiat}</b> · ${f.side === 'buy' ? 'покупка' : 'продажа'} · ${f.exchanges.length} бирж`);
  if (mode === 'live') {
    sendWs({ op: 'subscribe', channel: 'p2p.book', args: subscribeArgs() });
  } else {
    venues.clear();
    seedMock();
  }
}

const feedMode = () => mode;

function setFeedMode(next) {
  if (next === mode) return;
  set('settings', (s) => { s.feedMode = next; });
  stopFeed();
  state.offers = {};
  emit('offers', { reason: 'mode' });
  startFeed();
}

function subscribeArgs() {
  const f = state.filters;
  return { exchanges: f.exchanges, asset: f.asset, fiat: f.fiat, side: f.side };
}

/* ============================ live WS ============================ */

function connectWs() {
  const url = state.settings.wsUrl;
  for (const ex of state.filters.exchanges) setWire(ex, { state: 'connecting' });
  log('info', 'sys', `WS connect → <b>${url}</b>`);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    log('warn', 'sys', `WS не создан: ${e.message}`);
    return scheduleReconnect();
  }

  ws.onopen = () => {
    wsRetry = 0;
    resetGuards();
    log('info', 'sys', 'WS <b>открыт</b>, отправляю auth + subscribe');
    // nonce + ts позволяют серверу отбить replay самого auth-кадра
    sendWs({
      op: 'auth',
      token: state.profile.apiToken,
      initData: window.Telegram?.WebApp?.initData || '',
      nonce: newNonce(),
      ts: Date.now(),
    });
    sendWs({ op: 'subscribe', channel: 'p2p.book', args: subscribeArgs() });
    sendWs({ op: 'subscribe', channel: 'p2p.logs', args: { exchanges: state.filters.exchanges } });
  };

  ws.onmessage = (e) => {
    // 1) анти-флуд: бережём UI-поток от шквала кадров
    if (!rateOk()) return;
    // 2) отбрасываем бинарные и неадекватно большие кадры
    if (typeof e.data !== 'string' || e.data.length > MAX_FRAME) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return log('warn', 'sys', 'WS: не-JSON кадр'); }
    if (!msg || typeof msg !== 'object') return;
    // 3) replay: устаревший по времени или повторённый по id кадр — игнор
    if (!fresh(msg.ts)) return;
    if (duplicate(msg.id ?? msg.seq)) return;
    handleServerEvent(msg);
  };

  ws.onerror = () => log('warn', 'sys', 'WS <b>ошибка</b> соединения');

  ws.onclose = (e) => {
    for (const ex of state.filters.exchanges) setWire(ex, { state: 'down' });
    log('warn', 'sys', `WS закрыт (${e.code}) ${e.reason || ''}`);
    if (running && state.settings.autoReconnect) scheduleReconnect();
  };
}

function scheduleReconnect() {
  wsRetry++;
  // экспонента + джиттер: не создаём «стадо» одновременных переподключений к серверу
  const base = Math.min(30000, 1000 * 2 ** Math.min(wsRetry, 5));
  const delay = base / 2 + Math.random() * (base / 2);
  log('warn', 'sys', `Переподключение через <b>${(delay / 1000).toFixed(1)}с</b> (попытка ${wsRetry})`);
  setTimeout(() => { if (running && mode === 'live') connectWs(); }, delay);
}

function sendWs(payload) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ id: String(++reqId), ...payload }));
  return true;
}

/** Normalised server → client events (see docs/ws-protocol.md). */
function handleServerEvent(msg) {
  switch (msg.ev) {
    case 'snapshot': {
      const ex = msg.exchange;
      if (!EX[ex]) break;                     // неизвестная биржа — игнор
      for (const id of Object.keys(state.offers)) if (state.offers[id].exchange === ex) delete state.offers[id];
      const raw = Array.isArray(msg.data?.offers) ? msg.data.offers : [];
      let budget = MAX_OFFERS - Object.keys(state.offers).length;
      let added = 0;
      for (const r of raw) {
        if (budget <= 0) break;               // потолок памяти
        const o = normalizeOffer(r);
        if (!o || o.exchange !== ex) continue; // мусор / чужая биржа — отбрасываем
        state.offers[o.id] = o; budget--; added++;
      }
      setWire(ex, { state: 'live', lastTs: msg.ts || Date.now() });
      bumpMsgs(ex, added);
      log('info', ex, `snapshot · <b>${added}</b> оферов`);
      recomputeMarket();
      emit('offers', { reason: 'snapshot', exchange: ex });
      break;
    }
    case 'update': {
      const ex = msg.exchange;
      if (!EX[ex]) break;                     // неизвестная биржа — игнор
      const ups = Array.isArray(msg.data?.upsert) ? msg.data.upsert.slice(0, MAX_BATCH) : [];
      const rem = Array.isArray(msg.data?.remove) ? msg.data.remove.slice(0, MAX_BATCH) : [];
      let budget = MAX_OFFERS - Object.keys(state.offers).length;
      let touched = 0;
      for (const r of ups) {
        const o = normalizeOffer(r);
        if (!o || o.exchange !== ex) continue;
        if (!state.offers[o.id]) { if (budget <= 0) continue; budget--; }  // новый — только в пределах потолка
        applyUpsert(o); touched++;
      }
      for (const id of rem) { if (typeof id === 'string') { applyRemove(id); touched++; } }
      bumpMsgs(ex, touched);
      setWire(ex, { state: 'live', lastTs: msg.ts || Date.now() });
      recomputeMarket();
      emit('offers', { reason: 'update', exchange: ex });
      break;
    }
    case 'status': {
      if (!EX[msg.exchange]) break;
      const st = ['idle', 'connecting', 'live', 'down'].includes(msg.data?.state) ? msg.data.state : 'live';
      const lat = Math.min(60_000, Math.max(0, Number(msg.data?.latency) || 0));
      setWire(msg.exchange, { state: st, latency: lat });
      break;
    }
    case 'log': {
      const lvl = ['info', 'up', 'down', 'new', 'gone', 'warn', 'alert', 'trade'].includes(msg.data?.level) ? msg.data.level : 'info';
      const lex = EX[msg.data?.exchange] ? msg.data.exchange : 'sys';
      log(lvl, lex, String(msg.data?.text ?? '').slice(0, 300));  // текст экранируется в рендере лога
      break;
    }
    case 'pong':
      break;
    case 'error': {
      const lex = EX[msg.data?.exchange] ? msg.data.exchange : 'sys';
      log('warn', lex, `ошибка: <b>${String(msg.data?.message ?? msg.data?.code ?? '').slice(0, 200)}</b>`);
      break;
    }
    default:
      log('info', 'sys', `неизвестное событие: ${msg.ev}`);
  }
}

/**
 * Нормализация и САНИТИЗАЦИЯ входящего офера.
 * Возвращает null для мусора (нет id/биржи, нечисловая/абсурдная цена) —
 * чтобы NaN и огромные значения не ломали сортировку, depth-бары и расчёты.
 * Строки обрезаются, числа приводятся и зажимаются в разумные пределы.
 */
function normalizeOffer(o) {
  if (!o || typeof o !== 'object') return null;
  const id = typeof o.id === 'string' ? o.id.slice(0, 96) : null;
  const exchange = typeof o.exchange === 'string' ? o.exchange.slice(0, 24) : null;
  if (!id || !exchange) return null;

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  const price = num(o.price);
  if (!(price > 0) || price > 1e12) return null;        // явный мусор или нечисло

  const nn = (v, d = 0) => { const n = num(v); return Number.isFinite(n) ? Math.max(0, n) : d; };
  const str = (v, d, max) => (typeof v === 'string' ? v : d).slice(0, max);
  const m = o.merchant || {};

  return {
    id,
    exchange,
    side: o.side === 'sell' ? 'sell' : 'buy',
    asset: str(o.asset, 'USDT', 12),
    fiat: str(o.fiat, 'RUB', 8),
    price,
    prevPrice: state.offers[id]?.price ?? price,
    available: Math.min(nn(o.available), 1e15),
    min: Math.min(nn(o.min), 1e15),
    max: Math.min(nn(o.max), 1e15),
    methods: Array.isArray(o.methods) ? o.methods.filter((x) => typeof x === 'string').slice(0, 12) : [],
    merchant: {
      id: str(m.id, id, 96),
      name: str(m.name, 'unknown', 64),
      orders: Math.min(Math.round(nn(m.orders)), 1e9),
      completion: Math.min(1, Math.max(0, num(m.completion) || 0)),
      rating: Math.min(5, Math.max(0, num(m.rating) || 0)),
      verified: Boolean(m.verified),
      pro: Boolean(m.pro),
      avgReleaseMin: Math.min(1440, nn(m.avgReleaseMin, 10)),
      online: m.online !== false,
      blocked: Boolean(m.blocked),
    },
    kycRequired: Math.min(3, Math.max(0, Math.round(num(o.kycRequired) || 0))),
    terms: typeof o.terms === 'string' ? o.terms.slice(0, 600) : '',
    ts: Number.isFinite(num(o.ts)) ? num(o.ts) : Date.now(),
  };
}

function applyUpsert(o) {
  const prev = state.offers[o.id];
  state.offers[o.id] = o;
  if (prev && Math.abs(prev.price - o.price) > 1e-9) {
    const up = o.price > prev.price;
    const dp = ((o.price - prev.price) / prev.price) * 100;
    if (Math.abs(dp) > 0.02) {
      log(up ? 'up' : 'down', o.exchange,
        `${o.merchant.name} · цена <b>${o.price.toFixed(2)}</b> (${dp > 0 ? '+' : ''}${dp.toFixed(2)}%)`);
    }
  } else if (!prev) {
    log('new', o.exchange, `новый офер <b>${o.merchant.name}</b> · ${o.price.toFixed(2)} · ${Math.round(o.available)} ${o.asset}`);
  }
}

function applyRemove(id) {
  const o = state.offers[id];
  if (!o) return;
  delete state.offers[id];
  log('gone', o.exchange, `офер снят · ${o.merchant.name} · ${o.price.toFixed(2)}`);
}

/* ============================ wires / status ============================ */

function setWire(ex, patch) {
  if (!ex) return;
  const w = state.wires[ex] || (state.wires[ex] = { state: 'idle', latency: 0, msgs: 0, lastTs: 0 });
  Object.assign(w, patch);
  emit('wires', state.wires);
}

function bumpMsgs(ex, n) {
  const w = state.wires[ex];
  if (w) w.msgs += n || 1;
}

function heartbeat() {
  if (mode === 'live') sendWs({ op: 'ping', ts: Date.now() });
  for (const ex of state.filters.exchanges) {
    const w = state.wires[ex];
    if (!w) continue;
    const base = EX[ex]?.baseLatency ?? 60;
    w.latency = Math.round(base + (Math.random() - 0.4) * base * 0.5);
  }
  emit('wires', state.wires);
}

/* ============================ mock engine ============================ */

class MockVenue {
  constructor(exId, asset, fiat, side) {
    this.ex = EX[exId];
    this.asset = asset;
    this.fiat = fiat;
    this.side = side;
    this.rnd = mulberry(hashStr(exId + asset + fiat + side));
    this.seq = 0;
    this.offers = new Map();
    const mid = assetRate(asset, fiat);
    // venue premium: less reliable venues sit wider off mid
    this.premium = (1 - this.ex.reliability) * 0.6 * (this.rnd() - 0.3);
    this.mid = mid * (1 + this.premium * 0.01);
    const count = 6 + Math.floor(this.rnd() * 8);
    for (let i = 0; i < count; i++) this.spawn(i);
  }

  spawn(rank = null) {
    const r = this.rnd;
    const id = `${this.ex.id}:${++this.seq}`;
    const idx = rank ?? Math.floor(r() * 10);
    const dev = (0.0015 + idx * 0.0011 + r() * 0.0014) * (this.side === 'buy' ? 1 : -1);
    const unit = assetRate(this.asset, this.fiat);
    const usdtScale = this.asset === 'USDT' ? 1 : unit / (assetRate('USDT', this.fiat) || 1);

    // liquidity in asset units, roughly 500..90000 USDT-equivalent
    const liqUsdt = 400 + r() * r() * 90000;
    const available = liqUsdt / usdtScale;

    const orders = Math.floor(20 + r() ** 1.6 * 9000);
    const completion = 0.80 + r() * 0.198;
    const pool = methodsFor(this.fiat);
    const nMethods = 1 + Math.floor(r() * Math.min(3, pool.length));
    const methods = [...pool].sort(() => r() - 0.5).slice(0, nMethods);

    const price = this.mid * (1 + dev);
    const minFiat = Math.round((500 + r() * 14000) / 100) * 100;
    const maxFiat = Math.max(minFiat * 2, Math.round(available * price * (0.4 + r() * 0.6)));

    const offer = {
      id,
      exchange: this.ex.id,
      side: this.side,
      asset: this.asset,
      fiat: this.fiat,
      dev,
      price,
      prevPrice: price,
      available,
      min: minFiat,
      max: maxFiat,
      methods,
      merchant: {
        id: 'm_' + id,
        name: merchantName(r),
        orders,
        completion,
        rating: Number((4.0 + r() * 1.0).toFixed(2)),
        verified: r() < 0.62,
        pro: r() < 0.3,
        avgReleaseMin: Number((0.8 + r() * 14).toFixed(1)),
        online: r() < 0.88,
        blocked: r() < 0.04,
      },
      kycRequired: r() < 0.5 ? 1 : r() < 0.85 ? 2 : 0,
      terms: merchantTerms(r),
      ts: Date.now(),
    };
    this.offers.set(id, offer);
    return offer;
  }

  /** One market tick: drift mid, mutate a few offers, churn some. */
  tick() {
    const r = this.rnd;
    // mid random walk, mean-reverting toward the published base
    const base = assetRate(this.asset, this.fiat) * (1 + this.premium * 0.01);
    this.mid += (base - this.mid) * 0.06 + this.mid * (r() - 0.5) * 0.0009;

    const upserts = [];
    const removes = [];
    const ids = [...this.offers.keys()];

    const touch = 1 + Math.floor(r() * 3);
    for (let i = 0; i < touch && ids.length; i++) {
      const id = ids[Math.floor(r() * ids.length)];
      const o = this.offers.get(id);
      if (!o) continue;
      o.dev += (r() - 0.5) * 0.0006;
      o.price = this.mid * (1 + o.dev);
      o.available = Math.max(20, o.available * (0.94 + r() * 0.13));
      o.merchant.online = r() < 0.94 ? o.merchant.online : !o.merchant.online;
      o.ts = Date.now();
      upserts.push({ ...o });
    }

    // churn: an ad gets taken down / a new one appears
    if (r() < 0.14 && ids.length > 4) {
      const id = ids[Math.floor(r() * ids.length)];
      this.offers.delete(id);
      removes.push(id);
    }
    if (r() < 0.16 && this.offers.size < 18) {
      upserts.push({ ...this.spawn() });
    }

    return { upserts, removes };
  }
}

function seedMock() {
  const f = state.filters;
  for (const ex of f.exchanges) {
    if (!EX[ex]) continue;
    const v = new MockVenue(ex, f.asset, f.fiat, f.side);
    venues.set(ex, v);
    setWire(ex, { state: 'connecting', latency: EX[ex].baseLatency, msgs: 0 });
    // staggered snapshots, like real venues coming online one by one
    setTimeout(() => {
      if (!running || !venues.has(ex)) return;
      handleServerEvent({
        ev: 'snapshot', channel: 'p2p.book', exchange: ex, ts: Date.now(),
        data: { offers: [...v.offers.values()].map(stripInternal) },
      });
    }, 120 + Math.random() * 900);
  }
}

const stripInternal = (o) => { const { dev, prevPrice, ...rest } = o; return rest; };

function startMock() {
  seedMock();
  const period = Math.max(120, state.settings.throttleMs || 450);
  tickTimer = setInterval(() => {
    if (!running || state.ui.logPaused && false) return;
    for (const [ex, v] of venues) {
      if (!state.filters.exchanges.includes(ex)) continue;
      // simulate an occasional venue hiccup
      if (Math.random() > EX[ex].reliability + 0.028) {
        setWire(ex, { state: 'connecting' });
        log('warn', ex, 'таймаут ответа, повтор запроса…');
        continue;
      }
      const { upserts, removes } = v.tick();
      if (!upserts.length && !removes.length) continue;
      handleServerEvent({
        ev: 'update', channel: 'p2p.book', exchange: ex, ts: Date.now(),
        data: { upsert: upserts.map(stripInternal), remove: removes },
      });
    }
    maybeAlert();
  }, period);
}

/** Spread alert — mirrors what the backend's rule engine would push. */
let lastAlert = 0;
function maybeAlert() {
  if (!state.settings.notifySpread) return;
  if (Date.now() - lastAlert < 12000) return;
  const m = state.market;
  if (!m.best || !m.median) return;
  const spread = Math.abs((m.median - m.best) / m.median) * 100;
  if (spread >= (state.settings.notifySpreadPct || 1.5)) {
    lastAlert = Date.now();
    const best = bestOffer();
    log('alert', best?.exchange || 'sys',
      `СПРЕД <b>${spread.toFixed(2)}%</b> к медиане · лучший ${best ? best.price.toFixed(2) : '—'} у <b>${best?.merchant.name || '—'}</b>`);
  }
}

/* ============================ market aggregates ============================ */

function recomputeMarket() {
  const list = Object.values(state.offers).filter((o) => o.asset === state.filters.asset && o.fiat === state.filters.fiat);
  if (!list.length) { state.market.median = 0; state.market.best = 0; return; }
  const prices = list.map((o) => o.price).sort((a, b) => a - b);
  const mid = prices.length % 2
    ? prices[(prices.length - 1) / 2]
    : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const best = state.filters.side === 'buy' ? prices[0] : prices[prices.length - 1];
  state.market.prev = state.market.median;
  state.market.median = mid;
  state.market.best = best;
  state.market.history.push(mid);
  if (state.market.history.length > 60) state.market.history.shift();
  emit('market', state.market);
}

function bestOffer() {
  const list = Object.values(state.offers);
  if (!list.length) return null;
  return state.filters.side === 'buy'
    ? list.reduce((a, b) => (b.price < a.price ? b : a))
    : list.reduce((a, b) => (b.price > a.price ? b : a));
}

const allExchangeIds = EXCHANGES.map((e) => e.id);

  __x.startFeed = startFeed;
  __x.stopFeed = stopFeed;
  __x.restartFeed = restartFeed;
  __x.resubscribe = resubscribe;
  __x.setFeedMode = setFeedMode;
  __x.recomputeMarket = recomputeMarket;
  __x.bestOffer = bestOffer;
  __x.feedMode = feedMode;
  __x.allExchangeIds = allExchangeIds;
  __x.newNonce = newNonce;
};

__m["src/ui/sheet.js"] = function (__x, __req) {
const { h, icon, qs, append } = __req("src/core/dom.js");
const { haptic, setBackButton } = __req("src/services/telegram.js");
const stack = [];

/**
 * openSheet({ title, body, foot, onClose }) -> { close, el, body }
 * body/foot accept a Node, an array of Nodes, or a builder fn receiving the api.
 */
function openSheet({ title, subtitle, body, foot, onClose, dismissible = true } = {}) {
  const layers = qs('#layers');
  const scrim = h('div.scrim');
  const bodyEl = h('div.sheet-body');
  const footEl = foot ? h('div.sheet-foot') : null;

  const api = { close, el: null, bodyEl, footEl, setFoot, setBody };

  const closeBtn = h('button.btn.btn-icon.btn-ghost', { 'aria-label': 'Закрыть', onClick: () => close() }, icon('x'));
  const sheet = h('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Диалог' },
    h('div.sheet-grip', h('i')),
    h('div.sheet-head',
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('h2', title || ''),
        subtitle ? h('div.t-xs.t-muted', { style: { marginTop: '1px' } }, subtitle) : null,
      ),
      dismissible ? closeBtn : null,
    ),
    bodyEl,
    footEl,
  );
  api.el = sheet;

  setBody(body);
  if (foot) setFoot(foot);

  if (dismissible) scrim.addEventListener('click', () => close());
  layers.append(scrim, sheet);
  document.body.style.overflow = 'hidden';
  haptic('light');

  const entry = { scrim, sheet, onClose, close };
  stack.push(entry);
  syncBack();

  // drag-to-dismiss on the grip area
  if (dismissible) attachDrag(sheet, close);

  function setBody(content) {
    bodyEl.replaceChildren();
    const c = typeof content === 'function' ? content(api) : content;
    if (c) append(bodyEl, [c]);
  }
  function setFoot(content) {
    if (!footEl) return;
    footEl.replaceChildren();
    const c = typeof content === 'function' ? content(api) : content;
    if (c) append(footEl, [c]);
  }

  function close(result) {
    const i = stack.indexOf(entry);
    if (i === -1) return;
    stack.splice(i, 1);
    sheet.classList.add('is-out');
    scrim.style.animation = 'fade-in .2s reverse both';
    setTimeout(() => { sheet.remove(); scrim.remove(); }, 240);
    if (!stack.length) document.body.style.overflow = '';
    syncBack();
    onClose?.(result);
  }

  return api;
}

function syncBack() {
  const top = stack[stack.length - 1];
  setBackButton(Boolean(top), () => top?.close());
}

function attachDrag(sheet, close) {
  let y0 = null, dy = 0;
  const grip = sheet.querySelector('.sheet-grip');
  const head = sheet.querySelector('.sheet-head');
  const start = (e) => { y0 = e.touches ? e.touches[0].clientY : e.clientY; sheet.style.transition = 'none'; };
  const move = (e) => {
    if (y0 === null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dy = Math.max(0, y - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (y0 === null) return;
    sheet.style.transition = 'transform .26s cubic-bezier(.16,1,.3,1)';
    if (dy > 110) close(); else sheet.style.transform = '';
    y0 = null; dy = 0;
  };
  for (const el of [grip, head]) {
    if (!el) continue;
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
  }
}

function closeTopSheet() { stack[stack.length - 1]?.close(); }
const sheetOpen = () => stack.length > 0;

/** Simple confirm dialog built on the sheet. */
function confirmSheet({ title, message, confirmLabel = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet({
      title,
      body: h('div.t-sm.t-dim', { style: { lineHeight: '1.5' } }, message),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => { done = true; s.close(); resolve(false); } }, 'Отмена'),
        h(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, { onClick: () => { done = true; s.close(); resolve(true); } }, confirmLabel),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

  __x.openSheet = openSheet;
  __x.closeTopSheet = closeTopSheet;
  __x.confirmSheet = confirmSheet;
  __x.sheetOpen = sheetOpen;
};

__m["src/ui/toast.js"] = function (__x, __req) {
const { h, icon, qs } = __req("src/core/dom.js");
const { haptic } = __req("src/services/telegram.js");
const ICON_BY_KIND = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' };

function toast(title, body, kind = 'info', ttl = 3200) {
  const host = qs('#toasts');
  if (!host) return;
  const el = h('div.toast', { class: kind, role: 'status' },
    icon(ICON_BY_KIND[kind] || 'info', { class: kind === 'ok' ? 't-buy' : kind === 'err' ? 't-sell' : kind === 'warn' ? 't-warn' : 't-acid' }),
    h('div', h('div.tt', title), body ? h('div.tb', body) : null),
  );
  host.append(el);
  haptic(kind === 'ok' ? 'success' : kind === 'err' ? 'error' : kind === 'warn' ? 'warning' : 'light');
  setTimeout(() => {
    el.classList.add('is-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ttl);
  while (host.children.length > 3) host.firstChild.remove();
}

  __x.toast = toast;
};

__m["src/services/analysis.js"] = function (__x, __req) {
/**
 * Deal-context analysis ("AI-слой").
 *
 * Deterministic, explainable scoring — every verdict ships with the factors
 * and weights that produced it, so a B2B user can audit why an offer was
 * recommended or rejected. Weights are user-tunable in Настройки → AI.
 */
const { state, PAY_METHODS } = __req("src/core/store.js");
const { EX, AST, assetRate } = __req("src/data/exchanges.js");
const METHOD_RISK = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m.risk]));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Volume in USDT → amount of the traded asset. */
function usdtToAsset(volumeUsdt, asset, fiat) {
  if (asset === 'USDT') return volumeUsdt;
  const usdtUnit = assetRate('USDT', fiat);
  const assetUnit = assetRate(asset, fiat);
  return assetUnit ? (volumeUsdt * usdtUnit) / assetUnit : 0;
}

function assetToUsdt(amount, asset, fiat) {
  if (asset === 'USDT') return amount;
  const usdtUnit = assetRate('USDT', fiat);
  const assetUnit = assetRate(asset, fiat);
  return usdtUnit ? (amount * assetUnit) / usdtUnit : 0;
}

/* ------------------------------ components ------------------------------ */

function reputationScore(m) {
  const completion = clamp01((m.completion - 0.8) / 0.199);
  const volume = clamp01(Math.log10(Math.max(1, m.orders)) / 4);       // 10k orders ≈ 1.0
  const rating = clamp01((m.rating - 4) / 1);
  const trust = (m.verified ? 0.6 : 0) + (m.pro ? 0.4 : 0);
  return clamp01(completion * 0.4 + volume * 0.25 + rating * 0.15 + trust * 0.2);
}

function priceScore(offer, market) {
  if (!market.median) return 0.5;
  const dev = (offer.price - market.median) / market.median;   // negative = cheaper
  const favourable = offer.side === 'buy' ? -dev : dev;        // buying: cheaper is better
  // map −1.5% … +1.5% onto 0…1
  return clamp01(0.5 + favourable / 0.03);
}

function liquidityScore(offer, assetAmount, fiatNeeded) {
  const cover = clamp01(offer.available / Math.max(1e-9, assetAmount));
  const fitsMin = fiatNeeded >= offer.min;
  const fitsMax = fiatNeeded <= offer.max;
  let s = cover * 0.7;
  s += fitsMin ? 0.15 : 0;
  s += fitsMax ? 0.15 : 0;
  return clamp01(s);
}

function methodScore(methods) {
  if (!methods?.length) return 0.5;
  const risks = methods.map((m) => METHOD_RISK[m] ?? 0.25);
  return clamp01(1 - Math.min(...risks) * 2.2);
}

function speedScore(m) {
  const s = clamp01(1 - (m.avgReleaseMin - 1) / 14);
  return m.online ? s : s * 0.55;
}

function exchangeScore(exId) {
  const r = EX[exId]?.reliability ?? 0.85;
  const wire = state.wires[exId];
  const penalty = wire?.state === 'live' ? 0 : wire?.state === 'connecting' ? 0.12 : 0.25;
  return clamp01((r - 0.8) / 0.2 - penalty);
}

/* ------------------------------ main ------------------------------ */

/**
 * analyze(offer, volumeUsdt) → full deal context.
 */
function analyze(offer, volumeUsdt = state.settings.volume) {
  const s = state.settings;
  const market = state.market;
  const assetAmount = usdtToAsset(volumeUsdt, offer.asset, offer.fiat);
  const fillable = Math.min(assetAmount, offer.available);
  const fiatNeeded = assetAmount * offer.price;

  const comps = {
    reputation: reputationScore(offer.merchant),
    price: priceScore(offer, market),
    liquidity: liquidityScore(offer, assetAmount, fiatNeeded),
    method: methodScore(offer.methods),
    speed: speedScore(offer.merchant),
    exchange: exchangeScore(offer.exchange),
  };

  const w = s.weights;
  const wSum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let score = 0;
  for (const [k, v] of Object.entries(comps)) score += v * (w[k] ?? 0);
  score = (score / wSum) * 100;

  /* ---- hard blockers & flags ---- */
  const flags = [];
  let blocker = null;

  if (offer.merchant.blocked) {
    blocker = { code: 'blocked', text: 'Мерчант в блоклисте платформы' };
  }
  if (fiatNeeded < offer.min) {
    blocker = blocker || { code: 'under_min', text: `Объём ниже лимита офера (мин. ${Math.round(offer.min)} ${offer.fiat})` };
  }
  if (fiatNeeded > offer.max) {
    flags.push({ level: 'warn', text: `Объём выше лимита офера (макс. ${Math.round(offer.max)} ${offer.fiat}) — нужен сплит` });
  }
  if (offer.available < assetAmount) {
    flags.push({ level: 'warn', text: `Ликвидности хватает на ${(offer.available / assetAmount * 100).toFixed(0)}% объёма` });
  }
  if ((offer.kycRequired || 0) > state.kyc.level) {
    blocker = blocker || { code: 'kyc', text: `Мерчант требует KYC уровня ${offer.kycRequired}, у вас ${state.kyc.level}` };
  }
  if (!offer.merchant.online) flags.push({ level: 'warn', text: 'Мерчант офлайн — ответ может занять часы' });
  if (offer.merchant.completion < 0.9) flags.push({ level: 'warn', text: `Низкий процент исполнения: ${(offer.merchant.completion * 100).toFixed(1)}%` });
  if (offer.merchant.orders < 100) flags.push({ level: 'warn', text: `Мало сделок у мерчанта: ${offer.merchant.orders}` });

  // price anomaly: suspiciously generous ads are the classic scam pattern
  const dev = market.median ? ((offer.price - market.median) / market.median) * 100 : 0;
  const favourableDev = offer.side === 'buy' ? -dev : dev;
  if (favourableDev > 2.2) {
    flags.push({ level: 'alert', text: `Цена на ${favourableDev.toFixed(2)}% лучше рынка — аномалия, проверьте мерчанта` });
    score *= 0.72;
  }
  const highRisk = offer.methods.filter((m) => (METHOD_RISK[m] ?? 0) > 0.2);
  if (highRisk.length === offer.methods.length && highRisk.length) {
    flags.push({ level: 'warn', text: 'Только высокорисковые способы оплаты' });
  }
  if (offer.merchant.avgReleaseMin > 10) flags.push({ level: 'warn', text: `Среднее время отпуска ${offer.merchant.avgReleaseMin} мин` });

  const stale = Date.now() - offer.ts;
  if (stale > 15000) flags.push({ level: 'warn', text: `Котировка не обновлялась ${Math.round(stale / 1000)} с` });

  /* ---- economics ---- */
  const feePct = s.exchangeFee || 0;
  const bestPrice = market.best || offer.price;
  const slippagePct = bestPrice ? Math.abs((offer.price - bestPrice) / bestPrice) * 100 : 0;
  const grossFiat = fillable * offer.price;
  const feeFiat = grossFiat * (feePct / 100);
  const totalFiat = offer.side === 'buy' ? grossFiat + feeFiat : grossFiat - feeFiat;
  const effPrice = fillable ? totalFiat / fillable : 0;

  // exit at the target margin set in Настройки → Трейдинг
  const exitPrice = offer.side === 'buy'
    ? effPrice * (1 + s.targetMargin / 100)
    : effPrice * (1 - s.targetMargin / 100);
  const profitFiat = Math.abs(exitPrice - effPrice) * fillable - feeFiat;
  const profitUsdt = profitFiat / (assetRate('USDT', offer.fiat) || 1);

  /* ---- verdict ---- */
  const confidence = Math.round(clamp01(
    0.45 + comps.reputation * 0.25 + comps.exchange * 0.15 + (market.median ? 0.15 : 0)
  ) * 100);

  let verdict;
  if (blocker) {
    verdict = { key: 'blocked', title: 'Сделка недоступна', color: 'var(--sell)', ghost: 'var(--sell-ghost)', icon: 'x' };
  } else if (flags.some((f) => f.level === 'alert') && s.autoRejectRisky) {
    verdict = { key: 'avoid', title: 'Высокий риск', color: 'var(--sell)', ghost: 'var(--sell-ghost)', icon: 'alert' };
  } else if (score >= 78 && slippagePct <= s.slippageTol) {
    verdict = { key: 'strong', title: 'Сильная сделка', color: 'var(--buy)', ghost: 'var(--buy-ghost)', icon: 'zap' };
  } else if (score >= 62) {
    verdict = { key: 'ok', title: 'Приемлемо', color: 'var(--acid)', ghost: 'var(--acid-ghost)', icon: 'check' };
  } else if (score >= 45) {
    verdict = { key: 'caution', title: 'С осторожностью', color: 'var(--warn)', ghost: 'var(--warn-ghost)', icon: 'alert' };
  } else {
    verdict = { key: 'avoid', title: 'Лучше пропустить', color: 'var(--sell)', ghost: 'var(--sell-ghost)', icon: 'alert' };
  }

  const reasons = [];
  if (comps.price > 0.66) reasons.push('цена лучше медианы рынка');
  else if (comps.price < 0.4) reasons.push('цена хуже медианы');
  if (comps.reputation > 0.72) reasons.push('надёжный мерчант');
  else if (comps.reputation < 0.45) reasons.push('слабая репутация');
  if (comps.liquidity > 0.9) reasons.push('объём проходит целиком');
  else if (comps.liquidity < 0.6) reasons.push('ликвидности не хватает');
  if (comps.speed > 0.72) reasons.push('быстрый отпуск');
  if (comps.method < 0.5) reasons.push('рисковые реквизиты');

  return {
    offer, volumeUsdt, assetAmount, fillable, fiatNeeded,
    comps, weights: w, score: Math.round(score), confidence,
    dev, favourableDev, slippagePct,
    grossFiat, feeFiat, totalFiat, effPrice, exitPrice,
    profitFiat, profitUsdt,
    flags, blocker, verdict, reasons,
    executable: !blocker && confidence >= 0 && fillable > 0,
    coverage: assetAmount ? clamp01(fillable / assetAmount) : 0,
  };
}

/**
 * Multi-offer execution plan: fills the requested volume across the book,
 * which is what actually happens when one ad can't absorb the size.
 */
function buildPlan(offers, volumeUsdt, limit = 6) {
  const f = state.filters;
  const need = usdtToAsset(volumeUsdt, f.asset, f.fiat);
  const sorted = [...offers].sort((a, b) => (f.side === 'buy' ? a.price - b.price : b.price - a.price));
  const legs = [];
  let left = need;
  for (const o of sorted) {
    if (left <= 1e-9 || legs.length >= limit) break;
    const fiatMinAsset = o.min / o.price;
    if (o.available < fiatMinAsset) continue;
    const take = Math.min(left, o.available, o.max / o.price);
    if (take * o.price < o.min) continue;
    legs.push({ offer: o, amount: take, fiat: take * o.price });
    left -= take;
  }
  const filled = need - left;
  const fiatTotal = legs.reduce((a, l) => a + l.fiat, 0);
  const vwap = filled ? fiatTotal / filled : 0;
  const best = sorted[0]?.price || 0;
  return {
    legs, need, filled, left,
    coverage: need ? filled / need : 0,
    vwap, fiatTotal,
    slippagePct: best && vwap ? Math.abs((vwap - best) / best) * 100 : 0,
  };
}

/** Human-readable label for each weight key. */
const WEIGHT_LABELS = {
  reputation: 'Репутация мерчанта',
  price: 'Отклонение цены',
  liquidity: 'Ликвидность и лимиты',
  method: 'Риск реквизитов',
  speed: 'Скорость отпуска',
  exchange: 'Надёжность биржи',
};

  __x.usdtToAsset = usdtToAsset;
  __x.assetToUsdt = assetToUsdt;
  __x.analyze = analyze;
  __x.buildPlan = buildPlan;
  __x.WEIGHT_LABELS = WEIGHT_LABELS;
};

__m["src/services/trade.js"] = function (__x, __req) {
/**
 * Purchase execution (закупки).
 *
 * Front-end simulation of the order lifecycle the backend will own:
 *   created → paid → released → done  (or cancelled / disputed)
 * Fiat leaves the selected card, crypto lands on the USDT balance.
 */
const { state, set, emit, canTrade, kycInfo, PAY_METHODS, trackDealForQuests } = __req("src/core/store.js");
const { uid } = __req("src/core/format.js");
const { log } = __req("src/services/logs.js");
const { analyze, assetToUsdt } = __req("src/services/analysis.js");
const { toast } = __req("src/ui/toast.js");
const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));

/** Everything that must hold before a deal can be sent. */
function preflight(offer, volumeUsdt, cardId) {
  const errs = [];
  const s = state.settings;
  const kyc = canTrade();
  if (!kyc.ok) errs.push({ code: 'kyc', text: kyc.msg });

  const ctx = analyze(offer, volumeUsdt);
  if (ctx.blocker) errs.push({ code: ctx.blocker.code, text: ctx.blocker.text });

  if (volumeUsdt <= 0) errs.push({ code: 'volume', text: 'Укажите объём больше нуля' });
  if (volumeUsdt > s.maxPerDeal) errs.push({ code: 'max_deal', text: `Лимит на сделку ${s.maxPerDeal} USDT` });

  const lim = kycInfo();
  const dayUsed = state.stats.dayVolume || 0;
  if (dayUsed + volumeUsdt > Math.min(s.dayLimit, lim.dayLimit)) {
    errs.push({
      code: 'day_limit',
      text: `Дневной лимит: использовано ${Math.round(dayUsed)} из ${Math.round(Math.min(s.dayLimit, lim.dayLimit))} USDT`,
    });
  }

  const card = state.cards.find((c) => c.id === cardId);
  if (offer.side === 'buy') {
    if (!card) errs.push({ code: 'card', text: 'Выберите карту для оплаты' });
    else if (!card.active) errs.push({ code: 'card_off', text: 'Карта отключена' });
    else if (card.balance < ctx.fiatNeeded) {
      errs.push({ code: 'funds', text: `На карте ${Math.round(card.balance)} ${card.currency}, нужно ${Math.round(ctx.fiatNeeded)}` });
    }
  } else if (state.balance.usdt < volumeUsdt) {
    errs.push({ code: 'funds', text: `Недостаточно USDT: ${state.balance.usdt.toFixed(2)}` });
  }

  if (s.autoRejectRisky && ctx.verdict.key === 'avoid' && !ctx.blocker) {
    errs.push({ code: 'risk', text: 'AI отклонил сделку по риску (отключается в Настройках)' });
  }
  if (ctx.slippagePct > s.slippageTol) {
    errs.push({ code: 'slippage', text: `Слиппедж ${ctx.slippagePct.toFixed(2)}% выше допустимого ${s.slippageTol}%` });
  }

  return { ok: errs.length === 0, errors: errs, ctx };
}

// Защита от двойной отправки: быстрый повторный тап по «Закупить» не должен
// создавать два ордера. Лок на короткое окно + по конкретному оферу.
let execLock = 0;
let lastOfferKey = '';

/** Execute. Returns the purchase record or null. */
function execute(offer, volumeUsdt, cardId, method) {
  const now = Date.now();
  const key = `${offer.id}:${volumeUsdt}:${cardId}`;
  if (now - execLock < 900 && key === lastOfferKey) {
    log('warn', offer.exchange, 'повторная отправка подавлена (анти-дабл-тап)');
    return null;
  }
  execLock = now; lastOfferKey = key;

  const pf = preflight(offer, volumeUsdt, cardId);
  if (!pf.ok) {
    toast('Сделка не отправлена', pf.errors[0].text, 'err');
    log('warn', offer.exchange, `отказ: <b>${pf.errors[0].text}</b>`);
    return null;
  }
  const ctx = pf.ctx;
  const card = state.cards.find((c) => c.id === cardId);
  const amount = ctx.fillable;
  const fiat = amount * offer.price;
  const usdtDelta = assetToUsdt(amount, offer.asset, offer.fiat);

  const deal = {
    id: uid('deal'),
    ref: 'P2D-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    // ключ идемпотентности: бэкенд по нему отбивает повторную отправку одного ордера
    idemKey: uid('idem') + Math.random().toString(36).slice(2, 10),
    side: offer.side,
    exchange: offer.exchange,
    asset: offer.asset,
    fiat: offer.fiat,
    price: offer.price,
    effPrice: ctx.effPrice,
    amount,
    fiatTotal: fiat,
    feeFiat: ctx.feeFiat,
    volumeUsdt: usdtDelta,
    method: method || offer.methods[0],
    cardId: cardId || null,
    merchant: { ...offer.merchant },
    score: ctx.score,
    verdict: ctx.verdict.key,
    status: 'created',
    createdAt: Date.now(),
    timeline: [{ at: Date.now(), status: 'created', text: 'Ордер создан, реквизиты запрошены' }],
  };

  // move money
  if (offer.side === 'buy') {
    set('cards', (cards) => { const c = cards.find((x) => x.id === cardId); if (c) c.balance -= fiat; });
    set('balance', (b) => { b.locked += usdtDelta; });
  } else {
    set('balance', (b) => { b.usdt -= usdtDelta; b.locked += 0; });
    set('cards', (cards) => { const c = cards.find((x) => x.id === cardId); if (c) c.balance += fiat - ctx.feeFiat; });
  }

  set('purchases', (p) => { p.unshift(deal); if (p.length > 200) p.pop(); });
  set('stats', (st) => {
    st.deals += 1;
    st.dayVolume += usdtDelta;
    st.volumeUsdt += usdtDelta;
    st.spreadSum += Math.abs(ctx.dev);
  });
  trackDealForQuests(usdtDelta);     // недельные задания

  log('trade', offer.exchange,
    `ЗАКУПКА <b>${deal.ref}</b> · ${amount.toFixed(2)} ${offer.asset} @ ${offer.price.toFixed(2)} ${offer.fiat} · ${PM[deal.method]?.name || deal.method}`);
  toast('Ордер создан', `${deal.ref} · ${amount.toFixed(2)} ${offer.asset} @ ${offer.price.toFixed(2)}`, 'ok');

  advance(deal.id, 'paid', 'Оплата отправлена мерчанту', 2600);
  advance(deal.id, 'released', 'Мерчант подтвердил и отпустил актив', 6200);
  advance(deal.id, 'done', 'Сделка завершена, актив зачислен', 8000);

  return deal;
}

function advance(dealId, status, text, delay) {
  setTimeout(() => {
    const deal = state.purchases.find((d) => d.id === dealId);
    if (!deal || deal.status === 'cancelled') return;
    deal.status = status;
    deal.timeline.push({ at: Date.now(), status, text });

    if (status === 'done') {
      if (deal.side === 'buy') {
        set('balance', (b) => { b.locked = Math.max(0, b.locked - deal.volumeUsdt); b.usdt += deal.volumeUsdt; });
      }
      set('stats', (st) => { st.won += 1; });
      log('trade', deal.exchange, `<b>${deal.ref}</b> завершена · +${deal.volumeUsdt.toFixed(2)} USDT`);
      if (state.settings.notifyDealStatus) toast('Сделка завершена', `${deal.ref} · +${deal.volumeUsdt.toFixed(2)} USDT`, 'ok');
    } else {
      log('trade', deal.exchange, `<b>${deal.ref}</b> → ${status === 'paid' ? 'оплачено' : 'актив отпущен'}`);
    }
    set('purchases', (p) => p);
  }, delay);
}

function cancelDeal(dealId) {
  const deal = state.purchases.find((d) => d.id === dealId);
  if (!deal || ['done', 'cancelled'].includes(deal.status)) return;
  deal.status = 'cancelled';
  deal.timeline.push({ at: Date.now(), status: 'cancelled', text: 'Отменено пользователем, средства возвращены' });
  if (deal.side === 'buy') {
    set('cards', (cards) => { const c = cards.find((x) => x.id === deal.cardId); if (c) c.balance += deal.fiatTotal; });
    set('balance', (b) => { b.locked = Math.max(0, b.locked - deal.volumeUsdt); });
  } else {
    set('balance', (b) => { b.usdt += deal.volumeUsdt; });
    set('cards', (cards) => { const c = cards.find((x) => x.id === deal.cardId); if (c) c.balance -= deal.fiatTotal - deal.feeFiat; });
  }
  set('stats', (st) => { st.dayVolume = Math.max(0, st.dayVolume - deal.volumeUsdt); });
  set('purchases', (p) => p);
  log('warn', deal.exchange, `<b>${deal.ref}</b> отменена`);
  toast('Сделка отменена', `${deal.ref} · средства возвращены`, 'warn');
}

const DEAL_STATUS = {
  created:   { label: 'Создана',   color: 'var(--info)', badge: 'badge-info' },
  paid:      { label: 'Оплачена',  color: 'var(--warn)', badge: 'badge-warn' },
  released:  { label: 'Отпущена',  color: 'var(--acid)', badge: 'badge-acid' },
  done:      { label: 'Завершена', color: 'var(--buy)',  badge: 'badge-buy' },
  cancelled: { label: 'Отменена',  color: 'var(--sell)', badge: 'badge-sell' },
};

  __x.preflight = preflight;
  __x.execute = execute;
  __x.cancelDeal = cancelDeal;
  __x.DEAL_STATUS = DEAL_STATUS;
};

__m["src/ui/dealSheet.js"] = function (__x, __req) {
/** Shared purchase-detail sheet (used by Главная and P2P). */
const { h, icon } = __req("src/core/dom.js");
const { openSheet, confirmSheet } = __req("src/ui/sheet.js");
const { fmtN, fmt0, dateTime, hhmmss } = __req("src/core/format.js");
const { DEAL_STATUS, cancelDeal } = __req("src/services/trade.js");
const { PAY_METHODS, state } = __req("src/core/store.js");
const { EX } = __req("src/data/exchanges.js");
const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));

function openDealSheet(deal) {
  const st = DEAL_STATUS[deal.status];
  const card = state.cards.find((c) => c.id === deal.cardId);

  const render = () => {
    const cur = DEAL_STATUS[deal.status];
    return h('div',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } },
        h(`span.badge.${cur.badge}`, cur.label),
        h('span.badge', { style: { background: 'transparent' } }, EX[deal.exchange]?.name || deal.exchange),
        h('span.mono.t-xs.t-muted', { style: { marginLeft: 'auto' } }, deal.ref),
      ),
      h('dl',
        kv('Направление', deal.side === 'buy' ? 'Покупка' : 'Продажа'),
        kv('Актив', `${fmtN(deal.amount, 2)} ${deal.asset}`),
        kv('Цена', `${fmtN(deal.price, 2)} ${deal.fiat}`),
        kv('Эффективная цена', `${fmtN(deal.effPrice, 4)} ${deal.fiat}`),
        kv('Сумма', `${fmt0(deal.fiatTotal)} ${deal.fiat}`),
        kv('Комиссия', `${fmtN(deal.feeFiat, 2)} ${deal.fiat}`),
        kv('Объём', `${fmtN(deal.volumeUsdt, 2)} USDT`),
        kv('Реквизиты', PM[deal.method]?.name || deal.method),
        card ? kv('Карта', `${card.label} ···${String(card.number).slice(-4)}`) : null,
        kv('Мерчант', deal.merchant.name),
        kv('AI-скор', `${deal.score} / 100`),
        kv('Создана', dateTime(deal.createdAt)),
      ),
      h('div.section-title', h('span.eyebrow', 'Таймлайн'), h('i.rule')),
      h('div.panel.panel-flush',
        deal.timeline.map((t) => h('div.row',
          h('div.deal-ico', icon(t.status === 'cancelled' ? 'x' : t.status === 'done' ? 'check' : 'clock')),
          h('div.row-main', h('div.row-title', { style: { fontSize: '13px' } }, t.text), h('div.row-sub.mono', hhmmss(t.at))),
        )),
      ),
    );
  };

  const api = openSheet({
    title: deal.side === 'buy' ? 'Закупка' : 'Продажа',
    subtitle: `${fmtN(deal.amount, 2)} ${deal.asset} · ${st.label}`,
    body: render(),
    foot: ['done', 'cancelled'].includes(deal.status) ? null : [
      h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Закрыть'),
      h('button.btn.btn-danger', {
        onClick: async () => {
          if (await confirmSheet({ title: 'Отменить сделку?', message: `Ордер ${deal.ref} будет отменён, средства вернутся на баланс.`, confirmLabel: 'Отменить сделку', danger: true })) {
            cancelDeal(deal.id);
            api.close();
          }
        },
      }, 'Отменить'),
    ],
  });

  // keep the sheet in sync while the simulated lifecycle advances
  const iv = setInterval(() => {
    const fresh = state.purchases.find((d) => d.id === deal.id);
    if (!fresh) return clearInterval(iv);
    deal = fresh;
    api.setBody(render());
    if (['done', 'cancelled'].includes(deal.status)) {
      api.setFoot([h('button.btn.btn-ghost.btn-block', { onClick: () => api.close() }, 'Закрыть')]);
      clearInterval(iv);
    }
  }, 1200);

  return api;
}

function kv(k, v, cls = '') {
  return h('div.kv', h('dt', k), h(`dd${cls ? '.' + cls : ''}`, v));
}

  __x.openDealSheet = openDealSheet;
  __x.kv = kv;
};

__m["src/ui/wheel.js"] = function (__x, __req) {
/**
 * Колесо фортуны (демо).
 * Открывается по тапу на промо-баннер. Содержит само колесо, слоты (демо-призы)
 * и кнопку «Прокрутить».
 *
 * Принцип честного прокрута: сектор-победитель выбирается ДО анимации
 * (взвешенный RNG), а колесо просто «подъезжает» к нему с замедлением.
 * На проде результат должен приходить с сервера (provably-fair).
 */
const { h, icon, mount } = __req("src/core/dom.js");
const { openSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
const { haptic } = __req("src/services/telegram.js");
const { state, set, addSpins, consumeSpin } = __req("src/core/store.js");
/** Зачислить выигрыш демо-слота на баланс/прокруты (прокруты зажаты потолком). */
function creditPrize(slot) {
  const bonus = { s1: 1, s5: 5, s10: 10, s50: 50 }[slot.id];
  if (bonus) { set('balance', (b) => { b.usdt += bonus; }); return; }
  if (slot.id === 'spin1') addSpins(1);
  if (slot.id === 'spin3') addSpins(3);
  // fee / miss — без зачисления (демо)
}

/* Демо-слоты: у каждого свой цвет (c — заливка, c2 — для лёгкого градиента
   внутри сектора), weight — относительный шанс. Порядок = по часовой стрелке. */
const WHEEL_SLOTS = [
  { id: 's5',   label: '+5 USDT',      short: '+5',   weight: 20, c: '#f7a600', c2: '#ffc24d' },
  { id: 'spin1',label: 'Спин ×1',      short: '×1',   weight: 16, c: '#2ebd85', c2: '#53e0a6' },
  { id: 'fee',  label: '−50% комиссия', short: '−50%', weight: 12, c: '#4a9bff', c2: '#7cb8ff' },
  { id: 's1',   label: '+1 USDT',      short: '+1',   weight: 24, c: '#8b5cf6', c2: '#a981ff' },
  { id: 'miss', label: 'Мимо',         short: '—',    weight: 18, c: '#3a4150', c2: '#4b5566' },
  { id: 's10',  label: '+10 USDT',     short: '+10',  weight: 10, c: '#ec4899', c2: '#ff6fb3' },
  { id: 'spin3',label: 'Спин ×3',      short: '×3',   weight: 6,  c: '#06b6d4', c2: '#3fd6ef' },
  { id: 's50',  label: '+50 USDT',     short: '+50',  weight: 2,  c: '#ff5a3c', c2: '#ff8463' },
];

/** Взвешенный выбор индекса сектора. */
function pickIndex() {
  const total = WHEEL_SLOTS.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WHEEL_SLOTS.length; i++) {
    r -= WHEEL_SLOTS[i].weight;
    if (r <= 0) return i;
  }
  return WHEEL_SLOTS.length - 1;
}

/** conic-gradient из секторов, каждый своим цветом + тонкие разделители. */
function wheelGradient() {
  const n = WHEEL_SLOTS.length;
  const step = 360 / n;
  const gap = 0.8;   // градусов на разделитель
  const stops = [];
  WHEEL_SLOTS.forEach((s, i) => {
    const a0 = i * step;
    const a1 = (i + 1) * step;
    stops.push(`${s.c} ${a0 + gap}deg ${a1 - gap}deg`);
    stops.push(`rgba(0,0,0,.35) ${a1 - gap}deg ${a1 + gap}deg`);
  });
  return `conic-gradient(from -${step / 2}deg, ${stops.join(', ')})`;
}

function openWheelSheet() {
  const n = WHEEL_SLOTS.length;
  const step = 360 / n;
  let angle = 0;          // накопленный угол поворота
  let spinning = false;
  let lastSpinAt = 0;     // анти-дабл-клик

  const wheel = h('div.fw-wheel', { style: { background: wheelGradient() } },
    // подписи секторов (контейнер повёрнут к сектору, текст контр-вращением держим ровным)
    ...WHEEL_SLOTS.map((s, i) => h('div.fw-label', {
      style: { '--a': `${i * step}deg`, transform: `rotate(${i * step}deg)` },
    }, h('span', { style: { color: s.id === 'miss' ? '#eaecef' : '#111' } }, s.short))),
    h('div.fw-hub', icon('zap')),
  );

  const spinBtn = h('button.btn.btn-primary.btn-block.fw-spin', { onClick: spin });
  const spinsChip = h('span.badge.badge-acid');

  function updateSpinBtn() {
    const spins = state.wheel.spins;
    spinsChip.textContent = `${spins} прокрут${spins === 1 ? '' : spins >= 2 && spins <= 4 ? 'а' : 'ов'}`;
    if (spinning) { spinBtn.disabled = true; mount(spinBtn, 'Крутится…'); return; }
    spinBtn.disabled = spins <= 0;
    mount(spinBtn, spins > 0 ? [icon('refresh'), 'Прокрутить'] : [icon('info'), 'Нет прокрутов — выполни задания']);
  }

  const resultEl = h('div.fw-result', { 'aria-live': 'polite' });

  function spin() {
    // анти-абуз: блок повторного входа + атомарное списание прокрута
    if (spinning) return;
    if (Date.now() - lastSpinAt < 500) return;   // защита от дабл-клика
    if (!consumeSpin()) { updateSpinBtn(); return; }
    lastSpinAt = Date.now();
    spinning = true;
    updateSpinBtn();
    mount(resultEl, '');
    haptic('medium');

    const idx = pickIndex();                 // результат выбран заранее
    const target = WHEEL_SLOTS[idx];

    // целевой угол: несколько полных оборотов + подводим центр сектора к указателю (сверху)
    const turns = 5 + Math.floor(Math.random() * 3);
    const jitter = (Math.random() - 0.5) * step * 0.6;   // не ровно в центр
    const base = angle - (angle % 360);                  // от текущего положения
    angle = base + turns * 360 - idx * step + jitter;
    wheel.style.transition = 'transform 4.6s cubic-bezier(.16,1,.3,1)';
    wheel.style.transform = `rotate(${angle}deg)`;

    const done = () => {
      wheel.removeEventListener('transitionend', done);
      spinning = false;
      const win = target.id !== 'miss';
      haptic(win ? 'success' : 'warning');
      creditPrize(target);
      set('wheel', (w) => { w.lastResult = target.id; w.history.unshift(target.id); if (w.history.length > 20) w.history.pop(); });
      updateSpinBtn();
      mount(resultEl,
        h(`div.fw-win${win ? '' : ' is-miss'}`,
          icon(win ? 'zap' : 'info'),
          h('span', win ? `Выпало: ${target.label}` : 'Увы, мимо — попробуй ещё'),
        ),
      );
      if (win) toast('Колесо фортуны', target.label, 'ok');
    };
    wheel.addEventListener('transitionend', done);
    // страховка, если transitionend не придёт
    setTimeout(() => { if (spinning) done(); }, 5200);
  }
  updateSpinBtn();

  openSheet({
    title: 'Колесо фортуны',
    subtitle: 'Крути и забирай приз',
    body: h('div.fw',
      h('div', { style: { marginBottom: '8px' } }, spinsChip),
      h('div.fw-stage',
        h('div.fw-pointer', aria('')),
        wheel,
      ),
      resultEl,
      h('div.fw-slots',
        WHEEL_SLOTS.map((s) => h('div.fw-slot',
          h('i', { style: { background: s.c } }),
          h('span.fw-slot-l', s.label),
        )),
      ),
      h('div.note', { style: { marginTop: '12px' } }, icon('info'),
        'Демо-слоты. На проде призы и число прокрутов приходят с сервера (provably-fair), спины зарабатываются за задания.'),
    ),
    foot: [spinBtn],
  });
}

function aria() { const e = h('span'); e.setAttribute('aria-hidden', 'true'); return e; }

  __x.openWheelSheet = openWheelSheet;
  __x.WHEEL_SLOTS = WHEEL_SLOTS;
};

__m["src/ui/quests.js"] = function (__x, __req) {
/**
 * Еженедельные задания. Компактная карточка на главной + полный лист с
 * прогрессом. За выполнение всех — приз: прокрут колеса фортуны.
 */
const { h, icon, mount } = __req("src/core/dom.js");
const { openSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
const { state, on, questProgress, claimQuestReward } = __req("src/core/store.js");
const { fmt0, compact } = __req("src/core/format.js");
const { haptic } = __req("src/services/telegram.js");
const { openWheelSheet } = __req("src/ui/wheel.js");
const fmtVal = (q, remaining = false) => {
  const fmt = q.id === 'volume' ? compact : String;
  if (remaining) return q.id === 'volume' ? `${compact(Math.max(0, q.target - q.cur))} USDT` : `${Math.max(0, q.target - q.cur)}`;
  return `${fmt(q.cur)} / ${fmt(q.target)}`;
};

/** Карточка-сводка для главной. */
function questsCard() {
  const slot = h('div');
  const render = () => {
    const p = questProgress();
    const ready = p.allDone && !state.quests.claimed;
    mount(slot, h('button.quests-card', { onClick: openQuestsSheet },
      h('div.quests-ico', icon('target')),
      h('div.quests-main',
        h('div.quests-top',
          h('span.quests-title', 'Еженедельные задания'),
          ready ? h('span.badge.badge-acid', 'приз готов') : h('span.quests-count', `${p.doneCount}/${p.total}`),
        ),
        h('div.meter', { style: { marginTop: '7px' } },
          h('i', { class: p.allDone ? 'buy' : '', style: { width: `${(p.doneCount / p.total) * 100}%` } })),
      ),
      icon('chev', { class: 'row-chev' }),
    ));
  };
  render();
  const off = on(['quests', 'stats', 'kyc', 'cards', 'wheel'], render);
  slot._off = off;
  return slot;
}

function openQuestsSheet() {
  const listEl = h('div');
  const footEl = h('div', { style: { width: '100%' } });

  const render = () => {
    const p = questProgress();
    mount(listEl,
      h('div.panel.panel-flush',
        p.list.map((q) => h('div.quest-row', { class: q.done ? 'is-done' : '' },
          h('div.quest-check', { class: q.done ? 'is-done' : '' }, icon(q.done ? 'check' : 'clock')),
          h('div.quest-body',
            h('div.quest-name', q.title),
            h('div.quest-status', q.done
              ? h('span.t-buy', 'выполнено')
              : h('span.t-muted', `осталось ${fmtVal(q, true)}`)),
            h('div.meter', { style: { marginTop: '6px' } },
              h('i', { class: q.done ? 'buy' : '', style: { width: `${Math.min(100, (q.cur / q.target) * 100)}%` } })),
          ),
          h('div.quest-val.mono', fmtVal(q)),
        )),
      ),
    );

    const ready = p.allDone && !state.quests.claimed;
    mount(footEl, state.quests.claimed
      ? h('button.btn.btn-ghost.btn-block', { disabled: true }, icon('check'), 'Приз получен — заходи на следующей неделе')
      : h('button.btn.btn-primary.btn-block', { disabled: !ready, onClick: claim },
          icon('zap'), ready ? 'Забрать приз: +1 прокрут' : `Выполни все задания (${p.doneCount}/${p.total})`));
  };

  function claim() {
    if (!claimQuestReward()) return;
    haptic('success');
    toast('Приз получен', '+1 прокрут колеса фортуны', 'ok');
    api.close();                         // закрываем лист заданий…
    setTimeout(openWheelSheet, 320);     // …и открываем колесо
  }

  const api = openSheet({
    title: 'Еженедельные задания',
    subtitle: 'Обновляются каждый понедельник',
    body: h('div',
      listEl,
      h('div.note', { style: { marginTop: '12px' } }, icon('info'),
        'Прогресс считается за текущую неделю. Выполни все задания и забери прокрут колеса фортуны.'),
    ),
    foot: [footEl],
  });
  render();
  return api;
}

  __x.questsCard = questsCard;
  __x.openQuestsSheet = openQuestsSheet;
};

__m["src/screens/home.js"] = function (__x, __req) {
/** Главная — баланс USDT, карточки, KPI, последние закупки. */
const { h, icon, sparkline, mount } = __req("src/core/dom.js");
const { state, set, on, PAY_METHODS, kycInfo, rollDay } = __req("src/core/store.js");
const { splitAmount, fmtN, fmt0, compact, ago, dateTime, uid } = __req("src/core/format.js");
const { FIAT, assetRate } = __req("src/data/exchanges.js");
const { openSheet, confirmSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
const { haptic } = __req("src/services/telegram.js");
const { openDealSheet } = __req("src/ui/dealSheet.js");
const { openWheelSheet } = __req("src/ui/wheel.js");
const { questsCard } = __req("src/ui/quests.js");
const { DEAL_STATUS } = __req("src/services/trade.js");
const { navigate } = __req("src/core/router.js");
const BANK_TINT = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m.tint]));

function HomeScreen() {
  rollDay();
  const root = h('div.stagger');
  const unsubs = [];

  const kycSlot = h('div');
  const heroSlot = h('div');
  const tilesSlot = h('div');
  const cardsSlot = h('div');
  const dealsSlot = h('div');
  const questsSlot = questsCard();

  const renderAll = () => {
    mount(kycSlot, kycBanner());
    mount(heroSlot, hero());
    mount(tilesSlot, tiles());
    mount(cardsSlot, cardsBlock());
    mount(dealsSlot, dealsBlock());
  };

  unsubs.push(on(['balance', 'ui'], () => { mount(heroSlot, hero()); mount(cardsSlot, cardsBlock()); }));
  unsubs.push(on('cards', () => mount(cardsSlot, cardsBlock())));
  unsubs.push(on(['purchases', 'stats'], () => { mount(dealsSlot, dealsBlock()); mount(tilesSlot, tiles()); }));
  unsubs.push(on('kyc', () => mount(kycSlot, kycBanner())));
  unsubs.push(on('market', () => mount(heroSlot, hero())));

  renderAll();

  root.append(
    wrap(kycSlot, 0),
    wrap(heroSlot, 1),
    h('div', { style: { '--i': 2, marginTop: '12px' } }, promoBanner()),
    h('div', { style: { '--i': 2, marginTop: '10px' } }, questsSlot),
    sectionTitle('Операции за сегодня', 2),
    wrap(tilesSlot, 3),
    sectionTitle('Баланс карточек', 4, h('button.btn.btn-xs.btn-ghost', { onClick: () => openCardSheet() }, icon('plus'), 'Карта')),
    wrap(cardsSlot, 5),
    sectionTitle('Закупки', 6, h('button.btn.btn-xs.btn-ghost', { onClick: () => navigate('p2p') }, 'К стаканам', icon('chev'))),
    wrap(dealsSlot, 7),
    h('div.foot-note', 'P2P Light · агрегатор P2P-стаканов · данные обновляются в реальном времени во вкладке P2P'),
  );

  return { node: root, destroy: () => { unsubs.forEach((u) => u()); questsSlot._off?.(); } };
}

const wrap = (node, i) => h('div', { style: { '--i': i } }, node);

/** Промо-баннер: по тапу открывает колесо фортуны. */
function promoBanner() {
  return h('button.promo-banner', {
    'aria-label': 'Колесо фортуны — прокрути бесплатно',
    onClick: () => { haptic('light'); openWheelSheet(); },
  }, h('img', { src: 'data:image/webp;base64,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', alt: 'Прокрути колесо фортуны бесплатно' }));
}

function sectionTitle(text, i, aside) {
  return h('div.section-title', { style: { '--i': i } }, h('span.eyebrow', text), h('i.rule'), aside || null);
}

/* ============================ KYC banner ============================ */

function kycBanner() {
  const k = state.kyc;
  if (k.status === 'approved' && k.level >= 1) {
    const lim = kycInfo();
    return h('button.kyc-banner.ok', { onClick: () => navigate('profile') },
      h('div.kyc-ico', icon('shieldCheck', { class: 't-buy' })),
      h('div.kyc-main',
        h('div.kyc-t', `KYC уровень ${k.level} · ${lim.name}`),
        h('div.kyc-s', `Лимит ${lim.dayLimit === Infinity ? 'без ограничений' : fmt0(lim.dayLimit) + ' USDT/сутки'} · использовано ${fmt0(state.stats.dayVolume)}`),
      ),
      icon('chev', { class: 'row-chev' }),
    );
  }
  if (k.status === 'pending') {
    return h('button.kyc-banner.pending', { onClick: () => navigate('profile') },
      h('div.kyc-ico', icon('clock', { class: 't-acid' })),
      h('div.kyc-main',
        h('div.kyc-t', 'KYC на проверке'),
        h('div.kyc-s', `Заявка отправлена ${ago(k.submittedAt)}. Торговля откроется после одобрения.`),
      ),
      icon('chev', { class: 'row-chev' }),
    );
  }
  return h('button.kyc-banner', { onClick: () => navigate('profile') },
    h('div.kyc-ico', icon('shield', { class: 't-warn' })),
    h('div.kyc-main',
      h('div.kyc-t', k.status === 'rejected' ? 'KYC отклонён' : 'Торговля заблокирована'),
      h('div.kyc-s', k.status === 'rejected' ? k.rejectReason : 'Пройдите KYC-верификацию, чтобы закупать через P2P-стаканы'),
    ),
    h('span.badge.badge-warn', 'Пройти'),
  );
}

/* ============================ hero balance ============================ */

function hero() {
  const hidden = state.ui.balanceHidden;
  const b = state.balance;
  const rate = assetRate('USDT', state.filters.fiat) || assetRate('USDT', 'RUB');
  const [int, frac] = splitAmount(b.usdt, 2);
  const hist = state.market.history;
  const delta = hist.length > 2 ? ((hist[hist.length - 1] - hist[0]) / hist[0]) * 100 : 0;

  const el = h(`div.hero${hidden ? '.balance-hidden' : ''}`,
    h('div.hero-top',
      h('span.eyebrow', 'Баланс кошелька'),
      b.locked > 0 ? h('span.badge.badge-warn', icon('clock'), `эскроу ${fmt0(b.locked)}`) : null,
      h('span.badge.badge-acid', icon('cpu'), 'ai on'),
    ),
    h('button.balance-tap', {
      'aria-label': hidden ? 'Показать баланс' : 'Скрыть баланс',
      onClick: () => { haptic('light'); set('ui', (u) => { u.balanceHidden = !u.balanceHidden; }); },
    },
      h('div.balance-amount',
        h('img', { src: 'data:image/png;base64,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', alt: '', style: { width: '28px', height: '28px', marginRight: '2px' } }),
        h('span', int), h('span.frac', frac),
        h('span.cur', 'USDT'),
      ),
      h('div.balance-fiat',
        `≈ ${fmt0(b.usdt * rate)} ${FIAT[state.filters.fiat]?.sym || '₽'}`,
        h('span', { style: { marginLeft: '8px' } },
          h(`span.delta.${delta >= 0 ? 'up' : 'dn'}`, icon(delta >= 0 ? 'up' : 'down'), `${Math.abs(delta).toFixed(2)}%`),
        ),
      ),
      h('div.hide-hint', icon(hidden ? 'eyeOff' : 'eye'), hidden ? 'нажмите, чтобы показать' : 'нажмите, чтобы скрыть'),
    ),
    h('div.hero-actions',
      h('button.btn.btn-primary', { onClick: () => openBalanceSheet('deposit') }, icon('plus'), 'Пополнить'),
      h('button.btn.btn-ghost', { onClick: () => openBalanceSheet('withdraw') }, icon('upload'), 'Вывести'),
      h('button.btn.btn-ghost.btn-icon', { 'aria-label': 'Изменить баланс', onClick: () => openBalanceSheet('set') }, icon('edit')),
    ),
  );
  return el;
}

/** Balance editor: set / deposit / withdraw. */
function openBalanceSheet(mode = 'set') {
  const titles = { set: 'Изменить баланс', deposit: 'Пополнить баланс', withdraw: 'Вывести USDT' };
  let value = mode === 'set' ? String(state.balance.usdt.toFixed(2)) : '';
  const errEl = h('div.t-xs.t-sell', { style: { marginTop: '6px', minHeight: '15px' } });

  const input = h('input.input.num', {
    type: 'text', inputmode: 'decimal', placeholder: '0.00', value,
    onInput: (e) => { value = e.target.value.replace(',', '.'); errEl.textContent = ''; preview(); },
  });
  const previewEl = h('div.t-xs.t-muted', { style: { marginTop: '8px' } });

  function parsed() { const n = Number(value); return Number.isFinite(n) ? n : NaN; }
  function preview() {
    const n = parsed();
    if (!Number.isFinite(n)) return previewEl.textContent = '';
    const next = mode === 'set' ? n : mode === 'deposit' ? state.balance.usdt + n : state.balance.usdt - n;
    previewEl.textContent = `Станет: ${fmtN(Math.max(0, next), 2)} USDT  ≈ ${fmt0(Math.max(0, next) * assetRate('USDT', 'RUB'))} ₽`;
  }
  preview();

  const quick = h('div.vol-quick',
    [100, 500, 1000, 5000].map((v) => h('button.chip', {
      onClick: () => { value = String(v); input.value = value; preview(); },
    }, `+${compact(v)}`)),
  );

  const api = openSheet({
    title: titles[mode],
    subtitle: `Текущий баланс ${fmtN(state.balance.usdt, 2)} USDT`,
    body: h('div',
      h('label.field',
        h('span.label', mode === 'set' ? 'Новое значение' : 'Сумма', h('span.hint', 'USDT')),
        input, errEl, previewEl,
      ),
      mode !== 'set' ? quick : null,
      h('div.note', { style: { marginTop: '14px' } }, icon('info'),
        'Баланс кошелька. На проде синхронизируется с бэкендом и кастодиальным кошельком.'),
    ),
    foot: [
      h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Отмена'),
      h('button.btn.btn-primary', {
        onClick: () => {
          const n = parsed();
          if (!Number.isFinite(n) || n < 0) return errEl.textContent = 'Введите корректную сумму';
          if (mode === 'withdraw' && n > state.balance.usdt) return errEl.textContent = 'Недостаточно средств';
          set('balance', (b) => {
            if (mode === 'set') b.usdt = n;
            else if (mode === 'deposit') b.usdt += n;
            else b.usdt -= n;
          });
          toast('Баланс обновлён', `${fmtN(state.balance.usdt, 2)} USDT`, 'ok');
          api.close();
        },
      }, mode === 'set' ? 'Сохранить' : mode === 'deposit' ? 'Пополнить' : 'Вывести'),
    ],
  });
}

/* ============================ tiles ============================ */

function tiles() {
  const st = state.stats;
  const avgSpread = st.deals ? (st.spreadSum / st.deals) : 0;
  const success = st.deals ? (st.won / st.deals) * 100 : 0;
  const lim = kycInfo();
  const dayCap = Math.min(state.settings.dayLimit, lim.dayLimit === Infinity ? state.settings.dayLimit : lim.dayLimit);

  return h('div',
    h('div.tiles',
      tile('Объём за сутки', `${compact(st.dayVolume)}`, 'USDT', 'acid', state.market.history),
      tile('Сделок', String(st.deals), `${success.toFixed(0)}% успешных`, 'buy'),
      tile('Средний спред', `${avgSpread.toFixed(2)}%`, 'к медиане рынка', avgSpread >= 0 ? 'buy' : 'sell'),
      tile('Лимит суток', `${((st.dayVolume / (dayCap || 1)) * 100).toFixed(0)}%`, `${compact(dayCap)} USDT`, 'warn'),
    ),
  );
}

function tile(label, value, sub, tone = 'acid', spark = null) {
  const color = tone === 'buy' ? 'var(--buy)' : tone === 'sell' ? 'var(--sell)' : tone === 'warn' ? 'var(--warn)' : 'var(--acid)';
  return h('div.tile',
    h('div.tl', label),
    h('div.tv', { style: { color } }, value),
    h('div.ts', sub),
    spark && spark.length > 2 ? sparkline(spark, color) : null,
  );
}

/* ============================ cards ============================ */

function cardsBlock() {
  const hidden = state.ui.balanceHidden;

  // карт нет — одна крупная плитка «+ Добавить карту»
  if (!state.cards.length) {
    return h('button.pay-card.add.empty', { onClick: () => openCardSheet() },
      icon('plus'),
      h('span', 'Добавить карту'),
    );
  }

  const total = state.cards.filter((c) => c.active).reduce((a, c) => a + c.balance, 0);
  return h('div',
    h('div', { class: hidden ? 'balance-hidden' : '' },
      h('div.cards-rail',
        state.cards.map((c) => payCard(c)),
        h('button.pay-card.add', { onClick: () => openCardSheet() }, icon('plus'), h('span', 'Добавить карту')),
      ),
    ),
    h('div.wire', { style: { marginTop: '4px' } },
      icon('wallet', { class: 't-muted' }),
      h('span.t-xs.t-muted', 'Доступно для закупок'),
      h('span.wire-stat', { class: hidden ? 'balance-hidden' : '' },
        h('span.pc-bal', { style: { fontSize: '12px' } }, `${fmt0(total)} ₽`)),
    ),
  );
}

function payCard(c) {
  const used = c.limit ? (1 - c.balance / c.limit) * 100 : 0;
  return h('button.pay-card', {
    style: { '--card-tint': BANK_TINT[c.bank] || 'var(--acid)' },
    class: c.active ? '' : 'is-off',
    onClick: () => openCardSheet(c),
  },
    h('div.pc-top',
      h('div.pc-logo', { style: { background: BANK_TINT[c.bank] || 'var(--panel-3)' } }, (c.label || '?')[0]),
      h('div', { style: { minWidth: '0' } },
        h('div.pc-bank', c.label),
        h('div.pc-num', '···· ' + String(c.number).slice(-4)),
      ),
    ),
    h('div.pc-bal', fmt0(c.balance), h('span.pc-cur', c.currency)),
    h('div.pc-meta',
      h('div.meter', { style: { flex: '1' } }, h('i', { class: used > 80 ? 'sell' : used > 55 ? 'warn' : 'buy', style: { width: `${Math.min(100, Math.max(0, used))}%` } })),
      h('span', c.active ? `${used.toFixed(0)}%` : 'выкл'),
    ),
  );
}

function openCardSheet(card = null) {
  const isNew = !card;
  const draft = card ? { ...card } : { id: uid('card'), bank: 'sber', label: 'Сбербанк', number: '', balance: 0, limit: 300000, currency: 'RUB', active: true };
  const errEl = h('div.t-xs.t-sell', { style: { minHeight: '15px', marginTop: '4px' } });

  const bankSel = h('select.select', {
    onChange: (e) => {
      draft.bank = e.target.value;
      const pm = PAY_METHODS.find((m) => m.id === draft.bank);
      if (pm && (isNew || !draft.label)) { draft.label = pm.name; labelInput.value = pm.name; }
    },
  }, PAY_METHODS.filter((m) => !['cash', 'wire'].includes(m.id)).map((m) =>
    h('option', { value: m.id, selected: m.id === draft.bank }, m.name)));

  const labelInput = h('input.input', { value: draft.label, placeholder: 'Название', onInput: (e) => { draft.label = e.target.value; } });
  const numInput = h('input.input.mono', {
    value: draft.number, inputmode: 'numeric', placeholder: '0000 0000 0000 0000', maxlength: 19,
    onInput: (e) => { draft.number = e.target.value.replace(/\D/g, '').slice(0, 19); e.target.value = draft.number.replace(/(\d{4})(?=\d)/g, '$1 '); },
  });
  if (draft.number) numInput.value = String(draft.number).replace(/(\d{4})(?=\d)/g, '$1 ');

  const balInput = h('input.input.num', { value: draft.balance, inputmode: 'decimal', onInput: (e) => { draft.balance = Number(e.target.value.replace(',', '.')) || 0; } });
  const limInput = h('input.input.num', { value: draft.limit, inputmode: 'decimal', onInput: (e) => { draft.limit = Number(e.target.value.replace(',', '.')) || 0; } });
  const curSel = h('select.select', { onChange: (e) => { draft.currency = e.target.value; } },
    ['RUB', 'USD', 'EUR', 'UAH', 'KZT'].map((f) => h('option', { value: f, selected: f === draft.currency }, f)));

  const activeSwitch = h('button.switch', { role: 'switch', 'aria-checked': String(draft.active) });
  activeSwitch.addEventListener('click', () => {
    draft.active = !draft.active;
    activeSwitch.setAttribute('aria-checked', String(draft.active));
  });

  const api = openSheet({
    title: isNew ? 'Новая карта' : 'Карта',
    subtitle: isNew ? 'Источник фиата для закупок' : draft.label,
    body: h('div',
      h('div.grid-2',
        h('label.field', h('span.label', 'Банк'), bankSel),
        h('label.field', h('span.label', 'Валюта'), curSel),
      ),
      h('label.field', h('span.label', 'Название'), labelInput),
      h('label.field', h('span.label', 'Номер карты'), numInput),
      h('div.grid-2',
        h('label.field', h('span.label', 'Баланс'), balInput),
        h('label.field', h('span.label', 'Лимит'), limInput),
      ),
      errEl,
      h('div.panel', { style: { marginTop: '10px' } },
        h('div.switch-row',
          h('div.sr-main', h('div.sr-title', 'Активна'), h('div.sr-sub', 'Выключенная карта не предлагается при закупке')),
          activeSwitch,
        ),
      ),
    ),
    foot: [
      !isNew ? h('button.btn.btn-danger', {
        onClick: async () => {
          if (await confirmSheet({ title: 'Удалить карту?', message: `${draft.label} ···${String(draft.number).slice(-4)} будет удалена.`, confirmLabel: 'Удалить', danger: true })) {
            set('cards', (cards) => { const i = cards.findIndex((x) => x.id === draft.id); if (i > -1) cards.splice(i, 1); });
            toast('Карта удалена', null, 'warn');
            api.close();
          }
        },
      }, icon('trash')) : h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Отмена'),
      h('button.btn.btn-primary', {
        onClick: () => {
          if (String(draft.number).replace(/\D/g, '').length < 12) return errEl.textContent = 'Введите корректный номер карты (12–19 цифр)';
          if (!draft.label.trim()) return errEl.textContent = 'Укажите название';
          draft.number = String(draft.number).replace(/\D/g, '');
          set('cards', (cards) => {
            const i = cards.findIndex((x) => x.id === draft.id);
            if (i > -1) cards[i] = draft; else cards.push(draft);
          });
          toast(isNew ? 'Карта добавлена' : 'Карта обновлена', `${draft.label} · ${fmt0(draft.balance)} ${draft.currency}`, 'ok');
          api.close();
        },
      }, 'Сохранить'),
    ],
  });
}

/* ============================ deals ============================ */

function dealsBlock() {
  if (!state.purchases.length) {
    return h('div.panel',
      h('div.empty',
        icon('layers'),
        h('div.et', 'Закупок пока нет'),
        h('div.eb', 'Откройте вкладку P2P, выберите офер в стакане и задайте объём в USDT'),
        h('button.btn.btn-sm.btn-primary', { style: { marginTop: '12px' }, onClick: () => navigate('p2p') }, icon('layers'), 'Открыть стаканы'),
      ),
    );
  }
  return h('div.panel.panel-flush',
    state.purchases.slice(0, 7).map((d) => {
      const st = DEAL_STATUS[d.status];
      return h('button.deal', { onClick: () => openDealSheet(d) },
        h('div.deal-ico', { style: { color: st.color } }, icon(d.side === 'buy' ? 'down' : 'up')),
        h('div.deal-main',
          h('div.deal-t', d.merchant.name, h(`span.badge.${st.badge}`, st.label)),
          h('div.deal-s', `${d.ref} · ${dateTime(d.createdAt)}`),
        ),
        h('div.deal-a',
          h('div.da', { style: { color: d.side === 'buy' ? 'var(--buy)' : 'var(--sell)' } },
            `${d.side === 'buy' ? '+' : '−'}${fmtN(d.amount, 2)}`),
          h('div.db', `${fmt0(d.fiatTotal)} ${d.fiat}`),
        ),
      );
    }),
    state.purchases.length > 7
      ? h('button.row', { onClick: () => openAllDeals() }, h('div.row-main', h('div.row-title.t-acid', `Все закупки (${state.purchases.length})`)), icon('chev', { class: 'row-chev' }))
      : null,
  );
}

function openAllDeals() {
  openSheet({
    title: 'История закупок',
    subtitle: `${state.purchases.length} операций`,
    body: h('div.panel.panel-flush', state.purchases.map((d) => {
      const st = DEAL_STATUS[d.status];
      return h('button.deal', { onClick: () => openDealSheet(d) },
        h('div.deal-ico', { style: { color: st.color } }, icon(d.side === 'buy' ? 'down' : 'up')),
        h('div.deal-main',
          h('div.deal-t', d.merchant.name, h(`span.badge.${st.badge}`, st.label)),
          h('div.deal-s', `${d.ref} · ${dateTime(d.createdAt)}`),
        ),
        h('div.deal-a', h('div.da', `${fmtN(d.amount, 2)} ${d.asset}`), h('div.db', `${fmt0(d.fiatTotal)} ${d.fiat}`)),
      );
    })),
  });
}

  __x.HomeScreen = HomeScreen;
  __x.openBalanceSheet = openBalanceSheet;
  __x.openCardSheet = openCardSheet;
};

__m["src/ui/regionSheet.js"] = function (__x, __req) {
/**
 * Выбор региона. Используется и как обязательный экран при первом входе
 * (mandatory=true — без выбора не закрыть), и как смена региона в любой момент.
 */
const { h, icon, mount } = __req("src/core/dom.js");
const { openSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
const { state, setRegion } = __req("src/core/store.js");
const { COUNTRIES, COUNTRY, CUR } = __req("src/data/regions.js");
const { set } = __req("src/core/store.js");
const { resubscribe } = __req("src/services/feed.js");
const { haptic } = __req("src/services/telegram.js");
/** Применить регион: валюта и способы оплаты подтягиваются из страны. */
function applyRegion(code) {
  const c = COUNTRY[code];
  if (!c) return;
  setRegion(code);
  set('filters', (f) => { f.fiat = c.cur; f.methods = []; });
  resubscribe();
}

function openRegionSheet({ mandatory = false, onPick } = {}) {
  let query = '';
  const listEl = h('div.region-list');

  const render = () => {
    const q = query.trim().toLowerCase();
    const items = COUNTRIES.filter((c) =>
      !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || c.cur.toLowerCase().includes(q));
    mount(listEl, items.length ? items.map((c) => {
      const active = state.region === c.code;
      return h('button.region-row', { class: active ? 'is-active' : '', onClick: () => choose(c.code) },
        h('span.region-flag', c.flag),
        h('div.region-main',
          h('div.region-name', c.name),
          h('div.region-sub', `${CUR[c.cur]?.name || c.cur} · ${c.cur} ${CUR[c.cur]?.sym || ''}`),
        ),
        active ? icon('check', { class: 't-acid' }) : h('span.region-cur', c.flag ? c.cur : ''),
      );
    }) : h('div.empty', icon('search'), h('div.et', 'Ничего не найдено')));
  };

  const search = h('input.input', {
    type: 'search', placeholder: 'Поиск страны или валюты…', autocomplete: 'off',
    'aria-label': 'Поиск региона', maxlength: 40,
    onInput: (e) => { query = e.target.value; render(); },
  });

  const api = openSheet({
    title: 'Выберите регион',
    subtitle: mandatory ? 'Торговля ведётся в выбранном регионе' : 'Можно сменить в любой момент',
    dismissible: !mandatory,
    body: h('div',
      h('div.region-search', icon('search', { class: 'book-search-ico' }), search),
      listEl,
      h('div.note', { style: { marginTop: '10px' } }, icon('info'),
        'Регион задаёт валюту и доступные способы оплаты. Стаканы фильтруются по выбранному региону.'),
    ),
  });

  function choose(code) {
    haptic('select');
    applyRegion(code);
    const c = COUNTRY[code];
    toast('Регион выбран', `${c.flag} ${c.name} · ${c.cur}`, 'ok');
    onPick?.(code);
    api.close();
  }

  render();
  return api;
}

/** Чип региона для шапки P2P. */
function regionChip(onClick) {
  const c = state.region ? COUNTRY[state.region] : null;
  return h('button.region-chip', { onClick },
    h('span.region-chip-flag', c?.flag || '🌐'),
    h('span.region-chip-cur', c?.cur || '—'),
    icon('chevDown', { class: 'region-chip-chev' }),
  );
}

  __x.applyRegion = applyRegion;
  __x.openRegionSheet = openRegionSheet;
  __x.regionChip = regionChip;
};

__m["src/ui/offerSheet.js"] = function (__x, __req) {
/**
 * Deal-context sheet: the full "почему эта сделка" breakdown + execution.
 */
const { h, icon, mount } = __req("src/core/dom.js");
const { openSheet, confirmSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
const { state, set, PAY_METHODS, kycInfo } = __req("src/core/store.js");
const { fmtN, fmt0, compact, ago } = __req("src/core/format.js");
const { EX, FIAT } = __req("src/data/exchanges.js");
const { analyze, WEIGHT_LABELS } = __req("src/services/analysis.js");
const { preflight, execute } = __req("src/services/trade.js");
const { openDealSheet } = __req("src/ui/dealSheet.js");
const { navigate } = __req("src/core/router.js");
const { haptic } = __req("src/services/telegram.js");
const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));

function openOfferSheet(offerId) {
  let volume = state.settings.volume;
  let cardId = state.cards.find((c) => c.active)?.id || null;
  let method = null;

  const bodyHost = h('div');
  const footHost = h('div', { style: { display: 'flex', gap: '8px', width: '100%' } });

  const api = openSheet({
    title: 'Контекст сделки',
    subtitle: 'AI-анализ офера',
    body: bodyHost,
    foot: footHost,
  });

  const live = setInterval(draw, 1200);
  const origClose = api.close;
  api.close = (r) => { clearInterval(live); origClose(r); };

  function draw() {
    const offer = state.offers[offerId];
    if (!offer) {
      mount(bodyHost, h('div.empty', icon('x'), h('div.et', 'Офер снят с биржи'), h('div.eb', 'Мерчант убрал объявление или оно полностью выкуплено')));
      mount(footHost, h('button.btn.btn-ghost.btn-block', { onClick: () => api.close() }, 'Закрыть'));
      clearInterval(live);
      return;
    }
    if (!method || !offer.methods.includes(method)) method = offer.methods[0];
    const ctx = analyze(offer, volume);
    const pf = preflight(offer, volume, cardId);

    mount(bodyHost, renderBody(offer, ctx, pf));
    mount(footHost, renderFoot(offer, ctx, pf));
  }

  function renderBody(offer, ctx, pf) {
    const ex = EX[offer.exchange];
    const m = offer.merchant;
    const sym = FIAT[offer.fiat]?.sym || '';

    /* ---- volume control ---- */
    const volInput = h('input', {
      type: 'text', inputmode: 'decimal', value: String(volume),
      'aria-label': 'Объём в USDT',
      onInput: (e) => {
        const n = Number(e.target.value.replace(',', '.'));
        volume = Number.isFinite(n) ? n : 0;
        clearTimeout(volInput._t);
        volInput._t = setTimeout(() => { set('settings', (s) => { s.volume = volume; }); draw(); }, 420);
      },
    });

    const quickVols = [1000, 5000, 10000, 25000, 50000];

    return h('div',
      /* --- merchant head --- */
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } },
        h('div.avatar', { style: { width: '42px', height: '42px', fontSize: '16px', borderRadius: '12px', background: ex?.tint || 'var(--acid)' } }, m.name[0]),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '700', fontSize: '15px' } },
            m.name,
            m.verified ? icon('shieldCheck', { class: 'of-verified' }) : null,
            m.pro ? h('span.badge.badge-acid', 'pro') : null,
          ),
          h('div.t-xs.t-muted.mono', { style: { marginTop: '2px' } },
            `${ex?.name || offer.exchange} · ${m.orders} сделок · ${(m.completion * 100).toFixed(1)}% · ★${m.rating}`),
        ),
        h('div', { style: { textAlign: 'right' } },
          h('div.mono', { style: { fontSize: '18px', fontWeight: '700' } }, fmtN(offer.price, 2)),
          h('div.t-xs.t-muted.mono', `${sym}/${offer.asset}`),
        ),
      ),

      /* --- verdict --- */
      h('div.panel.panel-flush', { style: { '--v-c': ctx.verdict.color, '--v-ghost': ctx.verdict.ghost } },
        h('div.verdict',
          h('div.verdict-mark', icon(ctx.verdict.icon)),
          h('div.verdict-main',
            h('div.verdict-title', ctx.verdict.title),
            h('div.verdict-sub', ctx.reasons.length ? ctx.reasons.join(' · ') : 'недостаточно данных для вывода'),
          ),
          h('div.gauge-ring', { style: { '--p': ctx.score, '--gc': ctx.verdict.color } }, h('span', String(ctx.score))),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '10px 14px', borderBottom: '1px solid var(--line-soft)' } },
          h('span.badge.badge-acid', icon('cpu'), `${ctx.confidence}% увер.`),
          h('span.badge', `скор ${ctx.score}/100`),
          h('span.badge', { class: ctx.dev <= 0 ? 'badge-buy' : 'badge-sell' }, `${ctx.dev > 0 ? '+' : ''}${ctx.dev.toFixed(2)}% к мед.`),
          h('span.badge', { class: ctx.slippagePct > state.settings.slippageTol ? 'badge-sell' : 'badge-buy' }, `слип ${ctx.slippagePct.toFixed(2)}%`),
        ),
        h('div.factors', Object.entries(ctx.comps).map(([k, v]) => h('div.factor',
          h('div', { style: { width: '46px', flex: '0 0 auto' } },
            h('div.meter', h('i', { class: v > .66 ? 'buy' : v > .4 ? 'warn' : 'sell', style: { width: `${v * 100}%` } }))),
          h('div.ft', WEIGHT_LABELS[k] || k),
          h('div.fw', `${Math.round(v * 100)} · вес ${ctx.weights[k]}`),
        ))),
      ),

      /* --- условия контрагента (описание из ордера) --- */
      offer.terms ? h('div',
        h('div.section-title',
          h('span.eyebrow', offer.side === 'buy' ? 'Условия продавца' : 'Условия покупателя'),
          h('i.rule'),
        ),
        h('div.panel', h('div.offer-terms', offer.terms)),
      ) : null,

      /* --- volume --- */
      h('div.section-title', h('span.eyebrow', 'Объём закупки'), h('i.rule')),
      h('div.panel',
        h('div.vol-wrap',
          h('div.vol-input',
            h('img', { src: 'data:image/png;base64,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', alt: '' }),
            volInput,
            h('span.vc', 'USDT'),
          ),
          h('div.vol-quick', quickVols.map((v) => h('button.chip', {
            'aria-pressed': String(volume === v),
            onClick: () => { volume = v; set('settings', (s) => { s.volume = v; }); draw(); },
          }, compact(v)))),
          h('div.t-xs.t-muted', { style: { marginTop: '8px', fontFamily: 'var(--font-mono)' } },
            `${fmtN(ctx.assetAmount, offer.asset === 'USDT' ? 2 : 6)} ${offer.asset} · покрытие офером ${(ctx.coverage * 100).toFixed(0)}%`),
        ),
      ),

      /* --- economics --- */
      h('div.section-title', h('span.eyebrow', 'Экономика сделки'), h('i.rule')),
      h('div.panel.panel-body',
        h('dl',
          kvRow('Объём к исполнению', `${fmtN(ctx.fillable, 2)} ${offer.asset}`),
          kvRow('Сумма фиатом', `${fmt0(ctx.grossFiat)} ${sym}`),
          kvRow(`Комиссия (${state.settings.exchangeFee}%)`, `${fmtN(ctx.feeFiat, 2)} ${sym}`),
          kvRow('Итого списание', `${fmt0(ctx.totalFiat)} ${sym}`, 't-acid'),
          kvRow('Эффективная цена', `${fmtN(ctx.effPrice, 4)} ${sym}`),
          kvRow('Слиппедж к лучшей цене', `${ctx.slippagePct.toFixed(3)}%`, ctx.slippagePct > state.settings.slippageTol ? 't-sell' : 't-buy'),
          kvRow(`Выход при марже ${state.settings.targetMargin}%`, `${fmtN(ctx.exitPrice, 2)} ${sym}`),
          kvRow('Ожидаемая прибыль', `${fmtN(ctx.profitUsdt, 2)} USDT`, ctx.profitUsdt > 0 ? 't-buy' : 't-sell'),
          kvRow('Лимиты офера', `${fmt0(offer.min)} – ${fmt0(offer.max)} ${sym}`),
          kvRow('Доступно у мерчанта', `${fmtN(offer.available, 2)} ${offer.asset}`),
          kvRow('Отпуск в среднем', `${m.avgReleaseMin} мин`),
          kvRow('Обновлено', ago(offer.ts)),
        ),
      ),

      /* --- payment --- */
      h('div.section-title', h('span.eyebrow', 'Оплата'), h('i.rule')),
      h('div.panel.panel-body',
        h('label.field',
          h('span.label', 'Реквизиты мерчанта', h('span.hint', `риск ${((PM[method]?.risk ?? 0) * 100).toFixed(0)}%`)),
          h('div.chips', offer.methods.map((mid) => h('button.chip', {
            'aria-pressed': String(method === mid),
            onClick: () => { method = mid; draw(); },
          }, h('i.dot', { class: (PM[mid]?.risk ?? 0) < 0.12 ? 'on' : (PM[mid]?.risk ?? 0) < 0.2 ? 'warn' : 'off' }), PM[mid]?.name || mid))),
        ),
        offer.side === 'buy' ? h('label.field',
          h('span.label', 'Списать с карты'),
          h('select.select', { onChange: (e) => { cardId = e.target.value; draw(); } },
            state.cards.map((c) => h('option', {
              value: c.id, selected: c.id === cardId, disabled: !c.active,
            }, `${c.label} ···${String(c.number).slice(-4)} · ${fmt0(c.balance)} ${c.currency}${c.active ? '' : ' (выкл)'}`)),
          ),
        ) : h('div.note', icon('info'), `Продажа: ${fmtN(ctx.fillable, 2)} ${offer.asset} уйдут с баланса, фиат зачислится на выбранную карту.`),
      ),

      /* --- flags --- */
      ctx.flags.length ? h('div',
        h('div.section-title', h('span.eyebrow', `Факторы риска · ${ctx.flags.length}`), h('i.rule')),
        h('div.panel.panel-flush', ctx.flags.map((f) => h('div.factor',
          icon(f.level === 'alert' ? 'alert' : 'info', { class: f.level === 'alert' ? 'fi t-sell' : 'fi t-warn' }),
          h('div.ft', f.text),
        ))),
      ) : null,

      /* --- blockers --- */
      !pf.ok ? h('div', { style: { marginTop: '12px' } },
        pf.errors.map((e) => h('div.note.warn', { style: { marginBottom: '6px' } },
          icon('alert'),
          h('div', h('div', { style: { fontWeight: '650' } }, e.text),
            e.code === 'kyc' ? h('button.btn.btn-xs.btn-primary', { style: { marginTop: '7px' }, onClick: () => { api.close(); navigate('profile'); } }, 'Пройти KYC') : null,
          ),
        )),
      ) : null,
    );
  }

  function renderFoot(offer, ctx, pf) {
    const sym = FIAT[offer.fiat]?.sym || '';
    return [
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div.t-xs.t-muted', 'К списанию'),
        h('div.mono', { style: { fontSize: '16px', fontWeight: '700' } }, `${fmt0(ctx.totalFiat)} ${sym}`),
      ),
      h('button.btn', {
        class: offer.side === 'buy' ? 'btn-buy' : 'btn-sell',
        style: { flex: '0 0 auto', minWidth: '150px' },
        disabled: !pf.ok,
        onClick: async () => {
          if (state.settings.confirmDeals) {
            const ok = await confirmSheet({
              title: offer.side === 'buy' ? 'Подтвердить закупку' : 'Подтвердить продажу',
              message: `${fmtN(ctx.fillable, 2)} ${offer.asset} по ${fmtN(offer.price, 2)} ${sym} у ${offer.merchant.name} (${EX[offer.exchange]?.name}). Списание ${fmt0(ctx.totalFiat)} ${sym} · ${PM[method]?.name}. AI-скор ${ctx.score}/100.`,
              confirmLabel: offer.side === 'buy' ? 'Закупить' : 'Продать',
            });
            if (!ok) return;
          }
          haptic('success');
          const deal = execute(offer, volume, cardId, method);
          if (deal) { api.close(); openDealSheet(deal); }
        },
      }, icon('zap'), offer.side === 'buy' ? 'Закупить' : 'Продать'),
    ];
  }

  draw();
  return api;
}

function kvRow(k, v, cls = '') {
  return h('div.kv', h('dt', k), h(`dd${cls ? '.' + cls : ''}`, v));
}

  __x.openOfferSheet = openOfferSheet;
};

__m["src/ui/filterSheet.js"] = function (__x, __req) {
/** Фильтры стакана. */
const { h, icon } = __req("src/core/dom.js");
const { openSheet } = __req("src/ui/sheet.js");
const { state, set, PAY_METHODS } = __req("src/core/store.js");
const { EXCHANGES, methodsFor } = __req("src/data/exchanges.js");
const { resubscribe } = __req("src/services/feed.js");
const { toast } = __req("src/ui/toast.js");
const SORTS = [
  { id: 'price',      label: 'Лучшая цена' },
  { id: 'score',      label: 'AI-скор' },
  { id: 'available',  label: 'Ликвидность' },
  { id: 'completion', label: 'Исполнение' },
  { id: 'orders',     label: 'Опыт мерчанта' },
  { id: 'speed',      label: 'Скорость' },
];

function activeFilterCount() {
  const f = state.filters;
  const d = {
    methods: 0, priceMin: null, priceMax: null, amountMin: null, amountMax: null,
    minCompletion: 90, minOrders: 50, verifiedOnly: false, proOnly: false,
    onlineOnly: true, hideBlocked: true, fitsVolume: true, sort: 'price',
  };
  let n = 0;
  if (f.methods.length) n++;
  if (f.priceMin != null || f.priceMax != null) n++;
  if (f.amountMin != null || f.amountMax != null) n++;
  if (f.minCompletion !== d.minCompletion) n++;
  if (f.minOrders !== d.minOrders) n++;
  if (f.verifiedOnly) n++;
  if (f.proOnly) n++;
  if (!f.onlineOnly) n++;
  if (!f.hideBlocked) n++;
  if (!f.fitsVolume) n++;
  if (f.sort !== d.sort) n++;
  if (f.exchanges.length !== EXCHANGES.length) n++;
  return n;
}

function openFilterSheet(onApply) {
  const draft = JSON.parse(JSON.stringify(state.filters));
  const pool = methodsFor(draft.fiat);

  const numField = (label, key, hint) => {
    const input = h('input.input.num', {
      type: 'text', inputmode: 'decimal', placeholder: '—',
      value: draft[key] ?? '',
      onInput: (e) => { const n = Number(e.target.value.replace(',', '.')); draft[key] = Number.isFinite(n) && e.target.value !== '' ? n : null; },
    });
    return h('label.field', h('span.label', label, hint ? h('span.hint', hint) : null), input);
  };

  const switchRow = (title, sub, key) => {
    const sw = h('button.switch', { role: 'switch', 'aria-checked': String(Boolean(draft[key])) });
    sw.addEventListener('click', () => { draft[key] = !draft[key]; sw.setAttribute('aria-checked', String(draft[key])); });
    return h('div.switch-row', h('div.sr-main', h('div.sr-title', title), sub ? h('div.sr-sub', sub) : null), sw);
  };

  const sliderRow = (label, key, min, max, step, unit) => {
    const out = h('span.mono.t-sm.t-acid', `${draft[key]}${unit}`);
    const sl = h('input.slider', {
      type: 'range', min, max, step, value: draft[key],
      style: { '--fill': `${((draft[key] - min) / (max - min)) * 100}%` },
      onInput: (e) => {
        draft[key] = Number(e.target.value);
        out.textContent = `${draft[key]}${unit}`;
        e.target.style.setProperty('--fill', `${((draft[key] - min) / (max - min)) * 100}%`);
      },
    });
    return h('div.field', h('span.label', label, h('span.hint', out)), sl);
  };

  const exChips = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px' } },
    EXCHANGES.map((ex) => {
      const btn = h('button.check', { 'aria-checked': String(draft.exchanges.includes(ex.id)) },
        h('span.box', icon('check', { sw: 3 })),
        h('span', { style: { flex: '1' } }, ex.name),
        h('i', { style: { width: '7px', height: '7px', borderRadius: '50%', background: ex.tint } }),
      );
      btn.addEventListener('click', () => {
        const i = draft.exchanges.indexOf(ex.id);
        if (i > -1) draft.exchanges.splice(i, 1); else draft.exchanges.push(ex.id);
        btn.setAttribute('aria-checked', String(draft.exchanges.includes(ex.id)));
      });
      return btn;
    }),
  );

  const pmChips = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px' } },
    pool.map((mid) => {
      const pm = PAY_METHODS.find((m) => m.id === mid);
      if (!pm) return null;
      const btn = h('button.check', { 'aria-checked': String(draft.methods.includes(mid)) },
        h('span.box', icon('check', { sw: 3 })),
        h('span', { style: { flex: '1' } }, pm.name),
        h('span.t-xs.t-muted.mono', `${(pm.risk * 100).toFixed(0)}%`),
      );
      btn.addEventListener('click', () => {
        const i = draft.methods.indexOf(mid);
        if (i > -1) draft.methods.splice(i, 1); else draft.methods.push(mid);
        btn.setAttribute('aria-checked', String(draft.methods.includes(mid)));
      });
      return btn;
    }),
  );

  const sortSeg = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px' } },
    SORTS.map((s) => {
      const btn = h('button.check', { 'aria-checked': String(draft.sort === s.id) },
        h('span.box', icon('check', { sw: 3 })), h('span', s.label));
      btn.addEventListener('click', () => {
        draft.sort = s.id;
        for (const el of sortSeg.children) el.setAttribute('aria-checked', 'false');
        btn.setAttribute('aria-checked', 'true');
      });
      return btn;
    }),
  );

  const api = openSheet({
    title: 'Фильтры стакана',
    subtitle: `${draft.asset}/${draft.fiat} · ${draft.side === 'buy' ? 'покупка' : 'продажа'}`,
    body: h('div',
      h('div.section-title', { style: { marginTop: '0' } }, h('span.eyebrow', 'Сортировка'), h('i.rule')),
      sortSeg,

      h('div.section-title', h('span.eyebrow', 'Биржи'), h('i.rule'),
        h('button.btn.btn-xs.btn-ghost', {
          onClick: () => {
            const all = draft.exchanges.length === EXCHANGES.length;
            draft.exchanges = all ? ['binance', 'bybit'] : EXCHANGES.map((e) => e.id);
            for (const el of exChips.children) {
              const name = el.querySelector('span:nth-of-type(2)').textContent;
              const ex = EXCHANGES.find((e) => e.name === name);
              el.setAttribute('aria-checked', String(draft.exchanges.includes(ex.id)));
            }
          },
        }, 'Все / топ-2')),
      exChips,

      h('div.section-title', h('span.eyebrow', 'Цена'), h('i.rule')),
      h('div.grid-2', numField('Мин. цена', 'priceMin', draft.fiat), numField('Макс. цена', 'priceMax', draft.fiat)),

      h('div.section-title', h('span.eyebrow', 'Объём офера'), h('i.rule')),
      h('div.grid-2', numField('Мин. доступно', 'amountMin', draft.asset), numField('Макс. доступно', 'amountMax', draft.asset)),

      h('div.section-title', h('span.eyebrow', 'Мерчант'), h('i.rule')),
      h('div.panel.panel-body',
        sliderRow('Мин. процент исполнения', 'minCompletion', 70, 100, 1, '%'),
        sliderRow('Мин. число сделок', 'minOrders', 0, 2000, 50, ''),
      ),
      h('div.panel', { style: { marginTop: '10px' } },
        switchRow('Только verified', 'Мерчанты с подтверждённой личностью', 'verifiedOnly'),
        switchRow('Только PRO', 'Профессиональные мерчанты биржи', 'proOnly'),
        switchRow('Только онлайн', 'Скрыть мерчантов не в сети', 'onlineOnly'),
        switchRow('Скрыть блоклист', 'Мерчанты с жалобами и блокировками', 'hideBlocked'),
        switchRow('Проходит мой объём', `Лимиты офера вмещают ${state.settings.volume} USDT`, 'fitsVolume'),
      ),

      h('div.section-title', h('span.eyebrow', 'Способы оплаты'), h('i.rule')),
      pmChips,
      h('div.t-xs.t-muted', { style: { marginTop: '8px' } }, 'Проценты — оценка риска реквизита в AI-модели. Пусто = любые способы.'),
    ),
    foot: [
      h('button.btn.btn-ghost', {
        onClick: () => {
          set('filters', (f) => {
            Object.assign(f, {
              methods: [], priceMin: null, priceMax: null, amountMin: null, amountMax: null,
              minCompletion: 90, minOrders: 50, verifiedOnly: false, proOnly: false,
              onlineOnly: true, hideBlocked: true, fitsVolume: true, sort: 'price',
              exchanges: EXCHANGES.map((e) => e.id),
            });
          });
          toast('Фильтры сброшены', null, 'warn');
          api.close();
          onApply?.(true);
        },
      }, 'Сбросить'),
      h('button.btn.btn-primary', {
        onClick: () => {
          if (!draft.exchanges.length) return toast('Выберите хотя бы одну биржу', null, 'err');
          const exChanged = JSON.stringify(draft.exchanges.slice().sort()) !== JSON.stringify(state.filters.exchanges.slice().sort());
          set('filters', (f) => Object.assign(f, draft));
          api.close();
          if (exChanged) resubscribe();
          onApply?.(exChanged);
        },
      }, 'Применить'),
    ],
  });
}

  __x.activeFilterCount = activeFilterCount;
  __x.openFilterSheet = openFilterSheet;
  __x.SORTS = SORTS;
};

__m["src/screens/p2p.js"] = function (__x, __req) {
/**
 * P2P — агрегированные стаканы всех бирж в одной вкладке.
 * Сюда «переехали» все ордербуки (Binance, Bybit, OKX, Bitget, HTX, KuCoin, MEXC, Gate).
 *
 * Книга обновляется по месту (keyed reconciliation) и пересортировывается
 * не чаще REORDER_MS — иначе строка «уезжает» из-под пальца в момент тапа.
 */
const { h, icon, mount, sparkline, clear } = __req("src/core/dom.js");
const { state, set, on, PAY_METHODS } = __req("src/core/store.js");
const { fmtN, fmt0, compact, hhmmss } = __req("src/core/format.js");
const { EXCHANGES, EX, ASSETS, FIAT } = __req("src/data/exchanges.js");
const { regionChip, openRegionSheet } = __req("src/ui/regionSheet.js");
const { analyze, buildPlan, usdtToAsset } = __req("src/services/analysis.js");
const { resubscribe, recomputeMarket } = __req("src/services/feed.js");
const { clearLogs, exportLogs } = __req("src/services/logs.js");
const { openOfferSheet } = __req("src/ui/offerSheet.js");
const { openFilterSheet, activeFilterCount, SORTS } = __req("src/ui/filterSheet.js");
const { openSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
const { haptic } = __req("src/services/telegram.js");
const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));
const REORDER_MS = 1100;   // как часто разрешено менять порядок строк
const MAX_ROWS = 60;

const LOG_LEVELS = [
  { id: 'info', label: 'info' }, { id: 'up', label: 'рост' }, { id: 'down', label: 'падение' },
  { id: 'new', label: 'новые' }, { id: 'gone', label: 'снятые' }, { id: 'warn', label: 'warn' },
  { id: 'alert', label: 'алерты' }, { id: 'trade', label: 'сделки' },
];

/* ============================ selector ============================ */

function visibleOffers() {
  const f = state.filters;
  const needAsset = usdtToAsset(state.settings.volume, f.asset, f.fiat);

  const list = Object.values(state.offers).filter((o) => {
    if (o.asset !== f.asset || o.fiat !== f.fiat || o.side !== f.side) return false;
    if (!f.exchanges.includes(o.exchange)) return false;
    if (f.hideBlocked && o.merchant.blocked) return false;
    if (f.onlineOnly && !o.merchant.online) return false;
    if (f.verifiedOnly && !o.merchant.verified) return false;
    if (f.proOnly && !o.merchant.pro) return false;
    if (o.merchant.completion * 100 < f.minCompletion) return false;
    if (o.merchant.orders < f.minOrders) return false;
    if (f.priceMin != null && o.price < f.priceMin) return false;
    if (f.priceMax != null && o.price > f.priceMax) return false;
    if (f.amountMin != null && o.available < f.amountMin) return false;
    if (f.amountMax != null && o.available > f.amountMax) return false;
    if (f.methods.length && !o.methods.some((m) => f.methods.includes(m))) return false;
    if (f.fitsVolume && (needAsset * o.price < o.min || o.available < needAsset * 0.25)) return false;
    return true;
  });

  const byPrice = (a, b) => (f.side === 'buy' ? a.price - b.price : b.price - a.price);
  const cmp = {
    price: byPrice,
    available: (a, b) => b.available - a.available,
    completion: (a, b) => b.merchant.completion - a.merchant.completion,
    orders: (a, b) => b.merchant.orders - a.merchant.orders,
    speed: (a, b) => a.merchant.avgReleaseMin - b.merchant.avgReleaseMin,
    score: (a, b) => analyze(b, state.settings.volume).score - analyze(a, state.settings.volume).score,
  }[f.sort] || byPrice;

  return list.sort(cmp);
}

/* ============================ screen ============================ */

function P2PScreen({ slot }) {
  const unsubs = [];
  const root = h('div.stagger');

  /* ---- static hosts ---- */
  const headSlot = h('div');
  const wiresSlot = h('div.chips');
  const volSlot = h('div');
  const planSlot = h('div');
  const bookBody = h('div');
  const bookCount = h('span', 'Мерчант');
  const logStream = h('div.log-stream', { role: 'log' });
  const logBarSlot = h('div.console-bar');
  const sortLabel = h('span', SORTS.find((s) => s.id === state.filters.sort)?.label || 'Цена');

  /* ---- поиск по стакану (подсветка совпадений) ---- */
  let searchTerm = '';                 // всегда в нижнем регистре
  const searchCount = h('span.t-xs.mono.t-muted');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Экранированный HTML с обёрнутыми <mark> совпадениями. term уже в нижнем регистре. */
  function hlHTML(text, term) {
    const t = String(text);
    const low = t.toLowerCase();
    let i = 0, out = '', idx;
    while ((idx = low.indexOf(term, i)) !== -1) {
      out += esc(t.slice(i, idx)) + '<mark class="hl">' + esc(t.slice(idx, idx + term.length)) + '</mark>';
      i = idx + term.length;
      if (term.length === 0) break;    // страховка
    }
    return out + esc(t.slice(i));
  }

  /**
   * Пишет текст в узел: быстрый textContent, либо innerHTML с подсветкой.
   * Безопасно по XSS — текст всегда экранируется, в разметку уходят только <mark>.
   */
  function setHL(el, text) {
    text = String(text);
    if (el._text === text && el._hlTerm === searchTerm) return;
    el._text = text; el._hlTerm = searchTerm;
    if (searchTerm && text.toLowerCase().includes(searchTerm)) el.innerHTML = hlHTML(text, searchTerm);
    else el.textContent = text;
  }

  /* ---- topbar: индикатор активного потока ---- */
  slot.append(h('span.badge.badge-buy', { style: { gap: '5px' } },
    h('i', { style: { width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 8px currentColor' }, class: 'pulse' }),
    'онлайн',
  ));

  /* ===================== header (built once, patched after) ===================== */

  const hRefs = {};

  function buildHead() {
    const f = state.filters;
    hRefs.assetSel = h('select.select', {
      style: { flex: '1.2' }, 'aria-label': 'Актив',
      onChange: (e) => { set('filters', (x) => { x.asset = e.target.value; }); switchMarket(); },
    }, ASSETS.map((a) => h('option', { value: a.id, selected: a.id === f.asset }, `${a.id} · ${a.name}`)));

    hRefs.regionChip = regionChip(() => openRegionSheet({ onPick: () => switchMarket() }));

    hRefs.buyBtn = h('button', {
      'data-side': 'buy', 'aria-pressed': String(f.side === 'buy'),
      onClick: () => { if (state.filters.side === 'buy') return; haptic('select'); set('filters', (x) => { x.side = 'buy'; }); switchMarket(); },
    }, 'Покупка');
    hRefs.sellBtn = h('button', {
      'data-side': 'sell', 'aria-pressed': String(f.side === 'sell'),
      onClick: () => { if (state.filters.side === 'sell') return; haptic('select'); set('filters', (x) => { x.side = 'sell'; }); switchMarket(); },
    }, 'Продажа');

    hRefs.medianEl = h('span', '—');
    hRefs.medianCur = h('span.t-xs.t-muted', { style: { marginLeft: '4px' } }, FIAT[f.fiat]?.sym || '');
    hRefs.bestEl = h('div.mono', { style: { fontSize: '16px', fontWeight: '700', color: 'var(--acid)' } }, '—');
    hRefs.spreadEl = h('div.mono', { style: { fontSize: '16px', fontWeight: '700' } }, '—');
    hRefs.sparkHost = h('div', { style: { marginLeft: 'auto', width: '74px', height: '34px' } });

    mount(headSlot,
      h('div.panel.panel-body',
        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, hRefs.assetSel, hRefs.regionChip),
        h('div.seg.seg-sides', hRefs.buyBtn, hRefs.sellBtn),
        h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '14px', marginTop: '12px' } },
          h('div',
            h('div.eyebrow', 'медиана рынка'),
            h('div.mono', { style: { fontSize: '20px', fontWeight: '700', letterSpacing: '-.03em' } }, hRefs.medianEl, hRefs.medianCur),
          ),
          h('div', h('div.eyebrow', 'лучшая'), hRefs.bestEl),
          h('div', h('div.eyebrow', 'спред'), hRefs.spreadEl),
          hRefs.sparkHost,
        ),
      ),
    );
    updateHead();
  }

  function updateHead() {
    if (!hRefs.medianEl) return;
    const f = state.filters;
    const m = state.market;
    const spread = m.median && m.best ? Math.abs((m.median - m.best) / m.median) * 100 : 0;
    hRefs.medianEl.textContent = m.median ? fmtN(m.median, 2) : '—';
    hRefs.medianCur.textContent = FIAT[f.fiat]?.sym || '';
    hRefs.bestEl.textContent = m.best ? fmtN(m.best, 2) : '—';
    hRefs.spreadEl.textContent = `${spread.toFixed(2)}%`;
    hRefs.spreadEl.style.color = spread > 1 ? 'var(--buy)' : 'var(--ink-2)';
    hRefs.buyBtn.setAttribute('aria-pressed', String(f.side === 'buy'));
    hRefs.sellBtn.setAttribute('aria-pressed', String(f.side === 'sell'));
    hRefs.buyBtn.textContent = 'Покупка ' + f.asset;
    hRefs.sellBtn.textContent = 'Продажа ' + f.asset;
    if (m.history.length > 2) {
      const trend = m.history[m.history.length - 1] - m.history[0];
      mount(hRefs.sparkHost, sparkline(m.history, trend >= 0 ? 'var(--buy)' : 'var(--sell)'));
    }
  }

  /** Market pair / side changed: clear the book and resubscribe. */
  function switchMarket() {
    rows.clear();
    clear(bookBody);
    buildHead();            // пересобрать шапку: чип региона и валютные подписи
    resubscribe();
    renderVol();
    renderPlan();
    renderBook(true);
  }

  /* ===================== exchange wires (patched in place) ===================== */

  const wRefs = new Map();

  function buildWires() {
    clear(wiresSlot);
    wRefs.clear();
    for (const ex of EXCHANGES) {
      const led = h('i.wire-led');
      const count = h('span.t-xs.mono.t-muted');
      const chip = h('button.chip', {
        onClick: () => {
          set('filters', (x) => {
            const i = x.exchanges.indexOf(ex.id);
            if (i > -1) { if (x.exchanges.length === 1) return; x.exchanges.splice(i, 1); }
            else x.exchanges.push(ex.id);
          });
          haptic('select');
          rows.clear(); clear(bookBody);
          resubscribe();
          updateWires(); renderBook(true); renderPlan();
        },
      }, led, ex.name, count);
      wRefs.set(ex.id, { chip, led, count });
      wiresSlot.append(chip);
    }
    updateWires();
  }

  function updateWires() {
    const f = state.filters;
    const counts = {};
    for (const o of Object.values(state.offers)) counts[o.exchange] = (counts[o.exchange] || 0) + 1;
    for (const ex of EXCHANGES) {
      const r = wRefs.get(ex.id);
      if (!r) continue;
      const enabled = f.exchanges.includes(ex.id);
      const w = state.wires[ex.id];
      r.chip.setAttribute('aria-pressed', String(enabled));
      r.led.className = 'wire-led ' + (!enabled ? '' : w?.state === 'live' ? 'live' : w?.state === 'connecting' ? 'conn' : 'down');
      r.count.textContent = enabled && counts[ex.id] ? String(counts[ex.id]) : '';
    }
  }

  /* ===================== volume ===================== */

  let volMeta = null;

  function renderVol() {
    const f = state.filters;
    const input = h('input', {
      type: 'text', inputmode: 'decimal', value: String(state.settings.volume), 'aria-label': 'Объём закупки в USDT',
      onInput: (e) => {
        const n = Number(e.target.value.replace(',', '.'));
        clearTimeout(input._t);
        input._t = setTimeout(() => {
          set('settings', (s) => { s.volume = Number.isFinite(n) && n >= 0 ? n : 0; });
          updateVolMeta(); renderPlan(); renderBook(true);
        }, 420);
      },
    });
    volMeta = h('div.t-xs.t-muted.mono', { style: { marginTop: '8px' } });

    const setVol = (q) => {
      set('settings', (s) => { s.volume = q; });
      input.value = String(q);
      for (const c of quickRow.children) c.setAttribute('aria-pressed', String(Number(c.dataset.v) === q));
      updateVolMeta(); renderPlan(); renderBook(true);
    };

    const quickRow = h('div.vol-quick',
      [1000, 5000, 10000, 25000, 50000].map((q) => h('button.chip', {
        dataset: { v: q }, 'aria-pressed': String(state.settings.volume === q), onClick: () => setVol(q),
      }, compact(q))),
    );

    mount(volSlot,
      h('div.panel',
        h('div.panel-head',
          h('span.eyebrow', 'Объём закупки'),
          h('button.btn.btn-xs.btn-ghost', { onClick: () => openFilterSheet(() => afterFilters()) },
            icon('filter'), `Фильтры${activeFilterCount() ? ' · ' + activeFilterCount() : ''}`),
        ),
        h('div.vol-wrap',
          h('div.vol-input', h('img', { src: 'data:image/png;base64,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', alt: '' }), input, h('span.vc', 'USDT')),
          quickRow,
          h('div.vol-quick', { style: { marginTop: '6px' } },
            h('button.chip', {
              style: { flex: '1' },
              onClick: () => {
                const card = state.cards.filter((c) => c.active).sort((a, b) => b.balance - a.balance)[0];
                const px = state.market.median || 0;
                if (!card || !px) return toast('Нет данных для расчёта', card ? 'Ждём котировки' : 'Нет активных карт', 'warn');
                const q = Math.max(0, Math.floor(Math.min(card.balance / px, state.settings.maxPerDeal)));
                setVol(q);
                toast('Объём по балансу карты', `${card.label} → ${fmt0(q)} USDT`, 'ok');
              },
            }, icon('card'), 'Макс. по карте'),
            h('button.chip', {
              style: { flex: '1' },
              onClick: () => setVol(Math.floor(state.balance.usdt)),
            }, icon('wallet'), 'Весь баланс'),
          ),
          volMeta,
        ),
      ),
    );
    updateVolMeta();
  }

  function updateVolMeta() {
    if (!volMeta) return;
    const f = state.filters;
    const vol = state.settings.volume;
    const amt = usdtToAsset(vol, f.asset, f.fiat);
    volMeta.textContent = `${fmtN(amt, f.asset === 'USDT' ? 2 : 6)} ${f.asset} · ≈ ${fmt0(amt * (state.market.median || 0))} ${FIAT[f.fiat]?.sym || ''} · лимит на сделку ${compact(state.settings.maxPerDeal)}`;
  }

  function afterFilters() {
    rows.clear(); clear(bookBody);
    sortLabel.textContent = SORTS.find((s) => s.id === state.filters.sort)?.label || 'Цена';
    updateWires(); renderVol(); renderPlan(); renderBook(true);
  }

  /* ===================== execution plan ===================== */

  function renderPlan() {
    const list = visibleOffers();
    if (!list.length) return clear(planSlot);
    const plan = buildPlan(list, state.settings.volume);
    const f = state.filters;
    const sym = FIAT[f.fiat]?.sym || '';
    const covPct = plan.coverage * 100;

    mount(planSlot,
      h('div.panel',
        h('div.panel-head',
          h('span.ai-badge', icon('cpu'), 'ai план исполнения'),
          h('span.t-xs.t-muted.mono', { style: { marginLeft: 'auto' } }, `${plan.legs.length} офер(ов)`),
        ),
        h('div.panel-body.tight',
          h('dl',
            kv('VWAP по объёму', `${fmtN(plan.vwap, 3)} ${sym}`, 't-acid'),
            kv('Покрытие объёма', `${covPct.toFixed(1)}%`, covPct >= 99 ? 't-buy' : covPct > 60 ? 't-warn' : 't-sell'),
            kv('Слиппедж к лучшей цене', `${plan.slippagePct.toFixed(3)}%`, plan.slippagePct > state.settings.slippageTol ? 't-sell' : 't-buy'),
            kv('Сумма фиатом', `${fmt0(plan.fiatTotal)} ${sym}`),
          ),
          h('div.meter', { style: { marginTop: '8px' } },
            h('i', { class: covPct >= 99 ? 'buy' : covPct > 60 ? 'warn' : 'sell', style: { width: `${Math.min(100, covPct)}%` } })),
          plan.legs.length > 1 ? h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            plan.legs.map((l) => h('div', { style: { display: 'flex', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--ink-3)' } },
              h('span', { style: { color: EX[l.offer.exchange]?.tint, fontWeight: '700' } }, EX[l.offer.exchange]?.tag),
              h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, l.offer.merchant.name),
              h('span', fmtN(l.amount, 2)),
              h('span', { style: { color: 'var(--ink)' } }, fmtN(l.offer.price, 2)),
            )),
          ) : null,
          plan.left > 0.01 ? h('div.note.warn', { style: { marginTop: '10px' } }, icon('alert'),
            `Не хватает ликвидности на ${fmtN(plan.left, 2)} ${f.asset} — ослабьте фильтры или уменьшите объём.`) : null,
        ),
      ),
    );
  }

  const kv = (k, v, cls = '') => h('div.kv', h('dt', k), h(`dd${cls ? '.' + cls : ''}`, v));

  /* ===================== order book (keyed, patched in place) ===================== */

  const rows = new Map();     // offerId -> { el, refs }
  let lastOrder = [];
  let lastReorder = 0;
  let emptyEl = null;
  let bestRankMap = new Map();   // offerId -> 0|1|2 (лучшие стаканы)

  /** Лёгкая оценка качества офера: цена + репутация + ликвидность. */
  function quickScore(o) {
    const med = state.market.median;
    const dev = med ? (state.filters.side === 'buy' ? (med - o.price) / med : (o.price - med) / med) : 0;
    const need = usdtToAsset(state.settings.volume, state.filters.asset, state.filters.fiat) || 1;
    const rep = o.merchant.completion * 0.6 + Math.min(1, o.merchant.orders / 3000) * 0.4;
    const liq = Math.min(1, o.available / need);
    return dev * 55 + rep * 28 + liq * 17 + (o.merchant.online ? 4 : 0) + (o.merchant.verified ? 3 : 0);
  }

  function buildRow(o) {
    const ex = EX[o.exchange];
    const refs = {};
    refs.name = h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, o.merchant.name);
    refs.verified = h('span');
    refs.pro = h('span');
    refs.onlineDot = h('i', { style: { width: '5px', height: '5px', borderRadius: '50%' } });
    refs.orders = h('span');
    refs.completion = h('span');
    refs.release = h('span');
    refs.kyc = h('span');
    refs.methods = h('div.of-methods');
    refs.price = h('div.p');
    refs.dev = h('div.pd');
    refs.avail = h('div.av');
    refs.limits = h('div.lm');
    refs.best = h('span.of-best');     // метка лучшего стакана

    const el = h('button.offer', {
      dataset: { id: o.id },
      style: { '--ex-c': ex?.tint || 'var(--panel-3)' },
      onClick: () => {
        set('ui', (u) => { u.pickedOffer = o.id; });
        haptic('light');
        for (const [id, r] of rows) r.el.classList.toggle('is-picked', id === o.id);
        openOfferSheet(o.id);
      },
    },
      h('div.of-merchant',
        h('div.of-name', h('span.ex-tag', ex?.tag || o.exchange), refs.name, refs.verified, refs.pro, refs.best),
        h('div.of-sub', refs.onlineDot, refs.orders, h('span.sep', '·'), refs.completion, h('span.sep', '·'), refs.release, refs.kyc),
        refs.methods,
      ),
      h('div.of-price', refs.price, refs.dev),
      h('div.of-lim', refs.avail, refs.limits),
    );

    const entry = { el, refs, lastPrice: o.price, lastMethods: '' };
    rows.set(o.id, entry);
    patchRow(entry, o, 1);
    return entry;
  }

  function patchRow(entry, o, maxAvail) {
    const { refs } = entry;
    const m = o.merchant;
    const med = state.market.median;
    const dev = med ? ((o.price - med) / med) * 100 : 0;
    const favourable = state.filters.side === 'buy' ? -dev : dev;

    setHL(refs.name, m.name);

    const wantVerified = m.verified ? 'v' : '';
    if (refs.verified.dataset.s !== wantVerified) {
      refs.verified.dataset.s = wantVerified;
      mount(refs.verified, m.verified ? icon('shieldCheck', { class: 'of-verified' }) : null);
    }
    const wantPro = m.pro ? 'p' : '';
    if (refs.pro.dataset.s !== wantPro) {
      refs.pro.dataset.s = wantPro;
      mount(refs.pro, m.pro ? h('span.badge.badge-acid', { style: { height: '15px', fontSize: '8.5px' } }, 'pro') : null);
    }

    refs.onlineDot.style.background = m.online ? 'var(--buy)' : 'var(--ink-4)';
    setHL(refs.orders, String(m.orders));
    setHL(refs.completion, `${(m.completion * 100).toFixed(1)}%`);
    setHL(refs.release, `${m.avgReleaseMin}м`);

    const needKyc = (o.kycRequired || 0) > state.kyc.level;
    const wantKyc = needKyc ? `k${o.kycRequired}` : '';
    if (refs.kyc.dataset.s !== wantKyc) {
      refs.kyc.dataset.s = wantKyc;
      mount(refs.kyc, needKyc ? h('span.badge.badge-warn', { style: { height: '15px', fontSize: '8.5px' } }, `kyc${o.kycRequired}`) : null);
    }

    const methodsKey = state.settings.compactRows ? '' : o.methods.slice(0, 3).join(',');
    if (entry.lastMethods !== methodsKey) {
      entry.lastMethods = methodsKey;
      mount(refs.methods, methodsKey ? o.methods.slice(0, 3).map((mid) => h('span.pm', PM[mid]?.name || mid)) : null);
    }

    // метка лучших стаканов
    const rank = bestRankMap.get(o.id);
    const wantBest = rank === undefined ? '' : String(rank);
    if (refs.best.dataset.r !== wantBest) {
      refs.best.dataset.r = wantBest;
      mount(refs.best, rank === 0 ? h('span.best-tag.top1', '★ Лучшая')
        : rank !== undefined ? h('span.best-tag', 'ТОП') : null);
    }
    entry.el.classList.toggle('is-best', rank !== undefined);
    entry.el.classList.toggle('is-best1', rank === 0);

    setHL(refs.price, fmtN(o.price, 2));
    setHL(refs.dev, `${dev > 0 ? '+' : ''}${dev.toFixed(2)}%`);
    refs.dev.style.color = favourable > 0 ? 'var(--buy)' : favourable < 0 ? 'var(--sell)' : 'var(--ink-4)';
    setHL(refs.avail, compact(o.available));
    setHL(refs.limits, `${compact(o.min)}–${compact(o.max)}`);

    entry.el.style.setProperty('--depth', `${Math.min(100, (o.available / (maxAvail || 1)) * 100)}%`);
    entry.el.style.setProperty('--depth-c', state.filters.side === 'buy' ? 'var(--buy-ghost)' : 'var(--sell-ghost)');
    entry.el.classList.toggle('is-picked', state.ui.pickedOffer === o.id);

    // price-change flash, without rebuilding the node
    if (Math.abs(o.price - entry.lastPrice) > 1e-9) {
      const cls = o.price > entry.lastPrice ? 'flash-up' : 'flash-dn';
      entry.el.classList.remove('flash-up', 'flash-dn');
      void entry.el.offsetWidth;   // restart the animation
      entry.el.classList.add(cls);
      entry.lastPrice = o.price;
    }
  }

  /** @param {boolean} force re-sort immediately (filters/volume/market changed) */
  /** Текст строки, по которому ищем (совпадает с подсвечиваемыми полями). */
  function offerHay(o) {
    const med = state.market.median;
    const dev = med ? ((o.price - med) / med) * 100 : 0;
    return [
      o.merchant.name, String(o.merchant.orders), `${(o.merchant.completion * 100).toFixed(1)}%`,
      `${o.merchant.avgReleaseMin}м`, fmtN(o.price, 2), `${dev > 0 ? '+' : ''}${dev.toFixed(2)}%`,
      compact(o.available), `${compact(o.min)}–${compact(o.max)}`,
    ].join(' ').toLowerCase();
  }

  function renderBook(force = false) {
    const list = visibleOffers().slice(0, MAX_ROWS);
    bookCount.textContent = `Мерчант · ${list.length} оферов`;

    // лучшие стаканы: топ-3 по качеству (цена + репутация + ликвидность)
    bestRankMap = new Map(
      [...list].sort((a, b) => quickScore(b) - quickScore(a)).slice(0, 3).map((o, i) => [o.id, i]),
    );

    if (searchTerm) {
      const n = list.reduce((a, o) => a + (offerHay(o).includes(searchTerm) ? 1 : 0), 0);
      searchCount.textContent = n ? `${n} совпад.` : 'нет совпадений';
      searchCount.classList.toggle('t-sell', !n);
    } else {
      searchCount.textContent = '';
      searchCount.classList.remove('t-sell');
    }

    if (!list.length) {
      rows.clear();
      if (!emptyEl) {
        emptyEl = h('div.empty',
          icon('filter'),
          h('div.et', 'Нет оферов под фильтры'),
          h('div.eb', 'Ослабьте условия, включите больше бирж или уменьшите объём'),
          h('button.btn.btn-sm.btn-ghost', { style: { marginTop: '12px' }, onClick: () => openFilterSheet(() => afterFilters()) }, icon('filter'), 'Открыть фильтры'),
        );
      }
      mount(bookBody, emptyEl);
      lastOrder = [];
      return;
    }
    if (emptyEl?.isConnected) { emptyEl.remove(); emptyEl = null; }

    const maxAvail = Math.max(...list.map((o) => o.available));
    const ids = list.map((o) => o.id);

    // patch existing / create new
    for (const o of list) {
      const entry = rows.get(o.id) || buildRow(o);
      patchRow(entry, o, maxAvail);
    }
    // drop rows that left the book
    const idSet = new Set(ids);
    for (const [id, entry] of rows) {
      if (idSet.has(id)) continue;
      entry.el.remove();
      rows.delete(id);
    }

    const setChanged = ids.length !== lastOrder.length || ids.some((id, i) => lastOrder[i] !== id);
    const mayReorder = force || Date.now() - lastReorder > REORDER_MS;

    if (setChanged && mayReorder) {
      // minimal DOM moves: append in target order (append of an existing node moves it)
      const frag = document.createDocumentFragment();
      for (const id of ids) frag.append(rows.get(id).el);
      bookBody.append(frag);
      lastOrder = ids;
      lastReorder = Date.now();
    } else if (!bookBody.firstChild) {
      for (const id of ids) bookBody.append(rows.get(id).el);
      lastOrder = ids;
      lastReorder = Date.now();
    } else {
      // make sure brand-new rows are at least attached, even if we skip the re-sort
      for (const id of ids) {
        const el = rows.get(id).el;
        if (!el.isConnected) bookBody.append(el);
      }
    }
  }

  let frame = null;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      renderBook();
      renderPlan();
      updateWires();
      updateHead();
      updateVolMeta();
    });
  }

  /* ===================== log console ===================== */

  function renderLogBar() {
    mount(logBarSlot,
      h('span.eyebrow', 'логи стаканов'),
      h('span.t-xs.mono.t-muted', `${state.logs.length}/${state.settings.maxLogs}`),
      h('button.btn.btn-xs.btn-ghost', {
        'aria-label': state.ui.logPaused ? 'Продолжить' : 'Пауза',
        onClick: () => { set('ui', (u) => { u.logPaused = !u.logPaused; }); renderLogBar(); if (!state.ui.logPaused) renderLogs(); },
      }, icon(state.ui.logPaused ? 'play' : 'pause')),
      h('button.btn.btn-xs.btn-ghost', { 'aria-label': 'Фильтр уровней', onClick: openLogFilter }, icon('filter')),
      h('button.btn.btn-xs.btn-ghost', { 'aria-label': 'Экспорт логов', onClick: downloadLogs }, icon('download')),
      h('button.btn.btn-xs.btn-ghost', { 'aria-label': 'Очистить', onClick: () => { clearLogs(); renderLogs(); renderLogBar(); } }, icon('trash')),
    );
  }

  function downloadLogs() {
    const blob = new Blob([exportLogs()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `p2p-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Логи выгружены', `${state.logs.length} записей · JSON`, 'ok');
  }

  function openLogFilter() {
    const draft = [...state.settings.logLevels];
    const api = openSheet({
      title: 'Уровни логов',
      subtitle: 'Что показывать в консоли событий',
      body: h('div.check-list', LOG_LEVELS.map((l) => {
        const btn = h('button.check', { 'aria-checked': String(draft.includes(l.id)) },
          h('span.box', icon('check', { sw: 3 })),
          h('span', { style: { flex: '1' } }, l.label),
          h('i', { class: `log-line lv-${l.id}`, style: { width: '3px', height: '14px', padding: '0', borderLeftWidth: '3px' } }),
        );
        btn.addEventListener('click', () => {
          const i = draft.indexOf(l.id);
          if (i > -1) draft.splice(i, 1); else draft.push(l.id);
          btn.setAttribute('aria-checked', String(draft.includes(l.id)));
        });
        return btn;
      })),
      foot: [h('button.btn.btn-primary.btn-block', {
        onClick: () => { set('settings', (s) => { s.logLevels = draft; }); renderLogs(); api.close(); },
      }, 'Применить')],
    });
  }

  // Сообщение лога может содержать подставленные сервером/мерчантом строки.
  // Экранируем всё, затем возвращаем только <b>/</b> — так имя мерчанта вида
  // "<img onerror=…>" станет безопасным текстом, а форматирование сохранится.
  const safeLogHTML = (s) => esc(s).replace(/&lt;(\/?)b&gt;/g, '<$1b>');

  // иконка по уровню события — вместо «командной строки» аккуратная лента
  const LVL_ICON = { info: 'info', up: 'up', down: 'down', new: 'plus', gone: 'minus', warn: 'alert', alert: 'zap', trade: 'check' };

  const logLine = (e) => h('div.log-line', { class: `lv-${e.level}` },
    h('span.log-ico', icon(LVL_ICON[e.level] || 'info')),
    e.exchange && EX[e.exchange]
      ? h('span.log-tag', { style: { '--tag': EX[e.exchange].tint } }, EX[e.exchange].name)
      : h('span.log-tag.sys', 'система'),
    h('span.log-msg', { html: safeLogHTML(e.message) }),
    h('time.log-ts', hhmmss(e.ts)),
  );

  function renderLogs() {
    const levels = state.settings.logLevels;
    mount(logStream, state.logs.filter((e) => levels.includes(e.level)).slice(-160).map(logLine));
    logStream.scrollTop = logStream.scrollHeight;
  }

  function appendLog(entry) {
    if (!entry || state.ui.logPaused) return;
    if (!state.settings.logLevels.includes(entry.level)) return;
    const atBottom = logStream.scrollHeight - logStream.scrollTop - logStream.clientHeight < 44;
    logStream.append(logLine(entry));
    while (logStream.children.length > 160) logStream.firstChild.remove();
    if (atBottom) logStream.scrollTop = logStream.scrollHeight;
    const counter = logBarSlot.children[1];
    if (counter) counter.textContent = `${state.logs.length}/${state.settings.maxLogs}`;
  }

  /* ===================== sort sheet ===================== */

  function openSortSheet() {
    const api = openSheet({
      title: 'Сортировка стакана',
      body: h('div.check-list', SORTS.map((s) => {
        const btn = h('button.check', { 'aria-checked': String(state.filters.sort === s.id) },
          h('span.box', icon('check', { sw: 3 })), h('span', s.label));
        btn.addEventListener('click', () => {
          set('filters', (f) => { f.sort = s.id; });
          sortLabel.textContent = s.label;
          api.close();
          renderBook(true);
        });
        return btn;
      })),
    });
  }

  /* ===================== search bar ===================== */

  function searchBar() {
    const input = h('input', {
      type: 'search', inputmode: 'search', enterkeyhint: 'search',
      'aria-label': 'Поиск по стакану', placeholder: 'Поиск по стакану: мерчант, цена, «3»…',
      maxlength: 32, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      onInput: (e) => {
        clearTimeout(input._t);
        input._t = setTimeout(() => {
          searchTerm = String(e.target.value).trim().toLowerCase().slice(0, 32);
          clearBtn.style.display = searchTerm ? '' : 'none';
          renderBook(true);
        }, 140);                    // дебаунс: защита UI от ввода-флуда
      },
    });
    const clearBtn = h('button.book-search-clear', {
      type: 'button', 'aria-label': 'Очистить поиск', style: { display: 'none' },
      onClick: () => {
        input.value = ''; searchTerm = '';
        clearBtn.style.display = 'none';
        renderBook(true); input.focus();
      },
    }, icon('x'));
    return h('div.book-search',
      icon('search', { class: 'book-search-ico' }),
      input,
      searchCount,
      clearBtn,
    );
  }

  /* ===================== wiring ===================== */

  // build first — subscriptions fire synchronously and must find live refs
  buildHead();
  buildWires();
  renderVol();
  recomputeMarket();
  renderPlan();
  renderBook(true);
  renderLogBar();
  renderLogs();

  unsubs.push(on('offers', schedule));
  unsubs.push(on('wires', updateWires));
  unsubs.push(on('market', () => { updateHead(); updateVolMeta(); }));
  unsubs.push(on('logs', (entry) => { if (entry) appendLog(entry); else renderLogs(); }));
  unsubs.push(on('kyc', () => renderBook(true)));

  root.append(
    h('div', { style: { '--i': 0 } }, headSlot),
    h('div', { style: { '--i': 1, marginTop: '10px' } }, wiresSlot),
    h('div', { style: { '--i': 2, marginTop: '10px' } }, volSlot),
    h('div', { style: { '--i': 3, marginTop: '10px' } }, planSlot),
    h('div.section-title', { style: { '--i': 4 } },
      h('span.eyebrow', 'Агрегированный стакан'),
      h('i.rule'),
      h('button.btn.btn-xs.btn-ghost', { onClick: openSortSheet }, icon('scale'), sortLabel),
    ),
    h('div', { style: { '--i': 5 } },
      h('div.panel.panel-flush.book',
        searchBar(),
        h('div.book-head', bookCount, h('span', `Цена`), h('span', 'Доступно')),
        bookBody,
      ),
    ),
    h('div.section-title', { style: { '--i': 6 } }, h('span.eyebrow', 'Поток событий'), h('i.rule')),
    h('div.console', { style: { '--i': 7 } }, logBarSlot, logStream),
    h('div.foot-note',
      'Стаканы нормализуются бэкендом в единый формат и стримятся по WebSocket.',
      h('br'),
      'Контракт: docs/ws-protocol.md',
    ),
  );

  return {
    node: root,
    destroy: () => { unsubs.forEach((u) => u()); if (frame) cancelAnimationFrame(frame); rows.clear(); },
  };
}

  __x.visibleOffers = visibleOffers;
  __x.P2PScreen = P2PScreen;
};

__m["src/screens/settings.js"] = function (__x, __req) {
/** Настройки — соединение, трейдинг, AI, биржи, уведомления, внешний вид, данные. */
const { h, icon, mount } = __req("src/core/dom.js");
const { state, set, on, resetAll, exportState, importState } = __req("src/core/store.js");
const { fmt0, compact } = __req("src/core/format.js");
const { EXCHANGES } = __req("src/data/exchanges.js");
const { WEIGHT_LABELS } = __req("src/services/analysis.js");
const { restartFeed } = __req("src/services/feed.js");
const { openSheet, confirmSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
function SettingsScreen() {
  const root = h('div.stagger');
  const unsubs = [];
  const aiSlot = h('div');
  const exSlot = h('div');

  /* ---------- helpers ---------- */

  const sw = (title, sub, key, onAfter) => {
    const btn = h('button.switch', { role: 'switch', 'aria-checked': String(Boolean(state.settings[key])) });
    btn.addEventListener('click', () => {
      set('settings', (s) => { s[key] = !s[key]; });
      btn.setAttribute('aria-checked', String(state.settings[key]));
      onAfter?.(state.settings[key]);
    });
    return h('div.switch-row', h('div.sr-main', h('div.sr-title', title), sub ? h('div.sr-sub', sub) : null), btn);
  };

  const num = (label, key, { hint, min = 0, step = 'any', onAfter } = {}) => {
    const input = h('input.input.num', {
      type: 'text', inputmode: 'decimal', value: String(state.settings[key]),
      onChange: (e) => {
        const n = Number(e.target.value.replace(',', '.'));
        if (!Number.isFinite(n) || n < min) { e.target.value = state.settings[key]; return toast('Некорректное значение', null, 'err'); }
        set('settings', (s) => { s[key] = n; });
        onAfter?.(n);
      },
    });
    return h('label.field', h('span.label', label, hint ? h('span.hint', hint) : null), input);
  };

  const slider = (label, key, min, max, step, unit, onAfter) => {
    const out = h('span.mono.t-sm.t-acid', `${state.settings[key]}${unit}`);
    const sl = h('input.slider', {
      type: 'range', min, max, step, value: state.settings[key],
      style: { '--fill': `${((state.settings[key] - min) / (max - min)) * 100}%` },
      onInput: (e) => {
        const v = Number(e.target.value);
        out.textContent = `${v}${unit}`;
        e.target.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
        set('settings', (s) => { s[key] = v; });
        onAfter?.(v);
      },
    });
    return h('div.field', h('span.label', label, h('span.hint', out)), sl);
  };

  const title = (text, i, aside) => h('div.section-title', { style: { '--i': i } }, h('span.eyebrow', text), h('i.rule'), aside || null);

  /* ---------- поток данных ---------- */

  const connection = h('div',
    h('div.panel.panel-body',
      h('div.grid-2',
        num('Скорость обновления, мс', 'throttleMs', { hint: '120–3000', min: 120, onAfter: () => restartFeed() }),
        num('Буфер логов', 'maxLogs', { hint: 'записей', min: 50 }),
      ),
    ),
    h('div.panel',
      h('button.row', { onClick: () => { restartFeed(); toast('Поток перезапущен', null, 'ok'); } },
        h('div.deal-ico', icon('refresh')),
        h('div.row-main', h('div.row-title', 'Перезапустить поток'), h('div.row-sub', 'Сброс стаканов и повторная подписка')),
        icon('chev', { class: 'row-chev' }),
      ),
    ),
  );

  /* ---------- trading ---------- */

  const trading = h('div',
    h('div.panel.panel-body',
      h('div.grid-2',
        num('Объём по умолч.', 'volume', { hint: 'USDT' }),
        num('Лимит на сделку', 'maxPerDeal', { hint: 'USDT' }),
      ),
      num('Дневной лимит', 'dayLimit', { hint: 'USDT' }),
      slider('Допустимый слиппедж', 'slippageTol', 0, 3, 0.05, '%'),
      slider('Мин. спред для сигнала', 'minSpread', 0, 5, 0.1, '%'),
      slider('Целевая маржа выхода', 'targetMargin', 0.1, 10, 0.1, '%'),
      slider('Комиссия биржи', 'exchangeFee', 0, 1, 0.01, '%'),
    ),
    h('div.panel',
      sw('Подтверждение сделок', 'Спрашивать перед отправкой ордера', 'confirmDeals'),
      sw('Авто-отказ по риску', 'AI блокирует оферы с вердиктом «высокий риск»', 'autoRejectRisky'),
    ),
  );

  /* ---------- AI ---------- */

  function renderAi() {
    const w = state.settings.weights;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    mount(aiSlot,
      h('div.panel.panel-body',
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' } },
          h('span.ai-badge', icon('cpu'), 'веса модели'),
          h('span.t-xs.t-muted.mono', { style: { marginLeft: 'auto' } }, `Σ ${sum}`),
        ),
        Object.keys(w).map((k) => {
          const out = h('span.mono.t-sm.t-acid', String(w[k]));
          return h('div.field',
            h('span.label', WEIGHT_LABELS[k] || k, h('span.hint', out)),
            h('input.slider', {
              type: 'range', min: 0, max: 50, step: 1, value: w[k],
              style: { '--fill': `${(w[k] / 50) * 100}%` },
              onInput: (e) => {
                const v = Number(e.target.value);
                out.textContent = String(v);
                e.target.style.setProperty('--fill', `${(v / 50) * 100}%`);
                set('settings', (s) => { s.weights[k] = v; });
              },
            }),
          );
        }),
        slider('Мин. уверенность вердикта', 'minConfidence', 0, 100, 1, '%'),
      ),
      h('div.panel',
        sw('AI-анализ контекста сделки', 'Вердикт, факторы риска и план исполнения', 'aiEnabled'),
        h('button.row', {
          onClick: () => {
            set('settings', (s) => { s.weights = { reputation: 25, price: 25, liquidity: 15, method: 15, speed: 10, exchange: 10 }; });
            renderAi();
            toast('Веса сброшены к базовым', null, 'ok');
          },
        },
          h('div.deal-ico', icon('refresh')),
          h('div.row-main', h('div.row-title', 'Сбросить веса'), h('div.row-sub', 'Вернуть профиль модели по умолчанию')),
          icon('chev', { class: 'row-chev' }),
        ),
      ),
    );
  }
  renderAi();

  /* ---------- exchanges ---------- */

  function renderExchanges() {
    mount(exSlot,
      h('div.panel.panel-flush',
        EXCHANGES.map((ex) => {
          const enabled = state.filters.exchanges.includes(ex.id);
          const hasKey = Boolean(state.settings.apiKeys[ex.id]);
          const btn = h('button.switch', { role: 'switch', 'aria-checked': String(enabled) });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            set('filters', (f) => {
              const i = f.exchanges.indexOf(ex.id);
              if (i > -1) { if (f.exchanges.length === 1) return toast('Нужна хотя бы одна биржа', null, 'warn'); f.exchanges.splice(i, 1); }
              else f.exchanges.push(ex.id);
            });
            renderExchanges();
          });
          return h('div.switch-row',
            h('div.pc-logo', { style: { background: ex.tint, flex: '0 0 auto' } }, ex.tag[0]),
            h('button.sr-main', { style: { textAlign: 'left' }, onClick: () => openKeySheet(ex) },
              h('div.sr-title', ex.name, hasKey ? h('span.badge.badge-buy', { style: { marginLeft: '6px' } }, 'key') : null),
              h('div.sr-sub.mono', { style: { fontSize: '10.5px' } }, `${(ex.reliability * 100).toFixed(0)}% uptime · ~${ex.baseLatency} ms`),
            ),
            btn,
          );
        }),
      ),
      h('div.note', { style: { marginTop: '10px' } }, icon('key'),
        'API-ключи хранятся только в localStorage этого устройства и используются для приватных запросов (лимиты, собственные объявления). Публичные стаканы читаются без ключей.'),
    );
  }
  renderExchanges();

  function openKeySheet(ex) {
    const cur = state.settings.apiKeys[ex.id] || { key: '', secret: '' };
    const keyIn = h('input.input.mono', { value: cur.key, placeholder: 'API key', spellcheck: 'false' });
    const secIn = h('input.input.mono', { value: cur.secret, placeholder: 'API secret', type: 'password' });
    const api = openSheet({
      title: `${ex.name} · API`,
      subtitle: ex.endpoint,
      body: h('div',
        h('label.field', h('span.label', 'Key'), keyIn),
        h('label.field', h('span.label', 'Secret'), secIn),
        h('div.note.warn', { style: { marginTop: '12px' } }, icon('alert'),
          'На проде ключи должны жить на бэкенде. Здесь поле есть для self-hosted сценария: мини-апп передаёт их только своему серверу по TLS.'),
      ),
      foot: [
        h('button.btn.btn-danger', {
          onClick: () => { set('settings', (s) => { delete s.apiKeys[ex.id]; }); renderExchanges(); api.close(); toast('Ключи удалены', ex.name, 'warn'); },
        }, icon('trash')),
        h('button.btn.btn-primary', {
          onClick: () => {
            if (!keyIn.value.trim()) return toast('Введите key', null, 'err');
            set('settings', (s) => { s.apiKeys[ex.id] = { key: keyIn.value.trim(), secret: secIn.value.trim() }; });
            renderExchanges(); api.close(); toast('Ключи сохранены', ex.name, 'ok');
          },
        }, 'Сохранить'),
      ],
    });
  }

  /* ---------- notifications ---------- */

  const notifications = h('div.panel',
    sw('Алерты по спреду', `Сигнал, когда спред к медиане выше порога`, 'notifySpread'),
    h('div.panel-body', slider('Порог спреда', 'notifySpreadPct', 0.2, 5, 0.1, '%')),
    sw('Новые мерчанты', 'Уведомлять о появлении новых оферов в стакане', 'notifyNewMerchant'),
    sw('Статусы сделок', 'Пуш при оплате, отпуске и завершении', 'notifyDealStatus'),
  );

  /* ---------- appearance ---------- */

  const themeSeg = h('div.seg',
    [['dark', 'Тёмная'], ['light', 'Светлая']].map(([v, label]) => h('button', {
      'aria-pressed': String(state.settings.theme === v),
      onClick: (e) => {
        set('settings', (s) => { s.theme = v; });
        document.documentElement.dataset.theme = v;
        document.querySelector('meta[name=theme-color]')?.setAttribute('content', v === 'light' ? '#ffffff' : '#0b0c0f');
        for (const b of e.target.parentNode.children) b.setAttribute('aria-pressed', 'false');
        e.target.setAttribute('aria-pressed', 'true');
      },
    }, label)),
  );

  const appearance = h('div',
    h('div.panel.panel-body', h('label.field', h('span.label', 'Тема'), themeSeg)),
    h('div.panel',
      sw('Компактные строки', 'Скрыть способы оплаты в стакане', 'compactRows'),
      sw('Скрывать баланс при входе', 'Баланс по умолчанию замылен', 'hideBalanceDefault'),
      sw('Виброотклик', 'Haptic feedback в Telegram', 'haptics'),
    ),
  );

  /* ---------- data ---------- */

  const data = h('div.panel.panel-flush',
    h('button.row', {
      onClick: () => {
        const blob = new Blob([exportState()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `p2p-light-config-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Конфигурация выгружена', 'JSON со настройками, картами и KYC', 'ok');
      },
    },
      h('div.deal-ico', icon('download')),
      h('div.row-main', h('div.row-title', 'Экспорт конфигурации'), h('div.row-sub', 'Настройки, карты, фильтры, KYC — в JSON')),
      icon('chev', { class: 'row-chev' }),
    ),
    h('button.row', { onClick: openImport },
      h('div.deal-ico', icon('upload')),
      h('div.row-main', h('div.row-title', 'Импорт конфигурации'), h('div.row-sub', 'Вставьте JSON из экспорта')),
      icon('chev', { class: 'row-chev' }),
    ),
    h('button.row', {
      onClick: async () => {
        if (await confirmSheet({
          title: 'Сбросить всё?',
          message: 'Будут удалены баланс, карты, настройки, KYC и история закупок. Действие необратимо.',
          confirmLabel: 'Сбросить', danger: true,
        })) resetAll();
      },
    },
      h('div.deal-ico', { style: { color: 'var(--sell)' } }, icon('trash')),
      h('div.row-main', h('div.row-title.t-sell', 'Сбросить данные'), h('div.row-sub', 'Полная очистка локального состояния')),
      icon('chev', { class: 'row-chev' }),
    ),
  );

  function openImport() {
    const ta = h('textarea.textarea', { placeholder: '{ "settings": { ... } }', rows: 8 });
    const api = openSheet({
      title: 'Импорт конфигурации',
      body: h('div', ta, h('div.note', { style: { marginTop: '10px' } }, icon('info'), 'Приложение перезагрузится после импорта.')),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Отмена'),
        h('button.btn.btn-primary', {
          onClick: () => {
            try { importState(ta.value); } catch { toast('Некорректный JSON', null, 'err'); }
          },
        }, 'Импортировать'),
      ],
    });
  }

  unsubs.push(on('settings', () => { /* persisted automatically */ }));

  root.append(
    title('Поток данных', 0, h('span.badge.badge-buy', 'онлайн')),
    h('div', { style: { '--i': 1 } }, connection),
    title('Трейдинг', 2),
    h('div', { style: { '--i': 3 } }, trading),
    title('AI-анализ', 4),
    h('div', { style: { '--i': 5 } }, aiSlot),
    title('Биржи', 6, h('span.t-xs.t-muted.mono', `${state.filters.exchanges.length}/${EXCHANGES.length}`)),
    h('div', { style: { '--i': 7 } }, exSlot),
    title('Уведомления', 8),
    h('div', { style: { '--i': 9 } }, notifications),
    title('Внешний вид', 10),
    h('div', { style: { '--i': 11 } }, appearance),
    title('Данные', 12),
    h('div', { style: { '--i': 13 } }, data),
    h('div.foot-note', `P2P Light · ${compact(Object.keys(state.offers).length)} оферов в потоке`),
  );

  return { node: root, destroy: () => unsubs.forEach((u) => u()) };
}

  __x.SettingsScreen = SettingsScreen;
};

__m["src/services/kyc.js"] = function (__x, __req) {
/** KYC state machine. Gates trading; levels raise the daily limit. */
const { state, set, KYC_LEVELS } = __req("src/core/store.js");
const { log } = __req("src/services/logs.js");
const { toast } = __req("src/ui/toast.js");
const STEP_ORDER = ['personal', 'document', 'selfie', 'address', 'company'];

const STEP_META = {
  personal: { title: 'Личные данные',   sub: 'ФИО, дата рождения, страна',            icon: 'user' },
  document: { title: 'Документ',        sub: 'Паспорт или ID + скан',                  icon: 'doc' },
  selfie:   { title: 'Селфи с документом', sub: 'Живая проверка лица',                 icon: 'camera' },
  address:  { title: 'Адрес',           sub: 'Подтверждение места проживания',         icon: 'globe' },
  company:  { title: 'Компания',        sub: 'Для корпоративного уровня (B2B)',        icon: 'users' },
};

/** Which steps a target level needs. */
const stepsFor = (level) => KYC_LEVELS[level]?.needs || [];

function validateStep(step, d) {
  const e = {};
  if (step === 'personal') {
    if (!d.firstName?.trim()) e.firstName = 'Укажите имя';
    if (!d.lastName?.trim()) e.lastName = 'Укажите фамилию';
    if (!d.birthDate) e.birthDate = 'Укажите дату рождения';
    else {
      const age = (Date.now() - new Date(d.birthDate)) / (365.25 * 864e5);
      if (age < 18) e.birthDate = 'Доступно с 18 лет';
      if (age > 120 || Number.isNaN(age)) e.birthDate = 'Некорректная дата';
    }
  }
  if (step === 'document') {
    if (!d.docNumber?.trim() || d.docNumber.replace(/\D/g, '').length < 6) e.docNumber = 'Некорректный номер документа';
    if (!d.docExpiry) e.docExpiry = 'Укажите срок действия';
    else if (new Date(d.docExpiry) < new Date()) e.docExpiry = 'Документ просрочен';
    if (!d.docScan) e.docScan = 'Загрузите скан документа';
  }
  if (step === 'selfie' && !d.selfie) e.selfie = 'Нужно селфи с документом';
  if (step === 'address') {
    if (!d.address?.trim()) e.address = 'Укажите адрес';
    if (!d.city?.trim()) e.city = 'Укажите город';
  }
  if (step === 'company') {
    if (!d.company?.trim()) e.company = 'Укажите название компании';
    if (!d.taxId?.trim()) e.taxId = 'Укажите ИНН / Tax ID';
  }
  return e;
}

function saveStep(step, patch) {
  set('kyc', (k) => {
    Object.assign(k.data, patch);
    const errs = validateStep(step, k.data);
    k.steps[step] = Object.keys(errs).length === 0;
    if (k.status === 'none') k.status = 'draft';
  });
  return state.kyc.steps[step];
}

function canSubmit(targetLevel) {
  return stepsFor(targetLevel).every((s) => state.kyc.steps[s]);
}

function submit(targetLevel) {
  if (!canSubmit(targetLevel)) {
    toast('Не хватает данных', 'Заполните все шаги уровня', 'err');
    return false;
  }
  set('kyc', (k) => {
    k.status = 'pending';
    k.submittedAt = Date.now();
    k.pendingLevel = targetLevel;
    k.rejectReason = null;
  });
  log('info', 'sys', `KYC заявка отправлена · уровень <b>${targetLevel}</b>`);
  toast('Заявка отправлена', 'Проверка занимает до 10 минут', 'ok');

  // the backend will emit the real decision; simulate the review here
  setTimeout(() => {
    if (state.kyc.status !== 'pending') return;
    const d = state.kyc.data;
    const suspicious = /test|тест|qwerty|0000/i.test(`${d.firstName}${d.lastName}${d.docNumber}`);
    if (suspicious) {
      set('kyc', (k) => { k.status = 'rejected'; k.reviewedAt = Date.now(); k.rejectReason = 'Данные не прошли автопроверку: подозрительные значения в полях'; });
      log('warn', 'sys', 'KYC <b>отклонён</b> автопроверкой');
      toast('KYC отклонён', state.kyc.rejectReason, 'err', 5200);
    } else {
      set('kyc', (k) => { k.status = 'approved'; k.level = targetLevel; k.reviewedAt = Date.now(); });
      log('info', 'sys', `KYC <b>одобрен</b> · уровень ${targetLevel} · лимит ${KYC_LEVELS[targetLevel].dayLimit} USDT/сутки`);
      toast('KYC одобрен', `Уровень ${targetLevel} · торговля разблокирована`, 'ok', 4600);
    }
  }, 9000);
  return true;
}

function reset() {
  set('kyc', (k) => {
    k.status = 'none'; k.level = 0; k.submittedAt = null; k.reviewedAt = null; k.rejectReason = null;
    k.steps = { personal: false, document: false, selfie: false, address: false, company: false };
  });
}

  __x.validateStep = validateStep;
  __x.saveStep = saveStep;
  __x.canSubmit = canSubmit;
  __x.submit = submit;
  __x.reset = reset;
  __x.STEP_ORDER = STEP_ORDER;
  __x.STEP_META = STEP_META;
  __x.stepsFor = stepsFor;
};

__m["src/screens/profile.js"] = function (__x, __req) {
/** Профиль — KYC-верификация, тариф B2B, безопасность, статистика. */
const { h, icon, mount } = __req("src/core/dom.js");
const { state, set, on, KYC_LEVELS, PLANS, plan, kycInfo } = __req("src/core/store.js");
const { fmt0, fmtN, compact, dateTime, ago, mask } = __req("src/core/format.js");
const { openSheet, confirmSheet } = __req("src/ui/sheet.js");
const { toast } = __req("src/ui/toast.js");
const { STEP_ORDER, STEP_META, stepsFor, validateStep, saveStep, canSubmit, submit, reset } = __req("src/services/kyc.js");
const { inTelegram, closeApp } = __req("src/services/telegram.js");
const { openRegionSheet } = __req("src/ui/regionSheet.js");
const { COUNTRY, CUR } = __req("src/data/regions.js");
function ProfileScreen() {
  const root = h('div.stagger');
  const unsubs = [];
  const kycSlot = h('div');
  const headSlot = h('div');

  const title = (text, i, aside) => h('div.section-title', { style: { '--i': i } }, h('span.eyebrow', text), h('i.rule'), aside || null);

  const STATUS_RU = { none: 'не начата', draft: 'черновик', pending: 'на проверке', approved: 'одобрена', rejected: 'отклонена' };
  const kycBadge = h('span.badge');
  const statsSlot = h('div');

  function updateKycBadge() {
    const st = state.kyc.status;
    kycBadge.className = 'badge ' + (st === 'approved' ? 'badge-buy' : st === 'pending' ? 'badge-info' : st === 'rejected' ? 'badge-sell' : 'badge-warn');
    kycBadge.textContent = STATUS_RU[st] || st;
  }

  /* ---------------- header ---------------- */

  function renderHead() {
    const p = state.profile;
    const pl = plan();
    const k = state.kyc;
    mount(headSlot,
      h('div.panel',
        h('div.pro-head',
          h('div.avatar', p.photo ? h('img', { src: p.photo, alt: '' }) : (p.name[0] || 'U')),
          h('div.pro-main',
            h('div.pro-name', p.name,
              k.status === 'approved'
                ? h('span.badge.badge-buy', icon('shieldCheck'), `kyc ${k.level}`)
                : h('span.badge.badge-warn', 'kyc 0'),
            ),
            h('div.pro-sub', `${p.handle} · с ${dateTime(p.joinedAt)}`),
          ),
        ),
        h('div.panel-body', { style: { borderTop: '1px solid var(--line-soft)' } },
          h('div.tiles',
            miniTile('Объём всего', `${compact(state.stats.volumeUsdt)}`, 'USDT'),
            miniTile('Сделок', String(state.stats.deals), `${state.stats.deals ? ((state.stats.won / state.stats.deals) * 100).toFixed(0) : 0}% успешных`),
          ),
        ),
      ),
    );
  }

  const miniTile = (l, v, s) => h('div.tile', h('div.tl', l), h('div.tv', v), h('div.ts', s));

  /* ---------------- KYC ---------------- */

  function renderKyc() {
    const k = state.kyc;
    const target = k.level >= 2 ? 3 : k.level + 1 || 1;

    const statusBlock = () => {
      if (k.status === 'pending') {
        return h('div.kyc-banner.pending',
          h('div.kyc-ico', icon('clock', { class: 't-acid pulse' })),
          h('div.kyc-main',
            h('div.kyc-t', `Проверка уровня ${k.pendingLevel ?? target}`),
            h('div.kyc-s', `Отправлено ${ago(k.submittedAt)}. Решение придёт автоматически.`),
          ),
        );
      }
      if (k.status === 'approved') {
        const lim = kycInfo();
        return h('div.kyc-banner.ok',
          h('div.kyc-ico', icon('shieldCheck', { class: 't-buy' })),
          h('div.kyc-main',
            h('div.kyc-t', `Верифицирован · уровень ${k.level}`),
            h('div.kyc-s', `${lim.name} · ${lim.dayLimit === Infinity ? 'без лимита' : fmt0(lim.dayLimit) + ' USDT/сутки'} · проверено ${ago(k.reviewedAt)}`),
          ),
        );
      }
      if (k.status === 'rejected') {
        return h('div.kyc-banner',
          h('div.kyc-ico', icon('alert', { class: 't-sell' })),
          h('div.kyc-main', h('div.kyc-t', 'Заявка отклонена'), h('div.kyc-s', k.rejectReason || 'Проверьте корректность данных и отправьте заново')),
        );
      }
      return h('div.kyc-banner',
        h('div.kyc-ico', icon('shield', { class: 't-warn' })),
        h('div.kyc-main',
          h('div.kyc-t', 'Торговля заблокирована'),
          h('div.kyc-s', 'Для доступа к P2P-закупкам нужен KYC уровня 1 и выше'),
        ),
      );
    };

    const needed = stepsFor(target);
    const doneCount = needed.filter((s) => k.steps[s]).length;

    mount(kycSlot,
      statusBlock(),
      h('div.panel', { style: { marginTop: '10px' } },
        h('div.panel-head',
          h('span.eyebrow', `Шаги уровня ${target}`),
          h('span.t-xs.mono.t-muted', `${doneCount}/${needed.length}`),
        ),
        h('div.steps', { style: { padding: '10px 14px 2px' } },
          needed.map((s) => h('i.step-dot', { class: k.steps[s] ? 'done' : '' })),
        ),
        h('div.panel-flush',
          needed.map((s) => {
            const meta = STEP_META[s];
            const done = k.steps[s];
            return h('button.row', { onClick: () => openStep(s, target), disabled: k.status === 'pending' },
              h('div.deal-ico', { style: { color: done ? 'var(--buy)' : 'var(--ink-3)' } }, icon(done ? 'check' : meta.icon)),
              h('div.row-main',
                h('div.row-title', meta.title, done ? h('span.badge.badge-buy', 'готово') : null),
                h('div.row-sub', meta.sub),
              ),
              icon('chev', { class: 'row-chev' }),
            );
          }),
        ),
        k.status !== 'approved' || k.level < target ? h('div.panel-body', { style: { borderTop: '1px solid var(--line-soft)' } },
          h('button.btn.btn-primary.btn-block', {
            disabled: !canSubmit(target) || k.status === 'pending',
            onClick: () => { if (submit(target)) renderKyc(); },
          }, icon('shieldCheck'), k.status === 'pending' ? 'На проверке…' : `Отправить на верификацию (ур. ${target})`),
        ) : null,
      ),
      h('div.section-title', h('span.eyebrow', 'Уровни и лимиты'), h('i.rule')),
      h('div.levels',
        KYC_LEVELS.slice(1).map((lv) => h('div.level', {
          class: k.level === lv.level ? 'is-current' : k.level < lv.level - 1 ? 'is-locked' : '',
        },
          h('div.level-top',
            h('div.level-n', String(lv.level)),
            h('div.level-t', lv.name),
            k.level >= lv.level ? h('span.badge.badge-buy', icon('check'), 'активен') : h('span.badge', `${stepsFor(lv.level).length} шагов`),
          ),
          h('div.level-lim',
            `${lv.dayLimit === Infinity ? '∞' : fmt0(lv.dayLimit)} USDT / сутки · ${lv.monthLimit === Infinity ? '∞' : fmt0(lv.monthLimit)} USDT / месяц`),
        )),
      ),
      k.status !== 'none' ? h('button.btn.btn-ghost.btn-block', {
        style: { marginTop: '10px' },
        onClick: async () => {
          if (await confirmSheet({ title: 'Сбросить KYC?', message: 'Все заполненные данные верификации будут удалены, торговля снова заблокируется.', confirmLabel: 'Сбросить', danger: true })) {
            reset(); renderKyc(); toast('KYC сброшен', null, 'warn');
          }
        },
      }, icon('refresh'), 'Сбросить верификацию') : null,
    );
  }

  /* ---- step editor ---- */

  function openStep(step, target) {
    const d = { ...state.kyc.data };
    const errBox = h('div');

    const f = (label, key, props = {}) => {
      const input = h('input.input', { value: d[key] ?? '', ...props, onInput: (e) => { d[key] = e.target.value; } });
      return h('label.field', h('span.label', label, props.hint ? h('span.hint', props.hint) : null), input);
    };

    const uploader = (key, label, sub) => {
      const btn = h('button.upload', { class: d[key] ? 'filled' : '' },
        icon(d[key] ? 'check' : 'camera'),
        h('span.ut', d[key] ? 'Загружено' : label),
        h('span.us', sub),
      );
      btn.addEventListener('click', () => {
        // simulated capture; on prod this posts to the KYC provider
        d[key] = !d[key];
        btn.className = `upload ${d[key] ? 'filled' : ''}`;
        mount(btn, icon(d[key] ? 'check' : 'camera'), h('span.ut', d[key] ? 'Загружено' : label), h('span.us', sub));
      });
      return btn;
    };

    const bodies = {
      personal: () => h('div',
        h('div.grid-2',
          f('Имя', 'firstName', { placeholder: 'Иван' }),
          f('Фамилия', 'lastName', { placeholder: 'Иванов' }),
        ),
        f('Дата рождения', 'birthDate', { type: 'date' }),
        h('label.field', h('span.label', 'Страна'),
          h('select.select', { onChange: (e) => { d.country = e.target.value; } },
            [['RU', 'Россия'], ['KZ', 'Казахстан'], ['BY', 'Беларусь'], ['AM', 'Армения'], ['GE', 'Грузия'], ['AE', 'ОАЭ'], ['TR', 'Турция']]
              .map(([v, n]) => h('option', { value: v, selected: d.country === v }, n))),
        ),
      ),
      document: () => h('div',
        h('label.field', h('span.label', 'Тип документа'),
          h('select.select', { onChange: (e) => { d.docType = e.target.value; } },
            [['passport', 'Паспорт'], ['id', 'ID-карта'], ['driver', 'Водительское удостоверение']]
              .map(([v, n]) => h('option', { value: v, selected: d.docType === v }, n))),
        ),
        f('Номер документа', 'docNumber', { placeholder: '4510 123456', inputmode: 'numeric' }),
        f('Действителен до', 'docExpiry', { type: 'date' }),
        h('div.field', h('span.label', 'Скан документа'), uploader('docScan', 'Загрузить скан', 'JPG/PNG/PDF до 10 МБ')),
      ),
      selfie: () => h('div',
        h('div.field', h('span.label', 'Селфи с документом'), uploader('selfie', 'Сделать селфи', 'Лицо и документ в кадре, без блика')),
        h('div.note', icon('info'), 'Проверка живости (liveness) выполняется провайдером KYC на бэкенде. Мини-апп только получает результат.'),
      ),
      address: () => h('div',
        f('Адрес', 'address', { placeholder: 'ул. Ленина, 1, кв. 2' }),
        h('div.grid-2', f('Город', 'city', { placeholder: 'Москва' }), f('Индекс', 'zip', { placeholder: '101000', inputmode: 'numeric' })),
      ),
      company: () => h('div',
        f('Название компании', 'company', { placeholder: 'ООО «Пример»' }),
        f('ИНН / Tax ID', 'taxId', { placeholder: '7701234567', inputmode: 'numeric' }),
        h('label.field', h('span.label', 'Страна регистрации'),
          h('select.select', { onChange: (e) => { d.companyCountry = e.target.value; } },
            [['RU', 'Россия'], ['KZ', 'Казахстан'], ['AE', 'ОАЭ'], ['CY', 'Кипр'], ['HK', 'Гонконг']]
              .map(([v, n]) => h('option', { value: v, selected: d.companyCountry === v }, n))),
        ),
        h('div.note', icon('users'), 'Корпоративный уровень снимает лимиты и открывает API для B2B-интеграции (вебхуки, мульти-сит).'),
      ),
    };

    const meta = STEP_META[step];
    const api = openSheet({
      title: meta.title,
      subtitle: meta.sub,
      body: h('div', bodies[step](), errBox),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Отмена'),
        h('button.btn.btn-primary', {
          onClick: () => {
            const errs = validateStep(step, d);
            if (Object.keys(errs).length) {
              mount(errBox, h('div', { style: { marginTop: '12px' } },
                Object.values(errs).map((t) => h('div.note.warn', { style: { marginBottom: '6px' } }, icon('alert'), t))));
              return;
            }
            saveStep(step, d);
            renderKyc();
            toast('Шаг заполнен', meta.title, 'ok');
            api.close();
          },
        }, 'Сохранить'),
      ],
    });
  }

  /* ---------------- plan (B2B) ---------------- */

  const pl = plan();
  const planBlock = h('div',
    h('div.plan',
      h('div.plan-top',
        h('span.plan-name', pl.name),
        h('span.badge.badge-acid', icon('zap'), 'b2b saas'),
        h('span.mono', { style: { marginLeft: 'auto', fontSize: '15px', fontWeight: '700' } }, pl.price ? `$${pl.price}/мес` : 'free'),
      ),
      h('div.usage',
        usageRow('API-вызовы', state.profile.apiUsed, pl.apiCalls),
        usageRow('Места в команде', state.profile.seatsUsed, pl.seats),
        usageRow('Подключено бирж', state.filters.exchanges.length, pl.exchanges),
      ),
    ),
    h('div.plan-grid', { style: { marginTop: '10px' } },
      PLANS.map((p) => h('button.plan-card', {
        class: p.id === state.profile.plan ? 'is-active' : '',
        onClick: () => {
          set('profile', (pr) => { pr.plan = p.id; });
          toast('Тариф изменён', `${p.name} · ${p.seats} мест · ${compact(p.apiCalls)} вызовов`, 'ok');
          navigateRefresh();
        },
      },
        h('div.pn', p.name),
        h('div.pp', p.price ? `$${p.price}` : '0'),
        h('div.pu', `${p.seats} мест`),
      )),
    ),
  );

  function usageRow(label, used, total) {
    const pctv = total ? Math.min(100, (used / total) * 100) : 0;
    return h('div.usage-row',
      h('div.ur-top', h('span.l', label), h('span.v', `${compact(used)} / ${total === Infinity ? '∞' : compact(total)}`)),
      h('div.meter', h('i', { class: pctv > 85 ? 'sell' : pctv > 60 ? 'warn' : '', style: { width: `${pctv}%` } })),
    );
  }

  /* ---------------- security ---------------- */

  const twoFaBtn = h('button.switch', { role: 'switch', 'aria-checked': String(state.profile.twoFa) });
  twoFaBtn.addEventListener('click', () => {
    set('profile', (p) => { p.twoFa = !p.twoFa; });
    twoFaBtn.setAttribute('aria-checked', String(state.profile.twoFa));
    toast(state.profile.twoFa ? '2FA включена' : '2FA отключена', state.profile.twoFa ? 'Подтверждение сделок по TOTP' : null, state.profile.twoFa ? 'ok' : 'warn');
  });

  const security = h('div',
    h('div.panel',
      h('div.switch-row',
        h('div.sr-main', h('div.sr-title', 'Двухфакторная аутентификация'), h('div.sr-sub', 'TOTP-подтверждение при закупках')),
        twoFaBtn,
      ),
      h('button.row', { onClick: openToken },
        h('div.deal-ico', icon('key')),
        h('div.row-main', h('div.row-title', 'API-токен'), h('div.row-sub.mono', mask(state.profile.apiToken, 6))),
        icon('chev', { class: 'row-chev' }),
      ),
      h('button.row', {
        onClick: () => openSheet({
          title: 'Активные сессии',
          body: h('div.panel.panel-flush',
            [
              { d: inTelegram ? 'Telegram Mini App' : 'Браузер (этот)', ip: '—', now: true },
              { d: 'Chrome · macOS', ip: '95.24.·.·', now: false },
              { d: 'API · p2pd_live_···', ip: 'server', now: false },
            ].map((s) => h('div.row',
              h('div.deal-ico', icon(s.now ? 'globe' : 'link')),
              h('div.row-main', h('div.row-title', s.d, s.now ? h('span.badge.badge-buy', 'сейчас') : null), h('div.row-sub.mono', s.ip)),
              !s.now ? h('button.btn.btn-xs.btn-danger', { onClick: (e) => { e.currentTarget.closest('.row').remove(); toast('Сессия завершена', null, 'warn'); } }, 'Выйти') : null,
            )),
          ),
        }),
      },
        h('div.deal-ico', icon('users')),
        h('div.row-main', h('div.row-title', 'Сессии и устройства'), h('div.row-sub', '3 активные сессии')),
        icon('chev', { class: 'row-chev' }),
      ),
    ),
    h('div.panel', { style: { marginTop: '10px' } },
      h('button.row', {
        onClick: async () => {
          if (await confirmSheet({ title: 'Выйти из аккаунта?', message: 'Локальные данные останутся на устройстве. Для полной очистки используйте Настройки → Сбросить данные.', confirmLabel: 'Выйти', danger: true })) {
            if (inTelegram) closeApp(); else toast('Выход выполнен', 'В браузере сессия локальная', 'warn');
          }
        },
      },
        h('div.deal-ico', { style: { color: 'var(--sell)' } }, icon('logout')),
        h('div.row-main', h('div.row-title.t-sell', 'Выйти')),
        icon('chev', { class: 'row-chev' }),
      ),
    ),
  );

  function openToken() {
    const api = openSheet({
      title: 'API-токен',
      subtitle: 'Для серверных интеграций B2B',
      body: h('div',
        h('div.copy-row',
          h('span', state.profile.apiToken),
          h('button.btn.btn-xs.btn-ghost', {
            onClick: async () => {
              try { await navigator.clipboard.writeText(state.profile.apiToken); toast('Скопировано', null, 'ok'); }
              catch { toast('Не удалось скопировать', 'Разрешите доступ к буферу обмена', 'err'); }
            },
          }, icon('copy')),
        ),
        h('div.note', { style: { marginTop: '12px' } }, icon('info'),
          'Токен даёт доступ к REST и WebSocket API: подписка на стаканы, создание ордеров, вебхуки по статусам сделок.'),
      ),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => api.close() }, 'Закрыть'),
        h('button.btn.btn-danger', {
          onClick: () => {
            set('profile', (p) => { p.apiToken = 'p2pd_live_' + Math.random().toString(36).slice(2, 12); });
            toast('Токен перевыпущен', 'Старый больше не действует', 'warn');
            api.close();
          },
        }, icon('refresh'), 'Перевыпустить'),
      ],
    });
  }

  /* ---------------- stats ---------------- */

  function renderStats() {
    const st = state.stats;
    mount(statsSlot, h('div.panel.panel-body',
      h('dl',
        row('Общий объём', `${fmtN(st.volumeUsdt, 2)} USDT`),
        row('Сделок всего', String(st.deals)),
        row('Завершено успешно', `${st.won} (${st.deals ? ((st.won / st.deals) * 100).toFixed(1) : 0}%)`),
        row('Средний спред', `${st.deals ? (st.spreadSum / st.deals).toFixed(2) : '0.00'}%`),
        row('Объём за сутки', `${fmtN(st.dayVolume, 2)} USDT`),
        row('KYC-лимит в сутки', kycInfo().dayLimit === Infinity ? '∞' : `${fmt0(kycInfo().dayLimit)} USDT`),
      ),
    ));
  }

  function row(k, v) { return h('div.kv', h('dt', k), h('dd', v)); }

  function navigateRefresh() { renderHead(); }

  unsubs.push(on('kyc', () => { renderKyc(); renderHead(); updateKycBadge(); renderStats(); }));
  unsubs.push(on(['profile', 'stats'], () => { renderHead(); renderStats(); }));

  renderHead();
  renderKyc();
  updateKycBadge();
  renderStats();

  const regionSlot = h('div');
  function renderRegion() {
    const c = state.region ? COUNTRY[state.region] : null;
    mount(regionSlot, h('div.panel.panel-flush',
      h('button.row', { onClick: () => openRegionSheet({ onPick: renderRegion }) },
        h('div.deal-ico', { style: { fontSize: '18px' } }, c?.flag || '🌐'),
        h('div.row-main',
          h('div.row-title', c ? c.name : 'Регион не выбран'),
          h('div.row-sub', c ? `${CUR[c.cur]?.name || c.cur} · ${c.cur}` : 'Нажмите, чтобы выбрать'),
        ),
        icon('chev', { class: 'row-chev' }),
      ),
    ));
  }
  renderRegion();
  unsubs.push(on('region', renderRegion));

  root.append(
    h('div', { style: { '--i': 0 } }, headSlot),
    title('Регион', 1),
    h('div', { style: { '--i': 1 } }, regionSlot),
    title('KYC-верификация', 1, kycBadge),
    h('div', { style: { '--i': 2 } }, kycSlot),
    title('Тариф', 3),
    h('div', { style: { '--i': 4 } }, planBlock),
    title('Безопасность', 5),
    h('div', { style: { '--i': 6 } }, security),
    title('Статистика', 7),
    h('div', { style: { '--i': 8 } }, statsSlot),
    h('div.foot-note', inTelegram ? 'Запущено как Telegram Mini App' : 'Веб-версия'),
  );

  return { node: root, destroy: () => unsubs.forEach((u) => u()) };
}

  __x.ProfileScreen = ProfileScreen;
};

__m["src/ui/splash.js"] = function (__x, __req) {
/**
 * Загрузочный экран.
 * Последовательность: предметы прилетают с разных сторон (CSS-анимация) →
 * пауза → затемнение, предметы исчезают (.is-leaving) → снятие сплэша →
 * под ним уже смонтирован главный экран.
 */
const { qs } = __req("src/core/dom.js");
const t0 = Date.now();
const HOLD = 1750;    // прилёт предметов + пауза до начала ухода, мс
const LEAVE = 640;    // длительность затемнения/исчезновения, мс

let leaving = false;
let removed = false;

function removeSplash() {
  if (removed) return;
  removed = true;
  qs('#splash')?.remove();
}

/** Запустить уход сплэша (не раньше, чем предметы прилетят). */
function splashLeave() {
  if (leaving) return;
  leaving = true;
  const run = () => {
    const el = qs('#splash');
    if (!el) return;
    el.classList.add('is-leaving');
    setTimeout(removeSplash, LEAVE + 80);
  };
  setTimeout(run, Math.max(0, HOLD - (Date.now() - t0)));
}

/** Страховка: сплэш не должен залипнуть навсегда. */
function splashGuard(ms = 6000) {
  setTimeout(splashLeave, ms);
}

  __x.splashLeave = splashLeave;
  __x.splashGuard = splashGuard;
};

__m["src/main.js"] = function (__x, __req) {
/**
 * P2P Light — AI-терминал P2P-стаканов (Telegram Mini App / web).
 * Bootstrap: тема → Telegram → экраны → фид.
 */
const { state, set, on, rollDay } = __req("src/core/store.js");
const { register, navigate, renderTabbar } = __req("src/core/router.js");
const { initTelegram, inTelegram } = __req("src/services/telegram.js");
const { startFeed } = __req("src/services/feed.js");
const { log } = __req("src/services/logs.js");
const { HomeScreen } = __req("src/screens/home.js");
const { P2PScreen } = __req("src/screens/p2p.js");
const { SettingsScreen } = __req("src/screens/settings.js");
const { ProfileScreen } = __req("src/screens/profile.js");
const { closeTopSheet, sheetOpen } = __req("src/ui/sheet.js");
const { splashLeave, splashGuard } = __req("src/ui/splash.js");
const { openRegionSheet } = __req("src/ui/regionSheet.js");
const { qs } = __req("src/core/dom.js");
/* ---------- theme ---------- */
function applyTheme() {
  const t = state.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  qs('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#ffffff' : '#0b0c0f');
}

/* ---------- boot ---------- */
function boot() {
  splashGuard();                     // сплэш не должен залипнуть, если старт упадёт

  applyTheme();
  on('settings', applyTheme);

  initTelegram();
  rollDay();

  if (state.settings.hideBalanceDefault) set('ui', (u) => { u.balanceHidden = true; });

  register('home', HomeScreen);
  register('p2p', P2PScreen);
  register('settings', SettingsScreen);
  register('profile', ProfileScreen);

  renderTabbar();
  navigate(state.ui.tab || 'home');

  log('info', 'sys', `P2P Light запущен · ${inTelegram ? 'Telegram Mini App' : 'браузер'}`);

  startFeed();

  // первый вход: обязательный выбор региона (открывается под сплэшем)
  if (!state.region) openRegionSheet({ mandatory: true });

  // главный экран уже смонтирован под сплэшем — запускаем уход заставки
  splashLeave();

  // Esc / browser back closes the top sheet
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen()) { e.preventDefault(); closeTopSheet(); }
  });

  document.addEventListener('visibilitychange', () => {
    log('info', 'sys', document.hidden ? 'приложение в фоне' : 'приложение активно');
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// expose for console debugging / e2e checks
window.__p2p = { state };


};

  __req("src/main.js");
})();
