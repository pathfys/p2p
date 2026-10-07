#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P2P Light — Gateway (бэкенд одним файлом, только стандартная библиотека Python).

Реализует контракт docs/ws-protocol.md: WebSocket-стрим агрегированных стаканов
+ REST (аутентификация по Telegram initData/HMAC, идемпотентные сделки с
серверными лимитами, KYC, подписки с гейтом «лучших стаканов», топ мерчантов).

Зависимостей рантайма нет — только stdlib. WebSocket-сервер (RFC 6455) и
проверка подписи Telegram написаны вручную: граница доверия — здесь, на сервере
(фронт недоверенный, DevTools открыты у всех).

ЗАПУСК:
    SESSION_SECRET="<не короче 32 символов>" ALLOW_DEV_AUTH=true python3 p2p_gateway.py
    → REST + WebSocket на :8080 (WS по пути /v1/stream)

Переменные окружения и порты — см. .env.example / README.md рядом.
Хранилища in-memory, поток котировок — встроенный генератор (без ключей бирж);
для прода подменяются БД/Redis и реальные биржевые адаптеры.

Код организован секциями (ищите баннеры «==== ... ===="):
    config → errors → money → offer → kyc → subscription → deal → leaderboard
    → security → repositories → feed → services → websocket → http → main
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import queue
import random as _random
import re
import secrets
import signal
import socket
import struct
import threading
import time
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

NOW_MS = lambda: int(time.time() * 1000)  # noqa: E731  (текущее время, мс)
DAY_MS = 86_400_000


# ============================================================================
# config — чтение и валидация окружения (все порты/секреты), fail-fast на старте
# ============================================================================

class ConfigError(Exception):
    pass


def _load_dotenv(path: str) -> Dict[str, str]:
    """Мини-парсер .env: KEY=value, строки с # и пустые — пропускаются."""
    out: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return out
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        if k:
            out[k] = v
    return out


@dataclass(frozen=True)
class Config:
    env: str
    http_host: str
    http_port: int
    ws_path: str
    metrics_port: int
    telegram_bot_token: Optional[str]
    session_secret: str
    cors_origins: Tuple[str, ...]
    allow_dev_auth: bool
    feed_tick_ms: int
    # лимиты (кибербез)
    http_per_min_ip: int
    http_per_min_account: int
    deals_per_min: int
    max_body_bytes: int
    ws_max_conn_per_ip: int
    ws_frames_per_sec: int
    ws_max_frame_bytes: int
    ws_idle_timeout_ms: int


def load_config(cwd: Optional[str] = None) -> Config:
    cwd = cwd or os.getcwd()
    file_env = _load_dotenv(os.path.join(cwd, ".env"))
    errors: List[str] = []

    def get(key: str) -> Optional[str]:
        v = os.environ.get(key)  # переменные окружения приоритетнее .env (12-factor)
        if v is not None and v != "":
            return v
        return file_env.get(key)

    def as_int(key: str, default: int, lo: int = 0, hi: int = 2**53) -> int:
        v = get(key)
        if v is None or v == "":
            return default
        try:
            n = int(v)
        except ValueError:
            errors.append(f"{key} должен быть целым")
            return default
        if n < lo or n > hi:
            errors.append(f"{key} вне диапазона [{lo}, {hi}]")
            return default
        return n

    def as_bool(key: str, default: bool) -> bool:
        v = get(key)
        if v is None or v == "":
            return default
        if v == "true":
            return True
        if v == "false":
            return False
        errors.append(f"{key} должен быть true|false")
        return default

    env = get("NODE_ENV") or get("ENV") or "development"
    if env not in ("development", "production", "test"):
        env = "development"

    bot_token = get("TELEGRAM_BOT_TOKEN") or None
    session_secret = get("SESSION_SECRET") or ""
    if session_secret and len(session_secret) < 32:
        errors.append("SESSION_SECRET должен быть не короче 32 символов")
    if not session_secret:
        errors.append("SESSION_SECRET обязателен")

    cors = tuple(s.strip() for s in (get("CORS_ORIGINS") or "").split(",") if s.strip())
    allow_dev = as_bool("ALLOW_DEV_AUTH", False)

    if env == "production":
        if not bot_token:
            errors.append("В production TELEGRAM_BOT_TOKEN обязателен")
        if allow_dev:
            errors.append("В production ALLOW_DEV_AUTH должен быть false")
        if session_secret == "change-me-to-a-long-random-string-min-32-chars":
            errors.append("В production нельзя оставлять дефолтный SESSION_SECRET")
    if not bot_token and not allow_dev:
        errors.append("Нужен TELEGRAM_BOT_TOKEN или ALLOW_DEV_AUTH=true (локальный стенд)")

    if errors:
        raise ConfigError("Ошибки конфигурации:\n  - " + "\n  - ".join(errors))

    return Config(
        env=env,
        http_host=get("HTTP_HOST") or "127.0.0.1",
        http_port=as_int("HTTP_PORT", 8080, 1, 65535),
        ws_path=get("WS_PATH") or "/v1/stream",
        metrics_port=as_int("METRICS_PORT", 0, 0, 65535),
        telegram_bot_token=bot_token,
        session_secret=session_secret,
        cors_origins=cors,
        allow_dev_auth=allow_dev,
        feed_tick_ms=as_int("FEED_TICK_MS", 600, 50, 60000),
        http_per_min_ip=as_int("RATE_HTTP_PER_MIN_IP", 240, 1),
        http_per_min_account=as_int("RATE_HTTP_PER_MIN_ACCOUNT", 600, 1),
        deals_per_min=as_int("RATE_DEALS_PER_MIN", 20, 1),
        max_body_bytes=as_int("MAX_BODY_BYTES", 65536, 1024, 10 * 1024 * 1024),
        ws_max_conn_per_ip=as_int("WS_MAX_CONN_PER_IP", 8, 1),
        ws_frames_per_sec=as_int("WS_FRAMES_PER_SEC", 300, 1),
        ws_max_frame_bytes=as_int("WS_MAX_FRAME_BYTES", 524288, 1024, 4 * 1024 * 1024),
        ws_idle_timeout_ms=as_int("WS_IDLE_TIMEOUT_MS", 30000, 1000),
    )


# ============================================================================
# errors — таксономия доменных ошибок (code → HTTP-статус), безопасные сообщения
# ============================================================================

_STATUS = {
    "validation": 400, "unauthorized": 401, "forbidden": 403, "not_found": 404,
    "conflict": 409, "rate_limited": 429, "plan_required": 402, "kyc_required": 403,
    "limit_exceeded": 422, "insufficient_funds": 422, "internal": 500,
}


class DomainError(Exception):
    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = _STATUS.get(code, 500)
        self.details = details


def err(code: str, message: str, details: Optional[dict] = None) -> DomainError:
    return DomainError(code, message, details)


# ============================================================================
# money — активы (цена в USD), курсы валют, способы оплаты. Источник истины — тут
# ============================================================================

ASSETS = {  # id -> (цена в USD, знаков после запятой)
    "USDT": (1.0, 2), "BTC": (65_400.0, 6), "ETH": (2_530.0, 4),
    "BNB": (594.0, 4), "SOL": (146.0, 4), "TON": (5.26, 3),
}

CURRENCY_RATES = {  # 1 USD = rate единиц валюты
    "USD": 1, "EUR": 0.92, "GBP": 0.79, "RUB": 97, "UAH": 41, "KZT": 492, "TRY": 34,
    "INR": 83, "NGN": 1600, "BRL": 5.4, "ARS": 1000, "VND": 25400, "IDR": 15800,
    "THB": 35, "PHP": 58, "PKR": 278, "EGP": 49, "AED": 3.67, "SAR": 3.75, "KRW": 1380,
    "JPY": 150, "CNY": 7.2, "PLN": 4.0, "CZK": 23, "RON": 4.6, "HUF": 360, "ZAR": 18,
    "MXN": 18, "COP": 4100,
}

_RU_METHODS = ["sber", "tbank", "alfa", "vtb", "ozon", "sbp", "yoomoney"]
_EU_METHODS = ["sepa", "revolut", "wise", "bank", "card"]
_DEFAULT_METHODS = ["bank", "card", "wise", "paypal", "cash"]
_METHODS_BY_CUR = {
    "RUB": _RU_METHODS, "EUR": _EU_METHODS,
    "GBP": ["revolut", "wise", "bank", "card"],
    "UAH": ["card", "bank", "wise"], "KZT": ["card", "bank", "wise"],
}


def is_known_asset(a: str) -> bool:
    return a in ASSETS


def is_known_currency(c: str) -> bool:
    return c in CURRENCY_RATES


def methods_for(currency: str) -> List[str]:
    return list(_METHODS_BY_CUR.get(currency, _DEFAULT_METHODS))


def asset_rate(asset: str, currency: str) -> float:
    a = ASSETS.get(asset)
    r = CURRENCY_RATES.get(currency)
    if a is None or r is None:
        return 0.0
    return a[0] * r


def usdt_to_asset(usdt: float, asset: str) -> float:
    a = ASSETS.get(asset)
    if not a or a[0] <= 0:
        return 0.0
    return usdt / a[0]


# ============================================================================
# offer — нормализация/санитизация офера: ГРАНИЦА ДОВЕРИЯ к данным бирж
# ============================================================================

_MAX_PRICE = 1e12
_MAX_QTY = 1e15


def _num(v: Any) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return math.nan
    return n if math.isfinite(n) else math.nan


def _nonneg(v: Any, default: float = 0.0) -> float:
    n = _num(v)
    return max(0.0, n) if math.isfinite(n) else default


def _clamp_str(v: Any, default: str, maxlen: int) -> str:
    return (v if isinstance(v, str) else default)[:maxlen]


def normalize_offer(raw: Any, known_exchanges: Set[str]) -> Optional[dict]:
    """Возвращает валидный офер либо None для мусора. Никогда не бросает.

    Отбрасывает: без id/биржи, чужую/неизвестную биржу, id не из своей биржи,
    нечисловую/абсурдную цену, неизвестный актив/валюту. Числа зажимает,
    строки режет — чтобы NaN и гигантские значения не попали в расчёты."""
    if not isinstance(raw, dict):
        return None
    oid = raw.get("id")
    ex = raw.get("exchange")
    oid = oid[:96] if isinstance(oid, str) else None
    ex = ex[:24] if isinstance(ex, str) else None
    if not oid or not ex or ex not in known_exchanges:
        return None
    if not oid.startswith(ex + ":"):  # защита от подмены пространства имён
        return None
    price = _num(raw.get("price"))
    if not (price > 0) or price > _MAX_PRICE:
        return None
    asset = _clamp_str(raw.get("asset"), "USDT", 12)
    fiat = _clamp_str(raw.get("fiat"), "RUB", 8)
    if not is_known_asset(asset) or not is_known_currency(fiat):
        return None
    m = raw.get("merchant") if isinstance(raw.get("merchant"), dict) else {}
    methods = [x for x in raw.get("methods", []) if isinstance(x, str)][:12] if isinstance(raw.get("methods"), list) else []
    return {
        "id": oid,
        "exchange": ex,
        "side": "sell" if raw.get("side") == "sell" else "buy",
        "asset": asset,
        "fiat": fiat,
        "price": price,
        "available": min(_nonneg(raw.get("available")), _MAX_QTY),
        "min": min(_nonneg(raw.get("min")), _MAX_QTY),
        "max": min(_nonneg(raw.get("max")), _MAX_QTY),
        "methods": methods,
        "merchant": {
            "id": _clamp_str(m.get("id"), oid, 96),
            "name": _clamp_str(m.get("name"), "unknown", 64),
            "orders": min(int(_nonneg(m.get("orders"))), 1_000_000_000),
            "completion": min(1.0, max(0.0, _num(m.get("completion")) or 0.0)),
            "rating": min(5.0, max(0.0, _num(m.get("rating")) or 0.0)),
            "verified": bool(m.get("verified")),
            "pro": bool(m.get("pro")),
            "avgReleaseMin": min(1440.0, _nonneg(m.get("avgReleaseMin"), 10.0)),
            "online": m.get("online") is not False,
            "blocked": bool(m.get("blocked")),
        },
        "kycRequired": min(3, max(0, int(_num(raw.get("kycRequired")) or 0))),
        "terms": raw.get("terms")[:600] if isinstance(raw.get("terms"), str) else "",
        "ts": int(_num(raw.get("ts"))) if math.isfinite(_num(raw.get("ts"))) else NOW_MS(),
    }


def median_price(offers: List[dict]) -> float:
    if not offers:
        return 0.0
    p = sorted(o["price"] for o in offers)
    mid = len(p) // 2
    return p[mid] if len(p) % 2 else (p[mid - 1] + p[mid]) / 2


def quick_score(o: dict, median: float, side: str, need_asset: float) -> float:
    """Та же оценка качества офера, что на клиенте: цена + репутация + ликвидность."""
    dev = 0.0
    if median:
        dev = (median - o["price"]) / median if side == "buy" else (o["price"] - median) / median
    mrc = o["merchant"]
    rep = mrc["completion"] * 0.6 + min(1.0, mrc["orders"] / 3000) * 0.4
    liq = min(1.0, o["available"] / (need_asset or 1))
    return dev * 55 + rep * 28 + liq * 17 + (4 if mrc["online"] else 0) + (3 if mrc["verified"] else 0)


def rank_best_ids(offers: List[dict], median: float, side: str, need_asset: float, n: int = 3) -> Set[str]:
    ranked = sorted(offers, key=lambda o: quick_score(o, median, side, need_asset), reverse=True)
    return {o["id"] for o in ranked[:n]}


# ============================================================================
# kyc — уровни, лимиты, переходы. Лимиты серверные; PII здесь не хранится
# ============================================================================

KYC_LEVELS = [
    {"level": 0, "name": "Не верифицирован", "day": 0, "month": 0, "steps": []},
    {"level": 1, "name": "Базовый", "day": 10_000, "month": 100_000, "steps": ["personal", "document"]},
    {"level": 2, "name": "Расширенный", "day": 100_000, "month": 1_500_000, "steps": ["personal", "document", "selfie", "address"]},
    {"level": 3, "name": "Корпоративный", "day": math.inf, "month": math.inf, "steps": ["personal", "document", "selfie", "address", "company"]},
]


def kyc_level_info(level: int) -> dict:
    return KYC_LEVELS[max(0, min(3, level))]


def kyc_day_limit(level: int) -> float:
    return kyc_level_info(level)["day"]


def initial_kyc() -> dict:
    return {"status": "none", "level": 0, "pendingLevel": None,
            "submittedAt": None, "reviewedAt": None, "rejectReason": None}


def kyc_assert_can_submit(state: dict, target: int) -> None:
    if not isinstance(target, int) or target < 1 or target > 3:
        raise err("validation", "Некорректный уровень KYC (1..3)")
    if state["status"] == "pending":
        raise err("conflict", "Заявка уже на проверке")
    if state["status"] == "approved" and state["level"] >= target:
        raise err("conflict", f"Уровень {target} уже подтверждён")
    if target > state["level"] + 1:
        raise err("validation", f"Нельзя перепрыгнуть уровень: доступен {state['level'] + 1}")


def kyc_can_trade(state: dict) -> bool:
    return state["status"] == "approved" and state["level"] >= 1


# ============================================================================
# subscription — тарифы, пробный период, гейт «лучших стаканов» (только quarter)
# ============================================================================

PLANS = [
    {"id": "trial", "name": "Пробный", "term": "1 день", "priceUsd": 0, "days": 1, "bestOffers": False},
    {"id": "week", "name": "Неделя", "term": "7 дней", "priceUsd": 20, "days": 7, "bestOffers": False},
    {"id": "month", "name": "Месяц", "term": "30 дней", "priceUsd": 100, "days": 30, "bestOffers": False},
    {"id": "quarter", "name": "3 месяца", "term": "90 дней", "priceUsd": 200, "days": 90, "bestOffers": True},
]
_PLAN_BY_ID = {p["id"]: p for p in PLANS}


def plan_by_id(pid: str) -> Optional[dict]:
    return _PLAN_BY_ID.get(pid)


def initial_subscription() -> dict:
    return {"plan": None, "since": None, "until": None, "trialUsed": False}


def sub_is_active(sub: dict, now: int) -> bool:
    if not sub["plan"]:
        return False
    return sub["until"] is None or now <= sub["until"]


def active_plan(sub: dict, now: int) -> Optional[dict]:
    return plan_by_id(sub["plan"]) if sub_is_active(sub, now) else None


def can_use_best_offers(sub: dict, now: int) -> bool:
    p = active_plan(sub, now)
    return bool(p and p["bestOffers"])


def sub_subscribe(sub: dict, plan_id: str, now: int) -> dict:
    plan = plan_by_id(plan_id)
    if not plan:
        raise err("validation", "Неизвестный тариф")
    if plan["id"] == "trial" and sub["trialUsed"]:
        raise err("conflict", "Пробный период уже использован")
    return {"plan": plan["id"], "since": now, "until": now + plan["days"] * DAY_MS,
            "trialUsed": sub["trialUsed"] or plan["id"] == "trial"}


def sub_cancel(sub: dict) -> dict:
    return {**sub, "plan": None, "since": None, "until": None}


# ============================================================================
# deal — конечный автомат статусов сделки + генерация референса
# ============================================================================

_TRANSITIONS = {
    "created": ("paid", "cancelled", "disputed"),
    "paid": ("released", "cancelled", "disputed"),
    "released": ("done", "disputed"),
    "done": (),
    "cancelled": (),
    "disputed": ("released", "cancelled"),
}


def deal_is_terminal(s: str) -> bool:
    return len(_TRANSITIONS[s]) == 0


def deal_can_transition(a: str, b: str) -> bool:
    return b in _TRANSITIONS[a]


def deal_assert_transition(a: str, b: str) -> None:
    if not deal_can_transition(a, b):
        raise err("conflict", f"Недопустимый переход сделки: {a} → {b}")


_REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def make_ref() -> str:
    return "P2D-" + "".join(secrets.choice(_REF_ALPHABET) for _ in range(6))


# ============================================================================
# leaderboard — топ мерчантов (детерминированный генератор, seeded PRNG)
# ============================================================================

_PERIOD_MULT = {"week": 1.0, "month": 4.3, "all": 64.0}
PERIODS = ("week", "month", "all")
METRICS = ("volume", "orders")

_TOP_NAMES = [
    "CryptoBaron", "AlphaDesk", "FastSwap", "UsdtKing", "NordExchange", "MerchantPro",
    "LiquidHub", "SafeTrade", "OtcWhale", "PrimeP2P", "GoldBridge", "FlashDealer",
    "VostokPay", "SilkRoad", "EuroDesk", "AsiaLiquid", "TetherLord", "QuickFiat",
    "IronVault", "StableFlow", "RapidCash", "MetroSwap", "OceanOtc", "VertexPay",
    "ZenTrader", "NovaDesk", "ApexFiat", "LunarSwap", "TitanOtc", "OrbitPay",
    "CobraDeals", "FalconFx", "MeridianP2P", "HelixSwap", "CedarTrade", "AtlasDesk",
    "PulseFiat", "VektorPay", "DeltaWhale", "KometaOtc",
]

_U32 = 0xFFFFFFFF


def _mulberry32(seed: int) -> Callable[[], float]:
    state = seed & _U32

    def rnd() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _U32
        t = state
        t = (t ^ (t >> 15)) * (1 | t) & _U32
        t = (t + ((t ^ (t >> 7)) * (61 | t) & _U32)) & _U32 ^ t
        return ((t ^ (t >> 14)) & _U32) / 4294967296.0

    return rnd


def _hash_str(s: str) -> int:
    x = 2166136261
    for ch in s:
        x ^= ord(ch)
        x = (x * 16777619) & _U32
    return x & _U32


def build_leaderboard(exchanges: List[str], period: str, metric: str, limit: int = 30) -> List[dict]:
    pool = exchanges or ["binance"]
    rows = []
    for name in _TOP_NAMES:
        r = _mulberry32(_hash_str(name))
        ex = pool[int(r() * len(pool))]
        base_week_vol = 40_000 + r() * 2_400_000
        avg_ticket = 280 + r() * 4200
        completion = 0.93 + r() * 0.069
        rating = 4.6 + r() * 0.39
        verified = r() > 0.22
        pro = r() > 0.6
        j = _mulberry32(_hash_str(name + ":" + period))()
        jitter = 0.72 + j * 0.56
        volume = base_week_vol * _PERIOD_MULT[period] * jitter
        orders = max(1, round(volume / avg_ticket))
        rows.append({"name": name, "exchange": ex, "volumeUsdt": volume, "orders": orders,
                     "completion": completion, "rating": rating, "verified": verified, "pro": pro})
    rows.sort(key=lambda x: x["volumeUsdt"] if metric == "volume" else x["orders"], reverse=True)
    out = rows[:limit]
    for i, row in enumerate(out):
        row["rank"] = i + 1
    return out


# ============================================================================
# security — санитизация, rate-limit, TTL-хранилище, сессии (HMAC), Telegram HMAC
# ============================================================================

_ESCAPE = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}


