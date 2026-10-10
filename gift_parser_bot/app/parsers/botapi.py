"""Источник №3: официальный Bot API — getUserGifts (Bot API 9.3+).

Работает с токеном самого бота, без отдельного аккаунта. Нужен числовой user_id,
поэтому источник пользователей — те, кто запускал бота, и отправители подарков
(sender_user), найденные в чужих портфелях: база растёт «снежным комом».

Собираем два вида подарков:
* OwnedGiftUnique — улучшенные коллекционные NFT (модель/фон/узор);
* OwnedGiftRegular — обычные (неулучшенные) звёздные подарки. У них нет страницы
  t.me/nft и нет модели/фона — храним их с флагом upgraded=False для фильтра
  «Обычные подарки».
"""

from __future__ import annotations

import hashlib

from aiogram import Bot
from aiogram.exceptions import TelegramRetryAfter
from aiogram.types import OwnedGift, OwnedGiftRegular, OwnedGiftUnique, UniqueGift

from ..ratelimit import RateLimiter
from .models import Owner, ParsedGift, Portfolio, normalize_slug, title_to_collection


def unique_to_parsed(gift: UniqueGift) -> ParsedGift:
    slug = normalize_slug(gift.name) or f"{title_to_collection(gift.base_name)}-{gift.number}"
    return ParsedGift(
        slug=slug,
        title=gift.base_name,
        number=gift.number,
        model=gift.model.name,
        model_rarity=gift.model.rarity_per_mille or None,
        backdrop=gift.backdrop.name,
        backdrop_rarity=gift.backdrop.rarity_per_mille,
        symbol=gift.symbol.name,
        symbol_rarity=gift.symbol.rarity_per_mille,
        source="botapi",
        upgraded=True,
    )


def regular_to_parsed(owned: OwnedGiftRegular) -> ParsedGift | None:
    """Обычный (неулучшенный) подарок. У него нет номера/коллекции в привычном смысле,
    поэтому собираем синтетический, но стабильный slug из owned_gift_id."""
    gift = owned.gift
    key = owned.owned_gift_id or gift.id
    if not key:
        return None
    star = gift.star_count or 0
    collection = f"regular{star}"
    number = int(hashlib.sha1(str(key).encode()).hexdigest()[:12], 16) % 1_000_000_000
    title = f"Обычный подарок, {star} звёзд" if star else "Обычный подарок"
    return ParsedGift(slug=f"{collection}-{number}", title=title, number=number, source="botapi", upgraded=False)


def _sender(owned: OwnedGift, user_id: int) -> Owner | None:
    sender = owned.sender_user
    if sender and not sender.is_bot and sender.id != user_id:
        return Owner(user_id=sender.id, username=sender.username, name=sender.full_name)
    return None


async def fetch_user_portfolio(
    bot: Bot, limiter: RateLimiter, user_id: int, username: str | None = None, name: str | None = None
) -> Portfolio:
    portfolio = Portfolio(owner=Owner(user_id=user_id, username=username, name=name))
    offset = ""
    while True:
        await limiter.acquire()
        try:
            # без exclude_*: забираем и улучшенные (unique), и обычные подарки за один обход
            page = await bot.get_user_gifts(user_id=user_id, offset=offset, limit=100)
        except TelegramRetryAfter as e:
            limiter.on_throttle(e.retry_after)
            continue
        limiter.on_success()
        for owned in page.gifts:
            if isinstance(owned, OwnedGiftUnique):
                if owned.gift.is_burned:
                    continue
                portfolio.gifts.append(unique_to_parsed(owned.gift))
            elif isinstance(owned, OwnedGiftRegular):
                if owned.was_refunded:
                    continue
                parsed = regular_to_parsed(owned)
                if parsed is None:
                    continue
                portfolio.gifts.append(parsed)
            else:
                continue
            if found := _sender(owned, user_id):
                portfolio.senders.append(found)
        if not page.next_offset:
            return portfolio
        offset = page.next_offset
