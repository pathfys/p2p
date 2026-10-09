"""Фоновый парсер: непрерывно наполняет БД подарками и их владельцами.

Запускается сам при старте бота (autostart) и работает постоянно, давая живой
поток подарков для поиска. Независимые циклы:
1. nft — обходит коллекции по номерам t.me/nft/<slug>-<n> чанками по кругу
   (по чуть-чуть из каждой коллекции), чтобы в базе быстро появлялось разнообразие.
   Курсор каждой коллекции хранится в БД — после перезапуска парсинг продолжается.
2. fragment — отдельно подтягивает список коллекций и floor-цены (для режимов),
   не блокируя обход подарков.
3. botapi — getUserGifts для пользователей бота и найденных отправителей подарков.
4. mtproto (если настроен) — дообогащает владельцев с @username полным портфелем.
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

# Результат _safe_fetch, когда страницу не удалось получить (троттлинг/сеть), а НЕ «подарка нет».
# Такой номер нельзя считать отсутствующим и проскакивать курсором — повторим его позже.
_TRANSIENT: object = object()


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
        loops = [self._nft_loop, self._fragment_loop, self._botapi_loop]
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
        """Цикл не должен умирать от случайной ошибки (сеть, БД) — перезапускаем через 30 с.
        И не должен крутиться вхолостую, если вдруг вернулся сам — тогда ждём перед рестартом."""
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
            else:
                # штатно циклы бесконечны; если один завершился — пауза, чтобы не было busy-loop
                await asyncio.sleep(5)

    # ------------------------------------------------------------------ helpers
    @property
    def session(self) -> aiohttp.ClientSession:
        assert self._session is not None, "Crawler.setup() не вызван"
        return self._session

    async def _call(self, source: str, func: Callable[..., Awaitable[T]], *args, max_throttles: int = 5) -> T:
        """Запрос через лимитер источника: пауза на 429 и ограниченное число повторов.
        Повторы ограничены (и для сетевых ошибок, и для троттлинга), чтобы один «залипший»
        ответ не крутился в бесконечном цикле. max_throttles=1 — для быстрых ответов пользователю."""
        limiter = self.limiters[source]
        net_attempts = 0
        throttles = 0
        while True:
            await limiter.acquire()
            try:
                result = await func(*args)
            except Throttled as e:
                throttles += 1
                limiter.on_throttle(e.retry_after)
                if throttles >= max_throttles:
                    raise
                continue
            except (aiohttp.ClientError, asyncio.TimeoutError):
                net_attempts += 1
                if net_attempts >= 3:
                    raise
                await asyncio.sleep(2**net_attempts)
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
        """Живой запрос одного подарка в ответ пользователю. max_throttles=1 — чтобы не держать
        пользователя: при троттлинге сразу падаем, а вызывающий код показывает данные из базы."""
        gift = await self._call("live", fetch_nft, self.session, slug, max_throttles=1)
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
    async def _ensure_collections(self) -> None:
        """Чтобы парсеру сразу было что обходить, даже если Fragment ещё не ответил."""
        if not await self.db.collections():
            await self.db.upsert_collections((slug, None) for slug in SEED_COLLECTIONS)

    async def _fragment_loop(self) -> None:
        """Отдельно от обхода подарков: список коллекций и floor-цены (для режимов)."""
        await self._ensure_collections()
        while True:
            try:
                await self.sync_collections()
            except Exception as e:
                self.status.errors += 1
                self.status.last_error = f"fragment: {e!r}"
                log.warning("Fragment недоступен: %s", e)
                await self._ensure_collections()
                await asyncio.sleep(300)
                continue
            await asyncio.sleep(FLOOR_REFRESH_SECONDS)

    async def _nft_loop(self) -> None:
        """Непрерывный обход t.me/nft. Берём по одному чанку из каждой коллекции по
        кругу — так в базе быстро появляется разнообразие, а не одна коллекция целиком."""
        await self._ensure_collections()
        while True:
            todo = await self.db.collections_to_crawl(
                now() - self.settings.recrawl_hours * 3600, self.settings.crawl_min_floor_ton
            )
            if not todo:
                self.status.phase = "база свежая, жду обновления коллекций"
                self.status.collection = None
                await asyncio.sleep(300)
                continue
            before = self.status.gifts
            for collection in todo:
                await self._crawl_chunk(collection["slug"], collection["next_number"], collection["issued"] or 0)
            if self.status.gifts == before:
                # за весь проход ни одного подарка — t.me троттлит/недоступен, не долбим его впустую
                self.status.phase = "троттлинг t.me, пауза перед повтором"
                await asyncio.sleep(60)

    async def _crawl_chunk(self, slug: str, number: int, issued: int) -> None:
        """Обходит один чанк (chunk_size номеров) коллекции и двигает курсор в БД."""
        self.status.phase = "парсинг t.me/nft"
        self.status.collection = slug
        if not issued:  # новая коллекция — узнаём тираж по первым подаркам
            # пробуем вразброс: вдруг первые номера сожжены/редиректят, но коллекция живая
            first = None
            for probe in (1, 2, 3, 5, 10, 25, 50):
                try:
                    g = await self._call("nft_page", fetch_nft, self.session, f"{slug}-{probe}")
                except Exception as e:
                    # транзиент/троттлинг — НЕ финишируем, повторим в следующий проход,
                    # иначе сбой/нагрузка «похоронили» бы коллекцию до следующего recrawl
                    self.status.errors += 1
                    self.status.last_error = f"{slug}-{probe}: {e!r}"
                    return
                if g is not None:
                    first = g
                    break
            if first is None:  # ни один пробный номер не существует — пустой/битый slug
                await self.db.set_cursor(slug, 1, finished=True)
                return
            await self.db.save_gifts([first])
            self.status.gifts += 1
            issued = first.issued or 0
            if not issued:
                await self.db.set_cursor(slug, 1, finished=True)
                return
            number = max(number, first.number + 1)

        end = min(number + self.settings.chunk_size - 1, issued)
        self.status.position, self.status.issued = number, issued
        semaphore = asyncio.Semaphore(CONCURRENCY[self.preset])

        async def one(n: int) -> object:
            async with semaphore:
                return await self._safe_fetch(f"{slug}-{n}")

        results = await asyncio.gather(*(one(n) for n in range(number, end + 1)))
        gifts = [r for r in results if isinstance(r, ParsedGift)]
        if gifts:
            await self.db.save_gifts(gifts)
            issued = max([issued] + [g.issued or 0 for g in gifts])  # тираж мог вырасти
        self.status.pages += len(results)
        self.status.gifts += len(gifts)
        self.status.missing += sum(1 for r in results if r is None)
        # первый недокачанный (троттлинг/сеть) номер: курсор ставим на успешный префикс,
        # чтобы повторить именно его, а не «проскочить» подарок как отсутствующий
        first_transient = next((i for i, r in enumerate(results) if r is _TRANSIENT), None)
        if first_transient is None:
            number = end + 1
            await self.db.set_cursor(slug, number, finished=number > issued)
        else:
            await self.db.set_cursor(slug, number + first_transient)

    async def _safe_fetch(self, slug: str) -> object:
        """ParsedGift — подарок есть; None — подарка нет (редирект); _TRANSIENT — не докачали."""
        try:
            return await self._call("nft_page", fetch_nft, self.session, slug)
        except Exception as e:
            self.status.errors += 1
            self.status.last_error = f"{slug}: {e!r}"
            return _TRANSIENT

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
