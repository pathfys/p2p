/**
 * Аккаунт: баланс USDT и платёжные карты. Деньги и карты — серверное состояние
 * (на фронте они сейчас в localStorage; бэкенд даёт им единый источник истины).
 */
import type { BalanceRepo, CardRepo, IdGen } from '../ports.js';
import type { Card } from '../domain/types.js';
import { isKnownCurrency } from '../domain/money.js';
import { plainText } from '../adapters/security/sanitize.js';
import { err } from '../domain/errors.js';

export interface CardInput {
  label: unknown;
  bank: unknown;
  number: unknown; // полный номер не храним — берём только последние 4
  balance: unknown;
  currency: unknown;
  active?: unknown;
}

const MAX_BALANCE = 1e12;

export class AccountService {
  constructor(
    private readonly balances: BalanceRepo,
    private readonly cards: CardRepo,
    private readonly ids: IdGen,
  ) {}

  getBalance(userId: string): Promise<number> {
    return this.balances.getUsdt(userId);
  }

  listCards(userId: string): Promise<Card[]> {
    return this.cards.list(userId);
  }

  async setBalance(userId: string, mode: 'set' | 'deposit' | 'withdraw', amount: unknown): Promise<number> {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0 || n > MAX_BALANCE) throw err('validation', 'Некорректная сумма');
    const cur = await this.balances.getUsdt(userId);
    let next: number;
    if (mode === 'set') next = n;
    else if (mode === 'deposit') next = cur + n;
    else {
      if (n > cur) throw err('insufficient_funds', 'Недостаточно средств');
      next = cur - n;
    }
    await this.balances.setUsdt(userId, next);
    return next;
  }

  async upsertCard(userId: string, input: CardInput, cardId?: string): Promise<Card> {
    const label = plainText(input.label, 40);
    if (!label) throw err('validation', 'Укажите название карты');
    const digits = String(input.number ?? '').replace(/\D/g, '');
    if (digits.length < 12 || digits.length > 19) throw err('validation', 'Номер карты должен быть 12–19 цифр');
    const currency = String(input.currency ?? 'RUB');
    if (!isKnownCurrency(currency)) throw err('validation', 'Неизвестная валюта карты');
    const balance = Number(input.balance);
    if (!Number.isFinite(balance) || balance < 0 || balance > MAX_BALANCE) throw err('validation', 'Некорректный баланс карты');

    const existing = cardId ? await this.cards.get(userId, cardId) : null;
    if (cardId && !existing) throw err('not_found', 'Карта не найдена');

    const card: Card = {
      id: existing?.id ?? this.ids.uid('card'),
      label,
      bank: plainText(input.bank, 24) || 'bank',
      last4: digits.slice(-4), // полный PAN не сохраняем (PCI-гигиена)
      balance,
      currency,
      active: input.active === undefined ? existing?.active ?? true : Boolean(input.active),
    };
    await this.cards.upsert(userId, card);
    return card;
  }

  async removeCard(userId: string, cardId: string): Promise<void> {
    const existing = await this.cards.get(userId, cardId);
    if (!existing) throw err('not_found', 'Карта не найдена');
    await this.cards.remove(userId, cardId);
  }
}
