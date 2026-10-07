/**
 * KYC: приём анкеты на верификацию и асинхронный вердикт. Реального провайдера
 * нет — решение имитируется отложенным таймером, после чего пушится клиенту
 * по WS. Персональные данные НЕ принимаются и НЕ хранятся: в проде документы
 * идут напрямую провайдеру по одноразовому токену, бэкенд получает только
 * статус. Лимиты по уровню — серверные (см. domain/kyc.ts).
 */
import type { Clock, IdGen, KycRepo, Logger } from '../ports.js';
import type { KycState } from '../domain/types.js';
import { assertCanSubmit, initialKyc, toApproved, toPending, toRejected } from '../domain/kyc.js';
import type { UserEventBus } from './user-events.js';

const REVIEW_DELAY_MS = 4000;

export class KycService {
  constructor(
    private readonly kyc: KycRepo,
    private readonly events: UserEventBus,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly log: Logger,
  ) {}

  async get(userId: string): Promise<KycState> {
    return (await this.kyc.get(userId)) ?? initialKyc();
  }

  /** Подать заявку. Тело анкеты не принимаем — только целевой уровень. */
  async submit(userId: string, level: number): Promise<KycState> {
    const state = await this.get(userId);
    assertCanSubmit(state, level);
    const now = this.clock.now();
    const pending = toPending(state, level, now);
    await this.kyc.set(userId, pending);
    this.scheduleReview(userId, level);
    return pending;
  }

  /** Имитация асинхронного вердикта провайдера. */
  private scheduleReview(userId: string, level: number): void {
    const timer = setTimeout(() => {
      void this.finishReview(userId, level);
    }, REVIEW_DELAY_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private async finishReview(userId: string, level: number): Promise<void> {
    const state = await this.get(userId);
    if (state.status !== 'pending' || state.pendingLevel !== level) return; // заявка изменилась
    const now = this.clock.now();
    // 90% одобрений — детерминированно по криптоисточнику
    const approved = this.ids.random() < 0.9;
    const next = approved ? toApproved(state, now) : toRejected(state, 'Не удалось подтвердить данные. Проверьте корректность и отправьте снова.', now);
    await this.kyc.set(userId, next);
    this.events.emit(userId, {
      type: 'kyc',
      data: { status: next.status, level: next.level, reviewedAt: now, rejectReason: next.rejectReason },
    });
    this.log.log('info', 'kyc reviewed', { userId, status: next.status, level: next.level });
  }

  /** Сброс верификации пользователем. */
  async reset(userId: string): Promise<KycState> {
    const fresh = initialKyc();
    await this.kyc.set(userId, fresh);
    return fresh;
  }
}
