/** Контейнер зависимостей — то, что композиционный корень (main.ts) собирает и
 *  передаёт инбаунд-адаптерам (HTTP/WS). Сервисы зависят от портов, не наоборот. */
import type { Config } from './config.js';
import type { Clock, Logger } from './ports.js';
import type { AuthService } from './app/auth.service.js';
import type { AccountService } from './app/account.service.js';
import type { KycService } from './app/kyc.service.js';
import type { SubscriptionService } from './app/subscription.service.js';
import type { TopService } from './app/top.service.js';
import type { DealService } from './app/deal.service.js';
import type { FeedHub } from './app/feed.service.js';
import type { UserEventBus } from './app/user-events.js';

export interface Container {
  config: Config;
  log: Logger;
  clock: Clock;
  auth: AuthService;
  account: AccountService;
  kyc: KycService;
  subscriptions: SubscriptionService;
  top: TopService;
  deals: DealService;
  feed: FeedHub;
  events: UserEventBus;
}
