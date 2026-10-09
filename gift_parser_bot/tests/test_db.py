import asyncio

from app.db import Database, SearchQuery
from app.parsers.models import Owner, ParsedGift, Portfolio


def gift(slug, owner=None, backdrop="Onyx Black", model="Pumpkin", owner_name=None, source="nft_page"):
    collection, number = slug.rsplit("-", 1)
    return ParsedGift(
        slug=slug,
        title=collection.title(),
        number=int(number),
        model=model,
        model_rarity=30,
        backdrop=backdrop,
        backdrop_rarity=20,
        symbol="Star",
        symbol_rarity=5,
        issued=100,
        total=200,
        owner=owner,
        owner_name=owner_name,
        source=source,
    )


def run(tmp_path, scenario):
    async def main():
        db = Database(tmp_path / "t.db", medium_ton=30, rich_ton=300, default_gift_ton=3)
        await db.connect()
        try:
            await scenario(db)
        finally:
            await db.close()

    asyncio.run(main())


async def owner_row(db, username):
    cur = await db.conn.execute("SELECT * FROM owners WHERE username = ?", (username,))
    return await cur.fetchone()


def test_tiers_follow_floor_prices(tmp_path):
    async def scenario(db):
        await db.upsert_collections([("pepe", "Pepes"), ("pop", "Pops")])
        await db.set_floor("pepe", 7000)
        await db.set_floor("pop", 4)
        await db.save_gifts(
            [
                gift("pepe-1", Owner(username="whale")),
                gift("pop-1", Owner(username="small")),
                *[gift(f"pop-{n}", Owner(username="mid")) for n in range(2, 12)],  # 10 × 4 TON
            ]
        )
        assert (await owner_row(db, "whale"))["tier"] == "rich"
        assert (await owner_row(db, "small"))["tier"] == "light"
        mid = await owner_row(db, "mid")
        assert (mid["tier"], mid["gifts_count"], mid["value_ton"]) == ("medium", 10, 40)

        # ручной floor не перетирается автообновлением
        await db.set_floor("pop", 50, manual=True)
        assert not await db.set_floor("pop", 1)
        await db.recompute_owners(None)
        assert (await owner_row(db, "mid"))["tier"] == "rich"  # 10 × 50 TON

    run(tmp_path, scenario)


def test_owner_merge_and_portfolio(tmp_path):
    async def scenario(db):
        # со страницы t.me/nft знаем только @username, через Bot API — user_id и тот же username
        await db.save_gifts([gift("pepe-1", Owner(username="alice")), gift("pepe-2", Owner(username="alice"))])
        await db.save_gifts([gift("pepe-3", Owner(user_id=42))])
        await db.save_portfolio(
            Portfolio(owner=Owner(user_id=42, username="alice"), gifts=[gift("pepe-1"), gift("pepe-3")])
        )
        cur = await db.conn.execute("SELECT COUNT(*) FROM owners")
        assert (await cur.fetchone())[0] == 1
        alice = await owner_row(db, "alice")
        assert alice["user_id"] == 42
        assert alice["gifts_count"] == 2  # pepe-2 больше нет в портфеле — отвязан
        assert (await db.gift("pepe-2"))["username"] is None

        # страница отдала только имя владельца — уже известный владелец не теряется
        await db.conn.execute("UPDATE owners SET name = 'Alice' WHERE id = ?", (alice["id"],))
        await db.save_gifts([gift("pepe-1", owner_name="Alice")])
        assert (await db.gift("pepe-1"))["username"] == "alice"

    run(tmp_path, scenario)


