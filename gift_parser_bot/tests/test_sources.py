from aiogram.types import (
    Gift,
    OwnedGiftRegular,
    Sticker,
    UniqueGift,
    UniqueGiftBackdrop,
    UniqueGiftBackdropColors,
    UniqueGiftModel,
    UniqueGiftSymbol,
)
from telethon.tl.types import (
    DocumentEmpty,
    StarGiftAttributeBackdrop,
    StarGiftAttributeModel,
    StarGiftAttributePattern,
    StarGiftAttributeRarity,
    StarGiftAttributeRarityRare,
    StarGiftUnique,
)

from app.parsers.botapi import regular_to_parsed, unique_to_parsed
from app.parsers.mtproto import unique_from_tl


def sticker() -> Sticker:
    return Sticker(
        file_id="f", file_unique_id="u", type="custom_emoji", width=1, height=1, is_animated=True, is_video=False
    )


def test_bot_api_unique_gift():
    gift = UniqueGift(
        gift_id="1",
        base_name="Plush Pepe",
        name="PlushPepe-1",
        number=1,
        model=UniqueGiftModel(name="Pumpkin", sticker=sticker(), rarity_per_mille=30),
        symbol=UniqueGiftSymbol(name="Illuminati", sticker=sticker(), rarity_per_mille=5),
        backdrop=UniqueGiftBackdrop(
            name="Onyx Black",
            colors=UniqueGiftBackdropColors(center_color=0, edge_color=0, symbol_color=0, text_color=0),
            rarity_per_mille=20,
        ),
    )
    parsed = unique_to_parsed(gift)
    assert (parsed.slug, parsed.title, parsed.number, parsed.source) == ("plushpepe-1", "Plush Pepe", 1, "botapi")
    assert (parsed.model, parsed.model_rarity, parsed.backdrop, parsed.symbol_rarity) == (
        "Pumpkin",
        30,
        "Onyx Black",
        5,
    )


def test_bot_api_regular_gift():
    gift = Gift(id="99", sticker=sticker(), star_count=50)
    owned = OwnedGiftRegular(type="regular", gift=gift, send_date=0, owned_gift_id="abc123")
    parsed = regular_to_parsed(owned)
    assert parsed is not None
    assert parsed.upgraded is False  # обычный (неулучшенный) подарок
    assert parsed.source == "botapi"
    assert parsed.collection == "regular50" and parsed.slug.startswith("regular50-")
    assert parsed.title == "Обычный подарок, 50 звёзд"
    assert parsed.model is None and parsed.backdrop is None  # у обычного нет модели/фона
    # тот же подарок -> тот же slug (стабильность, без дублей в базе)
    again = OwnedGiftRegular(type="regular", gift=gift, send_date=1, owned_gift_id="abc123")
    assert regular_to_parsed(again).slug == parsed.slug


def _unique_tl(owner_id=None, owner_address=None, owner_name=None):
    from telethon.tl.types import StarGiftUnique

    return StarGiftUnique(
        id=1,
        gift_id=2,
        title="Durov's Cap",
        slug="DurovsCap-7",
        num=7,
        availability_issued=4710,
        availability_total=4774,
        attributes=[],
        owner_id=owner_id,
        owner_address=owner_address,
        owner_name=owner_name,
    )


def _fetch_unique(result):
    """Вызывает MtprotoSource.fetch_unique с подменённым сетевым вызовом."""
    import asyncio

    from app.parsers.mtproto import MtprotoSource

    source = object.__new__(MtprotoSource)  # без telethon-клиента

    async def fake_call(request):
        return result

    source._call = fake_call
    return asyncio.run(source.fetch_unique("durovscap-7"))


def test_mtproto_unique_gift_resolves_owner_username():
    """Ключевой путь: страница t.me/nft не отдаёт @username, а MTProto — отдаёт."""
    from telethon.tl.types import PeerUser, User

    class Result:
        gift = _unique_tl(owner_id=PeerUser(user_id=5))
        users = [User(id=5, first_name="Kate", last_name="K", username="kate")]
        chats = []

    parsed = _fetch_unique(Result())
    assert parsed.owner is not None
    assert (parsed.owner.user_id, parsed.owner.username, parsed.owner.name) == (5, "kate", "Kate K")
    assert parsed.slug == "durovscap-7" and parsed.source == "mtproto"