def escape_html(s: str) -> str:
    return "".join(_ESCAPE.get(c, c) for c in s)


def safe_log_text(value: Any, maxlen: int = 300) -> str:
    """Экранирует всё, кроме <b>/</b> (контракт логов фронта). Защита от XSS."""
    s = value if isinstance(value, str) else str(value or "")
    escaped = escape_html(s[:maxlen])
    return re.sub(r"&lt;(/?)b&gt;", r"<\1b>", escaped)


def plain_text(value: Any, maxlen: int = 300) -> str:
    s = value if isinstance(value, str) else str(value or "")
    s = re.sub(r"[\x00-\x1f\x7f]", " ", s).strip()
    return s[:maxlen]


class TokenBucket:
    """Token-bucket limiter в памяти: per-ключ ведро, пополняется во времени."""

    def __init__(self, per_interval: int, interval_ms: int):
        self.capacity = max(1, per_interval)
        self.refill_per_ms = per_interval / interval_ms
        self.buckets: Dict[str, Tuple[float, int]] = {}  # key -> (tokens, last_ms)
        self.lock = threading.Lock()
        self.last_sweep = 0

    def take(self, key: str, cost: float = 1.0) -> Tuple[bool, int]:
        now = NOW_MS()
        with self.lock:
            if now - self.last_sweep > 60_000:
                self.last_sweep = now
                for k, (tok, last) in list(self.buckets.items()):
                    if tok + (now - last) * self.refill_per_ms >= self.capacity:
                        self.buckets.pop(k, None)
            tokens, last = self.buckets.get(key, (float(self.capacity), now))
            tokens = min(self.capacity, tokens + (now - last) * self.refill_per_ms)
            if tokens >= cost:
                self.buckets[key] = (tokens - cost, now)
                return True, int(tokens - cost)
            self.buckets[key] = (tokens, now)
            retry = math.ceil((cost - tokens) / self.refill_per_ms)
            return False, retry


