/**
 * Порты (hexagonal architecture). Это ИНТЕРФЕЙСЫ, через которые приложение
 * общается с внешним миром. Домен и сервисы зависят только отсюда; конкретные
 * реализации (память/Postgres/Redis, генератор/реальные биржи, Telegram)
 * живут в adapters/ и подставляются в композиционном корне (main.ts).
 */
import type {
  Card, Deal, DealStatus, KycState, Offer, Side, Subscription, User,
} from './domain/types.js';

/* ───────────── инфраструктурные порты ───────────── */

export interface Clock {
  now(): number;
}

export interface IdGen {
  /** Непредсказуемый id с префиксом, напр. uid('deal') → 'deal_a1b2…'. */
  uid(prefix: string): string;
  /** Детерминированного вида случайное число [0,1) из криптоисточника. */
  random(): number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/* ───────────── хранилища (repositories) ───────────── */

export interface UserRepo {
  getById(id: string): Promise<User | null>;
  getByTgId(tgId: string): Promise<User | null>;
  create(user: User): Promise<User>;
}

export interface KycRepo {
  get(userId: string): Promise<KycState | null>;
  set(userId: string, state: KycState): Promise<void>;
}

export interface SubscriptionRepo {
  get(userId: string): Promise<Subscription | null>;
  set(userId: string, sub: Subscription): Promise<void>;
}

export interface BalanceRepo {
  getUsdt(userId: string): Promise<number>;
  setUsdt(userId: string, usdt: number): Promise<void>;
}

export interface CardRepo {
  list(userId: string): Promise<Card[]>;
  get(userId: string, cardId: string): Promise<Card | null>;
  upsert(userId: string, card: Card): Promise<void>;
  remove(userId: string, cardId: string): Promise<void>;
}

export interface DealRepo {
  create(deal: Deal): Promise<void>;
  get(dealId: string): Promise<Deal | null>;
  /** Поиск ранее созданной сделки по ключу идемпотентности (userId+idemKey). */
  findByIdemKey(userId: string, idemKey: string): Promise<Deal | null>;
  updateStatus(dealId: string, status: DealStatus, at: number): Promise<Deal | null>;
  listByUser(userId: string, limit: number): Promise<Deal[]>;
  /** Суммарный объём (USDT) засчитанных сделок пользователя за сутки [from,now]. */
  dayVolumeUsdt(userId: string, from: number): Promise<number>;
}

/**
 * Хранилище одноразовых значений с TTL. Используется и для anti-replay nonce,
 * и для идемпотентности. `putIfAbsent` атомарен: true — записали (значение было
 * свободно), false — уже существовало (повтор).
 */
export interface TtlStore {
  putIfAbsent(key: string, ttlMs: number): boolean;
  has(key: string): boolean;
}

/* ───────────── внешние сервисы ───────────── */

export interface TelegramUser {
  id: string;
  firstName: string;
  username: string | null;
}

export interface TelegramVerifier {
  /**
   * Проверяет подпись initData по схеме Telegram и свежесть auth_date.
   * @returns пользователя при успехе, либо null при любой ошибке проверки.
   */
  verify(initData: string, now: number): TelegramUser | null;
}

/* ───────────── поток котировок (биржи) ───────────── */

export interface FeedParams {
  exchanges: string[];
  asset: string;
  fiat: string;
  side: Side;
}

/** Нормализованные события стакана (подмножество docs/ws-protocol.md). */
export type FeedEvent =
  | { kind: 'snapshot'; exchange: string; ts: number; offers: Offer[] }
  | { kind: 'update'; exchange: string; ts: number; upsert: Offer[]; remove: string[] }
  | { kind: 'status'; exchange: string; ts: number; state: 'idle' | 'connecting' | 'live' | 'down'; latency: number }
  | { kind: 'log'; ts: number; level: string; exchange: string | null; text: string };

export interface FeedSubscription {
  /** Текущий полный набор оферов (для серверного ранжирования best-offer). */
  currentOffers(): Offer[];
  close(): void;
}

export interface ExchangeFeed {
  /** Подписаться на стакан. onEvent вызывается для каждого события адаптера. */
  subscribe(params: FeedParams, onEvent: (e: FeedEvent) => void): FeedSubscription;
  /** Известные серверу биржи (граница доверия к exchange в оферах). */
  knownExchanges(): ReadonlySet<string>;
}
