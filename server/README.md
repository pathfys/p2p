# P2P Light — Gateway (бэкенд)

Шлюз для мини-аппа P2P Light: WebSocket-стрим агрегированных стаканов +
REST (аутентификация, сделки, KYC, подписки, топ). Реализует контракт
[`../docs/ws-protocol.md`](../docs/ws-protocol.md), с которым уже умеет
говорить фронт (`src/services/feed.js`, режим `live`).

**Технологии:** TypeScript, Node.js ≥ 20. **Ноль рантайм-зависимостей** —
только встроенные модули (`node:http`, `node:crypto`, `node:stream`).
WebSocket-сервер (RFC 6455) и проверка Telegram `initData` написаны вручную:
меньше поверхности атаки и полностью аудируемый код (важно для кибербеза).

---

## Архитектура — ports & adapters (гексагональная)

Зависимости направлены внутрь: **домен ничего не знает о вводе-выводе**.
Порты (`ports.ts`) — это интерфейсы; адаптеры — их конкретные реализации;
сервисы приложения оркестрируют домен через порты. Подмена реализации
(память → Postgres/Redis, генератор → реальные биржи) делается в одном месте —
композиционном корне `main.ts`, без правок бизнес-логики.

```
src/
  config.ts              чтение+валидация окружения (все порты/секреты), fail-fast
  container.ts           тип контейнера зависимостей
  main.ts                КОМПОЗИЦИОННЫЙ КОРЕНЬ: порты ← адаптеры, старт HTTP+WS
  ports.ts               ИНТЕРФЕЙСЫ: репозитории, ExchangeFeed, TelegramVerifier, Clock…

  domain/                чистая логика, без I/O
    types.ts  errors.ts  money.ts
    offer.ts             нормализация/санитизация офера — ГРАНИЦА ДОВЕРИЯ к биржам
    deal.ts              конечный автомат статусов сделки
    kyc.ts               уровни, лимиты, переходы
    subscription.ts      тарифы, пробный период, гейт «лучших стаканов»
    leaderboard.ts       топ мерчантов (детерминированный генератор)

  app/                   use-cases (сервисы)
    auth · account · kyc · subscription · top · deal · feed(FeedHub) · user-events

  adapters/
    inbound/
      http/  server.ts router.ts routes.ts http-util.ts   (REST + конвейер middleware)
      ws/    server.ts(транспорт RFC6455) gateway.ts(протокол) frame.ts(кодек)
    outbound/
      memory/repositories.ts      in-memory репозитории + TTL-хранилища
      exchange/generator.ts       генератор стаканов (адаптер ExchangeFeed)
      telegram/verifier.ts        HMAC-проверка initData (+ dev-заглушка)
    security/  ratelimit.ts  sanitize.ts  session.ts
    infra.ts                      часы, генератор id, JSON-логгер
test/                    node:test — домен, безопасность, кодек WS, Telegram, сделки
```

---

## Сетевые порты

| Порт | Назначение | Дефолт | Выставлять наружу? |
|---|---|---|---|
| `HTTP_PORT` | REST API **и** апгрейд WebSocket (путь `WS_PATH`) на одном TCP | `8080` | да, за TLS-терминатором |
| `METRICS_PORT` | приватный health/metrics (`/healthz`) | `9090` (0 = выкл) | **нет**, только внутр. сеть |

WebSocket живёт на `HTTP_PORT` по пути `WS_PATH` (`/v1/stream`) — это HTTP
Upgrade, отдельный порт не нужен. **Исходящие** эндпоинты бирж (Binance/Bybit/…)
перечислены в `../docs/ws-protocol.md §4` — к ним ходит http-адаптер фида, а не
клиент; наружу эти соединения инициирует только сервер.

---

## Запуск

```bash
cd server
cp .env.example .env         # заполнить SESSION_SECRET (≥32 симв.)
npm install                  # dev-зависимости: typescript, @types/node
npm run build                # tsc → dist/
npm start                    # node dist/src/main.js
npm test                     # сборка + node:test (домен, безопасность, WS, сделки)
```

