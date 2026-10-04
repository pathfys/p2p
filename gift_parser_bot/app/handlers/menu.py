"""/start, главное меню, режимы и «Все подарки»."""

from __future__ import annotations

from aiogram import F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import keyboards as kb
from .. import texts
from ..config import Settings
from ..crawler import Crawler
from ..db import Database
from .common import safe_edit, spawn

router = Router(name="menu")


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext, db: Database, crawler: Crawler) -> None:
    await state.set_state(None)
    user = message.from_user
    if await db.touch_user(user.id, user.username, user.first_name):
        # Новый пользователь: его NFT-подарки сразу попадают в базу через Bot API getUserGifts
        spawn(crawler.parse_user(user.id, user.username, user.full_name))
    mode = await db.get_mode(user.id)
    await message.answer(texts.welcome(user.first_name, await db.cached_stats()), reply_markup=kb.main_menu(mode))


@router.callback_query(kb.MenuCb.filter(F.action == "main"))
async def cb_main(call: CallbackQuery, state: FSMContext, db: Database) -> None:
    await state.set_state(None)
    mode = await db.get_mode(call.from_user.id)
    await safe_edit(call.message, texts.welcome(call.from_user.first_name, await db.cached_stats()), kb.main_menu(mode))
    await call.answer()


@router.callback_query(kb.ModeCb.filter())
async def cb_mode(
    call: CallbackQuery, callback_data: kb.ModeCb, state: FSMContext, db: Database, settings: Settings
) -> None:
    mode = callback_data.mode if callback_data.mode in texts.MODES else "all"
    await db.set_mode(call.from_user.id, mode)
    await call.answer(texts.mode_hint(mode, settings))
    if callback_data.src == "filters":
        filters = (await state.get_data()).get("filters", {})
        await safe_edit(call.message, texts.filters_panel(filters, mode, settings), kb.filters_panel(filters, mode))
        return
    try:
        await call.message.edit_reply_markup(reply_markup=kb.main_menu(mode))
    except TelegramBadRequest:
        pass


@router.callback_query(kb.MenuCb.filter(F.action == "random"))
async def cb_random(call: CallbackQuery, db: Database, settings: Settings) -> None:
    """4-й режим: абсолютно случайные подарки из всей базы, независимо от фильтров и уровня."""
    await db.set_mode(call.from_user.id, "all")
    rows = await db.random_gifts(settings.random_count)
    await safe_edit(call.message, texts.random_gifts(rows), kb.random_gifts())
    await call.answer("🎲")


@router.callback_query(kb.MenuCb.filter(F.action == "stats"))
async def cb_stats(call: CallbackQuery, db: Database, settings: Settings) -> None:
    await safe_edit(call.message, texts.stats_text(await db.cached_stats(ttl=10), settings), kb.back_to_menu())
    await call.answer()
