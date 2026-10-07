/**
 * Конфигурация. Единая точка чтения окружения: всё остальное приложение
 * получает уже провалидированный, замороженный объект Config и никогда не
 * лезет в process.env напрямую. Любая ошибка конфигурации — аварийный выход
 * на старте (fail-fast), а не падение в рантайме под нагрузкой.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type NodeEnv = 'development' | 'production' | 'test';
export type FeedSource = 'generator' | 'http';

export interface Config {
  readonly env: NodeEnv;
  readonly http: { readonly host: string; readonly port: number; readonly wsPath: string };
  readonly metrics: { readonly enabled: boolean; readonly host: string; readonly port: number };
  readonly telegramBotToken: string | null;
  readonly sessionSecret: string;
  readonly corsOrigins: readonly string[];
  readonly allowDevAuth: boolean;
  readonly limits: {
    readonly httpPerMinIp: number;
    readonly httpPerMinAccount: number;
    readonly dealsPerMin: number;
    readonly maxBodyBytes: number;
    readonly wsMaxConnPerIp: number;
    readonly wsFramesPerSec: number;
    readonly wsMaxFrameBytes: number;
    readonly wsIdleTimeoutMs: number;
  };
  readonly feed: { readonly source: FeedSource; readonly tickMs: number };
}

/** Мини-парсер .env: KEY=value, строки с # и пустые — пропускаются. Без зависимостей. */
function loadDotEnv(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

export class ConfigError extends Error {}

export function loadConfig(cwd: string = process.cwd()): Config {
  const file = loadDotEnv(resolve(cwd, '.env'));
  // process.env имеет приоритет над .env (12-factor): контейнер переопределяет файл.
  const get = (k: string): string | undefined => {
    const fromEnv = process.env[k];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : file[k];
  };
  const errors: string[] = [];

  const str = (k: string, def?: string): string => {
    const v = get(k);
    if (v === undefined || v === '') {
      if (def !== undefined) return def;
      errors.push(`${k} обязателен`);
      return '';
    }
    return v;
  };
  const int = (k: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const v = get(k);
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${k} должен быть целым в диапазоне [${min}, ${max}], получено ${JSON.stringify(v)}`);
      return def;
    }
    return n;
  };
  const bool = (k: string, def: boolean): boolean => {
    const v = get(k);
    if (v === undefined || v === '') return def;
    if (v === 'true') return true;
    if (v === 'false') return false;
    errors.push(`${k} должен быть true|false, получено ${JSON.stringify(v)}`);
    return def;
  };

  const envRaw = str('NODE_ENV', 'development');
  const env: NodeEnv = envRaw === 'production' || envRaw === 'test' ? envRaw : 'development';

  const feedRaw = str('FEED_SOURCE', 'generator');
  const feedSource: FeedSource = feedRaw === 'http' ? 'http' : 'generator';

  const telegramBotToken = get('TELEGRAM_BOT_TOKEN') || null;
  const sessionSecret = str('SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < 32) errors.push('SESSION_SECRET должен быть не короче 32 символов');

  const corsOrigins = (get('CORS_ORIGINS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowDevAuth = bool('ALLOW_DEV_AUTH', false);
  const metricsPort = int('METRICS_PORT', 0, 0, 65535);

  // Критические инварианты безопасности для production.
  if (env === 'production') {
    if (!telegramBotToken) errors.push('В production TELEGRAM_BOT_TOKEN обязателен (проверка подписи initData)');
    if (allowDevAuth) errors.push('В production ALLOW_DEV_AUTH должен быть false');
    if (sessionSecret === 'change-me-to-a-long-random-string-min-32-chars') {
      errors.push('В production SESSION_SECRET нельзя оставлять значением по умолчанию');
    }
  }
  if (!telegramBotToken && !allowDevAuth) {
    errors.push('Нужен либо TELEGRAM_BOT_TOKEN, либо ALLOW_DEV_AUTH=true (для локального стенда)');
  }

  if (errors.length) {
    throw new ConfigError('Ошибки конфигурации:\n  - ' + errors.join('\n  - '));
  }

  const cfg: Config = {
    env,
    http: {
      host: str('HTTP_HOST', '127.0.0.1'),
      port: int('HTTP_PORT', 8080, 1, 65535),
      wsPath: str('WS_PATH', '/v1/stream'),
    },
    metrics: {
      enabled: metricsPort > 0,
      host: str('METRICS_HOST', '127.0.0.1'),
      port: metricsPort,
    },
    telegramBotToken,
    sessionSecret,
    corsOrigins,
    allowDevAuth,
    limits: {
      httpPerMinIp: int('RATE_HTTP_PER_MIN_IP', 240, 1),
      httpPerMinAccount: int('RATE_HTTP_PER_MIN_ACCOUNT', 600, 1),
      dealsPerMin: int('RATE_DEALS_PER_MIN', 20, 1),
      maxBodyBytes: int('MAX_BODY_BYTES', 65536, 1024, 10 * 1024 * 1024),
      wsMaxConnPerIp: int('WS_MAX_CONN_PER_IP', 8, 1),
      wsFramesPerSec: int('WS_FRAMES_PER_SEC', 300, 1),
      wsMaxFrameBytes: int('WS_MAX_FRAME_BYTES', 524288, 1024, 4 * 1024 * 1024),
      wsIdleTimeoutMs: int('WS_IDLE_TIMEOUT_MS', 30000, 1000),
    },
    feed: { source: feedSource, tickMs: int('FEED_TICK_MS', 600, 50, 60000) },
  };
  return Object.freeze(cfg);
}