Локальный стенд без бота Telegram: `ALLOW_DEV_AUTH=true` и пустой
`TELEGRAM_BOT_TOKEN` — тогда `initData` не проверяется подписью (dev-верификатор).
**В `NODE_ENV=production` это запрещено** — конфиг падает на старте, если
нет `TELEGRAM_BOT_TOKEN` или включён dev-auth, или `SESSION_SECRET` дефолтный.

Вся конфигурация и её инварианты — в [`.env.example`](.env.example) и `config.ts`.

---

## REST API (`/v1`)

Аутентификация: `Authorization: Bearer <token>`, где токен выдаёт
`POST /v1/auth/telegram`. Тело — JSON (лимит `MAX_BODY_BYTES`). Ошибки единым
форматом: `{ "error": { "code", "message", "details?" } }`.

| Метод | Путь | Авторизация | Назначение |
|---|---|---|---|
| GET | `/v1/health` | — | проверка живости |
| POST | `/v1/auth/telegram` | — | `{initData, nonce?}` → `{token, user, kyc, plan, limits}` |
| GET | `/v1/me` | ✓ | баланс, KYC, подписка, карты |
| GET | `/v1/market?asset&fiat&side` | ✓ | REST-срез стакана (медиана + топ-60 оферов) |
| GET | `/v1/top?period&metric&limit` | ✓ | лидерборд (`period∈{week,month,all}`, `metric∈{volume,orders}`) |
| POST | `/v1/balance` | ✓ | `{mode:set\|deposit\|withdraw, amount}` → баланс USDT |
| GET/POST | `/v1/cards` | ✓ | список / добавить карту (хранятся только последние 4 цифры) |
| PATCH/DELETE | `/v1/cards/:id` | ✓ | изменить / удалить карту |
| GET | `/v1/kyc` | ✓ | статус верификации |
| POST | `/v1/kyc/submit` | ✓ | `{level}` → `pending` (вердикт придёт по WS) |
| POST | `/v1/kyc/reset` | ✓ | сбросить верификацию |
| GET | `/v1/subscription` | ✓ | текущая подписка + список тарифов |
| POST | `/v1/subscription` | ✓ | `{plan}` → оформить (trial — однократно) |
| DELETE | `/v1/subscription` | ✓ | отменить |
| POST | `/v1/deals` | ✓ | **требует `Idempotency-Key`** → создать сделку |
| GET | `/v1/deals?limit` | ✓ | история сделок |
| GET | `/v1/deals/:id` | ✓ | одна сделка |
| POST | `/v1/deals/:id/paid` | ✓ | отметить оплату (далее авто released→done) |
| POST | `/v1/deals/:id/cancel` | ✓ | отменить (с возвратом резерва) |

`POST /v1/deals` тело: `{offerId, asset, fiat, side, volumeUsdt, method, cardId?}`.
Офер и цена берутся из **серверного** кэша стакана, а не из запроса.

## WebSocket (`WS_PATH`)

Протокол — [`../docs/ws-protocol.md`](../docs/ws-protocol.md). Клиент: `auth` →
`subscribe` (`p2p.book`/`p2p.logs`) → `ping`. Сервер шлёт `snapshot`/`update`/
`status`/`log` и пуши `deal`/`kyc`. **Каждый серверный кадр несёт монотонный
`seq` и честный `ts`** — без этого клиентские дедуп и проверка свежести не
работают против replay. Текст логов санитизируется на сервере (выживает только
`<b>`).

---

## Кибербезопасность (модель угроз и меры)

Фронт недоверенный (DevTools открыты у всех) — единственная граница доверия тут.
Клиентские проверки из `feed.js` продублированы и перекрыты на сервере.

