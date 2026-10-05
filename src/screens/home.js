/** Главная — баланс USDT, карточки, KPI, последние закупки. */
import { h, icon, sparkline, mount } from '../core/dom.js';
import { state, set, on, PAY_METHODS, kycInfo, rollDay } from '../core/store.js';
import { splitAmount, fmtN, fmt0, compact, ago, dateTime, uid } from '../core/format.js';
import { AST, FIAT } from '../data/exchanges.js';
import { openSheet, confirmSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { haptic } from '../services/telegram.js';
import { openDealSheet } from '../ui/dealSheet.js';
import { DEAL_STATUS } from '../services/trade.js';
import { navigate } from '../core/router.js';

const BANK_TINT = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m.tint]));

export function HomeScreen() {
  rollDay();
  const root = h('div.stagger');
  const unsubs = [];

  const kycSlot = h('div');
  const heroSlot = h('div');
  const tilesSlot = h('div');
  const cardsSlot = h('div');
  const dealsSlot = h('div');

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
    sectionTitle('Операции за сегодня', 2),
    wrap(tilesSlot, 3),
    sectionTitle('Баланс карточек', 4, h('button.btn.btn-xs.btn-ghost', { onClick: () => openCardSheet() }, icon('plus'), 'Карта')),
    wrap(cardsSlot, 5),
    sectionTitle('Закупки', 6, h('button.btn.btn-xs.btn-ghost', { onClick: () => navigate('p2p') }, 'К стаканам', icon('chev'))),
    wrap(dealsSlot, 7),
    h('div.foot-note', 'P2P Light · агрегатор P2P-стаканов · данные обновляются в реальном времени во вкладке P2P'),
  );

  return { node: root, destroy: () => unsubs.forEach((u) => u()) };
}

const wrap = (node, i) => h('div', { style: { '--i': i } }, node);

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
  const rate = AST.USDT.base[state.filters.fiat] || AST.USDT.base.RUB;
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
        h('img', { src: './assets/coins/usdt.png', alt: '', style: { width: '28px', height: '28px', marginRight: '2px' } }),
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
export function openBalanceSheet(mode = 'set') {
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
    previewEl.textContent = `Станет: ${fmtN(Math.max(0, next), 2)} USDT  ≈ ${fmt0(Math.max(0, next) * AST.USDT.base.RUB)} ₽`;
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
        'Это локальный (демо) баланс мини-аппа. На проде баланс приходит из бэкенда и сверяется с кастодиальным кошельком.'),
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

export function openCardSheet(card = null) {
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
