/**
 * Жизненный цикл сделки как конечный автомат. Доменная логика переходов живёт
 * здесь; сервис только применяет результат. Деньги — поэтому переходы строгие.
 */
import type { DealStatus } from './types.js';
import { err } from './errors.js';

/** Разрешённые переходы статусов. */
const TRANSITIONS: Record<DealStatus, readonly DealStatus[]> = {
  created: ['paid', 'cancelled', 'disputed'],
  paid: ['released', 'cancelled', 'disputed'],
  released: ['done', 'disputed'],
  done: [],
  cancelled: [],
  disputed: ['released', 'cancelled'],
};

export const isTerminal = (s: DealStatus): boolean => TRANSITIONS[s].length === 0;

export function canTransition(from: DealStatus, to: DealStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Бросает DomainError(conflict), если переход недопустим. */
export function assertTransition(from: DealStatus, to: DealStatus): void {
  if (!canTransition(from, to)) {
    throw err('conflict', `Недопустимый переход сделки: ${from} → ${to}`);
  }
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов

/** Человекочитаемый референс сделки: P2D-XXXXXX. rng ∈ [0,1). */
export function makeRef(rng: () => number): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[Math.floor(rng() * REF_ALPHABET.length)];
  return `P2D-${s}`;
}
