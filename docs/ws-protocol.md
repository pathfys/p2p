# P2P Light · WebSocket-контракт (фронт ↔ бэк)

Фронтенд **никогда** не ходит в API бирж напрямую: ключи и подписи остались бы
в мини-аппе, а CORS всё равно бы не пустил. Вместо этого бэкенд держит адаптеры
бирж, нормализует их ответы в один формат офера и стримит их сюда.

Этот файл — то, что должен реализовать бэкенд. Фронт уже говорит по нему:
`src/services/feed.js`, режим `live`.

```
┌──────────────┐   ws (этот контракт)   ┌─────────────┐   http/ws   ┌──────────┐
│  Mini App    │ ◄────────────────────► │   Gateway   │ ◄─────────► │ Binance  │
│ (этот репо)  │                        │  (Node.js)  │             │ Bybit    │
└──────────────┘                        └─────────────┘             │ OKX, …   │
                                              │                     └──────────┘
                                         ┌────▼─────┐
                                         │ Postgres │  оферы, мерчанты, сделки
                                         │  Redis   │  кэш стаканов, rate-limit
                                         └──────────┘
```

Транспорт: `wss://`, кадры — JSON, UTF-8. Рекомендуется `ws` (не socket.io):
протокол простой, а нативный `WebSocket` в Telegram WebView есть везде.

---

## 1. Аутентификация

Первым кадром после `open` клиент шлёт:

```json
{ "id": "1", "op": "auth", "token": "p2pd_live_xxx", "initData": "<Telegram WebApp.initData>" }
```

`initData` бэкенд **обязан** проверить HMAC-SHA256 по схеме Telegram
(`secret = HMAC_SHA256("WebAppData", bot_token)`), сверить `auth_date`
(не старше ~5 минут) и только потом доверять `user.id`. Без этого любой может
подделать пользователя.

Ответ:

```json
{ "ev": "auth", "ok": true, "data": { "userId": "u_123", "kycLevel": 1, "plan": "pro", "limits": { "dayUsdt": 10000 } } }
```

При отказе — `{ "ev": "error", "data": { "code": "auth_failed", "message": "..." } }` и закрытие с кодом `4401`.

---

## 2. Клиент → сервер

| op | назначение |
|---|---|
| `auth` | см. выше |
| `subscribe` | подписка на канал |
| `unsubscribe` | отписка |
| `ping` | keepalive, раз в 2 с |

### subscribe

```json
{
  "id": "2",
  "op": "subscribe",
  "channel": "p2p.book",
  "args": {
    "exchanges": ["binance", "bybit", "okx", "bitget", "htx", "kucoin", "mexc", "gate"],
    "asset": "USDT",
    "fiat": "RUB",
    "side": "buy"
  }
}
```

`side` — с точки зрения **пользователя**: `buy` = пользователь покупает крипту
(значит нужны объявления мерчантов на продажу), `sell` — наоборот.

Каналы:

| channel | что шлёт |
|---|---|
| `p2p.book` | снапшот + инкрементальные апдейты стакана |
| `p2p.logs` | события биржевых адаптеров (для консоли во вкладке P2P) |
| `deals` | изменения статусов сделок пользователя |

Смена пары/стороны = новый `subscribe`; сервер сам снимает предыдущую подписку
по тому же каналу.

---

## 3. Сервер → клиент

Все кадры имеют поле `ev`. Фронт разбирает их в `handleServerEvent()`.

### `snapshot` — полный стакан одной биржи

```json
{
  "ev": "snapshot",
  "channel": "p2p.book",
  "exchange": "binance",
  "ts": 1759500000000,
  "data": { "offers": [ /* Offer[] */ ] }
}
```

Шлётся при подписке и после восстановления адаптера. Фронт заменяет все оферы
этой биржи. Биржи приходят независимо — UI показывает их по мере готовности.

### `update` — инкремент

```json
{
  "ev": "update",
  "channel": "p2p.book",
  "exchange": "bybit",
  "ts": 1759500000420,
  "data": {
    "upsert": [ /* Offer[] */ ],
    "remove": ["bybit:88213"]
  }
}
```

Шлите дельты, а не весь стакан: при 8 биржах × ~15 оферов полный снапшот
каждые 400 мс — это мегабайты в минуту на мобильном.

### `status` — состояние адаптера биржи

```json
{ "ev": "status", "exchange": "okx", "ts": 1759500000000, "data": { "state": "live", "latency": 52 } }
```

`state`: `idle` | `connecting` | `live` | `down`. Рисуется LED-индикатором на чипе биржи.

### `log` — строка в консоль событий

```json
{ "ev": "log", "data": { "level": "warn", "exchange": "htx", "text": "rate limit 429, backoff 2s" } }
```

`level`: `info` | `up` | `down` | `new` | `gone` | `warn` | `alert` | `trade`.
В `text` допустим `<b>…</b>` — больше ничего, фронт вставляет его как HTML.
**Санитизируйте текст на сервере**, иначе это XSS.

### `error`

