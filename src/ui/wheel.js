/**
 * Колесо фортуны (демо).
 * Открывается по тапу на промо-баннер. Содержит само колесо, слоты (демо-призы)
 * и кнопку «Прокрутить».
 *
 * Принцип честного прокрута: сектор-победитель выбирается ДО анимации
 * (взвешенный RNG), а колесо просто «подъезжает» к нему с замедлением.
 * На проде результат должен приходить с сервера (provably-fair).
 */
import { h, icon, mount } from '../core/dom.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { haptic } from '../services/telegram.js';
import { state, set, addSpins, consumeSpin } from '../core/store.js';

/** Зачислить выигрыш демо-слота на баланс/прокруты (прокруты зажаты потолком). */
function creditPrize(slot) {
  const bonus = { s1: 1, s5: 5, s10: 10, s50: 50 }[slot.id];
  if (bonus) { set('balance', (b) => { b.usdt += bonus; }); return; }
  if (slot.id === 'spin1') addSpins(1);
  if (slot.id === 'spin3') addSpins(3);
  // fee / miss — без зачисления (демо)
}

/* Демо-слоты: у каждого свой цвет (c — заливка, c2 — для лёгкого градиента
   внутри сектора), weight — относительный шанс. Порядок = по часовой стрелке. */
export const WHEEL_SLOTS = [
  { id: 's5',   label: '+5 USDT',      short: '+5',   weight: 20, c: '#f7a600', c2: '#ffc24d' },
  { id: 'spin1',label: 'Спин ×1',      short: '×1',   weight: 16, c: '#2ebd85', c2: '#53e0a6' },
  { id: 'fee',  label: '−50% комиссия', short: '−50%', weight: 12, c: '#4a9bff', c2: '#7cb8ff' },
  { id: 's1',   label: '+1 USDT',      short: '+1',   weight: 24, c: '#8b5cf6', c2: '#a981ff' },
  { id: 'miss', label: 'Мимо',         short: '—',    weight: 18, c: '#3a4150', c2: '#4b5566' },
  { id: 's10',  label: '+10 USDT',     short: '+10',  weight: 10, c: '#ec4899', c2: '#ff6fb3' },
  { id: 'spin3',label: 'Спин ×3',      short: '×3',   weight: 6,  c: '#06b6d4', c2: '#3fd6ef' },
  { id: 's50',  label: '+50 USDT',     short: '+50',  weight: 2,  c: '#ff5a3c', c2: '#ff8463' },
];

/** Взвешенный выбор индекса сектора. */
function pickIndex() {
  const total = WHEEL_SLOTS.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WHEEL_SLOTS.length; i++) {
    r -= WHEEL_SLOTS[i].weight;
    if (r <= 0) return i;
  }
  return WHEEL_SLOTS.length - 1;
}

/** conic-gradient из секторов, каждый своим цветом + тонкие разделители. */
function wheelGradient() {
  const n = WHEEL_SLOTS.length;
  const step = 360 / n;
  const gap = 0.8;   // градусов на разделитель
  const stops = [];
  WHEEL_SLOTS.forEach((s, i) => {
    const a0 = i * step;
    const a1 = (i + 1) * step;
    stops.push(`${s.c} ${a0 + gap}deg ${a1 - gap}deg`);
    stops.push(`rgba(0,0,0,.35) ${a1 - gap}deg ${a1 + gap}deg`);
  });
  return `conic-gradient(from -${step / 2}deg, ${stops.join(', ')})`;
}

