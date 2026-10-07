/**
 * Композиционный корень. Единственное место, где конкретные адаптеры
 * подставляются в порты. Меняя реализации здесь (память → Postgres/Redis,
 * generator → http-адаптер бирж), остальной код трогать не нужно.
 */
import { loadConfig, ConfigError } from './config.js';
import { JsonLogger, systemClock, cryptoIdGen } from './adapters/infra.js';
import {
  MemoryUserRepo, MemoryKycRepo, MemorySubscriptionRepo, MemoryBalanceRepo,
  MemoryCardRepo, MemoryDealRepo, MemoryTtlStore,
} from './adapters/memory/repositories.js';
import { GeneratorFeed } from './adapters/exchange/generator.js';
import { HmacTelegramVerifier, DevTelegramVerifier } from './adapters/telegram/verifier.js';
import { SessionCodec } from './adapters/security/session.js';
import { AuthService } from './app/auth.service.js';
import { AccountService } from './app/account.service.js';
import { KycService } from './app/kyc.service.js';
import { SubscriptionService } from './app/subscription.service.js';
import { TopService } from './app/top.service.js';
import { FeedHub } from './app/feed.service.js';
import { DealService } from './app/deal.service.js';
import { UserEventBus } from './app/user-events.js';
import { createHttpServer, createMetricsServer } from './adapters/http/server.js';
import { attachWebsocket } from './adapters/ws/server.js';
import { makeWsHandler } from './adapters/ws/gateway.js';
import type { Container } from './container.js';
import type { TelegramVerifier } from './ports.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(e.message + '\n');
      process.exit(1);
    }
    throw e;
  }

  const log = new JsonLogger(config.env === 'development' ? 'debug' : 'info', { svc: 'p2p-gateway' });
  const clock = systemClock;
  const ids = cryptoIdGen;

  // Telegram verifier: реальный HMAC или dev (config гарантирует одно из двух)
  let telegram: TelegramVerifier;
  if (config.telegramBotToken) {
    telegram = new HmacTelegramVerifier(config.telegramBotToken);
  } else {
    telegram = new DevTelegramVerifier();
    log.log('warn', 'DEV AUTH ENABLED: initData не проверяется подписью (только для стенда)');
  }

  // хранилища (in-memory; прод-адаптер реализует те же порты)
  const users = new MemoryUserRepo();
  const kycRepo = new MemoryKycRepo();
  const subRepo = new MemorySubscriptionRepo();
  const balances = new MemoryBalanceRepo();
  const cards = new MemoryCardRepo();
  const dealRepo = new MemoryDealRepo();
  const nonces = new MemoryTtlStore(clock.now);
  const idem = new MemoryTtlStore(clock.now);
  const sessions = new SessionCodec(config.sessionSecret);

  if (config.feed.source === 'http') {
    log.log('warn', 'FEED_SOURCE=http: http-адаптер бирж не входит в эту сборку, используется generator');
  }
  const feed = new GeneratorFeed(config.feed.tickMs);

  const events = new UserEventBus();
  const feedHub = new FeedHub(feed, clock, log);
  feedHub.start();

  const auth = new AuthService(telegram, users, kycRepo, subRepo, nonces, sessions, clock);
  const account = new AccountService(balances, cards, ids);
  const kyc = new KycService(kycRepo, events, clock, ids, log);
  const subscriptions = new SubscriptionService(subRepo, clock);
  const top = new TopService(feed);
  const deals = new DealService(dealRepo, feedHub, kycRepo, subscriptions, balances, cards, idem, events, ids, clock, log);

  const container: Container = {
    config, log, clock, auth, account, kyc, subscriptions, top, deals, feed: feedHub, events,
  };

  const http = createHttpServer(container);
  attachWebsocket(http, container, makeWsHandler(container));
  http.listen(config.http.port, config.http.host, () => {
    log.log('info', 'http+ws listening', { host: config.http.host, port: config.http.port, wsPath: config.http.wsPath });
  });

  const metrics = config.metrics.enabled ? createMetricsServer(container) : null;
  metrics?.listen(config.metrics.port, config.metrics.host, () => {
    log.log('info', 'metrics listening', { host: config.metrics.host, port: config.metrics.port });
  });

  const shutdown = (signal: string): void => {
    log.log('info', 'shutting down', { signal });
    feedHub.stop();
    http.close();
    metrics?.close();
    // даём сокетам закрыться, затем выходим
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
