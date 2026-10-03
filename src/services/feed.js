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
import { mulberry, hashStr, merchantName } from '../data/merchants.js';
import { log } from './logs.js';

let mode = 'mock';
let running = false;
let tickTimer = null;
let statusTimer = null;
let ws = null;
let wsRetry = 0;
let reqId = 0;
const venues = new Map();     // exchange -> MockVenue

/* ============================ public API ============================ */

export function startFeed() {
  if (running) return;
  running = true;
  mode = state.settings.feedMode;
  log('info', 'sys', `Запуск фида · режим <b>${mode === 'live' ? 'LIVE WS' : 'MOCK'}</b>`);
  if (mode === 'live') connectWs(); else startMock();
  statusTimer = setInterval(heartbeat, 2000);
}

export function stopFeed() {
  running = false;
  clearInterval(tickTimer); tickTimer = null;
  clearInterval(statusTimer); statusTimer = null;
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

/** Re-subscribe after the user changes asset / fiat / side / exchanges. */
export function resubscribe() {
  const f = state.filters;
  log('info', 'sys', `Подписка <b>${f.asset}/${f.fiat}</b> · ${f.side === 'buy' ? 'покупка' : 'продажа'} · ${f.exchanges.length} бирж`);
  state.offers = {};
  emit('offers', { reason: 'resubscribe' });
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
    log('info', 'sys', 'WS <b>открыт</b>, отправляю auth + subscribe');
    sendWs({ op: 'auth', token: state.profile.apiToken, initData: window.Telegram?.WebApp?.initData || '' });
    sendWs({ op: 'subscribe', channel: 'p2p.book', args: subscribeArgs() });
    sendWs({ op: 'subscribe', channel: 'p2p.logs', args: { exchanges: state.filters.exchanges } });
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return log('warn', 'sys', 'WS: не-JSON кадр'); }
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
  const delay = Math.min(30000, 1000 * 2 ** Math.min(wsRetry, 5));
  log('warn', 'sys', `Переподключение через <b>${(delay / 1000).toFixed(0)}с</b> (попытка ${wsRetry})`);
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
      for (const id of Object.keys(state.offers)) if (state.offers[id].exchange === ex) delete state.offers[id];
      for (const o of msg.data?.offers || []) state.offers[o.id] = normalizeOffer(o);
      setWire(ex, { state: 'live', lastTs: msg.ts || Date.now() });
      bumpMsgs(ex, msg.data?.offers?.length || 0);
      log('info', ex, `snapshot · <b>${msg.data?.offers?.length || 0}</b> оферов`);
      recomputeMarket();
      emit('offers', { reason: 'snapshot', exchange: ex });
      break;
    }
    case 'update': {
      const ex = msg.exchange;
      for (const o of msg.data?.upsert || []) applyUpsert(normalizeOffer(o));
      for (const id of msg.data?.remove || []) applyRemove(id);
      bumpMsgs(ex, (msg.data?.upsert?.length || 0) + (msg.data?.remove?.length || 0));
      setWire(ex, { state: 'live', lastTs: msg.ts || Date.now() });
      recomputeMarket();
      emit('offers', { reason: 'update', exchange: ex });
      break;
    }
    case 'status':
      setWire(msg.exchange, { state: msg.data?.state || 'live', latency: msg.data?.latency ?? 0 });
      break;
    case 'log':
      log(msg.data?.level || 'info', msg.data?.exchange || 'sys', msg.data?.text || '');
      break;
    case 'pong':
      break;
    case 'error':
      log('warn', msg.data?.exchange || 'sys', `ошибка: <b>${msg.data?.message || msg.data?.code}</b>`);
      break;
    default:
      log('info', 'sys', `неизвестное событие: ${msg.ev}`);
  }
}

function normalizeOffer(o) {
  return {
    id: o.id,
    exchange: o.exchange,
    side: o.side,
    asset: o.asset,
    fiat: o.fiat,
    price: Number(o.price),
    prevPrice: state.offers[o.id]?.price ?? Number(o.price),
    available: Number(o.available),
    min: Number(o.min),
    max: Number(o.max),
    methods: o.methods || [],
    merchant: {
      id: o.merchant?.id || o.id,
      name: o.merchant?.name || 'unknown',
      orders: o.merchant?.orders ?? 0,
      completion: o.merchant?.completion ?? 0,
      rating: o.merchant?.rating ?? 0,
      verified: Boolean(o.merchant?.verified),
      pro: Boolean(o.merchant?.pro),
      avgReleaseMin: o.merchant?.avgReleaseMin ?? 10,
      online: o.merchant?.online !== false,
      blocked: Boolean(o.merchant?.blocked),
    },
    kycRequired: o.kycRequired ?? 0,
    ts: o.ts || Date.now(),
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
