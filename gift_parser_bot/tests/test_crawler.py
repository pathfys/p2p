import asyncio

import pytest
from aiogram import Bot

from app import crawler as crawler_module
from app.config import Settings
from app.crawler import Crawler
from app.db import Database
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


def test_rate_limiter_spacing():
    async def main():
        limiter = RateLimiter("botapi", "fast")  # 25 req/s -> 10 запросов ≈ 0.36 с
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        await asyncio.gather(*(limiter.acquire() for _ in range(10)))
        return loop.time() - t0

    assert asyncio.run(main()) >= 0.3
