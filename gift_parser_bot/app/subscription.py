"""Обязательная подписка на канал (по умолчанию @fiestagod).

Проверка — Bot API getChatMember(channel, user_id). Для каналов метод работает, только
если бот добавлен в канал администратором. Если проверить невозможно (бот не админ,
канал не найден), бот не блокирует пользователей, а пишет предупреждение в лог и в /admin.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware, Bot
from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import TelegramAPIError
from aiogram.types import CallbackQuery, Message, TelegramObject, User

from . import keyboards as kb
from . import texts

log = logging.getLogger(__name__)

SUBSCRIBED = {ChatMemberStatus.CREATOR, ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.MEMBER}


class SubscriptionChecker:
    def __init__(self, channel: str | None, admin_ids: frozenset[int] = frozenset(), ttl: float = 600):
        self.channel = (
            channel if not channel or channel.startswith("@") or channel.lstrip("-").isdigit() else "@" + channel
        )
        self.admin_ids = admin_ids
        self.ttl = ttl  # подтверждённую подписку не перепроверяем 10 минут
        self.last_error: str | None = None
        self._ok_until: dict[int, float] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.channel)

    @property
    def url(self) -> str:
        return f"https://t.me/{self.channel.lstrip('@')}" if self.channel else ""

    async def is_subscribed(self, bot: Bot, user_id: int, *, use_cache: bool = True) -> bool:
        if not self.enabled or user_id in self.admin_ids:
            return True
        if use_cache and self._ok_until.get(user_id, 0) > time.monotonic():
            return True
        try:
            member = await bot.get_chat_member(self.channel, user_id)
        except TelegramAPIError as e:
            self.last_error = f"{self.channel}: {e}"
            log.warning("Проверка подписки недоступна (бот должен быть админом %s): %s", self.channel, e)
            return True
        self.last_error = None
        ok = member.status in SUBSCRIBED or (
            member.status == ChatMemberStatus.RESTRICTED and getattr(member, "is_member", False)
        )
        if ok:
            self._ok_until[user_id] = time.monotonic() + self.ttl
        else:
            self._ok_until.pop(user_id, None)
        return ok


class SubscriptionMiddleware(BaseMiddleware):
    """Пропускает к парсеру только подписчиков; остальным показывает «Подписаться» / «Проверить подписку»."""

    def __init__(self, checker: SubscriptionChecker):
        self.checker = checker

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        user: User | None = data.get("event_from_user")
        chat = data.get("event_chat")
        if user is None or (chat is not None and chat.type != "private"):
            return await handler(event, data)
        if isinstance(event, CallbackQuery) and event.data == kb.SubCb(action="check").pack():
            return await handler(event, data)  # кнопка «Проверить подписку» доступна всем
        if await self.checker.is_subscribed(data["bot"], user.id):
            return await handler(event, data)

        text = texts.subscribe_required(self.checker.channel)
        markup = kb.subscribe(self.checker.url)
        if isinstance(event, CallbackQuery):
            await event.answer(texts.SUBSCRIBE_ALERT.format(channel=self.checker.channel), show_alert=True)
            if isinstance(event.message, Message):
                await event.message.answer(text, reply_markup=markup)
        elif isinstance(event, Message):
            await event.answer(text, reply_markup=markup)
        return None