def test_search_filters_and_random(tmp_path):
    async def scenario(db):
        await db.upsert_collections([("pepe", "Pepes"), ("pop", "Pops")])
        await db.set_floor("pepe", 7000)
        await db.save_gifts(
            [
                gift("pepe-1", Owner(username="whale"), backdrop="Onyx Black"),
                gift("pepe-2", Owner(username="whale2"), backdrop="Amber", model="Frog"),
                gift("pop-1", Owner(username="small"), backdrop="Onyx Black"),
                gift("pop-2", owner_name="Hidden Name", backdrop="Amber"),
            ]
        )
        rows, total = await db.search(SearchQuery(backdrop="onyx black"), limit=10, offset=0)
        assert total == 2 and {r["slug"] for r in rows} == {"pepe-1", "pop-1"}

        rows, total = await db.search(SearchQuery(tier="rich"), limit=10, offset=0)
        assert {r["slug"] for r in rows} == {"pepe-1", "pepe-2"}

        rows, total = await db.search(SearchQuery(text="pepe amber"), limit=10, offset=0)
        assert [r["slug"] for r in rows] == ["pepe-2"]

        rows, _ = await db.search(SearchQuery(collection="pepe", model="frog"), limit=10, offset=0)
        assert [r["slug"] for r in rows] == ["pepe-2"]

        rows, _ = await db.search(SearchQuery(owner="@small"), limit=10, offset=0)
        assert [r["slug"] for r in rows] == ["pop-1"]

        page1, total = await db.search(SearchQuery(seed=777), limit=2, offset=0)
        page2, _ = await db.search(SearchQuery(seed=777), limit=2, offset=2)
        assert total == 4 and len({r["slug"] for r in page1 + page2}) == 4  # пагинация без повторов

        assert await db.distinct_values("backdrop") == ["Amber", "Onyx Black"]
        assert await db.distinct_values("model", "pepe") == ["Frog", "Pumpkin"]

    run(tmp_path, scenario)


def test_user_modes_and_queue(tmp_path):
    async def scenario(db):
        assert await db.get_mode(1) == "all"
        assert await db.touch_user(1, "u1", "U") is True
        assert await db.touch_user(1, "u1", "U") is False
        await db.set_mode(1, "rich")
        assert await db.get_mode(1) == "rich"
        await db.add_seen_users([Owner(user_id=2, username="sender")])
        queue = await db.users_to_check(10, stale_before=0)
        assert [r["user_id"] for r in queue] == [1, 2]  # сначала пользователи бота
        await db.mark_user_checked(1)
        assert [r["user_id"] for r in await db.users_to_check(10, stale_before=0)] == [2]

    run(tmp_path, scenario)


def test_crawl_order_and_min_floor(tmp_path):
    async def scenario(db):
        await db.upsert_collections([("cheap", "C"), ("rich", "R"), ("mid", "M"), ("unknown", "U")])
        await db.set_floor("cheap", 4)
        await db.set_floor("rich", 7000)
        await db.set_floor("mid", 60)
        order = [r["slug"] for r in await db.collections_to_crawl(recrawl_before=0)]
        assert order == ["rich", "mid", "cheap", "unknown"]
        order = [r["slug"] for r in await db.collections_to_crawl(recrawl_before=0, min_floor_ton=50)]
        assert order == ["rich", "mid", "unknown"]

        await db.set_cursor("rich", 10, finished=True)
        assert "rich" not in [r["slug"] for r in await db.collections_to_crawl(recrawl_before=0)]
        # обход устарел — коллекция снова в очереди с №1
        assert (await db.collections_to_crawl(recrawl_before=2**40))[0]["next_number"] == 1

    run(tmp_path, scenario)


def test_search_people(tmp_path):
    async def scenario(db):
        await db.upsert_collections([("pepe", "Pepes"), ("pop", "Pops")])
        await db.set_floor("pepe", 7000)
        await db.set_floor("pop", 4)
        await db.save_gifts(
            [
                gift("pop-1", Owner(username="whale"), backdrop="Amber"),
                gift("pepe-1", Owner(username="whale"), backdrop="Amber"),
                gift("pepe-2", Owner(username="whale"), backdrop="Onyx Black"),
                gift("pop-2", Owner(username="small"), backdrop="Amber"),
                gift("pop-3", Owner(user_id=77, name="No Username"), backdrop="Amber"),
                gift("pepe-3", Owner(ton_address="UQwallet"), backdrop="Amber"),  # кошелёк — не человек
                gift("pop-4", owner_name="Hidden", backdrop="Amber"),
            ]
        )
        people = await db.search_people(SearchQuery(backdrop="amber"), limit=10)
        by_name = {p["username"] or p["o_name"]: p for p in people}
        assert set(by_name) == {"whale", "small", "No Username"}
        # у каждого человека один, самый дорогой подходящий подарок + число совпадений
        assert by_name["whale"]["slug"] == "pepe-1" and by_name["whale"]["matched"] == 2

        rich = await db.search_people(SearchQuery(tier="rich"), limit=10)
        assert [p["username"] for p in rich] == ["whale"] and rich[0]["slug"] in {"pepe-1", "pepe-2"}

        whale_id = by_name["whale"]["owner_id"]
        rest = await db.search_people(SearchQuery(backdrop="amber"), limit=10, exclude={whale_id})
        assert whale_id not in {p["owner_id"] for p in rest} and len(rest) == 2

        everyone = await db.search_people(SearchQuery(seed=5), limit=1)
        assert len(everyone) == 1

    run(tmp_path, scenario)


