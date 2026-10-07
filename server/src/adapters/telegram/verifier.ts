/**
 * Проверка Telegram WebApp initData.
 *
 *   data_check_string = отсортированные "key=value" (кроме hash), через '\n'
 *   secret_key        = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   expected_hash     = hex HMAC_SHA256(key=secret_key, msg=data_check_string)
 *
 * Сверяем с присланным hash (timing-safe) и проверяем свежесть auth_date (≤5 мин).
 * Только после этого доверяем user.id. Без этого любой подделает пользователя.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TelegramUser, TelegramVerifier } from '../../ports.js';

const AUTH_MAX_AGE_SEC = 300;

export class HmacTelegramVerifier implements TelegramVerifier {
  private readonly secretKey: Buffer;

  constructor(botToken: string) {
    if (!botToken) throw new Error('bot token required');
    this.secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  }

  verify(initData: string, now: number): TelegramUser | null {
    if (typeof initData !== 'string' || initData.length === 0 || initData.length > 8192) return null;

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(initData);
    } catch {
      return null;
    }
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

    const pairs: string[] = [];
    for (const [k, v] of params) {
      if (k === 'hash') continue;
      pairs.push(`${k}=${v}`);
    }
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const expected = createHmac('sha256', this.secretKey).update(dataCheckString).digest();
    const got = Buffer.from(hash, 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;

    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate) || now / 1000 - authDate > AUTH_MAX_AGE_SEC || authDate > now / 1000 + 60) {
      return null;
    }

    const userRaw = params.get('user');
    if (!userRaw) return null;
    try {
      const u = JSON.parse(userRaw) as Record<string, unknown>;
      const id = u['id'];
      if (typeof id !== 'number' && typeof id !== 'string') return null;
      return {
        id: String(id),
        firstName: typeof u['first_name'] === 'string' ? u['first_name'].slice(0, 64) : 'user',
        username: typeof u['username'] === 'string' ? u['username'].slice(0, 64) : null,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Dev-верификатор для локального стенда без бота. Разрешён ТОЛЬКО когда
 * config.allowDevAuth=true и нет TELEGRAM_BOT_TOKEN (проверяется в main.ts,
 * запрещено в production). Принимает initData вида:
 *   ''                       → фиксированный dev-пользователь
 *   'id=42&first_name=Art'   → заданный id/имя (подпись НЕ проверяется)
 */
export class DevTelegramVerifier implements TelegramVerifier {
  verify(initData: string): TelegramUser | null {
    let id = 'dev_1';
    let firstName = 'Dev';
    let username: string | null = 'dev';
    if (typeof initData === 'string' && initData.length > 0 && initData.length <= 2048) {
      try {
        const p = new URLSearchParams(initData);
        if (p.get('id')) id = String(p.get('id')).slice(0, 64);
        if (p.get('first_name')) firstName = String(p.get('first_name')).slice(0, 64);
        if (p.get('username')) username = String(p.get('username')).slice(0, 64);
      } catch {
        /* ignore — отдаём дефолтного dev-пользователя */
      }
    }
    return { id, firstName, username };
  }
}
