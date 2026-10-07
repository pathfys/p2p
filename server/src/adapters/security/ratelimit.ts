/**
 * Token-bucket rate limiter в памяти. На каждый ключ (IP/аккаунт/соединение) —
 * ведро ёмкостью `capacity`, пополняется `refillPerSec` токенов/с. Один запрос
 * тратит один токен; нет токенов → отказ с retryAfterMs.
 *
 * In-memory ⇒ лимит на один инстанс. Горизонтальное масштабирование требует
 * общего счётчика (Redis) — это отдельный адаптер того же понятия (см. README).
 */
export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private lastSweep = 0;

  /** @param perInterval сколько запросов за `intervalMs`. capacity = perInterval. */
  constructor(perInterval: number, intervalMs: number, now: () => number = Date.now) {
    this.capacity = Math.max(1, perInterval);
    this.refillPerMs = perInterval / intervalMs;
    this.now = now;
  }

  take(key: string, cost = 1): RateResult {
    const t = this.now();
    this.maybeSweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    } else {
      const refill = (t - b.last) * this.refillPerMs;
      if (refill > 0) {
        b.tokens = Math.min(this.capacity, b.tokens + refill);
        b.last = t;
      }
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    const deficit = cost - b.tokens;
    return { ok: false, remaining: 0, retryAfterMs: Math.ceil(deficit / this.refillPerMs) };
  }

  /** Периодически выбрасываем полностью восстановившиеся ведра (анти-рост памяти). */
  private maybeSweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) {
      const refill = (t - b.last) * this.refillPerMs;
      if (b.tokens + refill >= this.capacity) this.buckets.delete(k);
    }
  }
}
