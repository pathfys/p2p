/**
 * Загрузочный экран. Прогресс привязан к реальным этапам старта,
 * а не к таймеру — но держим минимальную выдержку, чтобы заставка не мигала.
 */
import { qs } from '../core/dom.js';

const MIN_VISIBLE = 1700;   // мс — сколько сплэш показывается минимум
const t0 = Date.now();

const STEPS = [
  { at: 12,  text: 'инициализация…' },
  { at: 34,  text: 'восстановление профиля' },
  { at: 56,  text: 'подключение к биржам' },
  { at: 78,  text: 'загрузка стаканов' },
  { at: 100, text: 'готово' },
];

let step = -1;
let done = false;

export function splashStep(i) {
  if (done || i <= step) return;
  step = Math.min(i, STEPS.length - 1);
  const s = STEPS[step];
  const bar = qs('#sp-progress');
  const hint = qs('#sp-hint');
  if (bar) bar.style.width = s.at + '%';
  if (hint) hint.textContent = s.text;
}

export function splashDone() {
  if (done) return;
  done = true;
  splashStep(STEPS.length - 1);

  const wait = Math.max(0, MIN_VISIBLE - (Date.now() - t0));
  setTimeout(() => {
    const el = qs('#splash');
    if (!el) return;
    el.classList.add('is-gone');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 900);     // подстраховка, если transitionend не придёт
  }, wait);
}

/** Сплэш не должен залипать навсегда, если что-то пошло не так на старте. */
export function splashGuard(ms = 6000) {
  setTimeout(splashDone, ms);
}
