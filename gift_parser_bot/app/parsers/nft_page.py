"""Источник №1: публичные страницы коллекционных подарков https://t.me/nft/<Slug>-<номер>.

Не нужен ни аккаунт, ни токен. На странице есть модель, фон (backdrop), узор (symbol)
с редкостью, тираж и владелец: @username (если он публичный), просто имя, либо
TON-адрес, если подарок выведен в блокчейн. Несуществующий номер отвечает редиректом 302.
"""

from __future__ import annotations

import html as html_lib
import re

import aiohttp

from .models import Owner, ParsedGift, Throttled, normalize_slug, percent_to_permille

NFT_URL = "https://t.me/nft/{slug}"

_OG_TITLE = re.compile(r'<meta property="og:title" content="([^"]*)"')
_ROW = re.compile(r"<tr><th>(.*?)</th><td>(.*?)</td></tr>", re.S)
_TAGS = re.compile(r"<[^>]+>")
_USERNAME_LINK = re.compile(r'<a href="https://t\.me/([A-Za-z0-9_]{4,})"')
_ADDRESS = re.compile(r'class="tgme_gift_owner_address">([^<]+)<')
_NAME = re.compile(r'<span dir="auto">(.*?)</span>', re.S)


_INVISIBLE = "­​‌‍⁠﻿ \t\n"


def _text(fragment: str) -> str:
    # strip() + невидимые символы: бывают «пустые» имена из одного мягкого переноса
    return html_lib.unescape(_TAGS.sub("", fragment)).strip(_INVISIBLE)


def _attribute(cell: str) -> tuple[str | None, int | None]:
    name, _, mark = cell.partition("<mark>")
    return (_text(name) or None), percent_to_permille(_text(mark)) if mark else None


def _owner(cell: str) -> tuple[Owner | None, str | None]:
    if m := _ADDRESS.search(cell):
        return Owner(ton_address=m.group(1).strip()), None
    name_m = _NAME.search(cell)
    name = (_text(name_m.group(1)) or None) if name_m else None
    if m := _USERNAME_LINK.search(cell):
        return Owner(username=m.group(1), name=name), None
    return None, name  # юзернейм скрыт — знаем только имя


def parse_nft_html(slug: str, page: str) -> ParsedGift | None:
    title_m = _OG_TITLE.search(page)
    if not title_m or "#" not in title_m.group(1):
        return None
    title, _, num = html_lib.unescape(title_m.group(1)).rpartition("#")
    gift = ParsedGift(slug=normalize_slug(slug) or slug.lower(), title=title.strip(), number=int(num))

    for th, td in _ROW.findall(page):
        key = _text(th).lower()
        if key == "owner":
            gift.owner, gift.owner_name = _owner(td)
        elif key == "model":
            gift.model, gift.model_rarity = _attribute(td)
        elif key == "backdrop":
            gift.backdrop, gift.backdrop_rarity = _attribute(td)
        elif key == "symbol":
            gift.symbol, gift.symbol_rarity = _attribute(td)
        elif key == "quantity":
            digits = re.sub(r"[^\d/]", "", _text(td))
            if "/" in digits:
                issued, total = digits.split("/", 1)
                gift.issued, gift.total = int(issued or 0), int(total or 0)
    return gift


async def fetch_nft(session: aiohttp.ClientSession, slug: str) -> ParsedGift | None:
    """Скачивает и разбирает страницу.

    None — такого номера нет (редирект/404, т.е. подарок не существует или сожжён).
    Если страница отдалась (200), но карточки подарка в ней нет — это НЕ «подарка нет»,
    а троттлинг t.me (служебный ответ под нагрузкой): кидаем Throttled, чтобы лимитер
    притормозил и запрос повторился, а не чтобы коллекцию посчитали пустой.
    """
    async with session.get(NFT_URL.format(slug=slug), allow_redirects=False) as resp:
        if resp.status in (301, 302, 303, 404):
            return None
        if resp.status == 429:
            retry = resp.headers.get("Retry-After")
            raise Throttled(float(retry) if retry and retry.isdigit() else None)
        resp.raise_for_status()
        page = await resp.text()
    gift = parse_nft_html(slug, page)
    if gift is None:
        raise Throttled(None)
    return gift
