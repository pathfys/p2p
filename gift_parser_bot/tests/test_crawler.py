import asyncio

import pytest
from aiogram import Bot

from app import crawler as crawler_module
from app.config import Settings
from app.crawler import Crawler
from app.db import Database, SearchQuery
from app.parsers.models import Owner, ParsedGift, Throttled
from app.ratelimit import RateLimiter


def test_crawl_chunks_round_robin_resume_and_follow_issued(tmp_path, monkeypatch):
    calls: list[str] = []
    throttled_once = {"done": False}

    async def fake_fetch(session, slug):
        calls.append(slug)
        number = int(slug.rsplit("-", 1)[1])
        if number == 3 and not throttled_once["done"]:
            throttled_once["done"] = True
            raise Throttled(0.01)  # лимитер выдерживает паузу и повторяет запрос
        if number == 5:
            return None  # номер не существует (302)
        return ParsedGift(
            slug=slug,
            title="Pepe",
            number=number,
            backdrop="Amber",
            issued=12,  # тираж вырос по ходу парсинга
            total=20,
            owner=Owner(username=f"owner{number % 3}"),
        )

    monkeypatch.setattr(crawler_module, "fetch_nft", fake_fetch)

    async def main():
        settings = Settings(bot_token="1:x", db_path=tmp_path / "c.db", chunk_size=4, speed="fast")
        db = Database(settings.db_path, medium_ton=30, rich_ton=300, default_gift_ton=3)
        await db.connect()
        crawler = Crawler(db, settings, Bot("123:abc"))
        await crawler.setup()
        try:
            await db.upsert_collections([("pepe", "Pepes")])
            # круговой обход: по одному чанку за проход, курсор в БД — пока коллекция не закрыта
            for _ in range(10):
                row = (await db.collections())[0]
                if row["crawled_at"] is not None:
                    break
                await crawler._crawl_chunk("pepe", row["next_number"], row["issued"] or 0)
            stats = await db.stats()
            assert stats["gifts"] == 11  # 1..12 без №5
            assert stats["owners"] == 3
            row = (await db.collections())[0]
            assert row["next_number"] == 13 and row["crawled_at"] is not None and row["issued"] == 12
            assert calls.count("pepe-3") == 2
            assert crawler.limiters["nft_page"].stats.throttled == 1
        finally:
            await crawler.shutdown()
            await db.close()

    asyncio.run(main())


def test_rate_limiter_adapts():
    limiter = RateLimiter("nft_page", "auto")
    start = limiter.rps
    for _ in range(25):
        limiter.on_success()
    assert limiter.rps > start
    raised = limiter.rps
    limiter.on_throttle(0)
    assert limiter.rps == pytest.approx(raised / 2)

    fixed = RateLimiter("botapi", "slow")
    fixed.on_throttle(1)
    for _ in range(100):
        fixed.on_success()
    assert fixed.rps == 5.0

    with pytest.raises(ValueError):
        fixed.set_preset("turbo")


def test_rate_limiter_backs_off_on_repeated_throttle():
    import time

    limiter = RateLimiter("nft_page", "slow")  # фиксированный пресет: сам rps не меняется

    def pause_now() -> float:
        limiter._paused_until = 0.0  # изолируем длительность одной паузы
        t = time.monotonic()
        limiter.on_throttle(None)  # Retry-After нет -> нарастающий бэкофф
        return limiter._paused_until - t

    d1 = pause_now()  # 1-й троттл подряд
    d2 = pause_now()  # 2-й подряд -> пауза больше
    assert d2 > d1 and limiter._throttle_streak == 2
    limiter.on_success()  # успех прерывает серию
    assert limiter._throttle_streak == 0
    d3 = pause_now()  # снова короткая пауза, как в начале
    assert d3 < d2

    # когда сервер прислал Retry-After — уважаем ровно его, без эскалации
    limiter._paused_until = 0.0
    t = time.monotonic()
    limiter.on_throttle(3)
    assert 3.0 <= (limiter._paused_until - t) < 4.0


def test_rate_limiter_spacing():
    async def main():
        limiter = RateLimiter("botapi", "fast")  # 25 req/s -> 10 запросов ≈ 0.36 с
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        await asyncio.gather(*(limiter.acquire() for _ in range(10)))
        return loop.time() - t0

    assert asyncio.run(main()) >= 0.3


