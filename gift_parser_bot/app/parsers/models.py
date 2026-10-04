"""Общие структуры данных, которые возвращают все источники парсинга."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


class Throttled(Exception):
    """Источник попросил притормозить (HTTP 429 / RetryAfter / FLOOD_WAIT)."""

    def __init__(self, retry_after: float | None = None):
        super().__init__(f"throttled, retry after {retry_after}s")
        self.retry_after = retry_after


@dataclass
class Owner:
    """Владелец подарка. Хотя бы одно из user_id / username / ton_address нужно, чтобы сохранить его в БД."""

    user_id: int | None = None
    username: str | None = None
    name: str | None = None
    ton_address: str | None = None

    @property
    def identifiable(self) -> bool:
        return bool(self.user_id or self.username or self.ton_address)


@dataclass
class ParsedGift:
    slug: str  # каноничный вид: "plushpepe-1"
    title: str  # "Plush Pepe"
    number: int
    model: str | None = None
    model_rarity: int | None = None  # промилле (на 1000 улучшений), как rarity_per_mille в Bot API
    backdrop: str | None = None
    backdrop_rarity: int | None = None
    symbol: str | None = None
    symbol_rarity: int | None = None
    issued: int | None = None
    total: int | None = None
    owner: Owner | None = None
    # Имя владельца без юзернейма — сохраняем только для отображения
    owner_name: str | None = None
    source: str = "nft_page"

    @property
    def collection(self) -> str:
        return collection_of(self.slug)


@dataclass
class Portfolio:
    """Все уникальные подарки одного аккаунта (ответ getUserGifts / getSavedStarGifts)."""

    owner: Owner
    gifts: list[ParsedGift] = field(default_factory=list)
    # Пользователи, которые дарили эти подарки — новые кандидаты для парсинга
    senders: list[Owner] = field(default_factory=list)
    complete: bool = True


_SLUG_RE = re.compile(r"(?:https?://)?(?:t\.me/nft/|tg://nft\?slug=)?([A-Za-z][A-Za-z0-9]*)-(\d+)\b")


def normalize_slug(raw: str) -> str | None:
    """'https://t.me/nft/PlushPepe-1' / 'PlushPepe-1' -> 'plushpepe-1'."""
    m = _SLUG_RE.search(raw.strip())
    if not m:
        return None
    return f"{m.group(1).lower()}-{int(m.group(2))}"


def collection_of(slug: str) -> str:
    return slug.rsplit("-", 1)[0].lower()


def title_to_collection(title: str) -> str:
    """'Durov's Cap' -> 'durovscap', 'Jack-in-the-Box' -> 'jackinthebox'."""
    return re.sub(r"[^a-z0-9]", "", title.lower())


def percent_to_permille(text: str) -> int | None:
    m = re.search(r"([\d.,]+)\s*%", text)
    if not m:
        return None
    return round(float(m.group(1).replace(",", ".")) * 10)