| Угроза | Мера | Где в коде |
|---|---|---|
| Подделка пользователя | HMAC-SHA256 проверки `initData` + свежесть `auth_date` (≤5 мин), сравнение `timingSafeEqual` | `adapters/telegram/verifier.ts` |
| Подделка/кража сессии | stateless-токен, подпись HMAC на `SESSION_SECRET`, `timingSafeEqual`, срок жизни; деньги/лимиты перечитываются из БД | `adapters/security/session.ts`, `app/auth.service.ts` |
| Replay auth-кадра | одноразовый `nonce` в TTL-хранилище | `app/auth.service.ts`, `MemoryTtlStore` |
| Replay серверных пушей | монотонный `seq` + честный `ts` на каждом кадре | `adapters/ws/gateway.ts` |
| Двойная закупка (ретрай) | идемпотентность по `(userId, Idempotency-Key)` + лок от гонки | `app/deal.service.ts`, `DealRepo` |
| Обход лимитов с фронта | лимиты офера (min/max, ликвидность) и дневной KYC-лимит считаются на сервере | `app/deal.service.ts`, `domain/kyc.ts` |
| Доступ к платным функциям | гейт «лучших стаканов» (только `quarter`) при создании сделки | `domain/subscription.ts`, `app/feed.service.ts` |
| Гонка баланса (TOCTOU) | сериализация операций одного пользователя (per-user lock) | `app/deal.service.ts` |
| DDoS/флуд (REST) | token-bucket по IP и по аккаунту + отдельный лимит на сделки; лимит тела | `adapters/http/server.ts`, `security/ratelimit.ts` |
| DDoS/флуд (WS) | лимит соединений с IP, кадров/с, размер кадра, idle-timeout, backpressure | `adapters/ws/server.ts` |
| Мусор/инъекции от бирж | `normalizeOffer` отбрасывает мусор, зажимает числа, режет строки, проверяет `exchange` и префикс id; потолок оферов на рынок | `domain/offer.ts`, `app/feed.service.ts` |
| XSS через логи/имена | санитизация на сервере (только `<b>`), фронт экранирует при выводе | `adapters/security/sanitize.ts` |
| CSWSH (cross-site WS) | Origin-allowlist и на REST-CORS, и на WS-апгрейде; сессия не на cookie | `adapters/http/http-util.ts`, `adapters/ws/server.ts` |
| Утечки в ответах | `DomainError`→свой код, прочее→500 без стека; в логах нет PII/токенов | `adapters/http/http-util.ts`, `adapters/infra.ts` |
| Заголовки | `nosniff`, `DENY`, `no-referrer`, CSP `default-src 'none'`, HSTS | `adapters/http/http-util.ts` |
| Секреты/опечатки конфига | валидация на старте, запрет dev-обходов и дефолтного секрета в prod | `config.ts` |

### Остаточные риски (что обязан дать прод-адаптер)

Текущие адаптеры хранилища — **in-memory, для демо/разработки**. Прод-реализация
тех же портов (`ports.ts`) обязана обеспечить:

- **Атомарность денег.** Списание/зачисление баланса и карт — в транзакции
  (`SELECT … FOR UPDATE` / атомарный декремент). Per-user lock здесь защищает
  только один инстанс; при нескольких инстансах нужна БД-транзакция или
  распределённый лок (Redis).
- **Общий rate-limit и nonce/idempotency-хранилище** (Redis) — иначе лимиты и
  anti-replay обходятся подключением к другому инстансу.
- **Шифрование PII.** Анкеты/документы KYC не должны проходить через мини-апп в
  открытом виде: загрузка напрямую провайдеру (Sumsub/Shufti), бэкенд получает
  только вердикт. Персональные данные — отдельное зашифрованное хранилище.
- **TLS терминируется впереди** (балансировщик/прокси); `X-Forwarded-For`
  доверяется только от него.
- Идемпотентный лок держится до TTL: повторная попытка с тем же ключом после
  ошибки вернёт `409` — клиент должен использовать новый ключ для новой попытки.

---

## Подключение фронта

Мини-апп уже говорит по протоколу в режиме `live`. Чтобы направить его на этот
шлюз: выставить `wsUrl` на `wss://<host><WS_PATH>` и включить `feedMode:'live'`
в состоянии фронта; добавить Origin мини-аппа в `CORS_ORIGINS`. REST-эндпоинты
выше покрывают то, что фронт сейчас держит локально (баланс, карты, KYC,
подписка, сделки, топ), — переключение на сервер идёт по одному срезу за раз.

## Что заменить для прод

`main.ts` — единственная точка сборки. Подставить: Postgres/Redis-репозитории
(те же интерфейсы), http-адаптер бирж вместо `GeneratorFeed`, вебхук
платёжного провайдера для подписок, провайдера KYC. Остальной код не меняется.
