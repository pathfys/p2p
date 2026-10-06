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

/* Демо-слоты: label — что показываем, weight — относительный шанс,
   tone — цвет сектора. Порядок = как на колесе по часовой стрелке. */
export const WHEEL_SLOTS = [
  { id: 's5',   label: '+5 USDT',   short: '+5',    weight: 20, tone: 'a' },
  { id: 'spin1',label: 'Спин ×1',   short: '×1',    weight: 16, tone: 'b' },
  { id: 'fee',  label: '−50% комиссия', short: '−50%', weight: 12, tone: 'a' },
  { id: 's1',   label: '+1 USDT',   short: '+1',    weight: 24, tone: 'b' },
  { id: 'miss', label: 'Мимо',      short: '—',     weight: 18, tone: 'c' },
  { id: 's10',  label: '+10 USDT',  short: '+10',   weight: 10, tone: 'a' },
  { id: 'spin3',label: 'Спин ×3',   short: '×3',    weight: 6,  tone: 'b' },
  { id: 's50',  label: '+50 USDT',  short: '+50',   weight: 2,  tone: 'd' },
];

const TONE = {
  a: 'var(--acid)',
  b: 'var(--buy)',
  c: 'var(--panel-3)',
  d: '#ff8a1e',
};

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

/** conic-gradient из секторов. */
function wheelGradient() {
  const n = WHEEL_SLOTS.length;
  const step = 360 / n;
  const stops = WHEEL_SLOTS.map((s, i) => `${TONE[s.tone]} ${i * step}deg ${(i + 1) * step}deg`);
  return `conic-gradient(from -${step / 2}deg, ${stops.join(', ')})`;
}

export function openWheelSheet() {
  const n = WHEEL_SLOTS.length;
  const step = 360 / n;
  let angle = 0;          // накопленный угол поворота
  let spinning = false;

  const wheel = h('div.fw-wheel', { style: { background: wheelGradient() } },
    // подписи секторов (контейнер повёрнут к сектору, текст контр-вращением держим ровным)
    ...WHEEL_SLOTS.map((s, i) => h('div.fw-label', {
      style: { '--a': `${i * step}deg`, transform: `rotate(${i * step}deg)` },
    }, h('span', s.short))),
    h('div.fw-hub', icon('zap')),
  );

  const spinBtn = h('button.btn.btn-primary.btn-block.fw-spin', { onClick: spin },
    icon('refresh'), 'Прокрутить');

  const resultEl = h('div.fw-result', { 'aria-live': 'polite' });

  function spin() {
    if (spinning) return;
    spinning = true;
    spinBtn.disabled = true;
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
      spinBtn.disabled = false;
      const win = target.id !== 'miss';
      haptic(win ? 'success' : 'warning');
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

  openSheet({
    title: 'Колесо фортуны',
    subtitle: 'Крути и забирай приз',
    body: h('div.fw',
      h('div.fw-stage',
        h('div.fw-pointer', aria('')),
        wheel,
      ),
      resultEl,
      h('div.fw-slots',
        WHEEL_SLOTS.map((s) => h('div.fw-slot',
          h('i', { style: { background: TONE[s.tone] } }),
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
