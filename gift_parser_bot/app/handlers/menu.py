"""/start, главное меню, режимы и «Все подарки»."""

from __future__ import annotations

from aiogram import F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message, User

from .. import keyboards as kb
from .. import texts
from ..config import Settings
from ..crawler import Crawler
from ..db import Database
from ..people import PeopleParser
from .common import safe_edit, spawn
from .people_view import run_people

router = Router(name="menu")


async def open_menu(message: Message, user: User, db: Database, crawler: Crawler, *, edit: bool) -> None:
    """Регистрирует пользователя и показывает приветствие с главным меню."""
    if await db.touch_user(user.id, user.username, user.first_name):
        # Новый пользователь: его NFT-подарки сразу попадают в базу через Bot API getUserGifts
        spawn(crawler.parse_user(user.id, user.username, user.full_name))
    mode = await db.get_mode(user.id)
    text, markup = texts.welcome(user.first_name, await db.cached_stats()), kb.main_menu(mode)
    if edit:
        await safe_edit(message, text, markup)
    else:
        await message.answer(text, reply_markup=markup)


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext, db: Database, crawler: Crawler) -> None:
    await state.set_state(None)
    await open_menu(message, message.from_user, db, crawler, edit=False)


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
async def cb_random(
    call: CallbackQuery, state: FSMContext, db: Database, people_parser: PeopleParser, settings: Settings
) -> None:
    """4-й режим: случайные люди с абсолютно разными подарками, независимо от фильтров и уровня."""
    await db.set_mode(call.from_user.id, "all")
    await call.answer(f"🎲 {texts.PARSING}")
    await run_people(
        call.message,
        state,
        people_parser,
        settings,
        query=None,
        header=texts.RANDOM_HEADER,
        mode="all",
        back="random",
        edit=True,
    )


@router.callback_query(kb.MenuCb.filter(F.action == "stats"))
async def cb_stats(call: CallbackQuery, db: Database, settings: Settings) -> None:
    await safe_edit(call.message, texts.stats_text(await db.cached_stats(ttl=10), settings), kb.back_to_menu())
    await call.answer()
