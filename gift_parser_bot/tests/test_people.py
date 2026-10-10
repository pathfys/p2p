import asyncio

from app.config import Settings
from app.db import Database, SearchQuery
from app.keyboards import people as people_kb
from app.parsers.models import Owner, ParsedGift
from app.people import PeopleParser, same_owner
from app.texts import people_page


def make_gift(slug, owner=None, owner_name=None):
    collection, number = slug.rsplit("-", 1)
    return ParsedGift(
        slug=slug,
        title=collection.title(),
        number=int(number),
        backdrop="Amber",
        model="M",
        owner=owner,
        owner_name=owner_name,
    )


class FakeCrawler:
    """Подменяет живой запрос к t.me/nft: некоторые подарки уже у других людей."""

    def __init__(self, db, sold):
        self.db, self.sold, self.calls = db, sold, []

    async def fetch_gift(self, slug):
        self.calls.append(slug)
        await asyncio.sleep(0.01)
        n = int(slug.rsplit("-", 1)[1])
        owner = Owner(username="new_owner") if slug in self.sold else Owner(username=f"user{n}")
        fresh = make_gift(slug, owner)
        await self.db.save_gifts([fresh])
        return fresh


def test_parse_two_pages_replaces_sold_and_repeat_gives_new_people(tmp_path):
    async def main():
        db = Database(tmp_path / "p.db", medium_ton=30, rich_ton=300, default_gift_ton=3)
        await db.connect()
        try:
            await scenario(db)
        finally:
            await db.close()

    async def scenario(db):
        await db.save_gifts([make_gift(f"pop-{n}", Owner(username=f"user{n}")) for n in range(1, 46)])
        crawler = FakeCrawler(db, sold={"pop-3", "pop-7"})
        settings = Settings(bot_token="1:x", people_per_page=10, people_pages=2, live_check=True)
        parser = PeopleParser(db, crawler, settings)

        first = await parser.parse(SearchQuery(backdrop="Amber", seed=11))
        names = [p["username"] for p in first.people]
        assert len(names) == 20 and len(set(names)) == 20
        assert "new_owner" not in names
        assert first.replaced in (0, 1, 2) and first.checked == 20 + first.replaced
        assert all(p.get("verified") for p in first.people)
        assert first.seconds >= first.live_seconds > 0

        shown = {p["owner_id"] for p in first.people}
        second = await parser.parse(SearchQuery(backdrop="Amber", seed=12), shown)
        assert not shown & {p["owner_id"] for p in second.people}  # «Повторить» — новые люди

        offline = PeopleParser(db, crawler, Settings(bot_token="1:x", live_check=False))
        calls = len(crawler.calls)
        result = await offline.parse(None)
        assert len(result.people) == 20 and result.checked == 0 and len(crawler.calls) == calls

    asyncio.run(main())


def test_same_owner_rules():
    person = {"username": "Alice", "o_name": "Alice"}
    assert same_owner(person, make_gift("a-1", Owner(username="alice")))
    assert not same_owner(person, make_gift("a-1", Owner(username="bob")))
    assert not same_owner(person, make_gift("a-1", Owner(ton_address="UQ")))
    assert not same_owner(person, make_gift("a-1", owner_name="Alice"))
    by_id = {"username": None, "o_name": "Bob Smith"}
    assert same_owner(by_id, make_gift("a-1", owner_name="Bob Smith"))
    assert not same_owner(by_id, make_gift("a-1", owner_name="Someone"))


def test_people_keyboard_and_page_text():
    def labels(markup):
        return [[b.text for b in row] for row in markup.inline_keyboard]

    assert labels(people_kb(0, 2, "filters"))[0] == ["След. страница"]
    assert labels(people_kb(1, 2, "filters"))[:2] == [["Назад"], ["Повторить"]]
    assert labels(people_kb(0, 1, "random")) == [["Повторить"], ["Меню"]]

    people = [
        {
            "slug": f"pop-{n}",
            "title": "Pop",
            "number": n,
            "backdrop": "Amber",
            "model": "M",
            "matched": 1,
            "username": f"user{n}",
            "o_name": None,
            "user_id": None,
            "ton_address": None,
            "owner_name": None,
            "tier": "light",
            "gifts_count": 1,
            "value_ton": 4,
        }
        for n in range(1, 21)
    ]
    timing = {"seconds": 1.23, "db_seconds": 0.01, "live_seconds": 1.22, "checked": 20, "replaced": 0}
    page2 = people_page("Тест", "all", people, 1, 10, timing)
    assert "Страница 2/2" in page2 and "11. @user11 / " in page2 and "20. @user20 / " in page2
    assert "@user10 /" not in page2 and "1.23 с" in page2


def test_regular_gift_row_has_no_nft_link():
    from app.texts import person_card

    regular = {
        "slug": "regular50-7",
        "title": "regular50",  # в БД у обычного подарка «коллекция» = regular<звёзды>
        "number": 7,
        "is_upgraded": 0,
        "matched": 2,
        "username": "kate",
        "o_name": None,
        "user_id": None,
        "ton_address": None,
        "owner_name": None,
        "gifts_count": 0,
        "value_ton": 0,
    }
    line = person_card(regular, 1)
    assert "t.me/nft" not in line  # у обычного подарка нет страницы NFT
    assert "Обычный подарок, 50 звёзд" in line and "@kate" in line and "(2 шт.)" in line


def test_female_search_progresses_across_rounds(tmp_path):
    """Пост-фильтр по полу не должен застревать: смена seed между раундами добирает всех девочек."""

    async def main():
        db = Database(tmp_path / "f.db", medium_ton=10, rich_ton=100, default_gift_ton=3)
        await db.connect()
        try:
            gifts = []
            for i in range(1, 16):  # 15 женских
                gifts.append(make_gift(f"pop-{i}", Owner(user_id=1000 + i, name="Анна")))
            for i in range(16, 61):  # 45 мужских/нейтральных
                gifts.append(make_gift(f"pop-{i}", Owner(user_id=2000 + i, name="Борис")))
            await db.save_gifts(gifts)

            settings = Settings(bot_token="1:x", people_per_page=10, people_pages=2, live_check=False)
            parser = PeopleParser(db, FakeCrawler(db, sold=set()), settings)
            res = await parser.parse(SearchQuery(female=True, seed=1))
            names = {p["o_name"] for p in res.people}
            assert names == {"Анна"}  # только девочки
            assert len(res.people) == 15  # добрал всех, несмотря на пост-фильтр и раунды
            assert len({p["owner_id"] for p in res.people}) == 15  # без повторов
        finally:
            await db.close()

    asyncio.run(main())