class TtlStore:
    """Одноразовые значения с TTL (anti-replay nonce, идемпотентность)."""

    def __init__(self):
        self.m: Dict[str, int] = {}  # key -> expires_at_ms
        self.lock = threading.Lock()
        self.last_sweep = 0

    def put_if_absent(self, key: str, ttl_ms: int) -> bool:
        now = NOW_MS()
        with self.lock:
            if now - self.last_sweep > 30_000:
                self.last_sweep = now
                for k, exp in list(self.m.items()):
                    if exp <= now:
                        self.m.pop(k, None)
            exp = self.m.get(key)
            if exp is not None and exp > now:
                return False
            self.m[key] = now + ttl_ms
            return True


class SessionCodec:
    """Stateless-сессии REST: payload.HMAC. Деньги не доверяют клейму вслепую —
    лимиты/план/баланс перечитываются из хранилища на момент операции."""

    def __init__(self, secret: str, ttl_ms: int = 12 * 60 * 60 * 1000):
        if not secret or len(secret) < 32:
            raise ValueError("SESSION_SECRET too short")
        self.secret = secret.encode()
        self.ttl_ms = ttl_ms

    def _sign(self, payload_b64: str) -> str:
        sig = hmac.new(self.secret, payload_b64.encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(sig).rstrip(b"=").decode()

    def issue(self, user_id: str, tg_id: str, now: int) -> str:
        claims = {"sub": user_id, "tg": tg_id, "iat": now, "exp": now + self.ttl_ms}
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
        return f"{payload}.{self._sign(payload)}"

    def verify(self, token: str, now: int) -> Optional[dict]:
        if not isinstance(token, str) or len(token) > 4096 or "." not in token:
            return None
        payload, _, sig = token.partition(".")
        if not hmac.compare_digest(sig, self._sign(payload)):  # timing-safe
            return None
        try:
            pad = "=" * (-len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload + pad))
        except Exception:
            return None
        if not isinstance(claims, dict) or not isinstance(claims.get("sub"), str):
            return None
        if now > claims.get("exp", 0):
            return None
        return claims


AUTH_MAX_AGE_SEC = 300


def telegram_verify_hmac(bot_token: str, init_data: str, now: int) -> Optional[dict]:
    """Проверка Telegram WebApp initData по схеме Telegram (HMAC-SHA256) +
    свежесть auth_date (≤5 мин). Только после этого доверяем user.id."""
    if not isinstance(init_data, str) or not init_data or len(init_data) > 8192:
        return None
    try:
        params = urllib.parse.parse_qsl(init_data, strict_parsing=False, keep_blank_values=True)
    except ValueError:
        return None
    data = dict(params)
    got_hash = data.get("hash", "")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", got_hash or ""):
        return None
    dcs = "\n".join(f"{k}={v}" for k, v in sorted((k, v) for k, v in data.items() if k != "hash"))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret_key, dcs.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, got_hash.lower()):
        return None
    try:
        auth_date = int(data.get("auth_date", "0"))
    except ValueError:
        return None
    if now / 1000 - auth_date > AUTH_MAX_AGE_SEC or auth_date > now / 1000 + 60:
        return None
    try:
        user = json.loads(data.get("user", ""))
    except Exception:
        return None
    uid = user.get("id")
    if not isinstance(uid, (int, str)):
        return None
    return {"id": str(uid),
            "firstName": plain_text(user.get("first_name"), 64) or "user",
            "username": plain_text(user.get("username"), 64) or None}


def telegram_verify_dev(init_data: str) -> Optional[dict]:
    """Dev-заглушка (без бота): подпись НЕ проверяется. Разрешена только когда
    ALLOW_DEV_AUTH=true и нет TELEGRAM_BOT_TOKEN; в production запрещена."""
    uid, first, username = "dev_1", "Dev", "dev"
    if isinstance(init_data, str) and 0 < len(init_data) <= 2048:
        try:
            p = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
            uid = (p.get("id") or uid)[:64]
            first = (p.get("first_name") or first)[:64]
            username = (p.get("username") or username)[:64]
        except ValueError:
            pass
    return {"id": uid, "firstName": first, "username": username}


# ============================================================================
# repositories — in-memory хранилища (потокобезопасные). Прод: Postgres/Redis
# ============================================================================

class Store:
    """Единое in-memory хранилище под общим замком. Прод-адаптер обязан
    обеспечить атомарность денежных операций (транзакции Б---транзакции БД)."""

    def __init__(self):
        self.lock = threading.RLock()
        self.users: Dict[str, dict] = {}
        self.by_tg: Dict[str, str] = {}
        self.kyc: Dict[str, dict] = {}
        self.subs: Dict[str, dict] = {}
        self.balances: Dict[str, float] = {}
        self.cards: Dict[str, Dict[str, dict]] = {}
        self.deals: Dict[str, dict] = {}
        self.deal_by_idem: Dict[str, str] = {}

    # users
    def get_user(self, uid: str) -> Optional[dict]:
        with self.lock:
            return self.users.get(uid)

    def create_user(self, user: dict) -> dict:
        with self.lock:
            self.users[user["id"]] = user
            self.by_tg[user["tgId"]] = user["id"]
            return user

    # kyc
    def get_kyc(self, uid: str) -> dict:
        with self.lock:
            return self.kyc.get(uid) or initial_kyc()

    def set_kyc(self, uid: str, state: dict) -> None:
        with self.lock:
            self.kyc[uid] = state

    # subscriptions
    def get_sub(self, uid: str) -> dict:
        with self.lock:
            return self.subs.get(uid) or initial_subscription()

    def set_sub(self, uid: str, sub: dict) -> None:
        with self.lock:
            self.subs[uid] = sub

    # balance
    def get_balance(self, uid: str) -> float:
        with self.lock:
            return self.balances.get(uid, 0.0)

    def set_balance(self, uid: str, usdt: float) -> None:
        with self.lock:
            self.balances[uid] = max(0.0, usdt)

    # cards
    def list_cards(self, uid: str) -> List[dict]:
        with self.lock:
            return list(self.cards.get(uid, {}).values())

    def get_card(self, uid: str, cid: str) -> Optional[dict]:
        with self.lock:
            return self.cards.get(uid, {}).get(cid)

    def upsert_card(self, uid: str, card: dict) -> None:
        with self.lock:
            self.cards.setdefault(uid, {})[card["id"]] = card

    def remove_card(self, uid: str, cid: str) -> None:
        with self.lock:
            self.cards.get(uid, {}).pop(cid, None)

    # deals
    def create_deal(self, deal: dict) -> None:
        with self.lock:
            self.deals[deal["id"]] = deal
            self.deal_by_idem[f"{deal['userId']}:{deal['idemKey']}"] = deal["id"]

    def get_deal(self, did: str) -> Optional[dict]:
        with self.lock:
            return self.deals.get(did)

    def find_deal_by_idem(self, uid: str, idem: str) -> Optional[dict]:
        with self.lock:
            did = self.deal_by_idem.get(f"{uid}:{idem}")
            return self.deals.get(did) if did else None

    def update_deal_status(self, did: str, status: str, at: int) -> Optional[dict]:
        with self.lock:
            d = self.deals.get(did)
            if not d:
                return None
            d["status"] = status
            d["updatedAt"] = at
            return d

    def list_deals(self, uid: str, limit: int) -> List[dict]:
        with self.lock:
            ds = [d for d in self.deals.values() if d["userId"] == uid]
        ds.sort(key=lambda d: d["createdAt"], reverse=True)
        return ds[:max(0, limit)]

    def day_volume_usdt(self, uid: str, frm: int) -> float:
        with self.lock:
            return sum(d["volumeUsdt"] for d in self.deals.values()
                       if d["userId"] == uid and d["createdAt"] >= frm and d["status"] != "cancelled")


