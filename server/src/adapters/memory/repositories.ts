/**
 * In-memory реализации портов хранилища. Для разработки/демо и как эталон
 * поведения для тестов. Прод-адаптер (Postgres/Redis) реализует те же
 * интерфейсы из ports.ts и подставляется в main.ts без правок сервисов.
 *
 * Границы безопасности, заложенные здесь и обязательные для любого адаптера:
 *  - идемпотентность сделок по (userId, idemKey);
 *  - дневной объём считается по серверным записям, а не по клиентским числам.
 */
import type {
  BalanceRepo, CardRepo, DealRepo, KycRepo, SubscriptionRepo, TtlStore, UserRepo,
} from '../../ports.js';
import type { Card, Deal, DealStatus, KycState, Subscription, User } from '../../domain/types.js';
import { DAY_MS } from '../../domain/subscription.js';

export class MemoryUserRepo implements UserRepo {
  private readonly byId = new Map<string, User>();
  private readonly byTg = new Map<string, string>();
  async getById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }
  async getByTgId(tgId: string): Promise<User | null> {
    const id = this.byTg.get(tgId);
    return id ? this.byId.get(id) ?? null : null;
  }
  async create(user: User): Promise<User> {
    this.byId.set(user.id, user);
    this.byTg.set(user.tgId, user.id);
    return user;
  }
}

export class MemoryKycRepo implements KycRepo {
  private readonly m = new Map<string, KycState>();
  async get(userId: string): Promise<KycState | null> {
    return this.m.get(userId) ?? null;
  }
  async set(userId: string, state: KycState): Promise<void> {
    this.m.set(userId, state);
  }
}

export class MemorySubscriptionRepo implements SubscriptionRepo {
  private readonly m = new Map<string, Subscription>();
  async get(userId: string): Promise<Subscription | null> {
    return this.m.get(userId) ?? null;
  }
  async set(userId: string, sub: Subscription): Promise<void> {
    this.m.set(userId, sub);
  }
}

export class MemoryBalanceRepo implements BalanceRepo {
  private readonly m = new Map<string, number>();
  async getUsdt(userId: string): Promise<number> {
    return this.m.get(userId) ?? 0;
  }
  async setUsdt(userId: string, usdt: number): Promise<void> {
    this.m.set(userId, Math.max(0, usdt));
  }
}

export class MemoryCardRepo implements CardRepo {
  private readonly m = new Map<string, Map<string, Card>>();
  private bucket(userId: string): Map<string, Card> {
    let b = this.m.get(userId);
    if (!b) {
      b = new Map();
      this.m.set(userId, b);
    }
    return b;
  }
  async list(userId: string): Promise<Card[]> {
    return [...this.bucket(userId).values()];
  }
  async get(userId: string, cardId: string): Promise<Card | null> {
    return this.bucket(userId).get(cardId) ?? null;
  }
  async upsert(userId: string, card: Card): Promise<void> {
    this.bucket(userId).set(card.id, card);
  }
  async remove(userId: string, cardId: string): Promise<void> {
    this.bucket(userId).delete(cardId);
  }
}

export class MemoryDealRepo implements DealRepo {
  private readonly byId = new Map<string, Deal>();
  private readonly byIdem = new Map<string, string>(); // `${userId}:${idemKey}` -> dealId

  async create(deal: Deal): Promise<void> {
    this.byId.set(deal.id, deal);
    this.byIdem.set(`${deal.userId}:${deal.idemKey}`, deal.id);
  }
  async get(dealId: string): Promise<Deal | null> {
    return this.byId.get(dealId) ?? null;
  }
  async findByIdemKey(userId: string, idemKey: string): Promise<Deal | null> {
    const id = this.byIdem.get(`${userId}:${idemKey}`);
    return id ? this.byId.get(id) ?? null : null;
  }
  async updateStatus(dealId: string, status: DealStatus, at: number): Promise<Deal | null> {
    const d = this.byId.get(dealId);
    if (!d) return null;
    const next: Deal = { ...d, status, updatedAt: at };
    this.byId.set(dealId, next);
    return next;
  }
  async listByUser(userId: string, limit: number): Promise<Deal[]> {
    return [...this.byId.values()]
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(0, limit));
  }
  async dayVolumeUsdt(userId: string, from: number): Promise<number> {
    let sum = 0;
    for (const d of this.byId.values()) {
      if (d.userId !== userId) continue;
      if (d.createdAt < from) continue;
      if (d.status === 'cancelled') continue; // отменённые не занимают лимит
      sum += d.volumeUsdt;
    }
    return sum;
  }
}

/**
 * TtlStore в памяти с ленивой очисткой. Для anti-replay nonce и идемпотентности
 * одиночных значений. putIfAbsent атомарен в рамках одного event-loop-тика Node.
 */
export class MemoryTtlStore implements TtlStore {
  private readonly m = new Map<string, number>(); // key -> expiresAt
  private lastSweep = 0;
  constructor(private readonly now: () => number = Date.now) {}

  putIfAbsent(key: string, ttlMs: number): boolean {
    const t = this.now();
    this.sweep(t);
    const exp = this.m.get(key);
    if (exp !== undefined && exp > t) return false;
    this.m.set(key, t + ttlMs);
    return true;
  }
  has(key: string): boolean {
    const exp = this.m.get(key);
    return exp !== undefined && exp > this.now();
  }
  private sweep(t: number): void {
    if (t - this.lastSweep < 30_000) return;
    this.lastSweep = t;
    for (const [k, exp] of this.m) if (exp <= t) this.m.delete(k);
  }
}

export const dayWindowStart = (now: number): number => now - DAY_MS;
