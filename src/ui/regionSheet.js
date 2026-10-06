/**
 * Выбор региона. Используется и как обязательный экран при первом входе
 * (mandatory=true — без выбора не закрыть), и как смена региона в любой момент.
 */
import { h, icon, mount } from '../core/dom.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { state, setRegion } from '../core/store.js';
import { COUNTRIES, COUNTRY, CUR } from '../data/regions.js';
import { set } from '../core/store.js';
import { resubscribe } from '../services/feed.js';
import { haptic } from '../services/telegram.js';

/** Применить регион: валюта и способы оплаты подтягиваются из страны. */
export function applyRegion(code) {
  const c = COUNTRY[code];
  if (!c) return;
  setRegion(code);
  set('filters', (f) => { f.fiat = c.cur; f.methods = []; });
  resubscribe();
}

export function openRegionSheet({ mandatory = false, onPick } = {}) {
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
export function regionChip(onClick) {
  const c = state.region ? COUNTRY[state.region] : null;
  return h('button.region-chip', { onClick },
    h('span.region-chip-flag', c?.flag || '🌐'),
    h('span.region-chip-cur', c?.cur || '—'),
    icon('chevDown', { class: 'region-chip-chev' }),
  );
}
