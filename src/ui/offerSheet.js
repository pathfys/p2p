/**
 * Deal-context sheet: the full "почему эта сделка" breakdown + execution.
 */
import { h, icon, mount } from '../core/dom.js';
import { openSheet, confirmSheet } from './sheet.js';
import { toast } from './toast.js';
import { state, set, PAY_METHODS, kycInfo } from '../core/store.js';
import { fmtN, fmt0, compact, ago } from '../core/format.js';
import { EX, FIAT } from '../data/exchanges.js';
import { analyze, WEIGHT_LABELS } from '../services/analysis.js';
import { preflight, execute } from '../services/trade.js';
import { openDealSheet } from './dealSheet.js';
import { navigate } from '../core/router.js';
import { haptic } from '../services/telegram.js';

const PM = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m]));

export function openOfferSheet(offerId) {
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

      /* --- volume --- */
      h('div.section-title', h('span.eyebrow', 'Объём закупки'), h('i.rule')),
      h('div.panel',
        h('div.vol-wrap',
          h('div.vol-input',
            h('img', { src: './assets/coins/usdt.png', alt: '' }),
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