# ============================================================================
# feed — генератор стаканов + FeedHub (общий кэш, фан-аут клиентам)
# ============================================================================

VENUES = [
    ("binance", 0.97, 38), ("bybit", 0.95, 44), ("okx", 0.94, 52), ("bitget", 0.92, 61),
    ("htx", 0.90, 74), ("kucoin", 0.89, 83), ("mexc", 0.87, 91), ("gate", 0.86, 96),
]
VENUE_IDS = {v[0] for v in VENUES}
VENUE_BY_ID = {v[0]: v for v in VENUES}
_NAME_PREFIX = ["Crypto", "Fast", "Prime", "Nord", "Gold", "Liquid", "Stable", "Rapid", "Vertex", "Atlas"]
_NAME_SUFFIX = ["Desk", "Pay", "Swap", "OTC", "Trade", "Hub", "King", "Vault", "Flow", "Bridge"]
_MAX_OFFERS_PER_MARKET = 4000
_IDLE_EVICT_MS = 120_000


class VenueBook:
    """Стакан одной биржи для пары/стороны. Детерминированный seed → стабильно."""

    def __init__(self, venue_id: str, reliability: float, asset: str, fiat: str, side: str):
        self.venue_id = venue_id
        self.reliability = reliability
        self.asset = asset
        self.fiat = fiat
        self.side = side
        self.rnd = _mulberry32(_hash_str(venue_id + asset + fiat + side))
        self.premium = (1 - reliability) * 0.6 * (self.rnd() - 0.3)
        self.mid = asset_rate(asset, fiat) * (1 + self.premium * 0.01)
        self.seq = 0
        self.offers: Dict[str, dict] = {}
        for i in range(6 + int(self.rnd() * 8)):
            self._spawn(i)

    def _merchant_name(self) -> str:
        r = self.rnd
        return _NAME_PREFIX[int(r() * len(_NAME_PREFIX))] + _NAME_SUFFIX[int(r() * len(_NAME_SUFFIX))] + str(int(r() * 90 + 10))

    def _spawn(self, rank: Optional[int] = None) -> dict:
        r = self.rnd
        self.seq += 1
        oid = f"{self.venue_id}:{self.seq}"
        idx = rank if rank is not None else int(r() * 10)
        dev = (0.0015 + idx * 0.0011 + r() * 0.0014) * (1 if self.side == "buy" else -1)
        usdt_mid = asset_rate("USDT", self.fiat) or 1
        unit = asset_rate(self.asset, self.fiat)
        usdt_scale = 1 if self.asset == "USDT" else unit / usdt_mid
        available = (400 + r() * r() * 90_000) / usdt_scale
        price = self.mid * (1 + dev)
        min_fiat = round((500 + r() * 14_000) / 100) * 100
        max_fiat = max(min_fiat * 2, round(available * price * (0.4 + r() * 0.6)))
        pool = methods_for(self.fiat)
        nm = 1 + int(r() * min(3, len(pool)))
        pool_shuffled = sorted(pool, key=lambda _: r())
        offer = {
            "id": oid, "exchange": self.venue_id, "side": self.side, "asset": self.asset,
            "fiat": self.fiat, "price": price, "available": available, "min": min_fiat, "max": max_fiat,
            "methods": pool_shuffled[:nm],
            "merchant": {
                "id": "m_" + oid, "name": self._merchant_name(),
                "orders": int(20 + r() ** 1.6 * 9000), "completion": 0.8 + r() * 0.198,
                "rating": round((4.0 + r()) * 100) / 100, "verified": r() < 0.62, "pro": r() < 0.3,
                "avgReleaseMin": round((0.8 + r() * 14) * 10) / 10, "online": r() < 0.88, "blocked": r() < 0.04,
            },
            "kycRequired": 1 if r() < 0.5 else (2 if r() < 0.85 else 0),
            "terms": "", "ts": NOW_MS(),
        }
        self.offers[oid] = offer
        return offer

    def snapshot(self) -> List[dict]:
        now = NOW_MS()
        return [{**o, "ts": now} for o in self.offers.values()]

    def tick(self, now: int) -> Tuple[List[dict], List[str]]:
        r = self.rnd
        base = asset_rate(self.asset, self.fiat) * (1 + self.premium * 0.01)
        self.mid += (base - self.mid) * 0.06 + self.mid * (r() - 0.5) * 0.0009
        upsert: List[dict] = []
        remove: List[str] = []
        ids = list(self.offers.keys())
        for _ in range(1 + int(r() * 3)):
            if not ids:
                break
            oid = ids[int(r() * len(ids))]
            o = self.offers.get(oid)
            if not o:
                continue
            frac = o["price"] / self.mid - 1 + (r() - 0.5) * 0.0006
            o["price"] = self.mid * (1 + frac)
            o["available"] = max(20.0, o["available"] * (0.94 + r() * 0.13))
            o["ts"] = now
            upsert.append(dict(o))
        if r() < 0.14 and len(ids) > 4:
            oid = ids[int(r() * len(ids))]
            self.offers.pop(oid, None)
            remove.append(oid)
        if r() < 0.16 and len(self.offers) < 18:
            upsert.append(dict(self._spawn()))
        return upsert, remove


class Market:
    def __init__(self, key: str, asset: str, fiat: str, side: str):
        self.key = key
        self.asset = asset
        self.fiat = fiat
        self.side = side
        self.books: Dict[str, VenueBook] = {}
        self.offers: Dict[str, dict] = {}   # нормализованный агрегированный стакан
        self.clients: Set["ClientReg"] = set()
        self.lock = threading.RLock()
        self.last_access = NOW_MS()
        self.stopped = False
        self.thread: Optional[threading.Thread] = None


class ClientReg:
    def __init__(self, exchanges: Set[str], emit: Callable[[dict], None]):
        self.exchanges = exchanges
        self.emit = emit


class FeedHub:
    def __init__(self, tick_ms: int, logger: Callable[[str, str, dict], None]):
        self.tick = tick_ms / 1000.0
        self.log = logger
        self.markets: Dict[str, Market] = {}
        self.lock = threading.RLock()
        self.known = set(VENUE_IDS)
        self._stop = threading.Event()
        threading.Thread(target=self._sweeper, daemon=True).start()

    def known_exchanges(self) -> Set[str]:
        return set(self.known)

    def _key(self, asset: str, fiat: str, side: str) -> str:
        return f"{asset}:{fiat}:{side}"

    def ensure_market(self, asset: str, fiat: str, side: str) -> Market:
        key = self._key(asset, fiat, side)
        with self.lock:
            m = self.markets.get(key)
            if m:
                m.last_access = NOW_MS()
                return m
            m = Market(key, asset, fiat, side)
            for vid, rel, _lat in VENUES:
                m.books[vid] = VenueBook(vid, rel, asset, fiat, side)
                for o in m.books[vid].snapshot():
                    no = normalize_offer(o, self.known)  # граница доверия
                    if no:
                        m.offers[no["id"]] = no
            self.markets[key] = m
            m.thread = threading.Thread(target=self._run_market, args=(m,), daemon=True)
            m.thread.start()
            self.log("info", "market opened", {"market": key})
            return m

    def _run_market(self, m: Market) -> None:
        while not self._stop.is_set():
            time.sleep(self.tick)
            with m.lock:
                if m.stopped:
                    return
                now = NOW_MS()
                for vid, book in m.books.items():
                    rel = VENUE_BY_ID[vid][1]
                    if _random.random() > rel + 0.028:  # редкий таймаут площадки
                        self._fanout(m, {"kind": "status", "exchange": vid, "ts": now, "state": "connecting", "latency": VENUE_BY_ID[vid][2]})
                        self._fanout(m, {"kind": "log", "ts": now, "level": "warn", "exchange": vid, "text": "таймаут ответа, повтор запроса…"})
                        continue
                    upsert, remove = book.tick(now)
                    clean = []
                    for o in upsert:
                        no = normalize_offer(o, self.known)
                        if not no:
                            continue
                        if no["id"] not in m.offers and len(m.offers) >= _MAX_OFFERS_PER_MARKET:
                            continue
                        m.offers[no["id"]] = no
                        clean.append(no)
                    for rid in remove:
                        m.offers.pop(rid, None)
                    if clean or remove:
                        self._fanout(m, {"kind": "update", "exchange": vid, "ts": now, "upsert": clean, "remove": remove})

    def _fanout(self, m: Market, ev: dict) -> None:
        for c in list(m.clients):
            try:
                if ev["kind"] == "log":
                    if ev["exchange"] is None or ev["exchange"] in c.exchanges:
                        c.emit(ev)
                elif ev.get("exchange") in c.exchanges:
                    c.emit(ev)
            except Exception:
                pass  # изоляция: сбой одного клиента не роняет остальных

    def subscribe_client(self, params: dict, emit: Callable[[dict], None]) -> Callable[[], None]:
        exchanges = {e for e in params["exchanges"] if e in self.known}
        m = self.ensure_market(params["asset"], params["fiat"], params["side"])
        reg = ClientReg(exchanges, emit)
        with m.lock:
            m.clients.add(reg)
            m.last_access = NOW_MS()
            now = NOW_MS()
            for ex in exchanges:  # стартовые снапшоты из кэша — по одному на биржу
                offers = [o for o in m.offers.values() if o["exchange"] == ex]
                if offers:
                    emit({"kind": "snapshot", "exchange": ex, "ts": now, "offers": offers})

        def unsub() -> None:
            with m.lock:
                m.clients.discard(reg)
        return unsub

    def get_market(self, asset: str, fiat: str, side: str) -> Tuple[List[dict], float]:
        m = self.ensure_market(asset, fiat, side)
        with m.lock:
            offers = list(m.offers.values())
        return offers, median_price(offers)

    def is_best_offer(self, asset: str, fiat: str, side: str, offer_id: str, volume_usdt: float) -> bool:
        key = self._key(asset, fiat, side)
        m = self.markets.get(key)
        if not m:
            return False
        with m.lock:
            offers = list(m.offers.values())
        need = usdt_to_asset(volume_usdt, asset) or 1
        return offer_id in rank_best_ids(offers, median_price(offers), side, need, 3)

    def _sweeper(self) -> None:
        while not self._stop.wait(30):
            now = NOW_MS()
            with self.lock:
                for key, m in list(self.markets.items()):
                    if not m.clients and now - m.last_access > _IDLE_EVICT_MS:
                        m.stopped = True
                        self.markets.pop(key, None)
                        self.log("info", "market evicted", {"market": key})

    def stop(self) -> None:
        self._stop.set()
        with self.lock:
            for m in self.markets.values():
                m.stopped = True
            self.markets.clear()


