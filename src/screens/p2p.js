/**
 * P2P — агрегированные стаканы всех бирж в одной вкладке.
 * Сюда «переехали» все ордербуки (Binance, Bybit, OKX, Bitget, HTX, KuCoin, MEXC, Gate).
 *
 * Книга обновляется по месту (keyed reconciliation) и пересортировывается
 * не чаще REORDER_MS — иначе строка «уезжает» из-под пальца в момент тапа.
 */
import { h, icon, mount, sparkline, clear } from '../core/dom.js';
import { state, set, on, PAY_METHODS } from '../core/store.js';
import { fmtN, fmt0, compact, hhmmss } from '../core/format.js';
import { EXCHANGES, EX, ASSETS, FIATS, FIAT } from '../data/exchanges.js';
import { analyze, buildPlan, usdtToAsset } from '../services/analysis.js';
import { resubscribe, recomputeMarket } from '../services/feed.js';
import { clearLogs, exportLogs } from '../services/logs.js';
import { openOfferSheet } from '../ui/offerSheet.js';
import { openFilterSheet, activeFilterCount, SORTS } from '../ui/filterSheet.js';
import { openSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { haptic } from '../services/telegram.js';

const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));
const REORDER_MS = 1100;   // как часто разрешено менять порядок строк
const MAX_ROWS = 60;

const LOG_LEVELS = [
  { id: 'info', label: 'info' }, { id: 'up', label: 'рост' }, { id: 'down', label: 'падение' },
  { id: 'new', label: 'новые' }, { id: 'gone', label: 'снятые' }, { id: 'warn', label: 'warn' },
  { id: 'alert', label: 'алерты' }, { id: 'trade', label: 'сделки' },
];

/* ============================ selector ============================ */

export function visibleOffers() {
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

export function P2PScreen({ slot }) {
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

    hRefs.fiatSel = h('select.select', {
      style: { flex: '1' }, 'aria-label': 'Фиат',
      onChange: (e) => { set('filters', (x) => { x.fiat = e.target.value; x.methods = []; }); switchMarket(); },
    }, FIATS.map((x) => h('option', { value: x.id, selected: x.id === f.fiat }, `${x.id} ${x.sym}`)));

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
        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, hRefs.assetSel, hRefs.fiatSel),
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
    resubscribe();
    updateHead();
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
          h('div.vol-input', h('img', { src: './assets/coins/usdt.png', alt: '' }), input, h('span.vc', 'USDT')),
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
        h('div.of-name', h('span.ex-tag', ex?.tag || o.exchange), refs.name, refs.verified, refs.pro),
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

  const logLine = (e) => h('div.log-line', { class: `lv-${e.level}` },
    h('span.log-ts', hhmmss(e.ts)),
    h('span.log-ex', { style: { color: EX[e.exchange]?.tint || 'var(--ink-3)' } }, EX[e.exchange]?.tag || e.exchange),
    h('span.log-msg', { html: safeLogHTML(e.message) }),
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
