/**
 * Подписки: оформление (в т.ч. однодневный пробный, однократно), отмена, чтение.
 * Оплата в проде проходит через платёжный провайдер и подтверждается вебхуком;
 * здесь подписка активируется сразу (демо). Гейт «лучших стаканов» (только
 * quarter) решается в domain/subscription.ts и применяется при создании сделки.
 */
import type { Clock, SubscriptionRepo } from '../ports.js';
import type { PlanId, Subscription } from '../domain/types.js';
import {
  PLANS, activePlan, cancel, canUseBestOffers, initialSubscription, isPlanId, subscribe,
} from '../domain/subscription.js';
import { err } from '../domain/errors.js';

export interface SubscriptionView {
  subscription: Subscription;
  activePlanId: PlanId | null;
  bestOffers: boolean;
  remainingMs: number;
}

export class SubscriptionService {
  constructor(
    private readonly subs: SubscriptionRepo,
    private readonly clock: Clock,
  ) {}

  plans(): typeof PLANS {
    return PLANS;
  }

  async get(userId: string): Promise<Subscription> {
    return (await this.subs.get(userId)) ?? initialSubscription();
  }

  async view(userId: string): Promise<SubscriptionView> {
    const now = this.clock.now();
    const subscription = await this.get(userId);
    const plan = activePlan(subscription, now);
    return {
      subscription,
      activePlanId: plan ? plan.id : null,
      bestOffers: canUseBestOffers(subscription, now),
      remainingMs: plan && subscription.until ? Math.max(0, subscription.until - now) : 0,
    };
  }

  async subscribe(userId: string, planId: string): Promise<SubscriptionView> {
    if (!isPlanId(planId)) throw err('validation', 'Неизвестный тариф');
    const now = this.clock.now();
    const current = await this.get(userId);
    const next = subscribe(current, planId, now); // бросит conflict при повторном пробном
    await this.subs.set(userId, next);
    return this.view(userId);
  }

  async cancel(userId: string): Promise<SubscriptionView> {
    const current = await this.get(userId);
    await this.subs.set(userId, cancel(current));
    return this.view(userId);
  }

  async canUseBestOffers(userId: string): Promise<boolean> {
    return canUseBestOffers(await this.get(userId), this.clock.now());
  }
}