# ============================================================================
# user events — доставка пушей (сделки/KYC) до подключённых WS-сессий
# ============================================================================

class UserEventBus:
    def __init__(self):
        self.subs: Dict[str, Set[Callable[[dict], None]]] = {}
        self.lock = threading.Lock()

    def on(self, user_id: str, fn: Callable[[dict], None]) -> Callable[[], None]:
        with self.lock:
            self.subs.setdefault(user_id, set()).add(fn)

        def off() -> None:
            with self.lock:
                s = self.subs.get(user_id)
                if s:
                    s.discard(fn)
                    if not s:
                        self.subs.pop(user_id, None)
        return off

    def emit(self, user_id: str, ev: dict) -> None:
        with self.lock:
            handlers = list(self.subs.get(user_id, ()))
        for fn in handlers:
            try:
                fn(ev)
            except Exception:
                pass


# ============================================================================
# services — сценарии (use-cases) поверх домена и хранилища
# ============================================================================

def new_uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(9)}"


class Services:
    """Контейнер сервисов + сами сценарии (в одном классе ради единственного файла)."""

    def __init__(self, cfg: Config, store: Store, feed: FeedHub, events: UserEventBus,
                 sessions: SessionCodec, logger: Callable[[str, str, dict], None]):
        self.cfg = cfg
        self.store = store
        self.feed = feed
        self.events = events
        self.sessions = sessions
        self.log = logger
        self.nonces = TtlStore()
        self.idem = TtlStore()
        self._user_locks: Dict[str, threading.Lock] = {}
        self._user_locks_guard = threading.Lock()

    # ---- auth ----
    def authenticate(self, init_data: str, nonce: Optional[str]) -> dict:
        now = NOW_MS()
        if self.cfg.telegram_bot_token:
            tg = telegram_verify_hmac(self.cfg.telegram_bot_token, init_data, now)
        else:
            tg = telegram_verify_dev(init_data)
        if not tg:
            raise err("unauthorized", "Проверка Telegram initData не пройдена")
        if nonce:
            if not isinstance(nonce, str) or not (8 <= len(nonce) <= 128):
                raise err("unauthorized", "Некорректный nonce")
            if not self.nonces.put_if_absent(f"auth:{tg['id']}:{nonce}", 5 * 60 * 1000):
                raise err("unauthorized", "Повтор auth-кадра (replay)")
        uid = f"u_{tg['id']}"
        user = self.store.get_user(uid)
        if not user:
            user = self.store.create_user({
                "id": uid, "tgId": tg["id"], "name": tg["firstName"],
                "handle": ("@" + tg["username"]) if tg["username"] else "@user", "createdAt": now,
            })
            self.store.set_kyc(uid, initial_kyc())
            self.store.set_sub(uid, initial_subscription())
        kyc = self.store.get_kyc(uid)
        sub = self.store.get_sub(uid)
        plan = active_plan(sub, now)
        return {
            "user": user, "token": self.sessions.issue(uid, tg["id"], now),
            "kyc": kyc, "plan": plan["id"] if plan else None,
            "limits": {"dayUsdt": _lim(kyc_day_limit(kyc["level"]))},
        }

    def resolve_token(self, token: str) -> Optional[dict]:
        claims = self.sessions.verify(token, NOW_MS())
        return {"userId": claims["sub"], "tgId": claims["tg"]} if claims else None

    # ---- account ----
    def set_balance(self, uid: str, mode: str, amount: Any) -> float:
        try:
            n = float(amount)
        except (TypeError, ValueError):
            raise err("validation", "Некорректная сумма")
        if not math.isfinite(n) or n < 0 or n > 1e12:
            raise err("validation", "Некорректная сумма")
        cur = self.store.get_balance(uid)
        if mode == "deposit":
            nxt = cur + n
        elif mode == "withdraw":
            if n > cur:
                raise err("insufficient_funds", "Недостаточно средств")
            nxt = cur - n
        else:
            nxt = n
        self.store.set_balance(uid, nxt)
        return nxt

    def upsert_card(self, uid: str, body: dict, card_id: Optional[str] = None) -> dict:
        label = plain_text(body.get("label"), 40)
        if not label:
            raise err("validation", "Укажите название карты")
        digits = re.sub(r"\D", "", str(body.get("number", "")))
        if not (12 <= len(digits) <= 19):
            raise err("validation", "Номер карты должен быть 12–19 цифр")
        currency = str(body.get("currency", "RUB"))
        if not is_known_currency(currency):
            raise err("validation", "Неизвестная валюта карты")
        try:
            balance = float(body.get("balance", 0))
        except (TypeError, ValueError):
            raise err("validation", "Некорректный баланс карты")
        if not math.isfinite(balance) or balance < 0 or balance > 1e12:
            raise err("validation", "Некорректный баланс карты")
        existing = self.store.get_card(uid, card_id) if card_id else None
        if card_id and not existing:
            raise err("not_found", "Карта не найдена")
        active = bool(body["active"]) if "active" in body else (existing["active"] if existing else True)
        card = {
            "id": existing["id"] if existing else new_uid("card"),
            "label": label, "bank": plain_text(body.get("bank"), 24) or "bank",
            "last4": digits[-4:],  # полный PAN не храним (PCI-гигиена)
            "balance": balance, "currency": currency, "active": active,
        }
        self.store.upsert_card(uid, card)
        return card

    def remove_card(self, uid: str, card_id: str) -> None:
        if not self.store.get_card(uid, card_id):
            raise err("not_found", "Карта не найдена")
        self.store.remove_card(uid, card_id)

    # ---- kyc ----
    def kyc_submit(self, uid: str, level: Any) -> dict:
        try:
            lvl = int(level)
        except (TypeError, ValueError):
            raise err("validation", "Некорректный уровень")
        state = self.store.get_kyc(uid)
        kyc_assert_can_submit(state, lvl)
        now = NOW_MS()
        pending = {**state, "status": "pending", "pendingLevel": lvl, "submittedAt": now, "rejectReason": None}
        self.store.set_kyc(uid, pending)
        t = threading.Timer(4.0, self._kyc_review, args=(uid, lvl))
        t.daemon = True
        t.start()
        return pending

    def _kyc_review(self, uid: str, level: int) -> None:
        state = self.store.get_kyc(uid)
        if state["status"] != "pending" or state["pendingLevel"] != level:
            return
        now = NOW_MS()
        if secrets.randbelow(10) < 9:  # 90% одобрений
            nxt = {**state, "status": "approved", "level": level, "pendingLevel": None, "reviewedAt": now, "rejectReason": None}
        else:
            nxt = {**state, "status": "rejected", "pendingLevel": None, "reviewedAt": now,
                   "rejectReason": "Не удалось подтвердить данные. Проверьте и отправьте снова."}
        self.store.set_kyc(uid, nxt)
        self.events.emit(uid, {"type": "kyc", "data": {
            "status": nxt["status"], "level": nxt["level"], "reviewedAt": now, "rejectReason": nxt["rejectReason"]}})

    def kyc_reset(self, uid: str) -> dict:
        fresh = initial_kyc()
        self.store.set_kyc(uid, fresh)
        return fresh

    # ---- subscription ----
    def sub_view(self, uid: str) -> dict:
        now = NOW_MS()
        sub = self.store.get_sub(uid)
        plan = active_plan(sub, now)
        return {
            "subscription": sub, "activePlanId": plan["id"] if plan else None,
            "bestOffers": can_use_best_offers(sub, now),
            "remainingMs": max(0, sub["until"] - now) if (plan and sub["until"]) else 0,
        }

    def sub_subscribe(self, uid: str, plan_id: str) -> dict:
        nxt = sub_subscribe(self.store.get_sub(uid), str(plan_id), NOW_MS())
        self.store.set_sub(uid, nxt)
        return self.sub_view(uid)

    def sub_cancel(self, uid: str) -> dict:
        self.store.set_sub(uid, sub_cancel(self.store.get_sub(uid)))
        return self.sub_view(uid)

    # ---- top ----
    def top(self, period: str, metric: str, limit: int) -> dict:
        period = period or "week"
        metric = metric or "volume"
        if period not in PERIODS:
            raise err("validation", "period ∈ {week, month, all}")
        if metric not in METRICS:
            raise err("validation", "metric ∈ {volume, orders}")
        n = max(3, min(100, limit if isinstance(limit, int) else 30))
        return {"period": period, "metric": metric,
                "entries": build_leaderboard(list(self.feed.known_exchanges()), period, metric, n)}

    # ---- deals (денежный путь) ----
    def _user_lock(self, uid: str) -> threading.Lock:
        with self._user_locks_guard:
            lk = self._user_locks.get(uid)
            if lk is None:
                lk = threading.Lock()
                self._user_locks[uid] = lk
            return lk

    def create_deal(self, uid: str, body: dict, idem_key: str) -> dict:
        # сериализация операций одного пользователя: устраняет гонку баланса (TOCTOU)
        with self._user_lock(uid):
            return self._create_deal_inner(uid, body, idem_key)

    def _create_deal_inner(self, uid: str, body: dict, idem_key: str) -> dict:
        if not isinstance(idem_key, str) or not (1 <= len(idem_key) <= 128):
            raise err("validation", "Требуется корректный Idempotency-Key")
        prior = self.store.find_deal_by_idem(uid, idem_key)
        if prior:
            return prior  # идемпотентность: тот же ключ → тот же ордер
        if not self.idem.put_if_absent(f"deal:{uid}:{idem_key}", 10 * 60 * 1000):
            again = self.store.find_deal_by_idem(uid, idem_key)
            if again:
                return again
            raise err("conflict", "Дубликат запроса в обработке, повторите позже")

        offer_id = str(body.get("offerId", ""))
        asset = str(body.get("asset", ""))
        fiat = str(body.get("fiat", ""))
        side = "sell" if body.get("side") == "sell" else "buy"
        method = str(body.get("method", ""))
        card_id = None if body.get("cardId") in (None, "") else str(body.get("cardId"))
        try:
            volume = float(body.get("volumeUsdt"))
        except (TypeError, ValueError):
            raise err("validation", "Некорректный объём в USDT")
        if not offer_id or len(offer_id) > 96:
            raise err("validation", "offerId обязателен")
        if not is_known_asset(asset):
            raise err("validation", "Неизвестный актив")
        if not is_known_currency(fiat):
            raise err("validation", "Неизвестная валюта")
        if not math.isfinite(volume) or volume <= 0 or volume > 1e9:
            raise err("validation", "Некорректный объём в USDT")

        kyc = self.store.get_kyc(uid)
        if not kyc_can_trade(kyc):
            raise err("kyc_required", "Нужна KYC-верификация (уровень 1 и выше)")

        offers, _median = self.feed.get_market(asset, fiat, side)  # поднимает рынок при нужде
        offer = next((o for o in offers if o["id"] == offer_id), None)
        if not offer:
            raise err("not_found", "Офер снят с биржи или не найден")
        if offer["merchant"]["blocked"]:
            raise err("forbidden", "Мерчант в блок-листе")
        if method not in offer["methods"]:
            raise err("validation", "Способ оплаты недоступен у офера")
        if offer["kycRequired"] > kyc["level"]:
            raise err("kyc_required", f"Офер требует KYC уровня {offer['kycRequired']}")

        amount_asset = usdt_to_asset(volume, asset)
        fiat_total = amount_asset * offer["price"]
        if amount_asset > offer["available"]:
            raise err("limit_exceeded", "Недостаточно ликвидности у офера")
        if fiat_total < offer["min"] or fiat_total > offer["max"]:
            raise err("limit_exceeded", f"Объём вне лимитов офера ({offer['min']}–{offer['max']} {fiat})")

        day_limit = kyc_day_limit(kyc["level"])
        if math.isfinite(day_limit):
            used = self.store.day_volume_usdt(uid, NOW_MS() - DAY_MS)
            if used + volume > day_limit:
                raise err("limit_exceeded", f"Превышен дневной лимит уровня KYC ({_lim(day_limit)} USDT)")

        if self.feed.is_best_offer(asset, fiat, side, offer_id, volume):
            if not can_use_best_offers(self.store.get_sub(uid), NOW_MS()):
                raise err("plan_required", "Лучшие стаканы доступны только на тарифе «3 месяца»")

        # резервирование средств
        if side == "buy":
            if not card_id:
                raise err("validation", "Для покупки нужна карта")
            card = self.store.get_card(uid, card_id)
            if not card or not card["active"]:
                raise err("validation", "Карта не найдена или отключена")
            if card["currency"] != fiat:
                raise err("validation", "Валюта карты не совпадает с валютой офера")
            if card["balance"] < fiat_total:
                raise err("insufficient_funds", "Недостаточно средств на карте")
            self.store.upsert_card(uid, {**card, "balance": card["balance"] - fiat_total})
        else:
            bal = self.store.get_balance(uid)
            if bal < amount_asset:
                raise err("insufficient_funds", "Недостаточно USDT для продажи")
            self.store.set_balance(uid, bal - amount_asset)

        now = NOW_MS()
        deal = {
            "id": new_uid("deal"), "ref": make_ref(), "userId": uid, "offerId": offer_id,
            "exchange": offer["exchange"], "side": side, "asset": asset, "fiat": fiat,
            "price": offer["price"], "amountAsset": amount_asset, "volumeUsdt": volume,
            "fiatTotal": fiat_total, "method": method, "cardId": card_id, "status": "created",
            "idemKey": idem_key, "createdAt": now, "updatedAt": now,
        }
        self.store.create_deal(deal)
        self.log("info", "deal created", {"userId": uid, "dealId": deal["id"], "ref": deal["ref"]})
        return deal

    def get_deal(self, uid: str, did: str) -> dict:
        d = self.store.get_deal(did)
        if not d or d["userId"] != uid:
            raise err("not_found", "Сделка не найдена")
        return d

    def list_deals(self, uid: str, limit: int) -> List[dict]:
        return self.store.list_deals(uid, max(1, min(200, limit)))

    def deal_mark_paid(self, uid: str, did: str) -> dict:
        d = self.get_deal(uid, did)
        deal_assert_transition(d["status"], "paid")
        updated = self._transition(d, "paid")
        self._schedule_settlement(uid, did)
        return updated

    def deal_cancel(self, uid: str, did: str) -> dict:
        d = self.get_deal(uid, did)
        if deal_is_terminal(d["status"]) or d["status"] == "released":
            raise err("conflict", "Сделку уже нельзя отменить")
        deal_assert_transition(d["status"], "cancelled")
        self._refund(d)
        return self._transition(d, "cancelled")

    def _transition(self, deal: dict, status: str) -> dict:
        now = NOW_MS()
        nxt = self.store.update_deal_status(deal["id"], status, now) or {**deal, "status": status, "updatedAt": now}
        self.events.emit(deal["userId"], {"type": "deal", "data": {
            "dealId": deal["id"], "ref": deal["ref"], "status": status, "at": now}})
        return nxt

    def _schedule_settlement(self, uid: str, did: str) -> None:
        def step_release() -> None:
            d = self.store.get_deal(did)
            if not d or d["userId"] != uid or d["status"] != "paid":
                return
            self._transition(d, "released")
            t2 = threading.Timer(2.5, step_done)
            t2.daemon = True
            t2.start()

        def step_done() -> None:
            d = self.store.get_deal(did)
            if not d or d["status"] != "released":
                return
            self._settle(d)
            self._transition(d, "done")

        t1 = threading.Timer(2.5, step_release)
        t1.daemon = True
        t1.start()

    def _settle(self, deal: dict) -> None:
        if deal["side"] == "buy":
            self.store.set_balance(deal["userId"], self.store.get_balance(deal["userId"]) + deal["amountAsset"])
        elif deal["cardId"]:
            card = self.store.get_card(deal["userId"], deal["cardId"])
            if card:
                self.store.upsert_card(deal["userId"], {**card, "balance": card["balance"] + deal["fiatTotal"]})

    def _refund(self, deal: dict) -> None:
        if deal["side"] == "buy":
            if not deal["cardId"]:
                return
            card = self.store.get_card(deal["userId"], deal["cardId"])
            if card:
                self.store.upsert_card(deal["userId"], {**card, "balance": card["balance"] + deal["fiatTotal"]})
        else:
            self.store.set_balance(deal["userId"], self.store.get_balance(deal["userId"]) + deal["amountAsset"])


