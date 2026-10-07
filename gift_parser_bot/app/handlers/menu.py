"""/start, главное меню, «Все подарки», статистика."""

from __future__ import annotations

from aiogram import F, Router
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
    if edit:
        await safe_edit(message, texts.welcome(), kb.main_menu())
    else:
        await message.answer(texts.welcome(), reply_markup=kb.main_menu())


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext, db: Database, crawler: Crawler) -> None:
    await state.set_state(None)
    await open_menu(message, message.from_user, db, crawler, edit=False)


@router.callback_query(kb.MenuCb.filter(F.action == "main"))
async def cb_main(call: CallbackQuery, state: FSMContext, db: Database, crawler: Crawler) -> None:
    await state.set_state(None)
    await open_menu(call.message, call.from_user, db, crawler, edit=True)
    await call.answer()


@router.callback_query(kb.MenuCb.filter(F.action == "random"))
async def cb_random(call: CallbackQuery, state: FSMContext, people_parser: PeopleParser, settings: Settings) -> None:
    """Поток: случайные люди с абсолютно разными подарками, независимо от фильтров и уровня."""
    await call.answer(texts.PARSING)
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
async def cb_stats(call: CallbackQuery, db: Database, crawler: Crawler, settings: Settings) -> None:
    parser = texts.parser_line(crawler.status, crawler.running)
    await safe_edit(call.message, texts.stats_text(await db.cached_stats(ttl=10), settings, parser), kb.back_to_menu())
    await call.answer("Обновлено")
