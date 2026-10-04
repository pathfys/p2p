"""Источник №2: fragment.com — полный список коллекций и floor-цены (в TON).

* https://fragment.com/gifts — все коллекции (slug + название);
* https://fragment.com/gifts/<slug>?sort=price_asc&filter=sale — самый дешёвый лот = floor.

Floor с Fragment — ориентир для режимов «лёгкий / средний / rich». Цены внутреннего
маркета Telegram (в звёздах) могут отличаться; админ может переопределить floor
командой /floor.
"""

from __future__ import annotations

import html as html_lib
import re

import aiohttp

from .models import Throttled

BASE = "https://fragment.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; GiftParserBot/1.0)"}

_COLLECTION = re.compile(
    r'<a href="/gifts/([a-z0-9]+)" class="tm-main-filters-item[^"]*"[^>]*>.*?'
    r'<div class="tm-main-filters-name">(.*?)</div>',
    re.S,
)
_PRICE = re.compile(r'class="tm-grid-item-value tm-value icon-before icon-ton">([\d.,]+)<')


def parse_collections(page: str) -> list[tuple[str, str]]:
    seen: dict[str, str] = {}
    for slug, name in _COLLECTION.findall(page):
        seen.setdefault(slug, html_lib.unescape(name).strip())
    return list(seen.items())


def parse_floor(page: str) -> float | None:
    m = _PRICE.search(page)
    return float(m.group(1).replace(",", "")) if m else None


async def _get(session: aiohttp.ClientSession, url: str) -> str:
    async with session.get(url, headers=HEADERS) as resp:
        if resp.status == 429:
            raise Throttled(None)
        resp.raise_for_status()
        return await resp.text()


async def fetch_collections(session: aiohttp.ClientSession) -> list[tuple[str, str]]:
    return parse_collections(await _get(session, f"{BASE}/gifts"))


async def fetch_floor(session: aiohttp.ClientSession, collection: str) -> float | None:
    return parse_floor(await _get(session, f"{BASE}/gifts/{collection}?sort=price_asc&filter=sale"))
