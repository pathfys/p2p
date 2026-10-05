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
import { state, emit, set } from '../core/store.js';
import { EXCHANGES, EX, AST, FIAT_METHODS } from '../data/exchanges.js';
import { mulberry, hashStr, merchantName, merchantTerms } from '../data/merchants.js';
import { log } from './logs.js';

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
export { newNonce };

/* ============================ public API ============================ */

export function startFeed() {
  if (running) return;
  running = true;
  mode = state.settings.feedMode;
  log('info', 'sys', 'Поток данных <b>запущен</b>');
  if (mode === 'live') connectWs(); else startMock();
  statusTimer = setInterval(heartbeat, 2000);
}

export function stopFeed() {
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

export function restartFeed() {
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
export function resubscribe() {
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

export const feedMode = () => mode;

export function setFeedMode(next) {
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
    const mid = AST[asset].base[fiat];
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
    const a = AST[this.asset];
    const unit = a.base[this.fiat];
    const usdtScale = this.asset === 'USDT' ? 1 : unit / AST.USDT.base[this.fiat];

    // liquidity in asset units, roughly 500..90000 USDT-equivalent
    const liqUsdt = 400 + r() * r() * 90000;
    const available = liqUsdt / usdtScale;

    const orders = Math.floor(20 + r() ** 1.6 * 9000);
    const completion = 0.80 + r() * 0.198;
    const pool = FIAT_METHODS[this.fiat] || ['wire'];
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
    const base = AST[this.asset].base[this.fiat] * (1 + this.premium * 0.01);
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

export function recomputeMarket() {
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

export function bestOffer() {
  const list = Object.values(state.offers);
  if (!list.length) return null;
  return state.filters.side === 'buy'
    ? list.reduce((a, b) => (b.price < a.price ? b : a))
    : list.reduce((a, b) => (b.price > a.price ? b : a));
}

export const allExchangeIds = EXCHANGES.map((e) => e.id);
