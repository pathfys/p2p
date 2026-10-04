from __future__ import annotations

import asyncio
from typing import Coroutine

from aiogram.exceptions import TelegramBadRequest
from aiogram.types import InlineKeyboardMarkup, Message

_background: set[asyncio.Task] = set()


def spawn(coro: Coroutine) -> asyncio.Task:
    """Фоновая задача, на которую держим ссылку (иначе её может собрать GC)."""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)
    return task


async def safe_edit(message: Message, text: str, markup: InlineKeyboardMarkup | None = None) -> None:
    """edit_text, который не падает на «message is not modified» и на старых сообщениях."""
    try:
        await message.edit_text(text, reply_markup=markup)
    except TelegramBadRequest as e:
        if "not modified" in str(e):
            return
        await message.answer(text, reply_markup=markup)
