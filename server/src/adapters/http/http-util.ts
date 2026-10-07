/** HTTP-утилиты: заголовки безопасности, CORS, чтение тела с лимитом, ответы. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../../config.js';
import { DomainError } from '../../domain/errors.js';

export function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // API не отдаёт HTML, но запрещаем любые внешние ресурсы на всякий случай
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

/**
 * CORS. Если Origin присутствует — он обязан быть в allowlist, иначе запрос
 * отклоняется (строгий дефолт, защита от кросс-сайтовых обращений). Запросы
 * без Origin (сервер-сервер, curl) проходят.
 * @returns 'ok' | 'preflight' | 'forbidden'
 */
export function applyCors(req: IncomingMessage, res: ServerResponse, cfg: Config): 'ok' | 'preflight' | 'forbidden' {
  const origin = req.headers['origin'];
  const method = (req.method ?? 'GET').toUpperCase();
  if (typeof origin === 'string' && origin.length > 0) {
    if (!cfg.corsOrigins.includes(origin)) return 'forbidden';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return method === 'OPTIONS' ? 'preflight' : 'ok';
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

export function errorToResponse(res: ServerResponse, e: unknown): void {
  if (e instanceof DomainError) {
    sendError(res, e.status, e.code, e.message, e.details);
    return;
  }
  sendError(res, 500, 'internal', 'Внутренняя ошибка');
}

/** Левый IP из X-Forwarded-For (за доверенным LB) либо адрес сокета. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Читает тело с жёстким лимитом; парсит JSON. Пустое тело → {}. */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: DomainError): void => {
      if (done) return;
      done = true;
      req.destroy();
      reject(e);
    };
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        fail(new DomainError('validation', 'Тело запроса слишком большое'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new DomainError('validation', 'Некорректный JSON'));
      }
    });
    req.on('error', () => fail(new DomainError('validation', 'Ошибка чтения тела')));
  });
}
