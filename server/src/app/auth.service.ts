/**
 * Аутентификация. Единый путь для REST и WS: проверка Telegram initData →
 * (опционально) одноразовость nonce → upsert пользователя → выдача
 * stateless-сессии. Токен удостоверяет личность; лимиты/план/KYC всегда
 * перечитываются из хранилища на момент денежной операции.
 */
import type { Clock, KycRepo, SubscriptionRepo, TelegramVerifier, TtlStore, UserRepo } from '../ports.js';
import type { KycState, Subscription, User } from '../domain/types.js';
import { initialKyc, dayLimitFor } from '../domain/kyc.js';
import { initialSubscription, activePlan } from '../domain/subscription.js';
import { SessionCodec } from '../adapters/security/session.js';
import { plainText } from '../adapters/security/sanitize.js';
import { err } from '../domain/errors.js';

const NONCE_TTL_MS = 5 * 60 * 1000;

export interface AuthResult {
  user: User;
  token: string;
  kyc: KycState;
  subscription: Subscription;
  limits: { dayUsdt: number };
  plan: string | null;
}

export class AuthService {
  constructor(
    private readonly telegram: TelegramVerifier,
    private readonly users: UserRepo,
    private readonly kyc: KycRepo,
    private readonly subs: SubscriptionRepo,
    private readonly nonces: TtlStore,
    private readonly sessions: SessionCodec,
    private readonly clock: Clock,
  ) {}

  /** @throws DomainError('unauthorized') при неверной подписи или повторе nonce. */
  async authenticate(initData: string, nonce: string | null): Promise<AuthResult> {
    const now = this.clock.now();
    const tgUser = this.telegram.verify(initData, now);
    if (!tgUser) throw err('unauthorized', 'Проверка Telegram initData не пройдена');

    // anti-replay самого auth-кадра
    if (nonce) {
      if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
        throw err('unauthorized', 'Некорректный nonce');
      }
      if (!this.nonces.putIfAbsent(`auth:${tgUser.id}:${nonce}`, NONCE_TTL_MS)) {
        throw err('unauthorized', 'Повтор auth-кадра (replay)');
      }
    }

    const userId = `u_${tgUser.id}`;
    let user = await this.users.getById(userId);
    if (!user) {
      user = await this.users.create({
        id: userId,
        tgId: tgUser.id,
        name: plainText(tgUser.firstName, 64) || 'user',
        handle: tgUser.username ? '@' + plainText(tgUser.username, 64) : '@user',
        createdAt: now,
      });
      await this.kyc.set(userId, initialKyc());
      await this.subs.set(userId, initialSubscription());
    }

    const kyc = (await this.kyc.get(userId)) ?? initialKyc();
    const subscription = (await this.subs.get(userId)) ?? initialSubscription();
    const token = this.sessions.issue(userId, tgUser.id, now);
    const plan = activePlan(subscription, now);

    return {
      user,
      token,
      kyc,
      subscription,
      plan: plan ? plan.id : null,
      limits: { dayUsdt: dayLimitFor(kyc.level) },
    };
  }

  /** Разбор bearer-токена REST → userId, либо null. */
  resolveToken(token: string): { userId: string; tgId: string } | null {
    const claims = this.sessions.verify(token, this.clock.now());
    return claims ? { userId: claims.sub, tgId: claims.tg } : null;
  }
}