def _lim(v: float):
    """Infinity → строка '∞' для JSON (там нет Infinity)."""
    return "∞" if v == math.inf else v


def deal_view(d: dict) -> dict:
    """Представление сделки клиенту (без внутреннего idemKey)."""
    return {k: d[k] for k in ("ref", "offerId", "exchange", "side", "asset", "fiat", "price",
                              "amountAsset", "volumeUsdt", "fiatTotal", "method", "status",
                              "createdAt", "updatedAt")} | {"dealId": d["id"]}


# ============================================================================
# websocket — кодек RFC 6455 + per-connection сессия (auth/subscribe/ping)
# ============================================================================

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def ws_accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _WS_GUID).encode()).digest()).decode()


def ws_frame(opcode: int, payload: bytes) -> bytes:
    n = len(payload)
    out = bytearray([0x80 | opcode])
    if n < 126:
        out.append(n)
    elif n < 65536:
        out.append(126)
        out += struct.pack("!H", n)
    else:
        out.append(127)
        out += struct.pack("!Q", n)
    out += payload
    return bytes(out)


def ws_text(s: str) -> bytes:
    return ws_frame(0x1, s.encode("utf-8"))


def ws_close_frame(code: int, reason: str = "") -> bytes:
    return ws_frame(0x8, struct.pack("!H", code) + reason.encode("utf-8")[:123])


