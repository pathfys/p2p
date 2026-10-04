"""Источник №3: официальный Bot API — getUserGifts (Bot API 9.3+).

Работает с токеном самого бота, без отдельного аккаунта. Нужен числовой user_id,
поэтому источник пользователей — те, кто запускал бота, и отправители подарков
(sender_user), найденные в чужих портфелях: база растёт «снежным комом».
"""

from __future__ import annotations

from aiogram import Bot
from aiogram.exceptions import TelegramRetryAfter
from aiogram.types import OwnedGiftUnique, UniqueGift

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
    )


async def fetch_user_portfolio(
    bot: Bot, limiter: RateLimiter, user_id: int, username: str | None = None, name: str | None = None
) -> Portfolio:
    portfolio = Portfolio(owner=Owner(user_id=user_id, username=username, name=name))
    offset = ""
    while True:
        await limiter.acquire()
        try:
            page = await bot.get_user_gifts(user_id=user_id, exclude_unlimited=True, offset=offset, limit=100)
        except TelegramRetryAfter as e:
            limiter.on_throttle(e.retry_after)
            continue
        limiter.on_success()
        for owned in page.gifts:
            if not isinstance(owned, OwnedGiftUnique) or owned.gift.is_burned:
                continue
            portfolio.gifts.append(unique_to_parsed(owned.gift))
            sender = owned.sender_user
            if sender and not sender.is_bot and sender.id != user_id:
                portfolio.senders.append(Owner(user_id=sender.id, username=sender.username, name=sender.full_name))
        if not page.next_offset:
            return portfolio
        offset = page.next_offset
