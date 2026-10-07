/**
 * REST-маршруты → сервисы приложения. Хендлеры только валидируют ввод, зовут
 * сервис и возвращают данные (сериализацию и коды ошибок делает server.ts).
 * Денежные и приватные маршруты помечены auth:true (нужен bearer-токен).
 */
import type { Container } from '../../container.js';
import { Router, type Ctx } from './router.js';

function asObj(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

const MARKET_MAX_OFFERS = 60;

export function registerRoutes(router: Router, c: Container): void {
  const uid = (ctx: Ctx): string => ctx.auth!.userId;

  /* ── здоровье ── */
  router.add('GET', '/v1/health', () => ({ ok: true, ts: c.clock.now() }), { auth: false });

  /* ── аутентификация ── */
  router.add('POST', '/v1/auth/telegram', async (ctx) => {
    const b = asObj(ctx.body);
    const initData = typeof b['initData'] === 'string' ? b['initData'] : '';
    const nonce = typeof b['nonce'] === 'string' ? b['nonce'] : null;
    const r = await c.auth.authenticate(initData, nonce);
    return {
      token: r.token,
      user: { id: r.user.id, name: r.user.name, handle: r.user.handle },
      kyc: r.kyc,
      plan: r.plan,
      limits: r.limits,
    };
  }, { auth: false });

  /* ── профиль ── */
  router.add('GET', '/v1/me', async (ctx) => {
    const userId = uid(ctx);
    const [balance, kyc, sub, cards] = await Promise.all([
      c.account.getBalance(userId),
      c.kyc.get(userId),
      c.subscriptions.view(userId),
      c.account.listCards(userId),
    ]);
    return { balanceUsdt: balance, kyc, subscription: sub, cards };
  }, { auth: true });

  /* ── рынок (REST-срез стакана) ── */
  router.add('GET', '/v1/market', (ctx) => {
    const asset = ctx.query.get('asset') ?? 'USDT';
    const fiat = ctx.query.get('fiat') ?? 'RUB';
    const side = ctx.query.get('side') === 'sell' ? 'sell' : 'buy';
    const view = c.feed.getMarket(asset, fiat, side);
    const sorted = [...view.offers].sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price));
    return { asset, fiat, side, median: view.median, offers: sorted.slice(0, MARKET_MAX_OFFERS) };
  }, { auth: true });

  /* ── топ ── */
  router.add('GET', '/v1/top', (ctx) => {
    const period = ctx.query.get('period') ?? 'week';
    const metric = ctx.query.get('metric') ?? 'volume';
    const limit = Number(ctx.query.get('limit') ?? '30');
    return c.top.leaderboard(period, metric, limit);
  }, { auth: true });

  /* ── баланс ── */
  router.add('POST', '/v1/balance', async (ctx) => {
    const b = asObj(ctx.body);
    const mode = b['mode'] === 'deposit' || b['mode'] === 'withdraw' ? b['mode'] : 'set';
    const usdt = await c.account.setBalance(uid(ctx), mode, b['amount']);
    return { balanceUsdt: usdt };
  }, { auth: true });

  /* ── карты ── */
  router.add('GET', '/v1/cards', (ctx) => c.account.listCards(uid(ctx)).then((cards) => ({ cards })), { auth: true });
  router.add('POST', '/v1/cards', async (ctx) => ({ card: await c.account.upsertCard(uid(ctx), asObj(ctx.body) as never) }), { auth: true });
  router.add('PATCH', '/v1/cards/:id', async (ctx) => ({ card: await c.account.upsertCard(uid(ctx), asObj(ctx.body) as never, ctx.params['id']) }), { auth: true });
  router.add('DELETE', '/v1/cards/:id', async (ctx) => {
    await c.account.removeCard(uid(ctx), ctx.params['id']!);
    return { ok: true };
  }, { auth: true });

  /* ── KYC ── */
  router.add('GET', '/v1/kyc', (ctx) => c.kyc.get(uid(ctx)), { auth: true });
  router.add('POST', '/v1/kyc/submit', async (ctx) => {
    const level = Number(asObj(ctx.body)['level']);
    return c.kyc.submit(uid(ctx), level);
  }, { auth: true });
  router.add('POST', '/v1/kyc/reset', (ctx) => c.kyc.reset(uid(ctx)), { auth: true });

  /* ── подписка ── */
  router.add('GET', '/v1/subscription', async (ctx) => {
    const view = await c.subscriptions.view(uid(ctx));
    return { ...view, plans: c.subscriptions.plans() };
  }, { auth: true });
  router.add('POST', '/v1/subscription', async (ctx) => {
    const plan = String(asObj(ctx.body)['plan'] ?? '');
    return c.subscriptions.subscribe(uid(ctx), plan);
  }, { auth: true });
  router.add('DELETE', '/v1/subscription', (ctx) => c.subscriptions.cancel(uid(ctx)), { auth: true });

  /* ── сделки ── */
  router.add('POST', '/v1/deals', async (ctx) => {
    const idemKey = ctx.header('idempotency-key') ?? '';
    const deal = await c.deals.create(uid(ctx), asObj(ctx.body) as never, idemKey);
    return dealView(deal);
  }, { auth: true });
  router.add('GET', '/v1/deals', async (ctx) => {
    const limit = Number(ctx.query.get('limit') ?? '50');
    const deals = await c.deals.list(uid(ctx), limit);
    return { deals: deals.map(dealView) };
  }, { auth: true });
  router.add('GET', '/v1/deals/:id', async (ctx) => dealView(await c.deals.get(uid(ctx), ctx.params['id']!)), { auth: true });
  router.add('POST', '/v1/deals/:id/paid', async (ctx) => dealView(await c.deals.markPaid(uid(ctx), ctx.params['id']!)), { auth: true });
  router.add('POST', '/v1/deals/:id/cancel', async (ctx) => dealView(await c.deals.cancel(uid(ctx), ctx.params['id']!)), { auth: true });
}

/** Представление сделки для клиента (без внутренних полей вроде idemKey). */
function dealView(d: import('../../domain/types.js').Deal) {
  return {
    dealId: d.id,
    ref: d.ref,
    offerId: d.offerId,
    exchange: d.exchange,
    side: d.side,
    asset: d.asset,
    fiat: d.fiat,
    price: d.price,
    amountAsset: d.amountAsset,
    volumeUsdt: d.volumeUsdt,
    fiatTotal: d.fiatTotal,
    method: d.method,
    status: d.status,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
