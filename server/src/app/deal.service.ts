/**
 * Сделки — денежный путь, самый критичный. Гарантии (дублируют и перекрывают
 * клиентский preflight, который обойти тривиально):
 *   • идемпотентность по (userId, Idempotency-Key) — ретрай не создаёт второй ордер;
 *   • все лимиты серверные: лимиты офера (min/max, ликвидность), дневной KYC-лимит;
 *   • доступ к «лучшим стаканам» только на тарифе quarter;
 *   • резервирование средств при создании, расчёт/возврат при done/cancel.
 * Переходы статусов — строгий автомат (domain/deal.ts).
 */
import type {
  BalanceRepo, CardRepo, Clock, DealRepo, IdGen, KycRepo, Logger, TtlStore,
} from '../ports.js';
import type { Deal, Side } from '../domain/types.js';
import { assertTransition, isTerminal, makeRef } from '../domain/deal.js';
import { canTrade, dayLimitFor, initialKyc } from '../domain/kyc.js';
import { usdtToAsset, isKnownAsset, isKnownCurrency } from '../domain/money.js';
import { err } from '../domain/errors.js';
import type { FeedHub } from './feed.service.js';
import type { SubscriptionService } from './subscription.service.js';
import type { UserEventBus } from './user-events.js';

export interface CreateDealInput {
  offerId: unknown;
  asset: unknown;
  fiat: unknown;
  side: unknown;
  volumeUsdt: unknown;
  method: unknown;
  cardId?: unknown;
}

const MAX_DEAL_USDT = 1e9;
const IDEM_TTL_MS = 10 * 60 * 1000;
const RELEASE_DELAY_MS = 2500;
const DONE_DELAY_MS = 2500;

export class DealService {
  constructor(
    private readonly deals: DealRepo,
    private readonly feed: FeedHub,
    private readonly kyc: KycRepo,
    private readonly subs: SubscriptionService,
    private readonly balances: BalanceRepo,
    private readonly cards: CardRepo,
    private readonly idem: TtlStore,
    private readonly events: UserEventBus,
    private readonly ids: IdGen,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  // сериализация операций одного пользователя: устраняет гонку проверки/списания
  // баланса при конкурентных запросах (TOCTOU) в рамках одного инстанса.
  private readonly userChain = new Map<string, Promise<void>>();

  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userChain.get(key) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(() => undefined, () => undefined);
    this.userChain.set(key, tail);
    void tail.finally(() => {
      if (this.userChain.get(key) === tail) this.userChain.delete(key);
    });
    return run;
  }

  create(userId: string, input: CreateDealInput, idemKey: string): Promise<Deal> {
    return this.runExclusive(userId, () => this.createInner(userId, input, idemKey));
  }

  private async createInner(userId: string, input: CreateDealInput, idemKey: string): Promise<Deal> {
    if (typeof idemKey !== 'string' || idemKey.length < 1 || idemKey.length > 128) {
      throw err('validation', 'Требуется корректный Idempotency-Key');
    }
    // 0) идемпотентность: уже созданная по этому ключу сделка возвращается как есть
    const prior = await this.deals.findByIdemKey(userId, idemKey);
    if (prior) return prior;

    // блокировка от гонки одинаковых ретраев в пределах окна
    const lockKey = `deal:${userId}:${idemKey}`;
    if (!this.idem.putIfAbsent(lockKey, IDEM_TTL_MS)) {
      const again = await this.deals.findByIdemKey(userId, idemKey);
      if (again) return again;
      throw err('conflict', 'Дубликат запроса в обработке, повторите позже');
    }

    const offerId = String(input.offerId ?? '');
    const asset = String(input.asset ?? '');
    const fiat = String(input.fiat ?? '');
    const side: Side = input.side === 'sell' ? 'sell' : 'buy';
    const volumeUsdt = Number(input.volumeUsdt);
    const method = String(input.method ?? '');
    const cardId = input.cardId === undefined || input.cardId === null ? null : String(input.cardId);

    if (!offerId || offerId.length > 96) throw err('validation', 'offerId обязателен');
    if (!isKnownAsset(asset)) throw err('validation', 'Неизвестный актив');
    if (!isKnownCurrency(fiat)) throw err('validation', 'Неизвестная валюта');
    if (!Number.isFinite(volumeUsdt) || volumeUsdt <= 0 || volumeUsdt > MAX_DEAL_USDT) {
      throw err('validation', 'Некорректный объём в USDT');
    }

    // 1) KYC
    const kyc = (await this.kyc.get(userId)) ?? initialKyc();
    if (!canTrade(kyc)) throw err('kyc_required', 'Нужна KYC-верификация (уровень 1 и выше)');

    // 2) офер — из серверного кэша стакана (не из запроса клиента).
    //    getMarket поднимает рынок, если он был вытеснен по простою.
    const offer = this.feed.getMarket(asset, fiat, side).offers.find((o) => o.id === offerId) ?? null;
    if (!offer) throw err('not_found', 'Офер снят с биржи или не найден');
    if (offer.merchant.blocked) throw err('forbidden', 'Мерчант в блок-листе');
    if (!offer.methods.includes(method)) throw err('validation', 'Способ оплаты недоступен у офера');
    if (offer.kycRequired > kyc.level) throw err('kyc_required', `Офер требует KYC уровня ${offer.kycRequired}`);

    // 3) экономика
    const amountAsset = usdtToAsset(volumeUsdt, asset);
    const fiatTotal = amountAsset * offer.price;
    if (amountAsset > offer.available) throw err('limit_exceeded', 'Недостаточно ликвидности у офера');
    if (fiatTotal < offer.min || fiatTotal > offer.max) {
      throw err('limit_exceeded', `Объём вне лимитов офера (${offer.min}–${offer.max} ${fiat})`);
    }

    // 4) дневной лимит KYC
    const dayLimit = dayLimitFor(kyc.level);
    if (Number.isFinite(dayLimit)) {
      const used = await this.deals.dayVolumeUsdt(userId, this.clock.now() - 86_400_000);
      if (used + volumeUsdt > dayLimit) {
        throw err('limit_exceeded', `Превышен дневной лимит уровня KYC (${dayLimit} USDT)`);
      }
    }

    // 5) гейт лучших стаканов → только quarter
    if (this.feed.isBestOffer(asset, fiat, side, offerId, volumeUsdt)) {
      if (!(await this.subs.canUseBestOffers(userId))) {
        throw err('plan_required', 'Лучшие стаканы доступны только на тарифе «3 месяца»');
      }
    }

    // 6) резервирование средств
    if (side === 'buy') {
      if (!cardId) throw err('validation', 'Для покупки нужна карта');
      const card = await this.cards.get(userId, cardId);
      if (!card || !card.active) throw err('validation', 'Карта не найдена или отключена');
      if (card.currency !== fiat) throw err('validation', 'Валюта карты не совпадает с валютой офера');
      if (card.balance < fiatTotal) throw err('insufficient_funds', 'Недостаточно средств на карте');
      await this.cards.upsert(userId, { ...card, balance: card.balance - fiatTotal });
    } else {
      const bal = await this.balances.getUsdt(userId);
      if (bal < amountAsset) throw err('insufficient_funds', 'Недостаточно USDT для продажи');
      await this.balances.setUsdt(userId, bal - amountAsset);
    }

    const now = this.clock.now();
    const deal: Deal = {
      id: this.ids.uid('deal'),
      ref: makeRef(() => this.ids.random()),
      userId,
      offerId,
      exchange: offer.exchange,
      side,
      asset,
      fiat,
      price: offer.price,
      amountAsset,
      volumeUsdt,
      fiatTotal,
      method,
      cardId,
      status: 'created',
      idemKey,
      createdAt: now,
      updatedAt: now,
    };
    await this.deals.create(deal);
    this.log.log('info', 'deal created', { userId, dealId: deal.id, ref: deal.ref, volumeUsdt });
    return deal;
  }

