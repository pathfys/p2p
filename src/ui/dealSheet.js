/** Shared purchase-detail sheet (used by Главная and P2P). */
import { h, icon } from '../core/dom.js';
import { openSheet, confirmSheet } from './sheet.js';
import { fmtN, fmt0, dateTime, hhmmss } from '../core/format.js';
import { DEAL_STATUS, cancelDeal } from '../services/trade.js';
import { PAY_METHODS, state } from '../core/store.js';
import { EX } from '../data/exchanges.js';

const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));

export function openDealSheet(deal) {
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

export function kv(k, v, cls = '') {
  return h('div.kv', h('dt', k), h(`dd${cls ? '.' + cls : ''}`, v));
}
