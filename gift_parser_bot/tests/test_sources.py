from aiogram.types import (
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

from app.parsers.botapi import unique_to_parsed
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