  async get(userId: string, dealId: string): Promise<Deal> {
    const d = await this.deals.get(dealId);
    if (!d || d.userId !== userId) throw err('not_found', 'Сделка не найдена');
    return d;
  }

  list(userId: string, limit: number): Promise<Deal[]> {
    return this.deals.listByUser(userId, Math.max(1, Math.min(200, limit)));
  }

  /** Пользователь отметил оплату: created → paid, затем авто released → done. */
  async markPaid(userId: string, dealId: string): Promise<Deal> {
    const deal = await this.get(userId, dealId);
    assertTransition(deal.status, 'paid');
    const updated = await this.transition(deal, 'paid');
    this.scheduleSettlement(userId, dealId);
    return updated;
  }

  async cancel(userId: string, dealId: string): Promise<Deal> {
    const deal = await this.get(userId, dealId);
    if (isTerminal(deal.status) || deal.status === 'released') {
      throw err('conflict', 'Сделку уже нельзя отменить');
    }
    assertTransition(deal.status, 'cancelled');
    await this.refund(deal);
    return this.transition(deal, 'cancelled');
  }

  /* ───────────── внутреннее ───────────── */

  private async transition(deal: Deal, status: Deal['status']): Promise<Deal> {
    const now = this.clock.now();
    const next = (await this.deals.updateStatus(deal.id, status, now)) ?? { ...deal, status, updatedAt: now };
    this.events.emit(deal.userId, { type: 'deal', data: { dealId: deal.id, ref: deal.ref, status, at: now } });
    return next;
  }

  private scheduleSettlement(userId: string, dealId: string): void {
    const t1 = setTimeout(() => {
      void (async () => {
        const d = await this.deals.get(dealId);
        if (!d || d.userId !== userId || d.status !== 'paid') return;
        await this.transition(d, 'released');
        const t2 = setTimeout(() => {
          void (async () => {
            const d2 = await this.deals.get(dealId);
            if (!d2 || d2.status !== 'released') return;
            await this.settle(d2);
            await this.transition(d2, 'done');
          })();
        }, DONE_DELAY_MS);
        if (typeof t2.unref === 'function') t2.unref();
      })();
    }, RELEASE_DELAY_MS);
    if (typeof t1.unref === 'function') t1.unref();
  }

  /** Зачисление по завершении сделки. */
  private async settle(deal: Deal): Promise<void> {
    if (deal.side === 'buy') {
      const bal = await this.balances.getUsdt(deal.userId);
      await this.balances.setUsdt(deal.userId, bal + deal.amountAsset);
    } else if (deal.cardId) {
      const card = await this.cards.get(deal.userId, deal.cardId);
      if (card) await this.cards.upsert(deal.userId, { ...card, balance: card.balance + deal.fiatTotal });
    }
  }

  /** Возврат резерва при отмене. */
  private async refund(deal: Deal): Promise<void> {
    if (deal.side === 'buy') {
      if (!deal.cardId) return;
      const card = await this.cards.get(deal.userId, deal.cardId);
      if (card) await this.cards.upsert(deal.userId, { ...card, balance: card.balance + deal.fiatTotal });
    } else {
      const bal = await this.balances.getUsdt(deal.userId);
      await this.balances.setUsdt(deal.userId, bal + deal.amountAsset);
    }
  }
}
