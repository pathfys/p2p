"""Источник №4 (опционально): MTProto-аккаунт через Telethon.

payments.getSavedStarGifts отдаёт все подарки любого пользователя или канала по
@username — то, что бот через Bot API сделать не может (ему нужен user_id).
Минус: resolveUsername у Telegram сильно лимитирован (FLOOD_WAIT), поэтому этот
источник медленный — используется для точечных запросов «@username» и для
постепенного дообогащения самых богатых владельцев.

Включается, если в .env заданы API_ID и API_HASH (https://my.telegram.org),
а сессия авторизована командой:  python -m app.login
"""

from __future__ import annotations

import logging

from ..ratelimit import RateLimiter
from .models import Owner, ParsedGift, Portfolio

log = logging.getLogger(__name__)


def unique_from_tl(gift) -> ParsedGift:
    from telethon.tl.types import StarGiftAttributeBackdrop, StarGiftAttributeModel, StarGiftAttributePattern

    parsed = ParsedGift(
        slug=gift.slug.lower(),
        title=gift.title,
        number=gift.num,
        issued=gift.availability_issued,
        total=gift.availability_total,
        source="mtproto",
    )
    for attr in gift.attributes:
        rarity = getattr(getattr(attr, "rarity", None), "permille", None)
        if isinstance(attr, StarGiftAttributeModel):
            parsed.model, parsed.model_rarity = attr.name, rarity
        elif isinstance(attr, StarGiftAttributeBackdrop):
            parsed.backdrop, parsed.backdrop_rarity = attr.name, rarity
        elif isinstance(attr, StarGiftAttributePattern):
            parsed.symbol, parsed.symbol_rarity = attr.name, rarity
    return parsed


class MtprotoSource:
    def __init__(self, api_id: int, api_hash: str, session_path: str, limiter: RateLimiter, name: str = ""):
        from pathlib import Path

        from telethon import TelegramClient

        self.client = TelegramClient(session_path, api_id, api_hash)
        self.limiter = limiter
        self.name = name or Path(session_path).name

    async def start(self) -> None:
        await self.client.connect()
        if not await self.client.is_user_authorized():
            await self.client.disconnect()
            raise RuntimeError("MTProto-сессия не авторизована: выполните `python -m app.login`")

    async def stop(self) -> None:
        await self.client.disconnect()

    async def _call(self, request, max_floods: int = 2):
        from telethon.errors import FloodWaitError

        floods = 0
        while True:
            await self.limiter.acquire()
            try:
                result = await request()
            except FloodWaitError as e:
                floods += 1
                log.warning("MTProto[%s] FLOOD_WAIT %ss", self.name, e.seconds)
                self.limiter.on_throttle(e.seconds)
                if floods >= max_floods:
                    raise  # пусть вызывающий пул попробует другой аккаунт
                continue
            self.limiter.on_success()
            return result

    async def fetch_unique(self, slug: str) -> ParsedGift | None:
        """Полные данные одного NFT по слагу, включая ВЛАДЕЛЬЦА.

        Публичная страница t.me/nft отдаёт только отображаемое имя владельца, без
        @username — поэтому людей в базу можно добрать только здесь:
        payments.getUniqueStarGift возвращает owner_id (Peer) и список users с username,
        либо owner_address, если подарок выведен в блокчейн.
        None — слаг не существует или данные недоступны.
        """
        from telethon.errors import FloodWaitError, RPCError
        from telethon.tl.functions.payments import GetUniqueStarGiftRequest
        from telethon.tl.types import PeerUser

        try:
            result = await self._call(lambda: self.client(GetUniqueStarGiftRequest(slug=slug)))
        except FloodWaitError:
            raise  # это НЕ «подарка нет»: отдаём наверх, чтобы сработал другой аккаунт
        except (ValueError, RPCError) as e:
            log.info("MTProto: getUniqueStarGift %s: %s", slug, e)
            return None

        gift = result.gift
        parsed = unique_from_tl(gift)
        peer = getattr(gift, "owner_id", None)
        user_id = peer.user_id if isinstance(peer, PeerUser) else (peer if isinstance(peer, int) else None)
        address = getattr(gift, "owner_address", None)
        if user_id:
            user = next((u for u in (getattr(result, "users", None) or []) if getattr(u, "id", None) == user_id), None)
            name = None
            if user is not None:
                name = " ".join(filter(None, [user.first_name, user.last_name])) or None
            parsed.owner = Owner(user_id=user_id, username=getattr(user, "username", None), name=name)
        elif address:
            parsed.owner = Owner(ton_address=address)
        else:  # владелец полностью скрыт — сохраняем хотя бы имя
            parsed.owner_name = getattr(gift, "owner_name", None)
        return parsed

    async def fetch_portfolio(self, username: str) -> Portfolio | None:
        """Все уникальные подарки аккаунта. None — юзернейм не существует."""
        from telethon.errors import FloodWaitError, RPCError
        from telethon.tl.functions.payments import GetSavedStarGiftsRequest
        from telethon.tl.types import StarGiftUnique, User

        try:
            entity = await self._call(lambda: self.client.get_entity(username))
        except FloodWaitError:
            raise
        except (ValueError, RPCError) as e:
            log.info("MTProto: не удалось найти %s: %s", username, e)
            return None

        owner = Owner(username=getattr(entity, "username", None) or username)
        if isinstance(entity, User):
            owner.user_id = entity.id
            owner.name = " ".join(filter(None, [entity.first_name, entity.last_name])) or None
        else:
            owner.name = getattr(entity, "title", None)

        portfolio = Portfolio(owner=owner)
        peer = await self.client.get_input_entity(entity)
        offset = ""
        while True:
            request = GetSavedStarGiftsRequest(peer=peer, offset=offset, limit=100, exclude_unlimited=True)
            page = await self._call(lambda: self.client(request))  # noqa: B023 — вызывается сразу
            for saved in page.gifts:
                if isinstance(saved.gift, StarGiftUnique) and not saved.gift.burned:
                    portfolio.gifts.append(unique_from_tl(saved.gift))
            if not page.next_offset:
                return portfolio
            offset = page.next_offset


class MtprotoPool:
    """Пул MTProto-аккаунтов.

    Лимиты Telegram считаются НА АККАУНТ, поэтому несколько сессий дают почти кратную
    скорость. Запрос уходит на самый свободный аккаунт; если он поймал FLOOD_WAIT —
    пробуем следующий, а «уставший» сам выпадет из ротации, пока не истечёт его пауза.
    """

    def __init__(self, sources: list[MtprotoSource]):
        self.sources = list(sources)

    def __len__(self) -> int:
        return len(self.sources)

    @property
    def names(self) -> list[str]:
        return [s.name for s in self.sources]

    def _by_readiness(self) -> list[MtprotoSource]:
        return sorted(self.sources, key=lambda s: s.limiter.busy_until)

    async def _any(self, call):
        from telethon.errors import FloodWaitError

        flood = None
        for source in self._by_readiness():
            try:
                return await call(source)
            except FloodWaitError as e:  # этот аккаунт на паузе — пробуем следующий
                flood = e
        if flood is not None:
            raise flood
        return None

    async def fetch_unique(self, slug: str) -> ParsedGift | None:
        return await self._any(lambda s: s.fetch_unique(slug))

    async def fetch_portfolio(self, username: str) -> Portfolio | None:
        return await self._any(lambda s: s.fetch_portfolio(username))

    async def stop(self) -> None:
        for source in self.sources:
            await source.stop()