export function openWheelSheet() {
  const n = WHEEL_SLOTS.length;
  const step = 360 / n;
  let angle = 0;          // накопленный угол поворота
  let spinning = false;
  let lastSpinAt = 0;     // анти-дабл-клик

  const wheel = h('div.fw-wheel', { style: { background: wheelGradient() } },
    // подписи секторов (контейнер повёрнут к сектору, текст контр-вращением держим ровным)
    ...WHEEL_SLOTS.map((s, i) => h('div.fw-label', {
      style: { '--a': `${i * step}deg`, transform: `rotate(${i * step}deg)` },
    }, h('span', { style: { color: s.id === 'miss' ? '#eaecef' : '#111' } }, s.short))),
    h('div.fw-hub', icon('zap')),
  );

  const spinBtn = h('button.btn.btn-primary.btn-block.fw-spin', { onClick: spin });
  const spinsChip = h('span.badge.badge-acid');

  function updateSpinBtn() {
    const spins = state.wheel.spins;
    spinsChip.textContent = `${spins} прокрут${spins === 1 ? '' : spins >= 2 && spins <= 4 ? 'а' : 'ов'}`;
    if (spinning) { spinBtn.disabled = true; mount(spinBtn, 'Крутится…'); return; }
    spinBtn.disabled = spins <= 0;
    mount(spinBtn, spins > 0 ? [icon('refresh'), 'Прокрутить'] : [icon('info'), 'Нет прокрутов — выполни задания']);
  }

  const resultEl = h('div.fw-result', { 'aria-live': 'polite' });

  function spin() {
    // анти-абуз: блок повторного входа + атомарное списание прокрута
    if (spinning) return;
    if (Date.now() - lastSpinAt < 500) return;   // защита от дабл-клика
    if (!consumeSpin()) { updateSpinBtn(); return; }
    lastSpinAt = Date.now();
    spinning = true;
    updateSpinBtn();
    mount(resultEl, '');
    haptic('medium');

    const idx = pickIndex();                 // результат выбран заранее
    const target = WHEEL_SLOTS[idx];

    // целевой угол: несколько полных оборотов + подводим центр сектора к указателю (сверху)
    const turns = 5 + Math.floor(Math.random() * 3);
    const jitter = (Math.random() - 0.5) * step * 0.6;   // не ровно в центр
    const base = angle - (angle % 360);                  // от текущего положения
    angle = base + turns * 360 - idx * step + jitter;
    wheel.style.transition = 'transform 4.6s cubic-bezier(.16,1,.3,1)';
    wheel.style.transform = `rotate(${angle}deg)`;

    const done = () => {
      wheel.removeEventListener('transitionend', done);
      spinning = false;
      const win = target.id !== 'miss';
      haptic(win ? 'success' : 'warning');
      creditPrize(target);
      set('wheel', (w) => { w.lastResult = target.id; w.history.unshift(target.id); if (w.history.length > 20) w.history.pop(); });
      updateSpinBtn();
      mount(resultEl,
        h(`div.fw-win${win ? '' : ' is-miss'}`,
          icon(win ? 'zap' : 'info'),
          h('span', win ? `Выпало: ${target.label}` : 'Увы, мимо — попробуй ещё'),
        ),
      );
      if (win) toast('Колесо фортуны', target.label, 'ok');
    };
    wheel.addEventListener('transitionend', done);
    // страховка, если transitionend не придёт
    setTimeout(() => { if (spinning) done(); }, 5200);
  }
  updateSpinBtn();

  openSheet({
    title: 'Колесо фортуны',
    subtitle: 'Крути и забирай приз',
    body: h('div.fw',
      h('div', { style: { marginBottom: '8px' } }, spinsChip),
      h('div.fw-stage',
        h('div.fw-pointer', aria('')),
        wheel,
      ),
      resultEl,
      h('div.fw-slots',
        WHEEL_SLOTS.map((s) => h('div.fw-slot',
          h('i', { style: { background: s.c } }),
          h('span.fw-slot-l', s.label),
        )),
      ),
      h('div.note', { style: { marginTop: '12px' } }, icon('info'),
        'Демо-слоты. На проде призы и число прокрутов приходят с сервера (provably-fair), спины зарабатываются за задания.'),
    ),
    foot: [spinBtn],
  });
}

function aria() { const e = h('span'); e.setAttribute('aria-hidden', 'true'); return e; }
