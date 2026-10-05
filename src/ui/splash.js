/**
 * Загрузочный экран.
 * Последовательность: предметы прилетают с разных сторон (CSS-анимация) →
 * пауза → затемнение, предметы исчезают (.is-leaving) → снятие сплэша →
 * под ним уже смонтирован главный экран.
 */
import { qs } from '../core/dom.js';

const t0 = Date.now();
const HOLD = 1750;    // прилёт предметов + пауза до начала ухода, мс
const LEAVE = 640;    // длительность затемнения/исчезновения, мс

let leaving = false;
let removed = false;

function removeSplash() {
  if (removed) return;
  removed = true;
  qs('#splash')?.remove();
}

/** Запустить уход сплэша (не раньше, чем предметы прилетят). */
export function splashLeave() {
  if (leaving) return;
  leaving = true;
  const run = () => {
    const el = qs('#splash');
    if (!el) return;
    el.classList.add('is-leaving');
    setTimeout(removeSplash, LEAVE + 80);
  };
  setTimeout(run, Math.max(0, HOLD - (Date.now() - t0)));
}

/** Страховка: сплэш не должен залипнуть навсегда. */
export function splashGuard(ms = 6000) {
  setTimeout(splashLeave, ms);
}