def test_random_people_prefers_different_collections(tmp_path):
    async def scenario(db):
        await db.save_gifts(
            [
                gift("pepe-1", Owner(username="a")),
                gift("pepe-2", Owner(username="b")),
                gift("pop-1", Owner(username="c")),
                gift("cap-1", Owner(username="d")),
                gift("cap-2", Owner(ton_address="UQwallet")),
            ]
        )
        for _ in range(10):
            people = await db.random_people(3)
            assert len(people) == 3
            assert len({p["title"] for p in people}) == 3  # три разные коллекции
            assert all(p["username"] for p in people)
        assert {p["username"] for p in await db.random_people(10, exclude=[1, 2])} == {"c", "d"}

    run(tmp_path, scenario)


def test_concurrent_saves_do_not_duplicate_owner(tmp_path):
    async def scenario(db):
        # живые проверки идут параллельно: два подарка одного нового владельца одновременно
        await asyncio.gather(*(db.save_gifts([gift(f"pop-{n}", Owner(username="new"))]) for n in range(1, 6)))
        row = await owner_row(db, "new")
        assert row["gifts_count"] == 5

    run(tmp_path, scenario)


def test_filters_min_gifts_min_rarity_and_female(tmp_path):
    async def scenario(db):
        await db.upsert_collections([("pepe", "Pepes")])
        await db.set_floor("pepe", 50)
        gifts = [
            gift("pepe-1", Owner(username="whale", name="Анна"), model="Rare"),
            gift("pepe-2", Owner(username="whale", name="Анна"), model="Rare"),
            gift("pepe-3", Owner(username="whale", name="Анна"), model="Rare"),
            gift("pepe-4", Owner(username="bob", name="Борис"), model="Common"),
            gift("pepe-5", Owner(username="kate", name="Катя"), model="Common"),
        ]
        gifts[0].model_rarity = 10  # 1% — очень редкая
        gifts[3].model_rarity = 300  # 30% — частая
        gifts[4].model_rarity = 50  # 5%
        await db.save_gifts(gifts)

        # По NFT: владелец с >=3 подарками
        rows = await db.search_people(SearchQuery(min_gifts=3), limit=10)
        assert [r["username"] for r in rows] == ["whale"]

        # По редкости: модель не хуже 1% (<=10 промилле)
        rows = await db.search_people(SearchQuery(min_rarity=10), limit=10)
        assert {r["username"] for r in rows} == {"whale"}
        rows = await db.search_people(SearchQuery(min_rarity=100), limit=10)  # <=10%
        assert {r["username"] for r in rows} == {"whale", "kate"}

        # Девочки: только женские имена (whale=Анна, kate=Катя; bob=Борис — нет)
        rows = await db.search_people(SearchQuery(female=True), limit=10)
        assert {r["username"] for r in rows} == {"whale", "kate"}

        # Комбинация фильтров (whale: 3 подарка x 50 TON = 150 TON -> medium при порогах 30/300)
        rows = await db.search_people(SearchQuery(collection="pepe", tier="medium", min_gifts=2), limit=10)
        assert [r["username"] for r in rows] == ["whale"]

    run(tmp_path, scenario)
