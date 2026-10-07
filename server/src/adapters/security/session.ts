/**
 * Stateless-сессии для REST. Токен = base64url(payload).base64url(HMAC-SHA256).
 * Подпись на SESSION_SECRET: содержимое читаемо, но не подделываемо. Проверка
 * времени через timingSafeEqual (защита от timing-атак). Без внешних JWT-библиотек
 * — меньше поверхности атаки (цель кибербез-ревью).
 *
 * Денежные операции НЕ доверяют клейму из токена вслепую: лимиты/план/баланс
 * перечитываются из хранилища на момент операции. Токен — только identity + TTL.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionClaims {
  sub: string; // userId
  tg: string; // telegram id
  iat: number; // issued-at (ms)
  exp: number; // expiry (ms)
}

const b64url = (buf: Buffer): string => buf.toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

export class SessionCodec {
  private readonly secret: string;
  private readonly ttlMs: number;

  constructor(secret: string, ttlMs = 12 * 60 * 60 * 1000) {
    if (!secret || secret.length < 32) throw new Error('SESSION_SECRET too short');
    this.secret = secret;
    this.ttlMs = ttlMs;
  }

  private sign(payloadB64: string): string {
    return b64url(createHmac('sha256', this.secret).update(payloadB64).digest());
  }

  issue(userId: string, tgId: string, now: number): string {
    const claims: SessionClaims = { sub: userId, tg: tgId, iat: now, exp: now + this.ttlMs };
    const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
    return `${payload}.${this.sign(payload)}`;
  }

  /** @returns валидные клеймы или null (плохая подпись / просрочен / мусор). */
  verify(token: string, now: number): SessionClaims | null {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = this.sign(payload);
    const a = fromB64url(sig);
    const b = fromB64url(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let claims: SessionClaims;
    try {
      claims = JSON.parse(fromB64url(payload).toString('utf8')) as SessionClaims;
    } catch {
      return null;
    }
    if (!claims || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (now > claims.exp) return null;
    return claims;
  }
}