def test_discovery_transient_error_does_not_finish_collection(tmp_path, monkeypatch):
    async def main():
        settings = Settings(bot_token="1:x", db_path=tmp_path / "d.db", speed="slow")
        db = Database(settings.db_path, medium_ton=10, rich_ton=100, default_gift_ton=3)
        await db.connect()
        crawler = Crawler(db, settings, Bot("123:abc"))
        await crawler.setup()
        try:
            await db.upsert_collections([("pepe", "Pepes")])

            # 1) транзиентная ошибка на #1 -> коллекция НЕ финишируется, курсор на месте
            async def boom(session, slug):
                raise RuntimeError("network down")

            monkeypatch.setattr(crawler_module, "fetch_nft", boom)
            await crawler._crawl_chunk("pepe", number=1, issued=0)
            row = (await db.collections())[0]
            assert row["crawled_at"] is None and row["next_number"] == 1

            # 2) #1 реально отсутствует (None) -> коллекция финишируется (битый/пустой slug)
            async def missing(session, slug):
                return None

            monkeypatch.setattr(crawler_module, "fetch_nft", missing)
            await crawler._crawl_chunk("pepe", number=1, issued=0)
            row = (await db.collections())[0]
            assert row["crawled_at"] is not None
        finally:
            await crawler.shutdown()
            await db.close()

    asyncio.run(main())


def test_chunk_does_not_skip_throttled_editions(tmp_path, monkeypatch):
    """Троттлинг в теле чанка не должен «проскакивать» подарок как отсутствующий:
    курсор останавливается на первом недокачанном номере, коллекция не финишируется."""

    async def main():
        settings = Settings(bot_token="1:x", db_path=tmp_path / "t.db", chunk_size=5, speed="fast")
        db = Database(settings.db_path, medium_ton=10, rich_ton=100, default_gift_ton=3)
        await db.connect()
        crawler = Crawler(db, settings, Bot("123:abc"))
        await crawler.setup()
        try:
            await db.upsert_collections([("c", "C")])

            async def fetch(session, slug):
                n = int(slug.rsplit("-", 1)[1])
                if n == 2:
                    raise Throttled(0.001)  # всегда троттлит -> _call сдастся -> _TRANSIENT
                if n == 4:
                    return None  # реально отсутствует (редирект)
                return ParsedGift(
                    slug=slug, title="C", number=n, backdrop="Amber", issued=10, owner=Owner(username=f"u{n}")
                )

            monkeypatch.setattr(crawler_module, "fetch_nft", fetch)
            await crawler._crawl_chunk("c", number=1, issued=10)  # issued известен -> без discovery

            row = (await db.collections())[0]
            # ключевой инвариант: курсор НЕ проскочил троттленный #2 — встал на него и не финишировал,
            # значит на следующем проходе #2 будет повторён, а не потерян как «отсутствующий»
            assert row["next_number"] == 2 and row["crawled_at"] is None
            # успешные номера сохранены; #2 (троттл) и #4 (редирект=нет) — нет
            cur = await db.conn.execute("SELECT slug FROM gifts ORDER BY number")
            saved = [r[0] for r in await cur.fetchall()]
            assert saved == ["c-1", "c-3", "c-5"] and "c-2" not in saved and "c-4" not in saved
            assert crawler.limiters["nft_page"].stats.throttled >= 1
        finally:
            await crawler.shutdown()
            await db.close()

    asyncio.run(main())


def test_crawl_uses_mtproto_and_fills_owners(tmp_path, monkeypatch):
    """Со страницы t.me владельца не узнать, поэтому при живой сессии подарки должны
    качаться через MTProto — и приходить сразу с @username."""

    class FakeMtproto:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_unique(self, slug):
            self.calls.append(slug)
            n = int(slug.rsplit("-", 1)[1])
            if n > 3:
                return None  # номера нет
            return ParsedGift(
                slug=slug,
                title="C",
                number=n,
                backdrop="Amber",
                issued=3,
                owner=Owner(user_id=100 + n, username=f"u{n}"),
                source="mtproto",
            )

        async def stop(self):
            pass

    async def must_not_be_used(session, slug):
        raise AssertionError("при живой сессии t.me/nft использоваться не должен")

    async def main():
        settings = Settings(bot_token="1:x", db_path=tmp_path / "m.db", chunk_size=10, speed="fast")
        db = Database(settings.db_path, medium_ton=10, rich_ton=100, default_gift_ton=3)
        await db.connect()
        crawler = Crawler(db, settings, Bot("123:abc"))
        await crawler.setup()
        monkeypatch.setattr(crawler_module, "fetch_nft", must_not_be_used)
        crawler.mtproto = FakeMtproto()
        try:
            await db.upsert_collections([("c", "C")])
            await crawler._crawl_chunk("c", number=1, issued=0)  # тираж неизвестен -> discovery

            stats = await db.stats()
            assert stats["gifts"] == 3  # #1 из discovery + #2,#3 из чанка
            assert stats["owners_named"] == 3 and stats["hidden_gifts"] == 0
            people = await db.search_people(SearchQuery(seed=1), limit=10)
            assert {p["username"] for p in people} == {"u1", "u2", "u3"}
            assert crawler.limiters["nft_page"].stats.requests == 0  # t.me не трогали
        finally:
            await crawler.shutdown()
            await db.close()

    asyncio.run(main())