```json
{ "ev": "error", "data": { "code": "rate_limited", "message": "…", "exchange": "mexc" } }
```

---

## 4. Формат офера (нормализованный)

Главная работа бэкенда — привести к этому виду ответы всех бирж.

```jsonc
{
  "id": "binance:7781234",        // "<exchange>:<id объявления на бирже>"
  "exchange": "binance",
  "side": "buy",                  // сторона пользователя
  "asset": "USDT",
  "fiat": "RUB",
  "price": 97.42,                 // цена за 1 единицу актива
  "available": 15230.55,          // доступно в активе
  "min": 5000,                    // лимиты сделки, в фиате
  "max": 500000,
  "methods": ["sber", "tbank"],   // id из PAY_METHODS (src/core/store.js)
  "merchant": {
    "id": "m_binance_4412",
    "name": "CryptoExchange",
    "orders": 1240,               // всего сделок
    "completion": 0.986,          // доля успешных, 0..1
    "rating": 4.9,
    "verified": true,
    "pro": true,
    "avgReleaseMin": 3.2,
    "online": true,
    "blocked": false              // блоклист платформы
  },
  "kycRequired": 1,               // минимальный KYC-уровень, 0..3
  "ts": 1759500000000             // когда котировка получена от биржи
}
```

Поля `price`, `available`, `min`, `max`, `completion` — числа, не строки.
Биржи отдают их строками, приводите на сервере: иначе сортировка стакана
сломается на лексикографическом сравнении.

### Источники по биржам

| exchange | публичный эндпоинт стакана |
|---|---|
| binance | `POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search` |
| bybit   | `POST https://api2.bybit.com/fiat/otc/item/online` |
| okx     | `GET  https://www.okx.com/v3/c2c/tradingOrders/books` |
| bitget  | `POST https://www.bitget.com/v1/p2p/pub/adv/queryAdvList` |
| htx     | `GET  https://otc-api.trygala.com/v1/data/trade-market` |
| kucoin  | `GET  https://www.kucoin.com/_api/otc/ad/list` |
| mexc    | `GET  https://otc.mexc.com/api/market/deal/list` |
| gate    | `GET  https://www.gate.io/json_svr/query_push` |

Это недокументированные веб-эндпоинты: они меняются без предупреждения, у них
агрессивный rate-limit и часто нужен прокси по гео. Закладывайте на адаптер
ретраи, backoff и схему-валидацию ответа, иначе одна смена поля у биржи уронит
весь стрим.

---

## 5. Переподключение

Фронт при `close` переподключается с экспоненциальной задержкой
`min(30s, 2^n)`, затем шлёт `auth` + `subscribe` заново. Сервер должен
отвечать `snapshot`, а не ждать следующего инкремента, иначе стакан будет пустым
до первого изменения цены.

Если за 10 с нет ни одного кадра — считайте соединение мёртвым и закрывайте
его: мобильные сети рвут TCP молча.

---

## 6. Сделки (следующий шаг)

Исполнение сейчас симулируется на фронте (`src/services/trade.js`). Для прода
нужен REST + события:

```
POST /v1/deals            { offerId, volumeUsdt, method, cardId }  → { dealId, ref, status }
POST /v1/deals/:id/paid   — пользователь отметил оплату
POST /v1/deals/:id/cancel
GET  /v1/deals?limit=50
```

и push по WS:

```json
{ "ev": "deal", "data": { "dealId": "…", "ref": "P2D-VABIT4", "status": "released", "at": 1759500009000 } }
```

Статусы: `created → paid → released → done`, плюс `cancelled` и `disputed`.

Критично для денег: `POST /v1/deals` должен быть **идемпотентным** по
ключу от клиента (`Idempotency-Key`), иначе ретрай на плохой сети создаст
две закупки. Лимиты (на сделку, дневной, KYC-уровня) проверяются на сервере —
проверки на фронте в `preflight()` только для UX, обойти их тривиально.

---

## 7. KYC

Фронт ведёт анкету и шлёт её на верификацию; решение приходит от бэкенда.

```
POST /v1/kyc/submit   { level, data }  → { status: "pending" }
GET  /v1/kyc          → { status, level, rejectReason }
```

```json
{ "ev": "kyc", "data": { "status": "approved", "level": 2, "reviewedAt": 1759500000000 } }
```

Уровни и лимиты (`src/core/store.js` → `KYC_LEVELS`):

| уровень | шаги | лимит/сутки | лимит/месяц |
|---|---|---|---|
| 1 | личные данные, документ | 10 000 USDT | 100 000 USDT |
| 2 | + селфи, адрес | 100 000 USDT | 1 500 000 USDT |
| 3 | + компания (B2B) | без лимита | без лимита |

Документы и селфи не должны проходить через мини-апп в открытом виде:
загрузка напрямую в KYC-провайдера (Sumsub / Shufti) по одноразовому токену,
бэкенд получает только вердикт. Персональные данные — отдельное хранилище
с шифрованием, в Postgres рядом с оферами им не место.
