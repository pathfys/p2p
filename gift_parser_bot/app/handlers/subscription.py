"""Кнопка «Проверить подписку» на обязательный канал."""

from __future__ import annotations

from aiogram import Bot, F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery

from .. import keyboards as kb
from .. import texts
from ..crawler import Crawler
from ..db import Database
from ..subscription import SubscriptionChecker
from .menu import open_menu

router = Router(name="subscription")


@router.callback_query(kb.SubCb.filter(F.action == "check"))
async def cb_check(
    call: CallbackQuery, bot: Bot, state: FSMContext, checker: SubscriptionChecker, db: Database, crawler: Crawler
) -> None:
    if not await checker.is_subscribed(bot, call.from_user.id, use_cache=False):
        await call.answer(texts.SUBSCRIBE_FAIL.format(channel=checker.channel), show_alert=True)
        return
    await call.answer(texts.SUBSCRIBE_OK)
    await state.set_state(None)
    await open_menu(call.message, call.from_user, db, crawler, edit=True)
