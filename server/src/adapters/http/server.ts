/**
 * HTTP-конвейер: заголовки безопасности → CORS → rate-limit (IP) → маршрут →
 * (авторизация + rate-limit аккаунта) → чтение тела → хендлер → JSON.
 * Единый перехват ошибок: DomainError → свой код, прочее → 500 без утечек.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Container } from '../../container.js';
import { Router, type Ctx } from './router.js';
import { registerRoutes } from './routes.js';
import { TokenBucketLimiter } from '../security/ratelimit.js';
import {
  applyCors, clientIp, errorToResponse, readJsonBody, securityHeaders, sendError, sendJson,
} from './http-util.js';

const MINUTE = 60_000;

export function createHttpServer(c: Container): Server {
  const router = new Router();
  registerRoutes(router, c);

  const ipLimiter = new TokenBucketLimiter(c.config.limits.httpPerMinIp, MINUTE, c.clock.now);
  const accountLimiter = new TokenBucketLimiter(c.config.limits.httpPerMinAccount, MINUTE, c.clock.now);
  const dealLimiter = new TokenBucketLimiter(c.config.limits.dealsPerMin, MINUTE, c.clock.now);

  return createServer((req, res) => {
    void handle(req, res).catch((e) => {
      c.log.log('error', 'unhandled request error', { err: String(e) });
      if (!res.headersSent) errorToResponse(res, e);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = cryptoId();
    res.setHeader('X-Request-Id', requestId);
    securityHeaders(res);

    const cors = applyCors(req, res, c.config);
    if (cors === 'forbidden') return sendError(res, 403, 'forbidden', 'Origin не разрешён');
    if (cors === 'preflight') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const ip = clientIp(req);
    const ipRate = ipLimiter.take(ip);
    if (!ipRate.ok) {
      res.setHeader('Retry-After', Math.ceil(ipRate.retryAfterMs / 1000).toString());
      return sendError(res, 429, 'rate_limited', 'Слишком много запросов с адреса');
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const matched = router.match(method, url.pathname);
    if (!matched) {
      if (router.allowsPath(url.pathname)) return sendError(res, 405, 'validation', 'Метод не поддерживается');
      return sendError(res, 404, 'not_found', 'Маршрут не найден');
    }

    const ctx: Ctx = {
      req, res, method, path: url.pathname,
      params: matched.params, query: url.searchParams,
      ip, requestId, auth: null, body: undefined,
      header: (name: string): string | null => {
        const v = req.headers[name.toLowerCase()];
        return typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? null : null;
      },
    };

    // авторизация + per-account лимиты
    if (matched.route.auth) {
      const bearer = parseBearer(ctx.header('authorization'));
      const resolved = bearer ? c.auth.resolveToken(bearer) : null;
      if (!resolved) return sendError(res, 401, 'unauthorized', 'Требуется авторизация');
      ctx.auth = resolved;

      const acct = accountLimiter.take(resolved.userId);
      if (!acct.ok) {
        res.setHeader('Retry-After', Math.ceil(acct.retryAfterMs / 1000).toString());
        return sendError(res, 429, 'rate_limited', 'Слишком много запросов аккаунта');
      }
      // отдельный лимит на создание сделок
      if (method === 'POST' && url.pathname === '/v1/deals') {
        const dr = dealLimiter.take(resolved.userId);
        if (!dr.ok) {
          res.setHeader('Retry-After', Math.ceil(dr.retryAfterMs / 1000).toString());
          return sendError(res, 429, 'rate_limited', 'Слишком часто создаются сделки');
        }
      }
    }

    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      ctx.body = await readJsonBody(req, c.config.limits.maxBodyBytes);
    }

    const result = await matched.route.handler(ctx);
    if (!res.writableEnded) sendJson(res, method === 'POST' && url.pathname === '/v1/deals' ? 201 : 200, result ?? {});
  }

  function cryptoId(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
}

function parseBearer(h: string | null): string | null {
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/** Приватный сервер health/metrics (поднимается только если задан METRICS_PORT). */
export function createMetricsServer(c: Container): Server {
  return createServer((req, res) => {
    securityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz' || url.pathname === '/') {
      return sendJson(res, 200, { ok: true, ts: c.clock.now(), markets: 'n/a' });
    }
    sendError(res, 404, 'not_found', 'not found');
  });
}