class WSSession:
    """Одно WS-соединение: рукопожатие уже сделано, здесь — протокол и защита.
    Читатель (этот поток) принимает кадры; писатель (отдельный поток) шлёт из
    очереди — медленный клиент не блокирует генератор (backpressure)."""

    def __init__(self, handler: "Handler", svc: Services, cfg: Config):
        self.h = handler
        self.svc = svc
        self.cfg = cfg
        self.sock: socket.socket = handler.connection
        self.rfile = handler.rfile
        self.wfile = handler.wfile
        self.seq = 0
        self.seq_lock = threading.Lock()
        self.out: "queue.Queue[Optional[bytes]]" = queue.Queue(maxsize=512)
        self.closed = threading.Event()
        self.authed = False
        self.user_id = ""
        self.book_unsub: Optional[Callable[[], None]] = None
        self.events_unsub: Optional[Callable[[], None]] = None
        self.sub_limiter = TokenBucket(60, 60_000)
        self.frame_limiter = TokenBucket(cfg.ws_frames_per_sec, 1000)
        self.dropped = 0

    # ---- отправка ----
    def send(self, ev: dict) -> None:
        with self.seq_lock:
            self.seq += 1
            ev = {**ev, "seq": self.seq, "ts": NOW_MS()}
        try:
            self.out.put_nowait(ws_text(json.dumps(ev, ensure_ascii=False)))
        except queue.Full:
            self.close(1013, "backpressure")  # медленный потребитель — отключаем

    def send_err(self, code: str, message: str) -> None:
        self.send({"ev": "error", "data": {"code": code, "message": message}})

    def _writer(self) -> None:
        ping_interval = max(1.0, self.cfg.ws_idle_timeout_ms / 2000.0)
        while not self.closed.is_set():
            try:
                item = self.out.get(timeout=ping_interval)
            except queue.Empty:
                item = ws_frame(0x9, b"")  # серверный ping
            if item is None:
                break
            try:
                self.wfile.write(item)
                self.wfile.flush()
            except OSError:
                break
        self.closed.set()

    def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        try:
            self.wfile.write(ws_close_frame(code, reason))
            self.wfile.flush()
        except OSError:
            pass
        try:
            self.out.put_nowait(None)
        except queue.Full:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    # ---- приём ----
    def _read_exact(self, n: int) -> bytes:
        data = self.rfile.read(n)
        if not data or len(data) < n:
            raise ConnectionError("eof")
        return data

    def _read_frame(self) -> Tuple[bool, int, bytes]:
        h = self._read_exact(2)
        fin = bool(h[0] & 0x80)
        if h[0] & 0x70:
            raise ConnectionError("rsv")
        opcode = h[0] & 0x0F
        masked = bool(h[1] & 0x80)
        length = h[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        if length > self.cfg.ws_max_frame_bytes:
            raise ConnectionError("frame too large")
        if not masked:  # клиент ОБЯЗАН маскировать
            raise ConnectionError("not masked")
        mask = self._read_exact(4)
        payload = bytearray(self._read_exact(length)) if length else bytearray()
        for i in range(length):
            payload[i] ^= mask[i & 3]
        return fin, opcode, bytes(payload)

    def run(self) -> None:
        self.sock.settimeout(self.cfg.ws_idle_timeout_ms / 1000.0)
        writer = threading.Thread(target=self._writer, daemon=True)
        writer.start()
        frags: List[bytes] = []
        total = 0
        try:
            while not self.closed.is_set():
                try:
                    fin, opcode, payload = self._read_frame()
                except socket.timeout:
                    self.close(1001, "idle timeout")
                    break
                except (ConnectionError, OSError):
                    break
                if opcode == 0x8:  # close
                    break
                if opcode == 0x9:  # ping → pong
                    try:
                        self.out.put_nowait(ws_frame(0xA, payload[:125]))
                    except queue.Full:
                        pass
                    continue
                if opcode == 0xA:  # pong
                    continue
                if opcode == 0x2:  # binary — не принимаем
                    self.close(1003, "binary")
                    break
                if opcode in (0x1, 0x0):  # text / continuation
                    ok, _retry = self.frame_limiter.take("f")
                    if not ok:
                        self.dropped += 1
                        if self.dropped > self.cfg.ws_frames_per_sec:
                            self.close(1008, "rate limit")
                            break
                        continue
                    total += len(payload)
                    if total > self.cfg.ws_max_frame_bytes:
                        self.close(1009, "message too large")
                        break
                    frags.append(payload)
                    if not fin:
                        continue
                    message = b"".join(frags)
                    frags, total = [], 0
                    self._handle_message(message)
        finally:
            self.close()
            if self.book_unsub:
                self.book_unsub()
            if self.events_unsub:
                self.events_unsub()
            self.h.close_connection = True

    def _handle_message(self, raw: bytes) -> None:
        if len(raw) > 64 * 1024:
            return
        try:
            msg = json.loads(raw.decode("utf-8"))
        except Exception:
            self.send_err("bad_json", "Кадр не является JSON")
            return
        if not isinstance(msg, dict):
            return
        op = msg.get("op")
        if op == "auth":
            self._on_auth(msg)
        elif op == "subscribe":
            self._on_subscribe(msg)
        elif op == "unsubscribe":
            if self.book_unsub:
                self.book_unsub()
                self.book_unsub = None
        elif op == "ping":
            self.send({"ev": "pong"})
        else:
            self.send_err("bad_op", "Неизвестная операция")

    def _on_auth(self, msg: dict) -> None:
        if self.authed:
            return
        try:
            r = self.svc.authenticate(msg.get("initData", "") if isinstance(msg.get("initData"), str) else "",
                                      msg.get("nonce") if isinstance(msg.get("nonce"), str) else None)
        except DomainError as e:
            self.send({"ev": "error", "data": {"code": e.code, "message": e.message}})
            self.close(4401, "auth failed")
            return
        self.authed = True
        self.user_id = r["user"]["id"]
        self.events_unsub = self.svc.events.on(self.user_id, lambda push: self.send({"ev": push["type"], "data": push["data"]}))
        self.send({"ev": "auth", "ok": True, "data": {
            "userId": self.user_id, "kycLevel": r["kyc"]["level"], "plan": r["plan"], "limits": r["limits"]}})

    def _on_subscribe(self, msg: dict) -> None:
        if not self.authed:
            self.send_err("unauthorized", "Сначала auth")
            return
        ok, _ = self.sub_limiter.take(self.user_id)
        if not ok:
            self.send_err("rate_limited", "Слишком частые подписки")
            return
        channel = msg.get("channel")
        if channel == "p2p.logs":
            return  # логи идут вместе с книгой — no-op ack
        if channel != "p2p.book":
            self.send_err("bad_channel", "Неизвестный канал")
            return
        args = msg.get("args") if isinstance(msg.get("args"), dict) else {}
        asset = str(args.get("asset", "USDT"))
        fiat = str(args.get("fiat", "RUB"))
        side = "sell" if args.get("side") == "sell" else "buy"
        if not is_known_asset(asset) or not is_known_currency(fiat):
            self.send_err("bad_args", "Неизвестный актив/валюта")
            return
        known = self.svc.feed.known_exchanges()
        exchanges = [e for e in (args.get("exchanges") or []) if isinstance(e, str) and e in known]
        if not exchanges:
            self.send_err("bad_args", "Не указаны известные биржи")
            return
        if self.book_unsub:
            self.book_unsub()
        self.book_unsub = self.svc.feed.subscribe_client(
            {"exchanges": exchanges, "asset": asset, "fiat": fiat, "side": side}, self._emit_feed)

    def _emit_feed(self, e: dict) -> None:
        kind = e["kind"]
        if kind == "snapshot":
            self.send({"ev": "snapshot", "channel": "p2p.book", "exchange": e["exchange"], "data": {"offers": e["offers"]}})
        elif kind == "update":
            self.send({"ev": "update", "channel": "p2p.book", "exchange": e["exchange"],
                       "data": {"upsert": e["upsert"], "remove": e["remove"]}})
        elif kind == "status":
            self.send({"ev": "status", "exchange": e["exchange"], "data": {"state": e["state"], "latency": e["latency"]}})
        elif kind == "log":
            self.send({"ev": "log", "data": {"level": e["level"], "exchange": e["exchange"], "text": safe_log_text(e["text"])}})


# ============================================================================
# http — конвейер (заголовки → CORS → rate-limit → маршрут → auth → хендлер)
# ============================================================================

_BEARER_RE = re.compile(r"^Bearer\s+(.+)$", re.I)


class Route:
    def __init__(self, method: str, pattern: str, fn: Callable, auth: bool):
        self.method = method
        self.parts = [p for p in pattern.split("/") if p]
        self.fn = fn
        self.auth = auth

    def match(self, parts: List[str]) -> Optional[Dict[str, str]]:
        if len(parts) != len(self.parts):
            return None
        params: Dict[str, str] = {}
        for pat, seg in zip(self.parts, parts):
            if pat.startswith(":"):
                params[pat[1:]] = urllib.parse.unquote(seg)
            elif pat != seg:
                return None
        return params


class Ctx:
    def __init__(self, params, query, body, auth):
        self.params = params
        self.query = query
        self.body = body
        self.auth = auth


def build_routes(svc: Services) -> List[Route]:
    def uid(ctx: Ctx) -> str:
        return ctx.auth["userId"]

    def obj(ctx: Ctx) -> dict:
        return ctx.body if isinstance(ctx.body, dict) else {}

    r: List[Route] = []
    add = lambda m, p, fn, auth=True: r.append(Route(m, p, fn, auth))  # noqa: E731

    add("GET", "/v1/health", lambda c: {"ok": True, "ts": NOW_MS()}, auth=False)

    def auth_tg(c: Ctx):
        b = obj(c)
        res = svc.authenticate(b.get("initData", "") if isinstance(b.get("initData"), str) else "",
                               b.get("nonce") if isinstance(b.get("nonce"), str) else None)
        return {"token": res["token"], "user": {k: res["user"][k] for k in ("id", "name", "handle")},
                "kyc": res["kyc"], "plan": res["plan"], "limits": res["limits"]}
    add("POST", "/v1/auth/telegram", auth_tg, auth=False)

    def me(c: Ctx):
        u = uid(c)
        return {"balanceUsdt": svc.store.get_balance(u), "kyc": svc.store.get_kyc(u),
                "subscription": svc.sub_view(u), "cards": svc.store.list_cards(u)}
    add("GET", "/v1/me", me)

    def market(c: Ctx):
        asset = c.query.get("asset", ["USDT"])[0]
        fiat = c.query.get("fiat", ["RUB"])[0]
        side = "sell" if c.query.get("side", ["buy"])[0] == "sell" else "buy"
        offers, median = svc.feed.get_market(asset, fiat, side)
        offers = sorted(offers, key=lambda o: o["price"], reverse=(side == "sell"))
        return {"asset": asset, "fiat": fiat, "side": side, "median": median, "offers": offers[:60]}
    add("GET", "/v1/market", market)

    def top(c: Ctx):
        try:
            limit = int(c.query.get("limit", ["30"])[0])
        except ValueError:
            limit = 30
        return svc.top(c.query.get("period", ["week"])[0], c.query.get("metric", ["volume"])[0], limit)
    add("GET", "/v1/top", top)

    def balance(c: Ctx):
        b = obj(c)
        mode = b.get("mode") if b.get("mode") in ("deposit", "withdraw") else "set"
        return {"balanceUsdt": svc.set_balance(uid(c), mode, b.get("amount"))}
    add("POST", "/v1/balance", balance)

    add("GET", "/v1/cards", lambda c: {"cards": svc.store.list_cards(uid(c))})
    add("POST", "/v1/cards", lambda c: {"card": svc.upsert_card(uid(c), obj(c))})
    add("PATCH", "/v1/cards/:id", lambda c: {"card": svc.upsert_card(uid(c), obj(c), c.params["id"])})
    add("DELETE", "/v1/cards/:id", lambda c: (svc.remove_card(uid(c), c.params["id"]), {"ok": True})[1])

    add("GET", "/v1/kyc", lambda c: svc.store.get_kyc(uid(c)))
    add("POST", "/v1/kyc/submit", lambda c: svc.kyc_submit(uid(c), obj(c).get("level")))
    add("POST", "/v1/kyc/reset", lambda c: svc.kyc_reset(uid(c)))

    add("GET", "/v1/subscription", lambda c: {**svc.sub_view(uid(c)), "plans": PLANS})
    add("POST", "/v1/subscription", lambda c: svc.sub_subscribe(uid(c), obj(c).get("plan", "")))
    add("DELETE", "/v1/subscription", lambda c: svc.sub_cancel(uid(c)))

    add("POST", "/v1/deals", lambda c: deal_view(svc.create_deal(uid(c), obj(c), c.idem or "")))
    add("GET", "/v1/deals", lambda c: {"deals": [deal_view(d) for d in svc.list_deals(uid(c), _qint(c, "limit", 50))]})
    add("GET", "/v1/deals/:id", lambda c: deal_view(svc.get_deal(uid(c), c.params["id"])))
    add("POST", "/v1/deals/:id/paid", lambda c: deal_view(svc.deal_mark_paid(uid(c), c.params["id"])))
    add("POST", "/v1/deals/:id/cancel", lambda c: deal_view(svc.deal_cancel(uid(c), c.params["id"])))
    return r


def _qint(c: Ctx, key: str, default: int) -> int:
    try:
        return int(c.query.get(key, [str(default)])[0])
    except ValueError:
        return default


class Handler(BaseHTTPRequestHandler):
    server_version = "P2PLightGateway/1.0"
    protocol_version = "HTTP/1.1"

    # доступ к контейнеру — через server
    @property
    def svc(self) -> Services:
        return self.server.svc  # type: ignore[attr-defined]

    @property
    def cfg(self) -> Config:
        return self.server.cfg  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # заглушаем access-лог stdlib
        pass

    # методы
    def do_GET(self) -> None:
        up = (self.headers.get("Upgrade") or "").lower()
        path = urllib.parse.urlsplit(self.path).path
        if path == self.cfg.ws_path and up == "websocket":
            self._handle_ws()
            return
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def do_OPTIONS(self) -> None:
        self._handle("OPTIONS")

    # общий конвейер REST
    def _handle(self, method: str) -> None:
        self._security_headers()
        cors = self._apply_cors()
        if cors == "forbidden":
            return self._send_err(403, "forbidden", "Origin не разрешён")
        if method == "OPTIONS":
            self.send_response(204)
            for k, v in getattr(self, "_extra_headers", []):
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ip = self._client_ip()
        ok, retry = self.server.ip_limiter.take(ip)  # type: ignore[attr-defined]
        if not ok:
            return self._send_err(429, "rate_limited", "Слишком много запросов с адреса", retry)

        split = urllib.parse.urlsplit(self.path)
        parts = [p for p in split.path.split("/") if p]
        query = urllib.parse.parse_qs(split.query)

        matched = None
        for route in self.server.routes:  # type: ignore[attr-defined]
            if route.method != method:
                continue
            params = route.match(parts)
            if params is not None:
                matched = (route, params)
                break
        if not matched:
            if any(r.match(parts) is not None for r in self.server.routes):  # type: ignore[attr-defined]
                return self._send_err(405, "validation", "Метод не поддерживается")
            return self._send_err(404, "not_found", "Маршрут не найден")

        route, params = matched
        auth = None
        if route.auth:
            m = _BEARER_RE.match(self.headers.get("Authorization") or "")
            resolved = self.svc.resolve_token(m.group(1).strip()) if m else None
            if not resolved:
                return self._send_err(401, "unauthorized", "Требуется авторизация")
            auth = resolved
            ok, retry = self.server.account_limiter.take(resolved["userId"])  # type: ignore[attr-defined]
            if not ok:
                return self._send_err(429, "rate_limited", "Слишком много запросов аккаунта", retry)
            if method == "POST" and split.path == "/v1/deals":
                ok, retry = self.server.deal_limiter.take(resolved["userId"])  # type: ignore[attr-defined]
                if not ok:
                    return self._send_err(429, "rate_limited", "Слишком часто создаются сделки", retry)

        body: Any = None
        if method in ("POST", "PATCH", "PUT"):
            body = self._read_body()
            if body is _BODY_TOO_LARGE:
                return self._send_err(400, "validation", "Тело запроса слишком большое")
            if body is _BODY_BAD_JSON:
                return self._send_err(400, "validation", "Некорректный JSON")

        ctx = Ctx(params, query, body, auth)
        ctx.idem = self.headers.get("Idempotency-Key")  # type: ignore[attr-defined]
        try:
            result = route.fn(ctx)
            status = 201 if (method == "POST" and split.path == "/v1/deals") else 200
            self._send_json(status, result if result is not None else {})
        except DomainError as e:
            self._send_err(e.status, e.code, e.message, None, e.details)
        except Exception as e:  # noqa: BLE001
            self.svc.log("error", "unhandled", {"err": repr(e)})
            self._send_err(500, "internal", "Внутренняя ошибка")

    # ---- WebSocket upgrade ----
    def _handle_ws(self) -> None:
        origin = self.headers.get("Origin")
        if origin and self.cfg.cors_origins and origin not in self.cfg.cors_origins:
            self._refuse_upgrade(403, "Forbidden Origin")
            return
        key = self.headers.get("Sec-WebSocket-Key")
        version = self.headers.get("Sec-WebSocket-Version")
        if not key or version != "13":
            self._refuse_upgrade(400, "Bad Request")
            return
        ip = self._client_ip()
        srv = self.server
        with srv.ws_lock:  # type: ignore[attr-defined]
            if srv.ws_conns.get(ip, 0) >= self.cfg.ws_max_conn_per_ip:  # type: ignore[attr-defined]
                self._refuse_upgrade(429, "Too Many Connections")
                return
            srv.ws_conns[ip] = srv.ws_conns.get(ip, 0) + 1  # type: ignore[attr-defined]
        try:
            self.wfile.write(
                b"HTTP/1.1 101 Switching Protocols\r\n"
                b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                b"Sec-WebSocket-Accept: " + ws_accept_key(key).encode() + b"\r\n\r\n")
            self.wfile.flush()
            self.close_connection = True  # по завершении WS не продолжаем HTTP keep-alive
            WSSession(self, self.svc, self.cfg).run()
        finally:
            with srv.ws_lock:  # type: ignore[attr-defined]
                srv.ws_conns[ip] = max(0, srv.ws_conns.get(ip, 1) - 1)  # type: ignore[attr-defined]
                if srv.ws_conns.get(ip) == 0:
                    srv.ws_conns.pop(ip, None)

    def _refuse_upgrade(self, status: int, text: str) -> None:
        try:
            self.wfile.write(f"HTTP/1.1 {status} {text}\r\nConnection: close\r\n\r\n".encode())
            self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True

    # ---- helpers ----
    def _security_headers(self) -> None:
        self._extra_headers = [
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
            ("Cross-Origin-Resource-Policy", "same-site"),
            ("Cache-Control", "no-store"),
            ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
            ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"),
        ]

    def _apply_cors(self) -> str:
        origin = self.headers.get("Origin")
        if origin:
            if origin not in self.cfg.cors_origins:
                return "forbidden"
            self._extra_headers += [
                ("Access-Control-Allow-Origin", origin),
                ("Vary", "Origin"),
                ("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS"),
                ("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key"),
                ("Access-Control-Max-Age", "600"),
            ]
        return "ok"

    def _client_ip(self) -> str:
        xff = self.headers.get("X-Forwarded-For")
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
        return self.client_address[0] if self.client_address else "unknown"

    def _read_body(self) -> Any:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            return _BODY_BAD_JSON
        if length <= 0:
            return {}
        if length > self.cfg.max_body_bytes:
            return _BODY_TOO_LARGE
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return _BODY_BAD_JSON

    def _send_json(self, status: int, body: Any) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        for k, v in getattr(self, "_extra_headers", []):
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_err(self, status: int, code: str, message: str, retry: Optional[int] = None, details=None) -> None:
        if retry:
            self._extra_headers = getattr(self, "_extra_headers", []) + [("Retry-After", str(max(1, math.ceil(retry / 1000))))]
        err_body = {"error": {"code": code, "message": message}}
        if details:
            err_body["error"]["details"] = details
        self._send_json(status, err_body)


# маркеры результата чтения тела
_BODY_TOO_LARGE = object()
_BODY_BAD_JSON = object()


# ============================================================================
# main — композиционный корень: собрать сервисы, поднять сервер
# ============================================================================

def make_logger(env: str) -> Callable[[str, str, dict], None]:
    min_level = 10 if env == "development" else 20
    rank = {"debug": 10, "info": 20, "warn": 30, "error": 40}

    def log(level: str, msg: str, fields: Optional[dict] = None) -> None:
        if rank.get(level, 20) < min_level:
            return
        line = json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                           "level": level, "msg": msg, "svc": "p2p-gateway", **(fields or {})},
                          ensure_ascii=False)
        print(line, flush=True)
    return log


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    try:
        cfg = load_config()
    except ConfigError as e:
        print(str(e), flush=True)
        raise SystemExit(1)

    log = make_logger(cfg.env)
    if not cfg.telegram_bot_token:
        log("warn", "DEV AUTH ENABLED: initData не проверяется подписью (только для стенда)")

    store = Store()
    events = UserEventBus()
    feed = FeedHub(cfg.feed_tick_ms, log)
    sessions = SessionCodec(cfg.session_secret)
    svc = Services(cfg, store, feed, events, sessions, log)

    server = GatewayServer((cfg.http_host, cfg.http_port), Handler)
    server.svc = svc            # type: ignore[attr-defined]
    server.cfg = cfg            # type: ignore[attr-defined]
    server.routes = build_routes(svc)  # type: ignore[attr-defined]
    server.ip_limiter = TokenBucket(cfg.http_per_min_ip, 60_000)        # type: ignore[attr-defined]
    server.account_limiter = TokenBucket(cfg.http_per_min_account, 60_000)  # type: ignore[attr-defined]
    server.deal_limiter = TokenBucket(cfg.deals_per_min, 60_000)        # type: ignore[attr-defined]
    server.ws_conns = {}        # type: ignore[attr-defined]
    server.ws_lock = threading.Lock()  # type: ignore[attr-defined]

    def shutdown(signum, _frame):
        log("info", "shutting down", {"signal": signum})
        feed.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    log("info", "http+ws listening", {"host": cfg.http_host, "port": cfg.http_port, "wsPath": cfg.ws_path})
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