def test_mtproto_unique_gift_wallet_and_hidden_owner():
    from telethon.tl.types import PeerUser

    class OnChain:
        gift = _unique_tl(owner_address="UQabc")
        users = []
        chats = []

    on_chain = _fetch_unique(OnChain())
    assert on_chain.owner.ton_address == "UQabc" and on_chain.owner.username is None

    class Hidden:
        gift = _unique_tl(owner_name="Скрытый")
        users = []
        chats = []

    hidden = _fetch_unique(Hidden())
    assert hidden.owner is None and hidden.owner_name == "Скрытый"

    # владелец известен только по id (нет его в users) — всё равно это человек
    class OnlyId:
        gift = _unique_tl(owner_id=PeerUser(user_id=9))
        users = []
        chats = []

    only_id = _fetch_unique(OnlyId())
    assert only_id.owner.user_id == 9 and only_id.owner.username is None


def test_mtproto_unique_gift():
    gift = StarGiftUnique(
        id=1,
        gift_id=2,
        title="Durov's Cap",
        slug="DurovsCap-7",
        num=7,
        availability_issued=4710,
        availability_total=4774,
        attributes=[
            StarGiftAttributeModel(name="Crafted", document=DocumentEmpty(id=0), rarity=StarGiftAttributeRarityRare()),
            StarGiftAttributeBackdrop(
                name="Mystic Pearl",
                backdrop_id=1,
                center_color=0,
                edge_color=0,
                pattern_color=0,
                text_color=0,
                rarity=StarGiftAttributeRarity(permille=20),
            ),
            StarGiftAttributePattern(
                name="Pickaxe", document=DocumentEmpty(id=0), rarity=StarGiftAttributeRarity(permille=2)
            ),
        ],
    )
    parsed = unique_from_tl(gift)
    assert (parsed.slug, parsed.title, parsed.number, parsed.issued) == ("durovscap-7", "Durov's Cap", 7, 4710)
    assert (parsed.model, parsed.model_rarity) == ("Crafted", None)  # у крафтовых моделей редкость — категория
    assert (parsed.backdrop, parsed.backdrop_rarity, parsed.symbol, parsed.symbol_rarity) == (
        "Mystic Pearl",
        20,
        "Pickaxe",
        2,
    )


def test_mtproto_pool_failover_and_spreading():
    """Лимиты считаются на аккаунт: при FLOOD_WAIT запрос должен уйти на другую сессию,
    а «уставший» аккаунт — уступать очередь, пока его пауза не истечёт."""
    import asyncio

    from telethon.errors import FloodWaitError

    from app.parsers.models import ParsedGift
    from app.parsers.mtproto import MtprotoPool
    from app.ratelimit import RateLimiter

    class FakeSource:
        def __init__(self, name, floods=0):
            self.name = name
            self.limiter = RateLimiter("mtproto", "fast", label=name)
            self.calls = []
            self.floods = floods

        async def fetch_unique(self, slug):
            self.calls.append(slug)
            if self.floods:
                self.floods -= 1
                self.limiter.on_throttle(30)  # аккаунт уходит на паузу
                raise FloodWaitError(request=None, capture=30)
            return ParsedGift(slug=slug, title="C", number=1, source="mtproto")

    first, second = FakeSource("acc1", floods=1), FakeSource("acc2")
    pool = MtprotoPool([first, second])
    assert len(pool) == 2 and pool.names == ["acc1", "acc2"]

    gift = asyncio.run(pool.fetch_unique("c-1"))
    assert gift is not None and gift.slug == "c-1"  # отработали, несмотря на FLOOD_WAIT
    assert first.calls == ["c-1"] and second.calls == ["c-1"]  # перешли на второй аккаунт

    # теперь acc1 на паузе -> следующий запрос начинается со свободного acc2
    asyncio.run(pool.fetch_unique("c-2"))
    assert second.calls == ["c-1", "c-2"] and first.calls == ["c-1"]
