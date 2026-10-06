/**
 * Топ — рейтинг мерчантов за неделю / месяц / всё время.
 * Тип топа выбирается фильтром: по объёму USDT или по числу ордеров.
 *
 * Бэкенда нет, поэтому таблица лидеров собирается детерминированным
 * генератором (seeded PRNG): состав и цифры стабильны между перерисовками,
 * но меняются от периода к периоду — ровно как отдавал бы сервер.
 */
import { h, icon, mount } from '../core/dom.js';
import { fmt0, compact } from '../core/format.js';
import { EXCHANGES, EX } from '../data/exchanges.js';
import { haptic } from '../services/telegram.js';

const PERIODS = [
  { id: 'week',  label: 'Неделя',    mult: 1 },
  { id: 'month', label: 'Месяц',     mult: 4.3 },
  { id: 'all',   label: 'Всё время', mult: 64 },
];

const METRICS = [
  { id: 'volume', label: 'По объёму USDT' },
  { id: 'orders', label: 'По ордерам' },
];

const NAMES = [
  'CryptoBaron', 'AlphaDesk', 'FastSwap', 'UsdtKing', 'NordExchange', 'MerchantPro',
  'LiquidHub', 'SafeTrade', 'OtcWhale', 'PrimeP2P', 'GoldBridge', 'FlashDealer',
  'VostokPay', 'SilkRoad', 'EuroDesk', 'AsiaLiquid', 'TetherLord', 'QuickFiat',
  'IronVault', 'StableFlow', 'RapidCash', 'MetroSwap', 'OceanOtc', 'VertexPay',
  'ZenTrader', 'NovaDesk', 'ApexFiat', 'LunarSwap', 'TitanOtc', 'OrbitPay',
  'CobraDeals', 'FalconFx', 'MeridianP2P', 'HelixSwap', 'CedarTrade', 'AtlasDesk',
  'PulseFiat', 'VektorPay', 'DeltaWhale', 'KometaOtc',
];

/* ---- детерминированный PRNG ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

/** Базовый профиль мерчанта — стабилен на всё время жизни экрана. */
function buildRoster() {
  return NAMES.map((name) => {
    const r = mulberry32(hashStr(name));
    const ex = EXCHANGES[Math.floor(r() * EXCHANGES.length)].id;
    const baseWeekVol = 40_000 + r() * 2_400_000;     // недельный объём, USDT
    const avgTicket = 280 + r() * 4200;               // средний чек, USDT/ордер
    const completion = 0.93 + r() * 0.069;
    const rating = 4.6 + r() * 0.39;
    const verified = r() > 0.22;
    const pro = r() > 0.6;
    return { name, ex, baseWeekVol, avgTicket, completion, rating, verified, pro };
  });
}

/** Значения за выбранный период (с детерминированным джиттером → топ меняется). */
function entriesFor(roster, periodId) {
  const period = PERIODS.find((p) => p.id === periodId) || PERIODS[0];
  return roster.map((m) => {
    const j = mulberry32(hashStr(m.name + ':' + periodId))();
    const jitter = 0.72 + j * 0.56;                   // 0.72..1.28
    const volume = m.baseWeekVol * period.mult * jitter;
    const orders = Math.max(1, Math.round(volume / m.avgTicket));
    return { ...m, volume, orders };
  });
}

