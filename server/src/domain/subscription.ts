/**
 * Подписки. Три платных срока + однодневный пробный период. Лучшие стаканы
 * («★ Лучшая» / «ТОП») открывает только активный тариф «3 месяца» (quarter).
 * Форма зеркалит фронтовый src/core/store.js, но решение — серверное.
 */
import type { PlanId, Subscription } from './types.js';
import { err } from './errors.js';

export const DAY_MS = 86_400_000;

export interface Plan {
  id: PlanId;
  name: string;
  term: string;
  priceUsd: number;
  days: number;
  bestOffers: boolean;
}

export const PLANS: readonly Plan[] = [
  { id: 'trial', name: 'Пробный', term: '1 день', priceUsd: 0, days: 1, bestOffers: false },
  { id: 'week', name: 'Неделя', term: '7 дней', priceUsd: 20, days: 7, bestOffers: false },
  { id: 'month', name: 'Месяц', term: '30 дней', priceUsd: 100, days: 30, bestOffers: false },
  { id: 'quarter', name: '3 месяца', term: '90 дней', priceUsd: 200, days: 90, bestOffers: true },
];

const PLAN_BY_ID = new Map(PLANS.map((p) => [p.id, p]));

export const planById = (id: string): Plan | undefined => PLAN_BY_ID.get(id as PlanId);
export const isPlanId = (id: string): id is PlanId => PLAN_BY_ID.has(id as PlanId);

export function initialSubscription(): Subscription {
  return { plan: null, since: null, until: null, trialUsed: false };
}

export function isActive(sub: Subscription, now: number): boolean {
  if (!sub.plan) return false;
  return sub.until === null || now <= sub.until;
}

export function activePlan(sub: Subscription, now: number): Plan | null {
  return isActive(sub, now) ? planById(sub.plan as string) ?? null : null;
}

export function canUseBestOffers(sub: Subscription, now: number): boolean {
  const p = activePlan(sub, now);
  return !!p && p.bestOffers;
}

/** Оформить подписку. Бросает DomainError при повторном пробном. */
export function subscribe(sub: Subscription, planId: PlanId, now: number): Subscription {
  const plan = planById(planId);
  if (!plan) throw err('validation', 'Неизвестный тариф');
  if (plan.id === 'trial' && sub.trialUsed) throw err('conflict', 'Пробный период уже использован');
  return {
    plan: plan.id,
    since: now,
    until: now + plan.days * DAY_MS,
    trialUsed: sub.trialUsed || plan.id === 'trial',
  };
}

export function cancel(sub: Subscription): Subscription {
  return { ...sub, plan: null, since: null, until: null };
}
