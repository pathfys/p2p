from app.parsers.fragment import parse_collections, parse_floor
from app.parsers.models import normalize_slug, percent_to_permille, title_to_collection
from app.parsers.nft_page import parse_nft_html


def nft_page(title: str, owner_cell: str | None) -> str:
    """Минимальная копия разметки https://t.me/nft/<slug> (только то, что читает парсер)."""
    owner_row = f"<tr><th>Owner</th><td>{owner_cell}</td></tr>" if owner_cell is not None else ""
    return (
        f'<html><head><meta property="og:title" content="{title}"></head><body>'
        '<table class="table tgme_gift_table"><tbody>'
        f"{owner_row}"
        "<tr><th>Model</th><td>Satellite <mark>0.5%</mark></td></tr>"
        "<tr><th>Backdrop</th><td>Carrot Juice <mark>2%</mark></td></tr>"
        "<tr><th>Symbol</th><td>Coin Purse <mark>0.4%</mark></td></tr>"
        "<tr><th>Quantity</th><td>434&nbsp;580/468&nbsp;745 issued</td></tr>"
        "</tbody></table></body></html>"
    )


def test_owner_with_username():
    cell = (
        '<a href="https://t.me/test_owner"><i class="tgme_gift_owner_photo bgcolor5" data-content="T"></i>'
        '<span dir="auto">Test &amp; Owner</span></a>'
    )
    gift = parse_nft_html("LolPop-5000", nft_page("Lol Pop #5000", cell))
    assert gift.slug == "lolpop-5000"
    assert (gift.title, gift.number, gift.collection) == ("Lol Pop", 5000, "lolpop")
    assert (gift.model, gift.model_rarity) == ("Satellite", 5)
    assert (gift.backdrop, gift.backdrop_rarity) == ("Carrot Juice", 20)
    assert (gift.symbol, gift.symbol_rarity) == ("Coin Purse", 4)
    assert (gift.issued, gift.total) == (434580, 468745)
    assert gift.owner.username == "test_owner"
    assert gift.owner.name == "Test & Owner"


def test_owner_wallet():
    cell = '<span class="tgme_gift_owner_address">UQDUNOrf-xylNgnw8QV6gbFBWozBbOqUpNQ-zi3K5e-RDxdx</span>'
    gift = parse_nft_html("plushpepe-100", nft_page("Plush Pepe #100", cell))
    assert gift.owner.ton_address.startswith("UQDUNOrf")
    assert gift.owner.username is None


def test_owner_name_only_and_hidden():
    cell = (
        '<i class="tgme_gift_owner_photo bgcolor4" data-content="J"><img src="x.jpg"></i><span dir="auto">John</span>'
    )
    gift = parse_nft_html("prettyposy-12", nft_page("Pretty Posy #12", cell))
    assert gift.owner is None and gift.owner_name == "John"

    invisible = '<span dir="auto">­</span>'
    gift = parse_nft_html("prettyposy-13", nft_page("Pretty Posy #13", invisible))
    assert gift.owner is None and gift.owner_name is None

    gift = parse_nft_html("prettyposy-14", nft_page("Pretty Posy #14", None))
    assert gift.owner is None and gift.owner_name is None


def test_title_with_apostrophe_and_garbage():
    gift = parse_nft_html("durovscap-2", nft_page("Durov’s Cap #2", None))
    assert gift.title == "Durov’s Cap" and gift.number == 2
    assert parse_nft_html("x-1", "<html>Telegram: Contact</html>") is None


def test_slug_helpers():
    assert normalize_slug("https://t.me/nft/PlushPepe-1") == "plushpepe-1"
    assert normalize_slug("смотри t.me/nft/DurovsCap-0042 !") == "durovscap-42"
    assert normalize_slug("tg://nft?slug=LolPop-7") == "lolpop-7"
    assert normalize_slug("plush pepe") is None
    assert title_to_collection("Durov's Cap") == "durovscap"
    assert title_to_collection("Jack-in-the-Box") == "jackinthebox"
    assert percent_to_permille("0.3%") == 3 and percent_to_permille("Rare") is None


def test_fragment():
    page = (
        '<a href="/gifts/plushpepe" class="tm-main-filters-item js-filter-item js-choose-collection-item" '
        'data-keywords="Plush Pepes" data-value="plushpepe"><div class="tm-main-filters-photo"></div>'
        '<div class="tm-main-filters-name">Plush Pepes</div><div class="tm-main-filters-count">2,473</div></a>'
        '<a href="/gifts/durovscap" class="tm-main-filters-item js-filter-item" data-value="durovscap">'
        '<div class="tm-main-filters-name">Durov&#39;s Caps</div></a>'
        '<a href="/gifts/plushpepe" class="tm-popup-filters-item icon-after" data-value="plushpepe">'
    )
    assert parse_collections(page) == [("plushpepe", "Plush Pepes"), ("durovscap", "Durov's Caps")]
    listing = '<div class="tm-grid-item-value tm-value icon-before icon-ton">7,000</div>'
    assert parse_floor(listing) == 7000.0
    assert parse_floor("<div>no lots</div>") is None
