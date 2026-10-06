/**
 * Еженедельные задания. Компактная карточка на главной + полный лист с
 * прогрессом. За выполнение всех — приз: прокрут колеса фортуны.
 */
import { h, icon, mount } from '../core/dom.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { state, on, questProgress, claimQuestReward } from '../core/store.js';
import { fmt0, compact } from '../core/format.js';
import { haptic } from '../services/telegram.js';
import { openWheelSheet } from './wheel.js';

const fmtVal = (q, remaining = false) => {
  const fmt = q.id === 'volume' ? compact : String;
  if (remaining) return q.id === 'volume' ? `${compact(Math.max(0, q.target - q.cur))} USDT` : `${Math.max(0, q.target - q.cur)}`;
  return `${fmt(q.cur)} / ${fmt(q.target)}`;
};

/** Карточка-сводка для главной. */
export function questsCard() {
  const slot = h('div');
  const render = () => {
    const p = questProgress();
    const ready = p.allDone && !state.quests.claimed;
    mount(slot, h('button.quests-card', { onClick: openQuestsSheet },
      h('div.quests-ico', icon('target')),
      h('div.quests-main',
        h('div.quests-top',
          h('span.quests-title', 'Еженедельные задания'),
          ready ? h('span.badge.badge-acid', 'приз готов') : h('span.quests-count', `${p.doneCount}/${p.total}`),
        ),
        h('div.meter', { style: { marginTop: '7px' } },
          h('i', { class: p.allDone ? 'buy' : '', style: { width: `${(p.doneCount / p.total) * 100}%` } })),
      ),
      icon('chev', { class: 'row-chev' }),
    ));
  };
  render();
  const off = on(['quests', 'stats', 'kyc', 'cards', 'wheel'], render);
  slot._off = off;
  return slot;
}

export function openQuestsSheet() {
  const listEl = h('div');
  const footEl = h('div', { style: { width: '100%' } });

  const render = () => {
    const p = questProgress();
    mount(listEl,
      h('div.panel.panel-flush',
        p.list.map((q) => h('div.quest-row', { class: q.done ? 'is-done' : '' },
          h('div.quest-check', { class: q.done ? 'is-done' : '' }, icon(q.done ? 'check' : 'clock')),
          h('div.quest-body',
            h('div.quest-name', q.title),
            h('div.quest-status', q.done
              ? h('span.t-buy', 'выполнено')
              : h('span.t-muted', `осталось ${fmtVal(q, true)}`)),
            h('div.meter', { style: { marginTop: '6px' } },
              h('i', { class: q.done ? 'buy' : '', style: { width: `${Math.min(100, (q.cur / q.target) * 100)}%` } })),
          ),
          h('div.quest-val.mono', fmtVal(q)),
        )),
      ),
    );

    const ready = p.allDone && !state.quests.claimed;
    mount(footEl, state.quests.claimed
      ? h('button.btn.btn-ghost.btn-block', { disabled: true }, icon('check'), 'Приз получен — заходи на следующей неделе')
      : h('button.btn.btn-primary.btn-block', { disabled: !ready, onClick: claim },
          icon('zap'), ready ? 'Забрать приз: +1 прокрут' : `Выполни все задания (${p.doneCount}/${p.total})`));
  };

  function claim() {
    if (!claimQuestReward()) return;
    haptic('success');
    toast('Приз получен', '+1 прокрут колеса фортуны', 'ok');
    api.close();                         // закрываем лист заданий…
    setTimeout(openWheelSheet, 320);     // …и открываем колесо
  }

  const api = openSheet({
    title: 'Еженедельные задания',
    subtitle: 'Обновляются каждый понедельник',
    body: h('div',
      listEl,
      h('div.note', { style: { marginTop: '12px' } }, icon('info'),
        'Прогресс считается за текущую неделю. Выполни все задания и забери прокрут колеса фортуны.'),
    ),
    foot: [footEl],
  });
  render();
  return api;
}
