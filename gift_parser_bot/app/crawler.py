"""Фоновый парсер: наполняет БД подарками и их владельцами.

Три независимых цикла:
1. nft_page — обходит все коллекции (список и floor-цены с Fragment) по номерам
   t.me/nft/<slug>-<n>, сначала самые дорогие. Курсор хранится в БД, поэтому после
   перезапуска парсинг продолжается с того же места.
2. botapi — getUserGifts для пользователей бота и найденных отправителей подарков.
3. mtproto (если настроен) — дообогащает владельцев с @username полным портфелем.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, TypeVar

import aiohttp
from aiogram import Bot
from aiogram.exceptions import TelegramAPIError

from .config import Settings
from .db import Database, now
from .parsers import fragment
from .parsers.botapi import fetch_user_portfolio
from .parsers.models import ParsedGift, Portfolio, Throttled
from .parsers.mtproto import MtprotoSource
from .parsers.nft_page import fetch_nft
from .parsers.seed import SEED_COLLECTIONS
from .ratelimit import CONCURRENCY, SPEED_PRESETS, SPEED_TABLE, RateLimiter

log = logging.getLogger(__name__)
T = TypeVar("T")

FLOOR_REFRESH_SECONDS = 6 * 3600


@dataclass
class CrawlStatus:
    started_at: float | None = None
    phase: str = "остановлен"
    collection: str | None = None
    position: int = 0
    issued: int = 0
    pages: int = 0
    gifts: int = 0
    missing: int = 0
    errors: int = 0
    users_checked: int = 0
    owners_enriched: int = 0
    last_error: str | None = None
    floors_synced_at: float = field(default=0.0)


class Crawler:
    def __init__(self, db: Database, settings: Settings, bot: Bot):
        self.db = db
        self.settings = settings
        self.bot = bot
        preset = settings.speed if settings.speed in SPEED_PRESETS else "auto"
        self.preset = preset
        self.limiters = {name: RateLimiter(name, preset) for name in SPEED_TABLE}
        self.status = CrawlStatus()
        self.mtproto: MtprotoSource | None = None
        self._session: aiohttp.ClientSession | None = None
        self._tasks: list[asyncio.Task] = []
        self._sync_lock = asyncio.Lock()

    # ---------------------------------------------------------------- lifecycle
    async def setup(self) -> None:
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25), trust_env=True)
        if self.settings.mtproto_enabled:
            s = self.settings
            source = MtprotoSource(s.api_id, s.api_hash, str(s.mtproto_session), self.limiters["mtproto"])
            try:
                await source.start()
                self.mtproto = source
                log.info("MTProto-источник подключён")
            except Exception as e:  # бот должен работать и без userbot-а
                log.warning("MTProto отключён: %s", e)

    async def shutdown(self) -> None:
        await self.stop()
        if self.mtproto:
            await self.mtproto.stop()
        if self._session:
            await self._session.close()

    @property
    def running(self) -> bool:
        return any(not t.done() for t in self._tasks)

    def start(self) -> bool:
        if self.running:
            return False
        self.status = CrawlStatus(started_at=time.time(), phase="запуск", floors_synced_at=self.status.floors_synced_at)
        loops = [self._nft_loop, self._botapi_loop]
        if self.mtproto:
            loops.append(self._mtproto_loop)
        self._tasks = [asyncio.create_task(self._guard(loop)) for loop in loops]
        return True

    async def stop(self) -> bool:
        if not self.running:
            return False
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        self.status.phase = "остановлен"
        return True

    def set_speed(self, preset: str) -> None:
        for limiter in self.limiters.values():
            limiter.set_preset(preset)
        self.preset = preset

    async def _guard(self, loop: Callable[[], Awaitable[None]]) -> None:
        """Цикл не должен умирать от случайной ошибки (сеть, БД) — перезапускаем через 30 с."""
        while True:
            try:
                await loop()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("Цикл парсера упал, перезапуск через 30 с")
                self.status.errors += 1
                self.status.last_error = repr(e)
                await asyncio.sleep(30)

    # ------------------------------------------------------------------ helpers
    @property
    def session(self) -> aiohttp.ClientSession:
        assert self._session is not None, "Crawler.setup() не вызван"
        return self._session

    async def _call(self, source: str, func: Callable[..., Awaitable[T]], *args) -> T:
        """Запрос через лимитер источника: пауза на 429 и до 3 повторов при сетевых ошибках."""
        limiter = self.limiters[source]
        attempt = 0
        while True:
            await limiter.acquire()
            try:
                result = await func(*args)
            except Throttled as e:
                limiter.on_throttle(e.retry_after)
                continue
            except (aiohttp.ClientError, asyncio.TimeoutError):
                attempt += 1
                if attempt >= 3:
                    raise
                await asyncio.sleep(2**attempt)
                continue
            limiter.on_success()
            return result

    # --------------------------------------------------------- public actions
    async def sync_collections(self) -> tuple[int, int]:
        """Список коллекций и floor-цены с Fragment. Возвращает (новых коллекций, обновлено floor)."""
        async with self._sync_lock:
            items = await self._call("fragment", fragment.fetch_collections, self.session)
            added = await self.db.upsert_collections(items)
            updated = 0
            for slug, _ in items:
                try:
                    floor = await self._call("fragment", fragment.fetch_floor, self.session, slug)
                except Exception as e:
                    log.warning("floor %s: %s", slug, e)
                    continue
                if floor is not None and await self.db.set_floor(slug, floor):
                    updated += 1
            await self.db.recompute_owners(None)
            await self.db.conn.commit()
            self.status.floors_synced_at = time.time()
            return added, updated

    async def fetch_gift(self, slug: str) -> ParsedGift | None:
        """Живой запрос одного подарка (быстрый поиск по ссылке)."""
        gift = await self._call("nft_page", fetch_nft, self.session, slug)
        if gift:
            await self.db.save_gifts([gift])
        return gift

    async def parse_user(self, user_id: int, username: str | None = None, name: str | None = None) -> int:
        """Подарки пользователя через Bot API getUserGifts. Возвращает число найденных NFT."""
        try:
            portfolio = await fetch_user_portfolio(self.bot, self.limiters["botapi"], user_id, username, name)
        except TelegramAPIError as e:
            log.info("getUserGifts(%s): %s", user_id, e)
            await self.db.mark_user_checked(user_id)
            return 0
        count = await self.db.save_portfolio(portfolio) if portfolio.gifts else 0
        await self.db.add_seen_users(portfolio.senders)
        await self.db.mark_user_checked(user_id)
        self.status.users_checked += 1
        return count

    async def lookup_username(self, username: str) -> Portfolio | None:
        """Живой запрос портфеля по @username (только если подключён MTProto)."""
        if not self.mtproto:
            return None
        portfolio = await self.mtproto.fetch_portfolio(username)
        if portfolio:
            await self.db.save_portfolio(portfolio)
            self.status.owners_enriched += 1
        return portfolio

    # -------------------------------------------------------------------- loops
    async def _nft_loop(self) -> None:
        while True:
            if time.time() - self.status.floors_synced_at > FLOOR_REFRESH_SECONDS:
                self.status.phase = "синхронизация коллекций и floor (Fragment)"
                try:
                    await self.sync_collections()
                except Exception as e:
                    self.status.errors += 1
                    self.status.last_error = f"fragment: {e!r}"
                    log.warning("Fragment недоступен: %s", e)
                    if not await self.db.collections():
                        await self.db.upsert_collections((slug, None) for slug in SEED_COLLECTIONS)

            todo = await self.db.collections_to_crawl(
                now() - self.settings.recrawl_hours * 3600, self.settings.crawl_min_floor_ton
            )
            if not todo:
                self.status.phase = "ожидание: все коллекции свежие"
                self.status.collection = None
                await asyncio.sleep(600)
                continue
            for collection in todo:
                await self._crawl_collection(collection["slug"], collection["next_number"], collection["issued"] or 0)

    async def _crawl_collection(self, slug: str, number: int, issued: int) -> None:
        self.status.phase = "парсинг t.me/nft"
        self.status.collection = slug
        if not issued:
            first = await self._safe_fetch(f"{slug}-1")
            if first:
                await self.db.save_gifts([first])
            issued = first.issued if first and first.issued else 0
            if not issued:
                await self.db.set_cursor(slug, 1, finished=True)
                return

        semaphore = asyncio.Semaphore(CONCURRENCY[self.preset])

        async def one(n: int) -> ParsedGift | None:
            async with semaphore:
                return await self._safe_fetch(f"{slug}-{n}")

        while number <= issued:
            end = min(number + self.settings.chunk_size - 1, issued)
            self.status.position, self.status.issued = number, issued
            results = await asyncio.gather(*(one(n) for n in range(number, end + 1)))
            gifts = [g for g in results if g]
            if gifts:
                await self.db.save_gifts(gifts)
                issued = max([issued] + [g.issued or 0 for g in gifts])  # тираж мог вырасти
            self.status.pages += len(results)
            self.status.gifts += len(gifts)
            self.status.missing += len(results) - len(gifts)
            number = end + 1
            await self.db.set_cursor(slug, number)
        await self.db.set_cursor(slug, number, finished=True)

    async def _safe_fetch(self, slug: str) -> ParsedGift | None:
        try:
            return await self._call("nft_page", fetch_nft, self.session, slug)
        except Exception as e:
            self.status.errors += 1
            self.status.last_error = f"{slug}: {e!r}"
            return None

    async def _botapi_loop(self) -> None:
        semaphore = asyncio.Semaphore(CONCURRENCY[self.preset])

        async def one(row) -> None:
            async with semaphore:
                await self.parse_user(row["user_id"], row["username"], row["first_name"])

        while True:
            users = await self.db.users_to_check(50, now() - self.settings.recrawl_hours * 3600)
            if not users:
                await asyncio.sleep(60)
                continue
            await asyncio.gather(*(one(row) for row in users))

    async def _mtproto_loop(self) -> None:
        while True:
            owners = await self.db.owners_to_enrich(20, now() - self.settings.recrawl_hours * 3600)
            if not owners:
                await asyncio.sleep(300)
                continue
            for owner in owners:
                try:
                    if await self.lookup_username(owner["username"]) is None:
                        await self.db.mark_owner_checked(owner["id"])
                except Exception as e:
                    self.status.errors += 1
                    self.status.last_error = f"mtproto @{owner['username']}: {e!r}"
                    await self.db.mark_owner_checked(owner["id"])
