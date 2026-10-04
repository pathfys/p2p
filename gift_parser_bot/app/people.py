"""Выдача «людей»: 10 человек на странице, 2 страницы, кнопка «Повторить».

Один «парсинг» = подобрать 20 человек (Telegram-аккаунтов) под запрос из базы и
проверить каждого живым запросом к его странице t.me/nft: подарок всё ещё у него?
Кто подарок уже продал/вывел — заменяется следующим кандидатом. Время каждого этапа
замеряется и показывается в выдаче.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

from .config import Settings
from .crawler import Crawler
from .db import Database, SearchQuery
from .parsers.models import ParsedGift

log = logging.getLogger(__name__)

MAX_ROUNDS = 3  # сколько раз добираем людей взамен «устаревших»


@dataclass
class ParseResult:
    people: list[dict] = field(default_factory=list)
    seconds: float = 0.0  # всего
    db_seconds: float = 0.0  # выборка из базы
    live_seconds: float = 0.0  # живая проверка t.me/nft
    checked: int = 0  # сколько страниц t.me/nft запрошено
    replaced: int = 0  # сколько кандидатов отсеяно (подарок сменил владельца)

    def timing(self) -> dict:
        return {
            "seconds": self.seconds,
            "db_seconds": self.db_seconds,
            "live_seconds": self.live_seconds,
            "checked": self.checked,
            "replaced": self.replaced,
        }


def same_owner(person: dict, gift: ParsedGift) -> bool:
    """Подтверждает ли свежая страница, что подарок всё ещё у этого человека."""
    owner = gift.owner
    if owner and owner.username:
        return bool(person["username"]) and owner.username.lower() == person["username"].lower()
    if owner and owner.ton_address:
        return False  # подарок выведен в блокчейн
    if person["username"]:
        return False  # раньше был @username, теперь его нет — скорее всего другой владелец
    # человек известен только по user_id (Bot API): сверяем отображаемое имя, если оно есть
    return not (gift.owner_name and person["o_name"]) or gift.owner_name == person["o_name"]


class PeopleParser:
    def __init__(self, db: Database, crawler: Crawler, settings: Settings):
        self.db = db
        self.crawler = crawler
        self.settings = settings

    @property
    def need(self) -> int:
        return self.settings.people_per_page * self.settings.people_pages

    async def parse(self, query: SearchQuery | None, exclude: set[int] | None = None) -> ParseResult:
        """query=None — режим «Все подарки» (случайные люди)."""
        result = ParseResult()
        started = time.perf_counter()
        seen = set(exclude or ())
        for _ in range(MAX_ROUNDS):
            missing = self.need - len(result.people)
            if missing <= 0:
                break
            t = time.perf_counter()
            if query is None:
                candidates = await self.db.random_people(missing, exclude=seen)
            else:
                candidates = await self.db.search_people(query, limit=missing, exclude=seen)
            result.db_seconds += time.perf_counter() - t
            if not candidates:
                break
            seen.update(c["owner_id"] for c in candidates)

            if self.settings.live_check:
                t = time.perf_counter()
                checked = await asyncio.gather(*(self._verify(c) for c in candidates))
                result.live_seconds += time.perf_counter() - t
                result.checked += len(candidates)
            else:
                checked = candidates
            for person in checked:
                if person is None:
                    result.replaced += 1
                else:
                    result.people.append(person)
        result.seconds = time.perf_counter() - started
        return result

    async def _verify(self, person: dict) -> dict | None:
        try:
            gift = await self.crawler.fetch_gift(person["slug"])
        except Exception as e:  # t.me недоступен — показываем данные из базы, без проверки
            log.warning("live check %s: %s", person["slug"], e)
            return person
        if gift is None or not same_owner(person, gift):
            return None
        fresh = await self.db.gift(person["slug"])
        return {**person, **dict(fresh), "verified": True} if fresh else person