export function TopScreen({ slot }) {
  const root = h('div.stagger');

  const roster = buildRoster();
  let periodId = 'week';
  let metricId = 'volume';

  /* topbar: что сейчас показываем */
  const slotBadge = h('span.badge', 'рейтинг');
  slot.append(slotBadge);

  const listSlot = h('div');
  const podiumSlot = h('div');

  const periodSeg = h('div.seg',
    PERIODS.map((p) => h('button', {
      'aria-pressed': String(p.id === periodId),
      onClick: (e) => {
        if (p.id === periodId) return;
        periodId = p.id; haptic('select');
        for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', 'false');
        e.currentTarget.setAttribute('aria-pressed', 'true');
        render();
      },
    }, p.label)),
  );

  const metricSeg = h('div.seg',
    METRICS.map((m) => h('button', {
      'aria-pressed': String(m.id === metricId),
      onClick: (e) => {
        if (m.id === metricId) return;
        metricId = m.id; haptic('select');
        for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', 'false');
        e.currentTarget.setAttribute('aria-pressed', 'true');
        render();
      },
    }, m.label)),
  );

  const metricVal = (e) => (metricId === 'volume' ? `${compact(e.volume)}` : `${fmt0(e.orders)}`);
  const metricUnit = () => (metricId === 'volume' ? 'USDT' : 'ордеров');
  const secondVal = (e) => (metricId === 'volume' ? `${fmt0(e.orders)} ордеров` : `${compact(e.volume)} USDT`);

  function avatar(e, size = 34) {
    const ex = EX[e.ex];
    return h('div.lb-ava', { style: { width: `${size}px`, height: `${size}px`, background: ex?.tint || 'var(--acid)' } }, (e.name[0] || '?'));
  }

  function podium(entries) {
    // порядок колонок: 2-е, 1-е, 3-е место (1-е по центру и выше)
    const order = [entries[1], entries[0], entries[2]].filter(Boolean);
    const rankOf = (e) => entries.indexOf(e) + 1;
    return h('div.podium',
      order.map((e) => {
        const rank = rankOf(e);
        return h('div.pod-col', { class: `r${rank}` },
          h('div.pod-medal', icon(rank === 1 ? 'crown' : 'medal')),
          avatar(e, rank === 1 ? 52 : 44),
          h('div.pod-name', e.name),
          h('div.pod-ex', EX[e.ex]?.name || e.ex),
          h('div.pod-val', metricVal(e), h('span.pod-unit', metricUnit())),
          h('div.pod-bar'),
          h('div.pod-rank', `#${rank}`),
        );
      }),
    );
  }

  function row(e, rank) {
    return h('button.lb-row', {
      onClick: () => haptic('light'),
    },
      h('div.lb-rank', String(rank)),
      avatar(e),
      h('div.lb-main',
        h('div.lb-name', e.name,
          e.verified ? icon('shieldCheck', { class: 'of-verified' }) : null,
          e.pro ? h('span.badge.badge-acid', { style: { height: '15px', fontSize: '8.5px' } }, 'pro') : null,
        ),
        h('div.lb-sub',
          h('span.ex-tag', { style: { '--ex-c': EX[e.ex]?.tint } }, EX[e.ex]?.tag || e.ex),
          h('span', `${(e.completion * 100).toFixed(1)}%`),
          h('span.sep', '·'),
          h('span', `★${e.rating.toFixed(2)}`),
        ),
      ),
      h('div.lb-val',
        h('div.lb-v', metricVal(e), h('span.lb-u', metricUnit())),
        h('div.lb-v2', secondVal(e)),
      ),
    );
  }

  function render() {
    const entries = entriesFor(roster, periodId)
      .sort((a, b) => (metricId === 'volume' ? b.volume - a.volume : b.orders - a.orders));

    const top3 = entries.slice(0, 3);
    const rest = entries.slice(3, 30);

    mount(podiumSlot, podium(top3));
    mount(listSlot, h('div.panel.panel-flush', rest.map((e, i) => row(e, i + 4))));
  }

  render();

  root.append(
    h('div.section-title', { style: { '--i': 0 } }, h('span.eyebrow', 'Рейтинг мерчантов'), h('i.rule')),
    h('div.panel.panel-body', { style: { '--i': 1 } },
      h('span.label', { style: { display: 'block', marginBottom: '8px' } }, 'Период'),
      periodSeg,
      h('span.label', { style: { display: 'block', margin: '12px 0 8px' } }, 'Тип топа'),
      metricSeg,
      h('p.set-desc', 'Лидеры площадок P2P по обороту. Переключите период и тип рейтинга — по суммарному объёму в USDT или по числу закрытых ордеров.'),
    ),
    h('div', { style: { '--i': 2, marginTop: '12px' } }, podiumSlot),
    h('div.section-title', { style: { '--i': 3 } }, h('span.eyebrow', 'Остальные места'), h('i.rule')),
    h('div', { style: { '--i': 4 } }, listSlot),
    h('div.foot-note', 'Рейтинг обновляется агрегатором по закрытым сделкам. Период и тип топа задаются фильтрами выше.'),
  );

  return { node: root };
}
