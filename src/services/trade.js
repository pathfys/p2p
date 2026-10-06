/**
 * Purchase execution (закупки).
 *
 * Front-end simulation of the order lifecycle the backend will own:
 *   created → paid → released → done  (or cancelled / disputed)
 * Fiat leaves the selected card, crypto lands on the USDT balance.
 */
import { state, set, emit, canTrade, kycInfo, PAY_METHODS, trackDealForQuests } from '../core/store.js';
import { uid } from '../core/format.js';
import { log } from './logs.js';
import { analyze, assetToUsdt } from './analysis.js';
import { toast } from '../ui/toast.js';

const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));

/** Everything that must hold before a deal can be sent. */
export function preflight(offer, volumeUsdt, cardId) {
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
export function execute(offer, volumeUsdt, cardId, method) {
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

export function cancelDeal(dealId) {
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

export const DEAL_STATUS = {
  created:   { label: 'Создана',   color: 'var(--info)', badge: 'badge-info' },
  paid:      { label: 'Оплачена',  color: 'var(--warn)', badge: 'badge-warn' },
  released:  { label: 'Отпущена',  color: 'var(--acid)', badge: 'badge-acid' },
  done:      { label: 'Завершена', color: 'var(--buy)',  badge: 'badge-buy' },
  cancelled: { label: 'Отменена',  color: 'var(--sell)', badge: 'badge-sell' },
};
