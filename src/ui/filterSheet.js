/** Фильтры стакана. */
import { h, icon } from '../core/dom.js';
import { openSheet } from './sheet.js';
import { state, set, PAY_METHODS } from '../core/store.js';
import { EXCHANGES, methodsFor } from '../data/exchanges.js';
import { resubscribe } from '../services/feed.js';
import { toast } from './toast.js';

export const SORTS = [
  { id: 'price',      label: 'Лучшая цена' },
  { id: 'score',      label: 'AI-скор' },
  { id: 'available',  label: 'Ликвидность' },
  { id: 'completion', label: 'Исполнение' },
  { id: 'orders',     label: 'Опыт мерчанта' },
  { id: 'speed',      label: 'Скорость' },
];

export function activeFilterCount() {
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

export function openFilterSheet(onApply) {
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
